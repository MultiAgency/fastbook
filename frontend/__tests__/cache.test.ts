import {
  clearByAction,
  clearCache,
  getCached,
  makeCacheKey,
  setCache,
} from '@/lib/cache';

beforeEach(() => {
  clearCache();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('getCached', () => {
  it('returns undefined for missing keys', () => {
    expect(getCached('nonexistent')).toBeUndefined();
  });

  it('returns data for fresh entries', () => {
    setCache('list_agents', 'key1', { agents: [] });
    expect(getCached('key1')).toEqual({ agents: [] });
  });

  it('returns undefined and evicts expired entries', () => {
    setCache('list_agents', 'key2', { agents: [] });
    // DEFAULT_TTL (30_000) + 1_000 to ensure expiry
    jest.advanceTimersByTime(31_000);
    expect(getCached('key2')).toBeUndefined();
  });
});

describe('setCache', () => {
  it('uses action-specific TTL for get_profile (60s)', () => {
    setCache('get_profile', 'profile1', { agent: {} });
    jest.advanceTimersByTime(59_000);
    expect(getCached('profile1')).toEqual({ agent: {} });
    jest.advanceTimersByTime(2_000);
    expect(getCached('profile1')).toBeUndefined();
  });

  it('uses action-specific TTL for list_agents (30s)', () => {
    setCache('list_agents', 'agents1', []);
    jest.advanceTimersByTime(29_000);
    expect(getCached('agents1')).toEqual([]);
    jest.advanceTimersByTime(2_000);
    expect(getCached('agents1')).toBeUndefined();
  });

  it('uses default TTL for unknown actions', () => {
    setCache('unknown_action', 'unk1', { data: true });
    jest.advanceTimersByTime(29_000);
    expect(getCached('unk1')).toEqual({ data: true });
    jest.advanceTimersByTime(2_000);
    expect(getCached('unk1')).toBeUndefined();
  });

  it('evicts oldest entry when exceeding 500 entries', () => {
    // MAX_CACHE_ENTRIES (500) + 1 to trigger eviction
    for (let i = 0; i < 501; i++) {
      setCache('list_agents', `evict_${i}`, { index: i });
    }
    expect(getCached('evict_0')).toBeUndefined();
    expect(getCached('evict_500')).toEqual({ index: 500 });
    expect(getCached('evict_250')).toEqual({ index: 250 });
  });
});

describe('compaction removes expired entries on access', () => {
  it('expired entries are cleaned up on getCached', () => {
    setCache('list_agents', 'comp_1', { a: 1 });
    setCache('get_profile', 'comp_2', { a: 2 });

    jest.advanceTimersByTime(35_000);

    expect(getCached('comp_1')).toBeUndefined();
    expect(getCached('comp_2')).toEqual({ a: 2 });
  });
});

describe('clearByAction', () => {
  it('removes only entries for the given action', () => {
    setCache('list_agents', 'agents_1', { a: 1 });
    setCache('get_profile', 'profile_1', { p: 1 });
    setCache('list_agents', 'agents_2', { a: 2 });

    clearByAction('list_agents');

    expect(getCached('agents_1')).toBeUndefined();
    expect(getCached('agents_2')).toBeUndefined();
    expect(getCached('profile_1')).toEqual({ p: 1 });
  });
});

describe('makeCacheKey', () => {
  it('produces deterministic keys regardless of property order', () => {
    const a = makeCacheKey({
      action: 'list_agents',
      limit: 10,
      sort: 'followers',
    });
    const b = makeCacheKey({
      sort: 'followers',
      action: 'list_agents',
      limit: 10,
    });
    expect(a).toBe(b);
  });

  it('produces different keys for different values', () => {
    const a = makeCacheKey({ action: 'list_agents', limit: 10 });
    const b = makeCacheKey({ action: 'list_agents', limit: 25 });
    expect(a).not.toBe(b);
  });
});
