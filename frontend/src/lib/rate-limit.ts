/**
 * In-memory sliding-window rate limiting.
 *
 * Resets on cold start — acceptable because this is defense-in-depth,
 * not the security boundary. Matches WASM rate limit constants from
 * wasm/src/types.rs.
 */

interface WindowEntry {
  window: number;
  count: number;
}

const store = new Map<string, WindowEntry>();
let callsSinceEviction = 0;
const EVICTION_INTERVAL = 500;

/** Per-action rate limit configuration (from wasm/src/types.rs). */
const LIMITS: Record<string, { limit: number; windowSecs: number }> = {
  follow: { limit: 10, windowSecs: 60 },
  unfollow: { limit: 10, windowSecs: 60 },
  endorse: { limit: 20, windowSecs: 60 },
  unendorse: { limit: 20, windowSecs: 60 },
  update_me: { limit: 10, windowSecs: 60 },
  heartbeat: { limit: 5, windowSecs: 60 },
  deregister: { limit: 1, windowSecs: 300 },
};

export function checkRateLimit(
  action: string,
  callerHandle: string,
): { ok: true } | { ok: false; retryAfter: number } {
  const config = LIMITS[action];
  if (!config) return { ok: true };

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
    return { ok: true };
  }

  if (entry.count >= config.limit) {
    const retryAfter = (window + 1) * config.windowSecs - now;
    return { ok: false, retryAfter };
  }

  return { ok: true };
}

/**
 * Increment rate limit counter without checking.
 * Used after successful mutation to count it against the budget.
 */
export function incrementRateLimit(action: string, callerHandle: string): void {
  const config = LIMITS[action];
  if (!config) return;

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / config.windowSecs);
  const key = `${action}:${callerHandle}`;
  const entry = store.get(key);

  if (!entry || entry.window !== window) {
    store.set(key, { window, count: 1 });
  } else {
    entry.count++;
  }
}

/**
 * Check remaining budget for batch operations.
 * Returns remaining count or error with retryAfter.
 */
export function checkRateLimitBudget(
  action: string,
  callerHandle: string,
): { ok: true; remaining: number } | { ok: false; retryAfter: number } {
  const config = LIMITS[action];
  if (!config) return { ok: true, remaining: Infinity };

  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / config.windowSecs);
  const key = `${action}:${callerHandle}`;
  const entry = store.get(key);

  if (!entry || entry.window !== window) {
    return { ok: true, remaining: config.limit };
  }

  if (entry.count >= config.limit) {
    const retryAfter = (window + 1) * config.windowSecs - now;
    return { ok: false, retryAfter };
  }

  return { ok: true, remaining: config.limit - entry.count };
}
