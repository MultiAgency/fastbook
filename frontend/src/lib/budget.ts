/**
 * Per-`accountId` daily quota + global daily cap for operator-paid LLM
 * calls. Two axes share the same UTC-day window: the per-caller counter
 * is the fairness mechanism, the global counter is the hard backstop
 * against cross-caller spend (Sybil amortization).
 *
 * Same memory model and cold-start-reset shape as `rate-limit.ts`:
 * single-instance only, defense-in-depth above and beyond per-action
 * rate limits which bound rate but not aggregate cross-caller spend.
 *
 * Window threading: `checkGenerateBudget` returns the window it
 * authorized against; `incrementGenerateBudget` pins to that window so
 * a UTC-rollover crossing between check and increment can't silently
 * move the count into a fresh budget.
 */

interface DayEntry {
  window: number;
  count: number;
}

const SECONDS_PER_DAY = 86400;
const EVICTION_INTERVAL = 500;

const callerStore = new Map<string, DayEntry>();
let globalEntry: DayEntry = { window: 0, count: 0 };
let callsSinceEviction = 0;

const DEFAULT_PER_CALLER_DAILY = 50;
const DEFAULT_GLOBAL_DAILY = 5000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function perCallerDailyLimit(): number {
  return readPositiveIntEnv(
    'NEARLY_GENERATE_PER_CALLER_DAILY',
    DEFAULT_PER_CALLER_DAILY,
  );
}

export function globalDailyLimit(): number {
  return readPositiveIntEnv('NEARLY_GENERATE_DAILY_CAP', DEFAULT_GLOBAL_DAILY);
}

export type BudgetScope = 'caller' | 'global';

export function checkGenerateBudget(
  accountId: string,
):
  | { ok: true; window: number }
  | { ok: false; retryAfter: number; scope: BudgetScope } {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / SECONDS_PER_DAY);
  const retryAfter = (window + 1) * SECONDS_PER_DAY - now;

  if (++callsSinceEviction >= EVICTION_INTERVAL) {
    callsSinceEviction = 0;
    for (const [k, v] of callerStore) {
      if (v.window < window) callerStore.delete(k);
    }
  }

  const callerEntry = callerStore.get(accountId);
  if (
    callerEntry &&
    callerEntry.window === window &&
    callerEntry.count >= perCallerDailyLimit()
  ) {
    return { ok: false, retryAfter, scope: 'caller' };
  }

  if (
    globalEntry.window === window &&
    globalEntry.count >= globalDailyLimit()
  ) {
    return { ok: false, retryAfter, scope: 'global' };
  }

  return { ok: true, window };
}

export function incrementGenerateBudget(
  accountId: string,
  window: number,
): void {
  const callerEntry = callerStore.get(accountId);
  if (!callerEntry || callerEntry.window < window) {
    callerStore.set(accountId, { window, count: 1 });
  } else if (callerEntry.window === window) {
    callerEntry.count++;
  }

  if (globalEntry.window < window) {
    globalEntry = { window, count: 1 };
  } else if (globalEntry.window === window) {
    globalEntry.count++;
  }
}

export function _resetBudgetForTesting(): void {
  callerStore.clear();
  globalEntry = { window: 0, count: 0 };
  callsSinceEviction = 0;
}
