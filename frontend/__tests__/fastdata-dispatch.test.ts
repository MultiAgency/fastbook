import * as fastdata from '@/lib/fastdata';
import { dispatchFastData } from '@/lib/fastdata-dispatch';

jest.mock('@/lib/fastdata');
const mockKvGet = fastdata.kvGet as jest.MockedFunction<typeof fastdata.kvGet>;
const mockKvList = fastdata.kvList as jest.MockedFunction<
  typeof fastdata.kvList
>;
const mockKvMulti = fastdata.kvMulti as jest.MockedFunction<
  typeof fastdata.kvMulti
>;

beforeEach(() => {
  jest.resetAllMocks();
  // Defaults: kvList returns empty, kvMulti returns empty.
  mockKvList.mockResolvedValue([]);
  mockKvMulti.mockResolvedValue([]);
});

const AGENT_ALICE = {
  handle: 'alice',
  description: 'Test agent',
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
      const err = expectError(await dispatchFastData('get_me', {}));
      expect(err).toContain('Unsupported');
    });
  });

  describe('health', () => {
    it('returns agent count', async () => {
      mockKvGet.mockResolvedValue(42);
      const data = expectData(await dispatchFastData('health', {}));
      expect(data).toEqual({ agent_count: 42, status: 'ok' });
    });

    it('returns 0 when key is missing', async () => {
      mockKvGet.mockResolvedValue(null);
      const data = expectData(await dispatchFastData('health', {}));
      expect(data).toEqual({ agent_count: 0, status: 'ok' });
    });
  });

  describe('check_handle', () => {
    it('returns available=true when agent not found', async () => {
      mockKvGet.mockResolvedValue(null);
      const data = expectData(
        await dispatchFastData('check_handle', { handle: 'newhandle' }),
      );
      expect(data).toEqual({ handle: 'newhandle', available: true });
    });

    it('returns available=false when agent exists', async () => {
      mockKvGet.mockResolvedValue(AGENT_ALICE);
      const data = expectData(
        await dispatchFastData('check_handle', { handle: 'alice' }),
      );
      expect(data).toEqual({ handle: 'alice', available: false });
    });
  });

  describe('get_profile', () => {
    it('returns formatted agent', async () => {
      mockKvGet.mockResolvedValue(AGENT_ALICE);
      const data = expectData(
        await dispatchFastData('get_profile', { handle: 'alice' }),
      ) as Record<string, unknown>;
      const agent = data.agent as Record<string, unknown>;
      expect(agent.handle).toBe('alice');
      expect(agent.follower_count).toBe(5);
      expect(agent.tags).toEqual(['ai', 'defi']);
    });

    it('returns error for missing agent', async () => {
      mockKvGet.mockResolvedValue(null);
      const err = expectError(
        await dispatchFastData('get_profile', { handle: 'nobody' }),
      );
      expect(err).toContain('not found');
    });
  });

  describe('list_tags', () => {
    it('returns sorted tags', async () => {
      mockKvGet.mockResolvedValue({ defi: 10, ai: 5, gaming: 3 });
      const data = expectData(
        await dispatchFastData('list_tags', {}),
      ) as Record<string, unknown>;
      const tags = data.tags as { tag: string; count: number }[];
      expect(tags[0]).toEqual({ tag: 'defi', count: 10 });
      expect(tags[1]).toEqual({ tag: 'ai', count: 5 });
      expect(tags[2]).toEqual({ tag: 'gaming', count: 3 });
    });

    it('returns empty array when no tags', async () => {
      mockKvGet.mockResolvedValue(null);
      const data = expectData(
        await dispatchFastData('list_tags', {}),
      ) as Record<string, unknown>;
      expect(data.tags).toEqual([]);
    });
  });

  describe('list_agents', () => {
    it('fetches sorted entries and batch-loads agents', async () => {
      mockKvList.mockResolvedValue([
        {
          key: 'sorted/followers/alice',
          value: { score: 10 },
          predecessor_id: '',
          current_account_id: '',
          block_height: 0,
          block_timestamp: 0,
        },
        {
          key: 'sorted/followers/bob',
          value: { score: 5 },
          predecessor_id: '',
          current_account_id: '',
          block_height: 0,
          block_timestamp: 0,
        },
      ]);
      mockKvMulti.mockResolvedValue([
        AGENT_ALICE,
        { ...AGENT_ALICE, handle: 'bob', follower_count: 5 },
      ]);

      const data = expectData(
        await dispatchFastData('list_agents', { sort: 'followers', limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      expect(agents[0].handle).toBe('alice');
      expect(agents[1].handle).toBe('bob');
    });

    it('filters by tag', async () => {
      // Tag filtering now uses tag-indexed sorted lists: sorted/followers/tag:{tag}/
      mockKvList.mockResolvedValueOnce([
        {
          key: 'sorted/followers/tag:ai/alice',
          value: { score: 10 },
          predecessor_id: '',
          current_account_id: '',
          block_height: 0,
          block_timestamp: 0,
        },
      ]);
      mockKvMulti.mockResolvedValueOnce([AGENT_ALICE]);

      const data = expectData(
        await dispatchFastData('list_agents', { tag: 'ai' }),
      ) as Record<string, unknown>;
      expect((data.agents as unknown[]).length).toBe(1);

      // Tag with no matching agents returns empty
      mockKvList.mockResolvedValueOnce([]);

      const data2 = expectData(
        await dispatchFastData('list_agents', { tag: 'nope' }),
      ) as Record<string, unknown>;
      expect((data2.agents as unknown[]).length).toBe(0);
    });
  });

  describe('get_followers', () => {
    it('returns paginated followers from prefix scan', async () => {
      mockKvList.mockResolvedValue([
        {
          key: 'follower/alice/bob',
          value: { ts: 1700000000 },
          predecessor_id: '',
          current_account_id: '',
          block_height: 0,
          block_timestamp: 0,
        },
        {
          key: 'follower/alice/carol',
          value: { ts: 0 },
          predecessor_id: '',
          current_account_id: '',
          block_height: 0,
          block_timestamp: 0,
        },
      ]);
      mockKvMulti.mockResolvedValue([
        { ...AGENT_ALICE, handle: 'bob' },
        { ...AGENT_ALICE, handle: 'carol' },
      ]);

      const data = expectData(
        await dispatchFastData('get_followers', { handle: 'alice', limit: 25 }),
      ) as Record<string, unknown>;
      expect(data.handle).toBe('alice');
      const followers = data.followers as Record<string, unknown>[];
      expect(followers).toHaveLength(2);
      expect(followers[0].handle).toBe('bob');
      expect(followers[1].handle).toBe('carol');
    });

    it('handles cursor pagination', async () => {
      mockKvList.mockResolvedValue([
        {
          key: 'follower/alice/a1',
          value: { ts: 0 },
          predecessor_id: '',
          current_account_id: '',
          block_height: 0,
          block_timestamp: 0,
        },
        {
          key: 'follower/alice/a2',
          value: { ts: 0 },
          predecessor_id: '',
          current_account_id: '',
          block_height: 0,
          block_timestamp: 0,
        },
        {
          key: 'follower/alice/a3',
          value: { ts: 0 },
          predecessor_id: '',
          current_account_id: '',
          block_height: 0,
          block_timestamp: 0,
        },
      ]);
      mockKvMulti.mockResolvedValue([{ ...AGENT_ALICE, handle: 'a2' }]);

      const data = expectData(
        await dispatchFastData('get_followers', {
          handle: 'alice',
          limit: 1,
          cursor: 'a1',
        }),
      ) as Record<string, unknown>;
      const followers = data.followers as Record<string, unknown>[];
      expect(followers).toHaveLength(1);
      expect(followers[0].handle).toBe('a2');
      expect(data.cursor).toBe('a2');
    });
  });

  describe('get_endorsers', () => {
    it('batches endorser agent lookups via kvMulti', async () => {
      const agentWithTags = {
        ...AGENT_ALICE,
        tags: ['ai'],
        capabilities: { tools: ['search'] },
      };
      // First kvGet: agent profile
      mockKvGet.mockResolvedValueOnce(agentWithTags);
      // Parallel kvGet for endorser lists: tags/ai, tools/search
      mockKvGet.mockResolvedValueOnce(['bob', 'carol']); // endorsers/alice/tags/ai
      mockKvGet.mockResolvedValueOnce(['bob']); // endorsers/alice/tools/search

      // kvMulti for unique agent records (bob, carol)
      mockKvMulti.mockResolvedValueOnce([
        { ...AGENT_ALICE, handle: 'bob', description: 'Bob' },
        { ...AGENT_ALICE, handle: 'carol', description: 'Carol' },
      ]);

      const data = expectData(
        await dispatchFastData('get_endorsers', { handle: 'alice' }),
      ) as Record<string, unknown>;
      expect(data.handle).toBe('alice');

      const endorsers = data.endorsers as Record<
        string,
        Record<string, unknown[]>
      >;
      expect(endorsers.tags.ai).toHaveLength(2);
      expect(endorsers.tools.search).toHaveLength(1);

      // Should have called kvMulti once with deduplicated handles
      expect(mockKvMulti).toHaveBeenCalledTimes(1);
      const multiKeys = mockKvMulti.mock.calls[0][0] as string[];
      expect(multiKeys).toHaveLength(2); // bob + carol deduplicated
      expect(multiKeys).toContain('agent/bob');
      expect(multiKeys).toContain('agent/carol');
    });

    it('returns empty endorsers when no pairs have endorsers', async () => {
      mockKvGet.mockResolvedValueOnce({
        ...AGENT_ALICE,
        tags: ['ai'],
        capabilities: {},
      });
      mockKvGet.mockResolvedValueOnce(null); // no endorsers for tags/ai

      const data = expectData(
        await dispatchFastData('get_endorsers', { handle: 'alice' }),
      ) as Record<string, unknown>;
      expect(data.endorsers).toEqual({});
      expect(mockKvMulti).not.toHaveBeenCalled();
    });

    it('returns 404 when agent not found', async () => {
      mockKvGet.mockResolvedValueOnce(null);
      const err = expectError(
        await dispatchFastData('get_endorsers', { handle: 'nobody' }),
      );
      expect(err).toContain('not found');
    });
  });

  describe('error handling', () => {
    it('returns error on fetch failure', async () => {
      mockKvGet.mockRejectedValueOnce(new Error('network error'));
      const err = expectError(
        await dispatchFastData('get_profile', { handle: 'alice' }),
      );
      expect(err).toContain('network error');
    });
  });
});
