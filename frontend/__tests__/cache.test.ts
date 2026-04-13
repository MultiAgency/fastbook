import {
  clearCache,
  getCached,
  invalidateForMutation,
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

describe('setCache', () => {
  it('uses action-specific TTL for profile (60s)', () => {
    setCache('profile', 'profile1', { agent: {} });
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

describe('invalidateForMutation', () => {
  it('selectively invalidates only affected action types', () => {
    setCache('list_agents', 'agents1', []);
    setCache('profile', 'profile1', { agent: {} });
    setCache('health', 'health1', { status: 'ok' });

    invalidateForMutation([
      'list_agents',
      'profile',
      'followers',
      'following',
      'edges',
    ]);

    // follow invalidates list_agents and profile but not health
    expect(getCached('agents1')).toBeUndefined();
    expect(getCached('profile1')).toBeUndefined();
    expect(getCached('health1')).toEqual({ status: 'ok' });
  });

  it('is a no-op for empty list', () => {
    setCache('list_agents', 'agents1', []);
    setCache('health', 'health1', { status: 'ok' });

    invalidateForMutation([]);

    expect(getCached('agents1')).toEqual([]);
    expect(getCached('health1')).toEqual({ status: 'ok' });
  });
});

describe('makeCacheKey', () => {
  it('produces deterministic keys regardless of property order', () => {
    const a = makeCacheKey({
      action: 'list_agents',
      limit: 10,
      sort: 'active',
    });
    const b = makeCacheKey({
      sort: 'active',
      action: 'list_agents',
      limit: 10,
    });
    expect(a).toBe(b);
  });
});
