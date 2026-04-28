/**
 * In-memory sliding-window rate limiting.
 *
 * Resets on cold start — acceptable because this is defense-in-depth,
 * not the security boundary.
 *
 * Window threading: check returns the window it authorized against;
 * increment pins to that window so a boundary crossing between check and
 * increment can't silently move the count into a fresh budget.
 */

interface WindowEntry {
  window: number;
  count: number;
}

const store = new Map<string, WindowEntry>();
let callsSinceEviction = 0;
const EVICTION_INTERVAL = 500;

/** Per-action rate limit configuration. */
export const LIMITS: Record<string, { limit: number; windowSecs: number }> = {
  'social.follow': { limit: 10, windowSecs: 60 },
  'social.unfollow': { limit: 10, windowSecs: 60 },
  'social.endorse': { limit: 20, windowSecs: 60 },
  'social.unendorse': { limit: 20, windowSecs: 60 },
  'social.profile': { limit: 10, windowSecs: 60 },
  'generate.profile': { limit: 30, windowSecs: 60 },
  'generate.follow': { limit: 30, windowSecs: 60 },
  'generate.endorse': { limit: 30, windowSecs: 60 },
  'social.heartbeat': { limit: 5, windowSecs: 60 },
  'social.delist_me': { limit: 1, windowSecs: 300 },
  verify_claim: { limit: 60, windowSecs: 60 },
  list_hidden: { limit: 120, windowSecs: 60 },
  list_platforms: { limit: 120, windowSecs: 60 },
};

export function checkRateLimit(
  action: string,
  callerHandle: string,
): { ok: true; window: number } | { ok: false; retryAfter: number } {
  const config = LIMITS[action];
  if (!config) return { ok: false, retryAfter: 60 };

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / config.windowSecs);

  // Periodic eviction of stale entries
  if (++callsSinceEviction >= EVICTION_INTERVAL) {
    callsSinceEviction = 0;
    const minWindow = window - 1;
    for (const [k, v] of store) {
      if (v.window < minWindow) store.delete(k);
    }
  }
  const key = `${action}:${callerHandle}`;
  const entry = store.get(key);

  if (!entry || entry.window !== window) {
    return { ok: true, window };
  }

  if (entry.count >= config.limit) {
    const retryAfter = (window + 1) * config.windowSecs - now;
    return { ok: false, retryAfter };
  }

  return { ok: true, window };
}

/**
 * Increment rate limit counter without checking.
 * Used after successful mutation to count it against the budget.
 *
 * Pass the `window` returned by the authorizing check to pin the increment
 * to that bucket so a boundary crossing between check and increment can't
 * silently move the count into a fresh budget.
 */
export function incrementRateLimit(
  action: string,
  callerHandle: string,
  window: number,
): void {
  const config = LIMITS[action];
  if (!config) return;

  const key = `${action}:${callerHandle}`;
  const entry = store.get(key);

  if (!entry || entry.window < window) {
    store.set(key, { window, count: 1 });
    return;
  }
  if (entry.window === window) {
    entry.count++;
  }
}

/**
 * Check remaining budget for batch operations.
 * Returns remaining count + the authorizing window, or error with retryAfter.
 */
export function checkRateLimitBudget(
  action: string,
  callerHandle: string,
):
  | { ok: true; remaining: number; window: number }
  | { ok: false; retryAfter: number } {
  const config = LIMITS[action];
  if (!config) return { ok: false, retryAfter: 60 };

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / config.windowSecs);
  const key = `${action}:${callerHandle}`;
  const entry = store.get(key);

  if (!entry || entry.window !== window) {
    return { ok: true, remaining: config.limit, window };
  }

  if (entry.count >= config.limit) {
    const retryAfter = (window + 1) * config.windowSecs - now;
    return { ok: false, retryAfter };
  }

  return { ok: true, remaining: config.limit - entry.count, window };
}
