import { clearCache } from '@/lib/cache';
import * as fastdata from '@/lib/fastdata/client';
import { dispatchFastData } from '@/lib/fastdata/reads';

const AGENT_ALICE = {
  name: null,
  description: 'Test agent Alice',
  image: null,
  tags: ['ai', 'defi'],
  capabilities: {},
  account_id: 'alice.near',
  follower_count: 5,
  following_count: 3,
  endorsements: {},
  created_at: 1700000000,
  last_active: 1700001000,
};

jest.mock('@/lib/constants', () => ({
  ...jest.requireActual('@/lib/constants'),
  OUTLAYER_ADMIN_ACCOUNT: 'admin.near',
}));
jest.mock('@/lib/admin-near-token', () => ({
  resolveAdminWriterAccount: jest.fn().mockResolvedValue('admin.near'),
}));
jest.mock('@/lib/fastdata/client');

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
const mockKvHistoryFirstByPredecessor =
  fastdata.kvHistoryFirstByPredecessor as jest.MockedFunction<
    typeof fastdata.kvHistoryFirstByPredecessor
  >;

beforeEach(() => {
  jest.resetAllMocks();
  clearCache();
  mockKvGetAgent.mockResolvedValue(null);
  mockKvGetAll.mockResolvedValue([]);
  mockKvListAll.mockResolvedValue([]);
  mockKvListAgent.mockResolvedValue([]);
  mockKvMultiAgent.mockResolvedValue([]);
});

// Block timestamp in nanoseconds (the units FastData uses). This fixed value
// resolves to the same second as the AGENT_ALICE `last_active`, so the
// trust-boundary override doesn't shift the timestamp in unrelated tests.
const FIXTURE_BLOCK_TS_NS = 1_700_000_000_000_000_000;

function entry(
  predecessorId: string,
  key: string,
  value: unknown,
): fastdata.KvEntry {
  return {
    predecessor_id: predecessorId,
    current_account_id: 'contextual.near',
    block_height: 100,
    block_timestamp: FIXTURE_BLOCK_TS_NS,
    key,
    value,
  };
}

