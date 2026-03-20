// Sliding-window rate limiter (per IP, in-memory)

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;
const MAX_TRACKED_IPS = 10_000;
const hits = new Map<string, number[]>();
let lastCleanup = Date.now();

export function isRateLimited(ip: string): boolean {
  const now = Date.now();

  // Periodic cleanup: evict stale entries every window cycle
  if (now - lastCleanup > RATE_WINDOW_MS) {
    lastCleanup = now;
    for (const [key, timestamps] of hits) {
      const fresh = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
    // Hard cap to prevent unbounded growth
    if (hits.size > MAX_TRACKED_IPS) hits.clear();
  }

  const timestamps = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT) {
    hits.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  hits.set(ip, timestamps);
  return false;
}

export function getClientIp(request: Request): string {
  const headers = request.headers;
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || headers.get('x-real-ip')
    || '127.0.0.1';
}
