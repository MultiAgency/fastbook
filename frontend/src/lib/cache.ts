interface CacheEntry {
  data: unknown;
  expires: number;
  action: string;
}

const MAX_CACHE_ENTRIES = 500;
const store = new Map<string, CacheEntry>();

/** Monotonic counter incremented on every clear (full or by-action).
 *  Prevents stale WASM responses from re-populating the cache. */
let generation = 0;

const TTL_MS: Record<string, number> = {
  get_profile: 60_000,
  health: 60_000,
  list_agents: 30_000,
  list_tags: 30_000,
  get_followers: 30_000,
  get_following: 30_000,
  get_edges: 30_000,
  get_endorsers: 30_000,
  check_handle: 5_000,
};
const DEFAULT_TTL = 30_000;

export function currentGeneration(): number {
  return generation;
}

export function getCached(key: string): unknown | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return undefined;
  }
  return entry.data;
}

/**
 * Store a response in the cache.
 *
 * @param gen - If provided, the write is skipped when the generation has
 *   advanced since the caller captured it (i.e. a clearCache() or
 *   clearByAction() happened while the WASM call was in-flight).
 */
export function setCache(
  action: string,
  key: string,
  data: unknown,
  gen?: number,
): void {
  if (gen !== undefined && gen !== generation) return;
  const ttl = TTL_MS[action] ?? DEFAULT_TTL;
  store.delete(key);
  store.set(key, { data, expires: Date.now() + ttl, action });
  if (store.size > MAX_CACHE_ENTRIES) {
    const overage = store.size - MAX_CACHE_ENTRIES;
    for (const key of Array.from(store.keys()).slice(0, overage)) {
      store.delete(key);
    }
  }
}

export function clearCache(): void {
  generation++;
  store.clear();
}

/** Remove only entries that were cached under the given action name.
 *  Bumps the generation so in-flight reads for that action cannot
 *  re-populate the cache after this clear. */
export function clearByAction(action: string): void {
  generation++;
  for (const [key, entry] of store) {
    if (entry.action === action) store.delete(key);
  }
}

export function makeCacheKey(body: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(body)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify(sorted);
}
