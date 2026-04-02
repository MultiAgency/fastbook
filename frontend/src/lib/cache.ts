interface CacheEntry {
  data: unknown;
  expires: number;
  action: string;
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
  check_handle: 5_000,
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
  store.set(key, { data, expires: Date.now() + ttl, action });
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

/** Remove only entries that were cached under the given action name. */
export function clearByAction(action: string): void {
  for (const [key, entry] of store) {
    if (entry.action === action) store.delete(key);
  }
}

/** Which cached action types each mutation can invalidate.
 *  Anything not listed here falls through to full clearCache(). */
const INVALIDATION_MAP: Record<string, string[]> = {
  register: ['list_agents', 'list_tags', 'health', 'check_handle'],
  update_me: ['list_agents', 'list_tags', 'get_profile'],
  follow: [
    'list_agents',
    'get_profile',
    'get_followers',
    'get_following',
    'get_edges',
  ],
  unfollow: [
    'list_agents',
    'get_profile',
    'get_followers',
    'get_following',
    'get_edges',
  ],
  endorse: ['list_agents', 'get_profile', 'get_endorsers'],
  unendorse: ['list_agents', 'get_profile', 'get_endorsers'],
  batch_follow: [
    'list_agents',
    'get_profile',
    'get_followers',
    'get_following',
    'get_edges',
  ],
  batch_endorse: ['list_agents', 'get_profile', 'get_endorsers'],
  heartbeat: ['list_agents', 'get_profile'],
  migrate_account: ['get_profile'],
  deregister: [
    'list_agents',
    'list_tags',
    'health',
    'check_handle',
    'get_profile',
    'get_followers',
    'get_following',
    'get_edges',
    'get_endorsers',
  ],
  admin_deregister: [
    'list_agents',
    'list_tags',
    'health',
    'check_handle',
    'get_profile',
    'get_followers',
    'get_following',
    'get_edges',
    'get_endorsers',
  ],
};

/** Invalidate only the cached action types affected by the given mutation.
 *  Falls back to full clearCache() for unmapped mutations. */
export function invalidateForMutation(mutation: string): void {
  const affected = INVALIDATION_MAP[mutation];
  if (!affected) {
    clearCache();
    return;
  }
  const affectedSet = new Set(affected);
  for (const [key, entry] of store) {
    if (affectedSet.has(entry.action)) store.delete(key);
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
