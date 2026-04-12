import { clearCache } from '@/lib/cache';
import * as fastdata from '@/lib/fastdata';
import { dispatchFastData } from '@/lib/fastdata-dispatch';
import { profileCompleteness, profileGaps } from '@/lib/fastdata-utils';
import { AGENT_ALICE } from './fixtures';

jest.mock('@/lib/constants', () => ({
  ...jest.requireActual('@/lib/constants'),
  OUTLAYER_ADMIN_ACCOUNT: 'admin.near',
}));
jest.mock('@/lib/fastdata');
const mockKvGetAgent = fastdata.kvGetAgent as jest.MockedFunction<
  typeof fastdata.kvGetAgent
>;
const mockKvGetAll = fastdata.kvGetAll as jest.MockedFunction<
  typeof fastdata.kvGetAll
>;
const mockKvListAgent = fastdata.kvListAgent as jest.MockedFunction<
  typeof fastdata.kvListAgent
>;
const mockKvListAll = fastdata.kvListAll as jest.MockedFunction<
  typeof fastdata.kvListAll
>;
const mockKvMultiAgent = fastdata.kvMultiAgent as jest.MockedFunction<
  typeof fastdata.kvMultiAgent
>;

beforeEach(() => {
  jest.resetAllMocks();
  clearCache();
  mockKvGetAll.mockResolvedValue([]);
  mockKvListAll.mockResolvedValue([]);
  mockKvListAgent.mockResolvedValue([]);
  mockKvMultiAgent.mockResolvedValue([]);
});

function entry(
  predecessorId: string,
  key: string,
  value: unknown,
): fastdata.KvEntry {
  return {
    predecessor_id: predecessorId,
    current_account_id: 'contextual.near',
    block_height: 100,
    block_timestamp: 1700000000,
    key,
    value,
  };
}

function expectData(result: unknown): unknown {
  expect(result).toHaveProperty('data');
  return (result as { data: unknown }).data;
}

function expectError(result: unknown): string {
  expect(result).toHaveProperty('error');
  return (result as { error: string }).error;
}

describe('profileCompleteness', () => {
  it('returns 100 when all fields are complete', () => {
    const agent = {
      description: 'A description longer than 10 chars',
      tags: ['ai'],
      capabilities: { skills: ['testing'] },
    };
    expect(profileGaps(agent)).toEqual([]);
    expect(profileCompleteness(agent)).toBe(100);
  });

  it('penalizes missing description', () => {
    expect(
      profileGaps({
        description: '',
        tags: ['ai'],
        capabilities: { skills: ['x'] },
      }),
    ).toContain('description');
  });

  it('penalizes description <= 10 chars', () => {
    expect(
      profileGaps({
        description: '0123456789',
        tags: ['ai'],
        capabilities: { skills: ['x'] },
      }),
    ).toContain('description');
  });

  it('accepts description > 10 chars', () => {
    expect(
      profileGaps({
        description: '01234567890',
        tags: ['ai'],
        capabilities: { skills: ['x'] },
      }),
    ).not.toContain('description');
  });

  it('penalizes empty tags', () => {
    expect(
      profileGaps({
        description: 'long enough text',
        tags: [],
        capabilities: { skills: ['x'] },
      }),
    ).toContain('tags');
  });

  it('penalizes empty capabilities', () => {
    expect(
      profileGaps({
        description: 'long enough text',
        tags: ['ai'],
        capabilities: {},
      }),
    ).toContain('capabilities');
  });

  it('scores AGENT_ALICE at 60 (description 30 + tags 30, capabilities 0)', () => {
    expect(
      profileCompleteness(
        AGENT_ALICE as Parameters<typeof profileCompleteness>[0],
      ),
    ).toBe(60);
  });
});