/** Wrap a profile blob in a KvEntry with the standard fixture block time. */
function profileEntry(accountId: string, value: unknown): fastdata.KvEntry {
  return entry(accountId, 'profile', value);
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

  describe('profile', () => {
    it('reads profile by account_id', async () => {
      mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', AGENT_ALICE));
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
      mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', AGENT_ALICE));
      const data = expectData(
        await dispatchFastData('profile', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;
      expect(data).not.toHaveProperty('is_following');
      expect(data).not.toHaveProperty('my_endorsements');
    });

    it('populates is_following=true when caller follows the target', async () => {
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile')
          return profileEntry('alice.near', AGENT_ALICE);
        if (accountId === 'bob.near' && key === 'graph/follow/alice.near')
          return entry('bob.near', 'graph/follow/alice.near', {
            at: 1700000000,
          });
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
      expect(data.my_endorsements).toEqual([]);
    });

    it('populates is_following=false when caller does not follow', async () => {
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile')
          return profileEntry('alice.near', AGENT_ALICE);
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
      expect(data.my_endorsements).toEqual([]);
    });

    it('returns my_endorsements as a flat list of key_suffixes', async () => {
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile')
          return profileEntry('alice.near', AGENT_ALICE);
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
      expect(data.my_endorsements).toEqual([
        'tags/ai',
        'tags/defi',
        'skills/testing',
      ]);
    });

    it('returns zero caller context when caller is the target', async () => {
      // Self-follow and self-endorse are blocked at write time, so the
      // natural KV lookups yield is_following=false and my_endorsements=[].
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile')
          return profileEntry('alice.near', AGENT_ALICE);
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
      expect(data.my_endorsements).toEqual([]);
    });

    it('falls back to unenriched profile when caller context lookup fails', async () => {
      // The profile read succeeds; the follow-edge lookup fails. With a
      // single kvGetAgent, split by key via mockImplementation.
      mockKvGetAgent.mockImplementation(async (accountId, key) => {
        if (accountId === 'alice.near' && key === 'profile')
          return profileEntry('alice.near', AGENT_ALICE);
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
    it('filters by tag', async () => {
      mockKvGetAll.mockResolvedValue([
        entry('alice.near', 'tag/ai', { score: 10 }),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('alice.near', AGENT_ALICE),
      ]);

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
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('alice.near', AGENT_ALICE),
      ]);

      const data = expectData(
        await dispatchFastData('list_agents', { capability: 'skills/testing' }),
      ) as Record<string, unknown>;
      expect((data.agents as unknown[]).length).toBe(1);
      // Verify kvGetAll was called with the capability key
      expect(mockKvGetAll).toHaveBeenCalledWith('cap/skills/testing');
    });

    it('keeps hidden agents in list_agents results without a hidden flag', async () => {
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
      // Admin has hidden bob — hiding is a presentation concern, not a data
      // one. The backend returns raw graph truth; no flag is stamped.
      mockKvListAgent.mockImplementation(async (id: string, prefix: string) => {
        if (id === 'admin.near' && prefix === 'hidden/')
          return [entry('admin.near', 'hidden/bob.near', { at: 1000 })];
        return [];
      });

      const data = expectData(
        await dispatchFastData('list_agents', { limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      const byId = Object.fromEntries(agents.map((a) => [a.account_id, a]));
      expect(byId['bob.near']).toBeDefined();
      expect(byId['bob.near'].hidden).toBeUndefined();
      expect(byId['alice.near'].hidden).toBeUndefined();
    });

    it('sorts by newest (block_timestamp of first profile write, descending)', async () => {
      // sort=newest is driven by `kvHistoryFirstByPredecessor` returning
      // the FIRST profile write's KvEntry per agent. The block_timestamp
      // on each entry determines ordering — NOT any caller-asserted
      // `created_at` field on the profile blob (those are stripped by
      // `foldProfile`). To prove the test isn't accidentally
      // passing through the bug we just fixed, the blob carries an
      // ANTI-CORRELATED `created_at` (alice's blob value is bigger than
      // bob's) but the history entries set bob's first write later than
      // alice's. The expected order follows the history, not the blob.
      const bob = { ...AGENT_ALICE, account_id: 'bob.near', created_at: 1 };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            entry('alice.near', 'profile', AGENT_ALICE),
            entry('bob.near', 'profile', bob),
          ];
        return [];
      });
      mockKvHistoryFirstByPredecessor.mockResolvedValue(
        new Map([
          [
            'alice.near',
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 100,
              block_timestamp: 1_700_000_000_000_000_000,
              key: 'profile',
              value: {},
            },
          ],
          [
            'bob.near',
            {
              predecessor_id: 'bob.near',
              current_account_id: 'contextual.near',
              block_height: 200,
              block_timestamp: 1_700_002_000_000_000_000,
              key: 'profile',
              value: {},
            },
          ],
        ]),
      );

      const data = expectData(
        await dispatchFastData('list_agents', { sort: 'newest', limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      // Bob's first write block_timestamp is later than Alice's, so bob
      // is newer — even though alice's BLOB has a larger caller-asserted
      // created_at. The trust boundary strips the blob value; the join
      // from kvHistoryFirstByPredecessor sets the block-derived value.
      expect(agents[0].account_id).toBe('bob.near');
      expect(agents[1].account_id).toBe('alice.near');
    });

    it('sorts by active (block_timestamp descending)', async () => {
      // `last_active` is overridden by the trust boundary with each entry's
      // block_timestamp, so the sort order is driven by the FastData-indexed
      // time of the profile write — not by whatever the caller claims in
      // the value blob. Stored `last_active` values below are intentionally
      // reversed from the block_timestamp ordering to verify the override.
      const bob = {
        ...AGENT_ALICE,
        account_id: 'bob.near',
        last_active: 1700001000, // lower than Alice's in the stored value
      };
      const alice = {
        ...AGENT_ALICE,
        last_active: 1700005000, // higher, but her block_timestamp is older
      };
      mockKvGetAll.mockReset();
      mockKvGetAll.mockImplementation(async (key: string) => {
        if (key === 'profile')
          return [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 100,
              block_timestamp: 1_700_001_000_000_000_000,
              key: 'profile',
              value: alice,
            },
            {
              predecessor_id: 'bob.near',
              current_account_id: 'contextual.near',
              block_height: 101,
              block_timestamp: 1_700_005_000_000_000_000,
              key: 'profile',
              value: bob,
            },
          ];
        return [];
      });

      const data = expectData(
        await dispatchFastData('list_agents', { sort: 'active', limit: 25 }),
      ) as Record<string, unknown>;
      const agents = data.agents as Record<string, unknown>[];
      expect(agents).toHaveLength(2);
      // Bob's block_timestamp (1_700_005_000 s) is newer than Alice's
      // (1_700_001_000 s), so Bob ranks first — independent of the
      // values in the stored profile blobs.
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
        profileEntry('bob.near', { ...AGENT_ALICE, account_id: 'bob.near' }),
        profileEntry('carol.near', {
          ...AGENT_ALICE,
          account_id: 'carol.near',
        }),
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

  describe('endorsing (handleGetEndorsing)', () => {
    const CALLER = 'alice.near';

    /**
     * Construct an `endorsing/{target}/{key_suffix}` entry written by
     * the CALLER (predecessor = alice.near). The shared `entry()`
     * helper hardcodes block_height to 100; for ordering tests that
     * need distinct heights, callers can override via Object.assign.
     */
    function endorsingEntry(
      target: string,
      keySuffix: string,
      value: Record<string, unknown> = {},
    ): fastdata.KvEntry {
      return entry(CALLER, `endorsing/${target}/${keySuffix}`, value);
    }

    type EndorsingEntry = {
      key_suffix: string;
      reason?: string;
      content_hash?: string;
      at: number;
      at_height: number;
    };
    type EndorsingGroup = {
      target: {
        account_id: string;
        name: string | null;
        description: string;
        image: string | null;
      };
      entries: EndorsingEntry[];
    };
    type EndorsingData = {
      account_id: string;
      endorsing: Record<string, EndorsingGroup>;
    };

    it('returns empty envelope when the caller has written no endorsements', async () => {
      mockKvListAgent.mockResolvedValue([]);

      const data = expectData(
        await dispatchFastData('endorsing', { account_id: CALLER }),
      ) as EndorsingData;

      expect(data.account_id).toBe(CALLER);
      expect(data.endorsing).toEqual({});
      // Scan is addressed to the caller's own predecessor namespace.
      expect(mockKvListAgent).toHaveBeenCalledWith(CALLER, 'endorsing/');
    });

    it('surfaces a single endorsement with one suffix', async () => {
      mockKvListAgent.mockResolvedValue([
        endorsingEntry('bob.near', 'skills/rust'),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('bob.near', {
          ...AGENT_ALICE,
          account_id: 'bob.near',
          name: 'Bob',
          description: 'agent bob',
        }),
      ]);

      const data = expectData(
        await dispatchFastData('endorsing', { account_id: CALLER }),
      ) as EndorsingData;

      expect(Object.keys(data.endorsing)).toEqual(['bob.near']);
      const group = data.endorsing['bob.near'];
      expect(group.target.account_id).toBe('bob.near');
      expect(group.target.name).toBe('Bob');
      expect(group.target.description).toBe('agent bob');
      expect(group.entries).toHaveLength(1);
      expect(group.entries[0].key_suffix).toBe('skills/rust');
    });

    it('groups multiple suffixes on the same target into one entry list', async () => {
      mockKvListAgent.mockResolvedValue([
        endorsingEntry('bob.near', 'skills/rust'),
        endorsingEntry('bob.near', 'skills/typescript'),
        endorsingEntry('bob.near', 'task_completion/job_42'),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('bob.near', { ...AGENT_ALICE, account_id: 'bob.near' }),
      ]);

      const data = expectData(
        await dispatchFastData('endorsing', { account_id: CALLER }),
      ) as EndorsingData;

      expect(Object.keys(data.endorsing)).toEqual(['bob.near']);
      const suffixes = data.endorsing['bob.near'].entries.map(
        (e) => e.key_suffix,
      );
      expect(suffixes).toEqual([
        'skills/rust',
        'skills/typescript',
        'task_completion/job_42',
      ]);
    });

    it('groups endorsements across multiple targets independently', async () => {
      mockKvListAgent.mockResolvedValue([
        endorsingEntry('bob.near', 'skills/rust'),
        endorsingEntry('carol.near', 'skills/audit'),
        endorsingEntry('bob.near', 'skills/typescript'),
        endorsingEntry('dave.near', 'verified/human'),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('bob.near', { ...AGENT_ALICE, account_id: 'bob.near' }),
        profileEntry('carol.near', {
          ...AGENT_ALICE,
          account_id: 'carol.near',
        }),
        profileEntry('dave.near', { ...AGENT_ALICE, account_id: 'dave.near' }),
      ]);

      const data = expectData(
        await dispatchFastData('endorsing', { account_id: CALLER }),
      ) as EndorsingData;

      const targetIds = Object.keys(data.endorsing).sort();
      expect(targetIds).toEqual(['bob.near', 'carol.near', 'dave.near']);
      expect(
        data.endorsing['bob.near'].entries.map((e) => e.key_suffix).sort(),
      ).toEqual(['skills/rust', 'skills/typescript']);
      expect(data.endorsing['carol.near'].entries).toHaveLength(1);
      expect(data.endorsing['dave.near'].entries).toHaveLength(1);
    });

    it('surfaces targets with no profile using a null-fielded summary', async () => {
      mockKvListAgent.mockResolvedValue([
        endorsingEntry('ghost.near', 'skills/rust'),
      ]);
      // No profile returned — ghost.near has never heartbeated.
      mockKvMultiAgent.mockResolvedValue([]);

      const data = expectData(
        await dispatchFastData('endorsing', { account_id: CALLER }),
      ) as EndorsingData;

      const group = data.endorsing['ghost.near'];
      expect(group.target).toEqual({
        account_id: 'ghost.near',
        name: null,
        description: '',
        image: null,
      });
      expect(group.entries).toHaveLength(1);
      expect(group.entries[0].key_suffix).toBe('skills/rust');
    });

    it('round-trips reason and content_hash from the stored value blob', async () => {
      mockKvListAgent.mockResolvedValue([
        endorsingEntry('bob.near', 'skills/rust', {
          reason: 'solid crate author',
          content_hash: 'sha256:abcdef',
        }),
        endorsingEntry('bob.near', 'skills/typescript', {
          reason: 'clean typing',
        }),
        endorsingEntry('bob.near', 'skills/audit'), // no reason / no hash
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('bob.near', { ...AGENT_ALICE, account_id: 'bob.near' }),
      ]);

      const data = expectData(
        await dispatchFastData('endorsing', { account_id: CALLER }),
      ) as EndorsingData;

      const entries = data.endorsing['bob.near'].entries;
      const rust = entries.find((e) => e.key_suffix === 'skills/rust')!;
      expect(rust.reason).toBe('solid crate author');
      expect(rust.content_hash).toBe('sha256:abcdef');
      const ts = entries.find((e) => e.key_suffix === 'skills/typescript')!;
      expect(ts.reason).toBe('clean typing');
      expect(ts.content_hash).toBeUndefined();
      const audit = entries.find((e) => e.key_suffix === 'skills/audit')!;
      expect(audit.reason).toBeUndefined();
      expect(audit.content_hash).toBeUndefined();
    });

    it('preserves scan order for entries inside a single target group', async () => {
      // `kvListAgent` returns entries in a defined order; the handler
      // must push them into the per-target entries array in that order
      // without re-sorting. Order matters for UI rendering and for any
      // consumer that cares about write sequence within a target.
      mockKvListAgent.mockResolvedValue([
        endorsingEntry('bob.near', 'skills/c'),
        endorsingEntry('bob.near', 'skills/a'),
        endorsingEntry('bob.near', 'skills/b'),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('bob.near', { ...AGENT_ALICE, account_id: 'bob.near' }),
      ]);

      const data = expectData(
        await dispatchFastData('endorsing', { account_id: CALLER }),
      ) as EndorsingData;

      expect(
        data.endorsing['bob.near'].entries.map((e) => e.key_suffix),
      ).toEqual(['skills/c', 'skills/a', 'skills/b']);
    });

    it('derives at and at_height from the entry block metadata, not the value blob', async () => {
      // Caller-asserted `at` / `at_height` in the value blob must be
      // ignored — block-authoritative times come from entry.block_*.
      // Same trust-boundary rule as `handleGetEndorsers`.
      mockKvListAgent.mockResolvedValue([
        endorsingEntry('bob.near', 'skills/rust', {
          // Lies the endorser might try to plant.
          at: 999999,
          at_height: 999999,
        }),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('bob.near', { ...AGENT_ALICE, account_id: 'bob.near' }),
      ]);

      const data = expectData(
        await dispatchFastData('endorsing', { account_id: CALLER }),
      ) as EndorsingData;

      const edge = data.endorsing['bob.near'].entries[0];
      // The fixture `entry()` helper sets block_height: 100 and
      // block_timestamp: FIXTURE_BLOCK_TS_NS. Validate both fields
      // come from there, not from the caller-asserted value blob.
      expect(typeof edge.at).toBe('number');
      expect(typeof edge.at_height).toBe('number');
      expect(edge.at_height).toBe(100);
      expect(edge.at).toBe(Math.floor(FIXTURE_BLOCK_TS_NS / 1e9));
      expect(edge.at).not.toBe(999999);
      expect(edge.at_height).not.toBe(999999);
    });

    it('drops entries with an empty key_suffix', async () => {
      // A bare `endorsing/bob.near/` with no suffix is garbage — the
      // server should not surface it. Same rule as `handleGetEndorsers`.
      mockKvListAgent.mockResolvedValue([
        entry(CALLER, 'endorsing/bob.near/', {}),
        endorsingEntry('bob.near', 'skills/rust'),
      ]);
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('bob.near', { ...AGENT_ALICE, account_id: 'bob.near' }),
      ]);

      const data = expectData(
        await dispatchFastData('endorsing', { account_id: CALLER }),
      ) as EndorsingData;

      const entries = data.endorsing['bob.near'].entries;
      expect(entries).toHaveLength(1);
      expect(entries[0].key_suffix).toBe('skills/rust');
    });

    it('returns an error envelope when account_id is missing from the body', async () => {
      const err = expectError(await dispatchFastData('endorsing', {}));
      expect(err).toContain('account_id');
      expect(mockKvListAgent).not.toHaveBeenCalled();
    });
  });

  describe('me', () => {
    it('returns profile with computed completeness', async () => {
      mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', AGENT_ALICE));

      const data = expectData(
        await dispatchFastData('me', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;
      expect((data.agent as Record<string, unknown>).account_id).toBe(
        'alice.near',
      );
      expect(data.profile_completeness).toBe(24); // description (20) + tags 2*2 (4); name, capabilities, image missing
    });
  });

  describe('discover_agents', () => {
    it('returns scored suggestions excluding self and followed', async () => {
      const bob = {
        ...AGENT_ALICE,
        account_id: 'bob.near',
        tags: ['ai'],
      };
      mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', AGENT_ALICE));
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

  describe('activity (handleGetActivity)', () => {
    /**
     * Build a follow-edge KvEntry with explicit block_height. The shared
     * `entry()` helper hardcodes block_height to 100, which is fine for the
     * rest of the suite but useless for cursor semantics — here we need to
     * distinguish entries by their block_height to verify that `cursor`
     * filtering compares on height, not seconds.
     */
    function followEdge(
      predecessorId: string,
      targetAccountId: string,
      blockHeight: number,
    ): fastdata.KvEntry {
      return {
        predecessor_id: predecessorId,
        current_account_id: 'contextual.near',
        block_height: blockHeight,
        block_timestamp: FIXTURE_BLOCK_TS_NS,
        key: `graph/follow/${targetAccountId}`,
        value: {},
      };
    }

    it('returns every inbound edge when the cursor is absent', async () => {
      mockKvGetAll.mockImplementation(async (key) => {
        if (key === 'graph/follow/alice.near') {
          return [
            followEdge('bob.near', 'alice.near', 100),
            followEdge('carol.near', 'alice.near', 200),
            followEdge('dave.near', 'alice.near', 300),
          ];
        }
        return [];
      });
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('bob.near', { ...AGENT_ALICE, account_id: 'bob.near' }),
        profileEntry('carol.near', {
          ...AGENT_ALICE,
          account_id: 'carol.near',
        }),
        profileEntry('dave.near', { ...AGENT_ALICE, account_id: 'dave.near' }),
      ]);

      const data = expectData(
        await dispatchFastData('activity', { account_id: 'alice.near' }),
      ) as Record<string, unknown>;

      const newFollowers = data.new_followers as { account_id: string }[];
      expect(newFollowers).toHaveLength(3);
      expect(data.cursor).toBe(300);
    });

    it('returns only edges strictly after the cursor block_height', async () => {
      mockKvGetAll.mockImplementation(async (key) => {
        if (key === 'graph/follow/alice.near') {
          return [
            followEdge('bob.near', 'alice.near', 100),
            followEdge('carol.near', 'alice.near', 200),
            followEdge('dave.near', 'alice.near', 300),
          ];
        }
        return [];
      });
      mockKvMultiAgent.mockResolvedValue([
        profileEntry('dave.near', { ...AGENT_ALICE, account_id: 'dave.near' }),
      ]);

      // Cursor = 200 (the previous response's max). The caller should
      // receive only the 300-height entry — strictly greater, not equal.
      // This is the core cursoring semantic: re-querying with the cursor
      // from the previous response is idempotent on state that hasn't
      // changed.
      const data = expectData(
        await dispatchFastData('activity', {
          account_id: 'alice.near',
          cursor: '200',
        }),
      ) as Record<string, unknown>;

      const newFollowers = data.new_followers as { account_id: string }[];
      expect(newFollowers).toHaveLength(1);
      expect(newFollowers[0].account_id).toBe('dave.near');
      expect(data.cursor).toBe(300);
    });

    it('echoes the input cursor when no new entries are returned', async () => {
      // Re-cursoring at the high-water mark on a stable graph: the caller
      // passes back 300 after receiving it in the previous response, and
      // nothing moves. The response should echo 300 back so the caller
      // can keep polling from the same position without losing state.
      mockKvGetAll.mockImplementation(async (key) => {
        if (key === 'graph/follow/alice.near') {
          return [
            followEdge('bob.near', 'alice.near', 100),
            followEdge('carol.near', 'alice.near', 200),
            followEdge('dave.near', 'alice.near', 300),
          ];
        }
        return [];
      });

      const data = expectData(
        await dispatchFastData('activity', {
          account_id: 'alice.near',
          cursor: '300',
        }),
      ) as Record<string, unknown>;

      expect(data.new_followers).toEqual([]);
      expect(data.new_following).toEqual([]);
      expect(data.cursor).toBe(300);
    });

    it('rejects a non-numeric cursor with a validation error', async () => {
      const err = expectError(
        await dispatchFastData('activity', {
          account_id: 'alice.near',
          cursor: 'garbage',
        }),
      );
      expect(err).toContain('cursor');
    });

    it('rejects a negative cursor with a validation error', async () => {
      const err = expectError(
        await dispatchFastData('activity', {
          account_id: 'alice.near',
          cursor: '-1',
        }),
      );
      expect(err).toContain('cursor');
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
