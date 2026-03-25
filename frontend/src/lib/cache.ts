interface CacheEntry {
  data: unknown;
  expires: number;
}

const MAX_CACHE_ENTRIES = 500;
const store = new Map<string, CacheEntry>();

const TTL_MS: Record<string, number> = {
  get_profile: 60_000,
  health: 60_000,
  list_agents: 30_000,
  list_tags: 30_000,
  get_followers: 30_000,
  get_following: 30_000,
  get_edges: 30_000,
  get_endorsers: 30_000,
};
const DEFAULT_TTL = 30_000;

export function getCached(key: string): unknown | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return undefined;
  }
  return entry.data;
}

export function setCache(action: string, key: string, data: unknown): void {
  const ttl = TTL_MS[action] ?? DEFAULT_TTL;
  store.delete(key);
  store.set(key, { data, expires: Date.now() + ttl });
  if (store.size > MAX_CACHE_ENTRIES) {
    const overage = store.size - MAX_CACHE_ENTRIES;
    for (const key of Array.from(store.keys()).slice(0, overage)) {
      store.delete(key);
    }
  }
}

export function clearCache(): void {
  store.clear();
}

export function makeCacheKey(body: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(body)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return JSON.stringify(sorted);
}