describe('dispatchFastData', () => {
  describe('unsupported actions', () => {
    it('returns error for unknown action', async () => {
      const err = expectError(await dispatchFastData('bogus_action', {}));
      expect(err).toContain('Unsupported');
    });
  });

  describe('profile', () => {
    it('reads profile by account_id', async () => {
      mockKvGetAgent.mockResolvedValue(AGENT_ALICE);
      const data = expectData(
        await dispatchFastData('profile', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;
      expect((data.agent as Record<string, unknown>).account_id).toBe(
        'alice.near',
      );
    });

    it('returns 404 when account not found', async () => {
      mockKvGetAgent.mockResolvedValue(null);
      const err = expectError(
        await dispatchFastData('profile', { account_id: 'nobody.near' }),
      );
      expect(err).toContain('not found');
    });

    it('returns error when account_id is missing', async () => {
      const err = expectError(await dispatchFastData('profile', {}));
      expect(err).toContain('account_id');
    });

    it('omits is_following and my_endorsements when caller is not set', async () => {
      mockKvGetAgent.mockResolvedValue(AGENT_ALICE);
      const data = expectData(
        await dispatchFastData('profile', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;
      expect(data).not.toHaveProperty('is_following');
      expect(data).not.toHaveProperty('my_endorsements');
    });

    it('populates is_following=true when caller follows the target', async () => {
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile') return AGENT_ALICE;
        if (accountId === 'bob.near' && key === 'graph/follow/alice.near')
          return { at: 1700000000 };
        return null;
      });
      mockKvListAgent.mockResolvedValue([]);
      const data = expectData(
        await dispatchFastData('profile', {
          account_id: 'alice.near',
          caller_account_id: 'bob.near',
        }),
      ) as Record<string, unknown>;
      expect(data.is_following).toBe(true);
      expect(data.my_endorsements).toEqual({});
    });

    it('populates is_following=false when caller does not follow', async () => {
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile') return AGENT_ALICE;
        return null;
      });
      mockKvListAgent.mockResolvedValue([]);
      const data = expectData(
        await dispatchFastData('profile', {
          account_id: 'alice.near',
          caller_account_id: 'bob.near',
        }),
      ) as Record<string, unknown>;
      expect(data.is_following).toBe(false);
      expect(data.my_endorsements).toEqual({});
    });

    it('groups my_endorsements by namespace', async () => {
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile') return AGENT_ALICE;
        return null;
      });
      mockKvListAgent.mockImplementation(async (accountId, prefix) => {
        if (accountId === 'bob.near' && prefix === 'endorsing/alice.near/') {
          return [
            entry('bob.near', 'endorsing/alice.near/tags/ai', {
              at: 1700000000,
            }),
            entry('bob.near', 'endorsing/alice.near/tags/defi', {
              at: 1700000000,
            }),
            entry('bob.near', 'endorsing/alice.near/skills/testing', {
              at: 1700000000,
            }),
          ];
        }
        return [];
      });
      const data = expectData(
        await dispatchFastData('profile', {
          account_id: 'alice.near',
          caller_account_id: 'bob.near',
        }),
      ) as Record<string, unknown>;
      expect(data.my_endorsements).toEqual({
        tags: ['ai', 'defi'],
        skills: ['testing'],
      });
    });

    it('returns zero caller context when caller is the target', async () => {
      // Self-follow and self-endorse are blocked at write time, so the
      // natural KV lookups yield is_following=false and my_endorsements={}.
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile') return AGENT_ALICE;
        return null;
      });
      mockKvListAgent.mockResolvedValue([]);
      const data = expectData(
        await dispatchFastData('profile', {
          account_id: 'alice.near',
          caller_account_id: 'alice.near',
        }),
      ) as Record<string, unknown>;
      expect(data.is_following).toBe(false);
      expect(data.my_endorsements).toEqual({});
    });

    it('falls back to unenriched profile when caller context lookup fails', async () => {
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile') return AGENT_ALICE;
        throw new Error('fastdata down');
      });
      mockKvListAgent.mockResolvedValue([]);
      const data = expectData(
        await dispatchFastData('profile', {
          account_id: 'alice.near',
          caller_account_id: 'bob.near',
        }),
      ) as Record<string, unknown>;
      expect(data).toHaveProperty('agent');
      expect(data).not.toHaveProperty('is_following');
      expect(data).not.toHaveProperty('my_endorsements');
    });
  });

  describe('list_tags', () => {
    it('aggregates tag counts from all agents', async () => {
      mockKvListAll.mockResolvedValue([
        entry('alice.near', 'tag/ai', { score: 5 }),
        entry('bob.near', 'tag/ai', { score: 3 }),
        entry('alice.near', 'tag/defi', { score: 5 }),
      ]);
      const data = expectData(
        await dispatchFastData('list_tags', {}),
      ) as Record<string, unknown>;
      const tags = data.tags as { tag: string; count: number }[];
      expect(tags[0]).toEqual({ tag: 'ai', count: 2 });
      expect(tags[1]).toEqual({ tag: 'defi', count: 1 });
    });
  });

  describe('list_capabilities', () => {
    it('aggregates capability counts from all agents', async () => {
      mockKvListAll.mockResolvedValue([
        entry('alice.near', 'cap/skills/testing', { score: 5 }),
        entry('bob.near', 'cap/skills/testing', { score: 3 }),
        entry('alice.near', 'cap/languages/python', { score: 5 }),
      ]);
      const data = expectData(
        await dispatchFastData('list_capabilities', {}),
      ) as Record<string, unknown>;
      const caps = data.capabilities as {
        namespace: string;
        value: string;
        count: number;
      }[];
      expect(caps[0]).toEqual({
        namespace: 'skills',
        value: 'testing',
        count: 2,
      });
      expect(caps[1]).toEqual({
        namespace: 'languages',
        value: 'python',
        count: 1,
      });
    });
  });

  describe('list_agents', () => {
    it('fetches profiles and sorts by follower count', async () => {
      const bob = {
        ...AGENT_ALICE,
        account_id: 'bob.near',
      };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            entry('bob.near', 'profile', bob),
            entry('alice.near', 'profile', AGENT_ALICE),
          ];
        return []; // deregistered/* checks
      });
      // Alice has 3 followers, Bob has 1 — drives sort order via getFollowerCountMap
      mockKvListAll.mockResolvedValue([
        entry('f1.near', 'graph/follow/alice.near', { at: 1000 }),
        entry('f2.near', 'graph/follow/alice.near', { at: 1001 }),
        entry('f3.near', 'graph/follow/alice.near', { at: 1002 }),
        entry('f4.near', 'graph/follow/bob.near', { at: 1003 }),
      ]);

      const data = expectData(
        await dispatchFastData('list_agents', { sort: 'followers', limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      // Alice (3 followers) should sort before Bob (1 follower)
      expect(agents[0].account_id).toBe('alice.near');
      expect(agents[1].account_id).toBe('bob.near');
    });

    it('filters by tag', async () => {
      mockKvGetAll.mockResolvedValue([
        entry('alice.near', 'tag/ai', { score: 10 }),
      ]);
      mockKvMultiAgent.mockResolvedValue([AGENT_ALICE]);

      const data = expectData(
        await dispatchFastData('list_agents', { tag: 'ai' }),
      ) as Record<string, unknown>;
      expect((data.agents as unknown[]).length).toBe(1);
      expect(mockKvGetAll).toHaveBeenCalledWith('tag/ai');
    });

    it('filters by capability', async () => {
      mockKvGetAll.mockResolvedValue([
        entry('alice.near', 'cap/skills/testing', { score: 10 }),
      ]);
      mockKvMultiAgent.mockResolvedValue([AGENT_ALICE]);

      const data = expectData(
        await dispatchFastData('list_agents', { capability: 'skills/testing' }),
      ) as Record<string, unknown>;
      expect((data.agents as unknown[]).length).toBe(1);
      // Verify kvGetAll was called with the capability key
      expect(mockKvGetAll).toHaveBeenCalledWith('cap/skills/testing');
    });

    it('excludes hidden accounts from results', async () => {
      const bob = { ...AGENT_ALICE, account_id: 'bob.near' };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            entry('alice.near', 'profile', AGENT_ALICE),
            entry('bob.near', 'profile', bob),
          ];
        return [];
      });
      // Admin has hidden bob
      mockKvListAgent.mockImplementation(async (id: string, prefix: string) => {
        if (id === 'admin.near' && prefix === 'hidden/')
          return [entry('admin.near', 'hidden/bob.near', { at: 1000 })];
        return [];
      });

      const data = expectData(
        await dispatchFastData('list_agents', { limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(1);
      expect(agents[0].account_id).toBe('alice.near');
    });

    it('sorts by newest (created_at descending)', async () => {
      const bob = {
        ...AGENT_ALICE,
        account_id: 'bob.near',
        created_at: 1700002000,
      };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            entry('alice.near', 'profile', AGENT_ALICE),
            entry('bob.near', 'profile', bob),
          ];
        return [];
      });

      const data = expectData(
        await dispatchFastData('list_agents', { sort: 'newest', limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      // Bob (created_at: 1700002000) is newer than Alice (1700000000)
      expect(agents[0].account_id).toBe('bob.near');
      expect(agents[1].account_id).toBe('alice.near');
    });

    it('sorts by active (last_active descending)', async () => {
      const bob = {
        ...AGENT_ALICE,
        account_id: 'bob.near',
        last_active: 1700005000,
      };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            entry('alice.near', 'profile', AGENT_ALICE),
            entry('bob.near', 'profile', bob),
          ];
        return [];
      });

      const data = expectData(
        await dispatchFastData('list_agents', { sort: 'active', limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      // Bob (last_active: 1700005000) is more recent than Alice (1700001000)
      expect(agents[0].account_id).toBe('bob.near');
      expect(agents[1].account_id).toBe('alice.near');
    });

    it('sorts by endorsements descending', async () => {
      const bob = { ...AGENT_ALICE, account_id: 'bob.near' };
      const alice = { ...AGENT_ALICE };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            entry('alice.near', 'profile', alice),
            entry('bob.near', 'profile', bob),
          ];
        return [];
      });
      // Live endorsement counts are overlaid from a cross-predecessor
      // scan of `endorsing/`: 3 endorsements for bob, 1 for alice.
      mockKvListAll.mockImplementation(async (prefix: string) => {
        if (prefix === 'endorsing/') {
          return [
            entry('x.near', 'endorsing/bob.near/tags/ai', { at: 1 }),
            entry('y.near', 'endorsing/bob.near/tags/ai', { at: 1 }),
            entry('z.near', 'endorsing/bob.near/tags/defi', { at: 1 }),
            entry('x.near', 'endorsing/alice.near/tags/ai', { at: 1 }),
          ];
        }
        return [];
      });

      const data = expectData(
        await dispatchFastData('list_agents', {
          sort: 'endorsements',
          limit: 25,
        }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      // Bob (3 live endorsements) sorts before Alice (1)
      expect(agents[0].account_id).toBe('bob.near');
      expect(agents[1].account_id).toBe('alice.near');
    });
  });

  describe('followers', () => {
    it('returns agents who follow the account', async () => {
      mockKvGetAll.mockResolvedValue([
        entry('bob.near', 'graph/follow/alice.near', { at: 1700000000 }),
        entry('carol.near', 'graph/follow/alice.near', { at: 1700000001 }),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        { ...AGENT_ALICE, account_id: 'bob.near' },
        { ...AGENT_ALICE, account_id: 'carol.near' },
      ]);

      const data = expectData(
        await dispatchFastData('followers', {
          account_id: 'alice.near',
          limit: 25,
        }),
      ) as Record<string, unknown>;
      expect(data.account_id).toBe('alice.near');
      expect((data.followers as unknown[]).length).toBe(2);
      expect(mockKvGetAll).toHaveBeenCalledWith('graph/follow/alice.near');
    });
  });

  describe('me', () => {
    it('returns profile with computed completeness', async () => {
      mockKvGetAgent.mockResolvedValue(AGENT_ALICE);

      const data = expectData(
        await dispatchFastData('me', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;
      expect((data.agent as Record<string, unknown>).account_id).toBe(
        'alice.near',
      );
      expect(data.profile_completeness).toBe(60); // description >10 chars (30) + tags present (30), capabilities empty (0)
    });
  });

  describe('discover_agents', () => {
    it('returns scored suggestions excluding self and followed', async () => {
      const bob = {
        ...AGENT_ALICE,
        account_id: 'bob.near',
        tags: ['ai'],
      };
      mockKvGetAgent.mockResolvedValue(AGENT_ALICE);
      mockKvListAgent.mockResolvedValue([]); // no follows yet
      mockKvGetAll.mockResolvedValue([
        entry('alice.near', 'profile', AGENT_ALICE),
        entry('bob.near', 'profile', bob),
      ]);

      const data = expectData(
        await dispatchFastData('discover_agents', {
          account_id: 'alice.near',
          limit: 10,
        }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      // Alice should be filtered (self), only bob remains
      expect(agents.length).toBe(1);
      expect(agents[0].account_id).toBe('bob.near');
      expect(agents[0].reason).toContain('Shared tags');
    });
  });

  describe('error handling', () => {
    it('returns error on fetch failure', async () => {
      mockKvGetAgent.mockRejectedValue(new Error('network error'));
      const err = expectError(
        await dispatchFastData('profile', { account_id: 'alice.near' }),
      );
      expect(err).toContain('network error');
    });
  });
});
