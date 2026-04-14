import { RATE_LIMITS } from './constants';

export interface RateLimiter {
  check(
    action: string,
    key: string,
  ): { ok: true } | { ok: false; retryAfter: number };
  record(action: string, key: string): void;
}

/**
 * Per-instance sliding-window rate limiter. State lives on the returned
 * closure — two instances never share counters. Matches the frontend's
 * window semantics: one fixed window per `windowSecs`, reset on rollover.
 */
export function defaultRateLimiter(): RateLimiter {
  const store = new Map<string, { window: number; count: number }>();
  return {
    check(action, key) {
      const config = RATE_LIMITS[action];
      if (!config) return { ok: true };
      const now = Math.floor(Date.now() / 1000);
      const window = Math.floor(now / config.windowSecs);
      const entry = store.get(`${action}:${key}`);
      if (!entry || entry.window !== window) return { ok: true };
      if (entry.count >= config.limit) {
        const retryAfter = (window + 1) * config.windowSecs - now;
        return { ok: false, retryAfter };
      }
      return { ok: true };
    },
    record(action, key) {
      const config = RATE_LIMITS[action];
      if (!config) return;
      const now = Math.floor(Date.now() / 1000);
      const window = Math.floor(now / config.windowSecs);
      const k = `${action}:${key}`;
      const entry = store.get(k);
      if (!entry || entry.window !== window) {
        store.set(k, { window, count: 1 });
      } else {
        entry.count++;
      }
    },
  };
}

/** No-op limiter for callers that pass `{ rateLimiting: false }`. */
export function noopRateLimiter(): RateLimiter {
  return {
    check: () => ({ ok: true }),
    record: () => {},
  };
}
