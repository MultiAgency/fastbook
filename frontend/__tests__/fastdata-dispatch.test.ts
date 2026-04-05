import * as fastdata from '@/lib/fastdata';
import { dispatchFastData } from '@/lib/fastdata-dispatch';

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
  mockKvGetAll.mockResolvedValue([]);
  mockKvListAll.mockResolvedValue([]);
  mockKvListAgent.mockResolvedValue([]);
  mockKvMultiAgent.mockResolvedValue([]);
});

const AGENT_ALICE = {
  handle: 'alice',
  description: 'Test agent Alice',
  avatar_url: null,
  tags: ['ai', 'defi'],
  capabilities: {},
  near_account_id: 'alice.near',
  follower_count: 5,
  following_count: 3,
  endorsements: {},
  platforms: [],
  created_at: 1700000000,
  last_active: 1700001000,
};

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

describe('dispatchFastData', () => {
  describe('unsupported actions', () => {
    it('returns error for unknown action', async () => {
      const err = expectError(await dispatchFastData('bogus_action', {}));
      expect(err).toContain('Unsupported');
    });
  });

  describe('health', () => {
    it('counts agents from profile entries', async () => {
      mockKvGetAll.mockResolvedValue([
        entry('alice.near', 'profile', AGENT_ALICE),
        entry('bob.near', 'profile', AGENT_ALICE),
      ]);
      const data = expectData(await dispatchFastData('health', {}));
      expect(data).toEqual({ agent_count: 2, status: 'ok' });
    });

    it('returns 0 when no agents', async () => {
      mockKvGetAll.mockResolvedValue([]);
      const data = expectData(await dispatchFastData('health', {}));
      expect(data).toEqual({ agent_count: 0, status: 'ok' });
    });
  });

  describe('get_profile', () => {
    it('reads profile by account_id', async () => {
      mockKvGetAgent.mockResolvedValue(AGENT_ALICE);
      const data = expectData(
        await dispatchFastData('get_profile', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;
      expect((data.agent as Record<string, unknown>).handle).toBe('alice');
    });

    it('returns 404 when account not found', async () => {
      mockKvGetAgent.mockResolvedValue(null);
      const err = expectError(
        await dispatchFastData('get_profile', { account_id: 'nobody.near' }),
      );
      expect(err).toContain('not found');
    });

    it('returns error when account_id is missing', async () => {
      const err = expectError(await dispatchFastData('get_profile', {}));
      expect(err).toContain('account_id');
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
        handle: 'bob',
        near_account_id: 'bob.near',
        follower_count: 3,
      };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            entry('alice.near', 'profile', AGENT_ALICE),
            entry('bob.near', 'profile', bob),
          ];
        return []; // deregistered/* checks
      });

      const data = expectData(
        await dispatchFastData('list_agents', { sort: 'followers', limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      expect(agents[0].handle).toBe('alice');
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
  });

  describe('get_followers', () => {
    it('returns agents who follow the account', async () => {
      mockKvGetAll.mockResolvedValue([
        entry('bob.near', 'graph/follow/alice.near', { at: 1700000000 }),
        entry('carol.near', 'graph/follow/alice.near', { at: 1700000001 }),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        { ...AGENT_ALICE, handle: 'bob', near_account_id: 'bob.near' },
        { ...AGENT_ALICE, handle: 'carol', near_account_id: 'carol.near' },
      ]);

      const data = expectData(
        await dispatchFastData('get_followers', {
          account_id: 'alice.near',
          limit: 25,
        }),
      ) as Record<string, unknown>;
      expect(data.account_id).toBe('alice.near');
      expect((data.followers as unknown[]).length).toBe(2);
    });
  });

  describe('get_me', () => {
    it('returns profile with computed completeness', async () => {
      mockKvGetAgent.mockResolvedValue(AGENT_ALICE);

      const data = expectData(
        await dispatchFastData('get_me', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;
      expect((data.agent as Record<string, unknown>).handle).toBe('alice');
      expect(data.profile_completeness).toBe(60); // description >10 chars (30) + tags present (30), capabilities empty (0)
    });
  });

  describe('get_suggested', () => {
    it('returns scored suggestions excluding self and followed', async () => {
      const bob = {
        ...AGENT_ALICE,
        handle: 'bob',
        near_account_id: 'bob.near',
        tags: ['ai'],
      };
      mockKvGetAgent.mockResolvedValue(AGENT_ALICE);
      mockKvListAgent.mockResolvedValue([]); // no follows yet
      mockKvGetAll.mockResolvedValue([
        entry('alice.near', 'profile', AGENT_ALICE),
        entry('bob.near', 'profile', bob),
      ]);

      const data = expectData(
        await dispatchFastData('get_suggested', {
          account_id: 'alice.near',
          limit: 10,
        }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      // Alice should be filtered (self), only bob remains
      expect(agents.length).toBe(1);
      expect(agents[0].handle).toBe('bob');
      expect(agents[0].reason).toContain('Shared tags');
    });
  });

  describe('error handling', () => {
    it('returns error on fetch failure', async () => {
      mockKvGetAgent.mockRejectedValue(new Error('network error'));
      const err = expectError(
        await dispatchFastData('get_profile', { account_id: 'alice.near' }),
      );
      expect(err).toContain('network error');
    });
  });
});
