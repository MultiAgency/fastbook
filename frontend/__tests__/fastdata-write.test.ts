/**
 * @jest-environment node
 */

import * as fastdata from '@/lib/fastdata';
import {
  handleDeregister,
  handleEndorse,
  handleFollow,
  handleHeartbeat,
  handleUnendorse,
  handleUnfollow,
  handleUpdateMe,
} from '@/lib/fastdata-write';
import * as fetchLib from '@/lib/fetch';
import * as rateLimit from '@/lib/rate-limit';
import type { Agent } from '@/types';

jest.mock('@/lib/fastdata');
jest.mock('@/lib/fetch');
jest.mock('@/lib/rate-limit');

const mockKvGetAgent = fastdata.kvGetAgent as jest.MockedFunction<
  typeof fastdata.kvGetAgent
>;
const mockKvMultiAgent = fastdata.kvMultiAgent as jest.MockedFunction<
  typeof fastdata.kvMultiAgent
>;
const mockFetchWithTimeout = fetchLib.fetchWithTimeout as jest.MockedFunction<
  typeof fetchLib.fetchWithTimeout
>;
const mockCheckRateLimit = rateLimit.checkRateLimit as jest.MockedFunction<
  typeof rateLimit.checkRateLimit
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

function mockAgent(handle: string): Agent {
  return {
    handle,
    description: 'Test agent',
    avatar_url: null,
    tags: ['test'],
    capabilities: {},
    endorsements: {},
    platforms: [],
    near_account_id: `${handle}.near`,
    follower_count: 0,
    following_count: 0,
    created_at: 1000,
    last_active: 2000,
  };
}

const WK = 'wk_testkey';
const resolveAccountId = jest.fn().mockResolvedValue('alice.near');

/** Set up mocks so resolveCaller succeeds for the given handle. */
function setupCaller(handle: string) {
  resolveAccountId.mockResolvedValue(`${handle}.near`);
  mockKvGetAgent.mockImplementation(async (_accountId: string, key: string) => {
    if (key === 'profile') return mockAgent(handle);
    return null;
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  resolveAccountId.mockResolvedValue('alice.near');
  mockCheckRateLimit.mockReturnValue({ ok: true });
  (rateLimit.checkRateLimitBudget as jest.Mock).mockReturnValue({
    ok: true,
    remaining: 20,
    retryAfter: 0,
  });
  (rateLimit.incrementRateLimit as jest.Mock).mockImplementation(() => {});
  // Default: writeToFastData succeeds
  mockFetchWithTimeout.mockResolvedValue({ ok: true } as Response);
});

// ---------------------------------------------------------------------------
// (a) Self-action prevention
// ---------------------------------------------------------------------------

describe('self-action prevention', () => {
  beforeEach(() => {
    setupCaller('alice');
  });

  it('handleFollow returns SELF_FOLLOW when target matches caller', async () => {
    const result = await handleFollow(
      WK,
      'alice.near',
      undefined,
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: false, code: 'SELF_FOLLOW' });
  });

  it('handleUnfollow returns SELF_UNFOLLOW when target matches caller', async () => {
    const result = await handleUnfollow(WK, 'alice.near', resolveAccountId);
    expect(result).toMatchObject({ success: false, code: 'SELF_UNFOLLOW' });
  });

  it('handleEndorse returns SELF_ENDORSE when target matches caller', async () => {
    const result = await handleEndorse(
      WK,
      'alice.near',
      ['test'],
      undefined,
      undefined,
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: false, code: 'SELF_ENDORSE' });
  });

  it('handleUnendorse returns SELF_UNENDORSE when target matches caller', async () => {
    const result = await handleUnendorse(
      WK,
      'alice.near',
      ['test'],
      undefined,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: false,
      code: 'SELF_UNENDORSE',
    });
  });
});

// ---------------------------------------------------------------------------
// (b) Idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  beforeEach(() => {
    setupCaller('alice');
  });

  it('handleFollow returns already_following when edge exists', async () => {
    // After resolveCaller, subsequent kvGetAgent calls check existing edge
    const originalImpl = mockKvGetAgent.getMockImplementation()!;
    mockKvGetAgent.mockImplementation(
      async (accountId: string, key: string) => {
        if (key === 'graph/follow/bob.near') return { at: 1000 };
        if (key === 'profile' && accountId === 'bob.near')
          return mockAgent('bob');
        return originalImpl(accountId, key);
      },
    );

    const result = await handleFollow(
      WK,
      'bob.near',
      undefined,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: { action: 'already_following' },
    });
  });

  it('handleUnfollow returns not_following when edge does not exist', async () => {
    // kvGetAgent for graph/follow/bob.near returns null (default from setupCaller)
    const result = await handleUnfollow(WK, 'bob.near', resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: { action: 'not_following' },
    });
  });

  it('handleEndorse returns already_endorsed map when all items exist', async () => {
    const bobAgent = mockAgent('bob');
    bobAgent.tags = ['ai'];

    const originalImpl = mockKvGetAgent.getMockImplementation()!;
    mockKvGetAgent.mockImplementation(
      async (accountId: string, key: string) => {
        if (key === 'profile' && accountId === 'bob.near') return bobAgent;
        return originalImpl(accountId, key);
      },
    );

    // All endorsement keys already exist
    mockKvMultiAgent.mockResolvedValue([{ at: 1000 }]);

    const result = await handleEndorse(
      WK,
      'bob.near',
      ['ai'],
      undefined,
      undefined,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        action: 'endorsed',
        endorsed: {},
        already_endorsed: { tags: ['ai'] },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// (c) Storage error handling
// ---------------------------------------------------------------------------

describe('storage error handling', () => {
  beforeEach(() => {
    setupCaller('alice');
  });

  it('handleFollow returns STORAGE_ERROR when writeToFastData fails', async () => {
    // Make target profile lookup succeed, then writeToFastData fails
    const originalImpl = mockKvGetAgent.getMockImplementation()!;
    mockKvGetAgent.mockImplementation(
      async (accountId: string, key: string) => {
        if (key === 'profile' && accountId === 'bob.near')
          return mockAgent('bob');
        return originalImpl(accountId, key);
      },
    );
    mockFetchWithTimeout.mockResolvedValue({ ok: false } as Response);

    const result = await handleFollow(
      WK,
      'bob.near',
      undefined,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: false,
      code: 'STORAGE_ERROR',
      status: 500,
    });
  });

  it('handleFollow returns STORAGE_ERROR when fetchWithTimeout throws', async () => {
    const originalImpl = mockKvGetAgent.getMockImplementation()!;
    mockKvGetAgent.mockImplementation(
      async (accountId: string, key: string) => {
        if (key === 'profile' && accountId === 'bob.near')
          return mockAgent('bob');
        return originalImpl(accountId, key);
      },
    );
    mockFetchWithTimeout.mockRejectedValue(new Error('network error'));

    const result = await handleFollow(
      WK,
      'bob.near',
      undefined,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: false,
      code: 'STORAGE_ERROR',
      status: 500,
    });
  });

  it('handleUpdateMe returns STORAGE_ERROR when writeToFastData fails', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false } as Response);

    const result = await handleUpdateMe(
      WK,
      { description: 'Updated description for testing' },
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: false,
      code: 'STORAGE_ERROR',
      status: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// (d) Bootstrap heartbeat (register → fund → first heartbeat seeds FastData)
// ---------------------------------------------------------------------------

describe('first-write heartbeat', () => {
  it('creates default profile and completes heartbeat when no profile exists', async () => {
    resolveAccountId.mockResolvedValue('alice.near');
    mockKvGetAgent.mockResolvedValue(null);
    mockFetchWithTimeout.mockResolvedValue({ ok: true } as Response);
    mockKvGetAll.mockResolvedValue([]);
    mockKvListAgent.mockResolvedValue([]);
    mockKvListAll.mockResolvedValue([]);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: {
        agent: expect.objectContaining({ near_account_id: 'alice.near' }),
        delta: expect.objectContaining({
          profile_completeness: expect.any(Number),
        }),
      },
    });

    // Verify FastData was written
    expect(mockFetchWithTimeout).toHaveBeenCalled();
  });

  it('returns AUTH_FAILED when account resolution fails', async () => {
    resolveAccountId.mockResolvedValue(null);
    mockKvGetAgent.mockResolvedValue(null);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({ success: false, code: 'AUTH_FAILED' });
  });

  it('returns WALLET_UNFUNDED when FastData write fails', async () => {
    resolveAccountId.mockResolvedValue('alice.near');
    mockKvGetAgent.mockResolvedValue(null);
    mockFetchWithTimeout.mockResolvedValue({ ok: false } as Response);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: false,
      code: 'WALLET_UNFUNDED',
      status: 402,
    });
  });
});

// ---------------------------------------------------------------------------
// (e) Heartbeat delta population
// ---------------------------------------------------------------------------

function kvEntry(overrides: {
  predecessor_id?: string;
  key: string;
  value: unknown;
}) {
  return {
    predecessor_id: overrides.predecessor_id ?? 'test.near',
    current_account_id: 'contextual.near',
    block_height: 100000,
    block_timestamp: 1700000000000000000,
    key: overrides.key,
    value: overrides.value,
  };
}

describe('heartbeat delta', () => {
  beforeEach(() => {
    setupCaller('alice');
  });

  it('populates new_followers from follower entries since last_active', async () => {
    const bobAgent = mockAgent('bob');

    // Follower entries: bob followed after last_active (2000), charlie before
    mockKvGetAll.mockResolvedValue([
      kvEntry({
        predecessor_id: 'bob.near',
        key: 'graph/follow/alice',
        value: { at: 2500 },
      }),
      kvEntry({
        predecessor_id: 'charlie.near',
        key: 'graph/follow/alice',
        value: { at: 1500 },
      }),
    ]);
    mockKvListAgent.mockResolvedValue([]);
    mockKvListAll.mockResolvedValue([]);

    // kvMultiAgent: batch-fetch profiles for new follower summaries
    mockKvMultiAgent.mockResolvedValue([bobAgent]);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: {
        delta: {
          since: 2000,
          new_followers: [expect.objectContaining({ handle: 'bob' })],
          new_followers_count: 1,
          new_following_count: 0,
        },
      },
    });
  });

  it('returns empty new_followers when no followers since last_active', async () => {
    mockKvGetAll.mockResolvedValue([
      kvEntry({
        predecessor_id: 'bob.near',
        key: 'graph/follow/alice',
        value: { at: 1000 },
      }),
    ]);
    mockKvListAgent.mockResolvedValue([]);
    mockKvListAll.mockResolvedValue([]);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: {
        delta: {
          new_followers: [],
          new_followers_count: 0,
        },
      },
    });
  });

  it('counts new_following_count from follow entries since last_active', async () => {
    mockKvGetAll.mockResolvedValue([]);
    mockKvListAgent.mockResolvedValue([
      kvEntry({ key: 'graph/follow/bob', value: { at: 2500 } }),
      kvEntry({ key: 'graph/follow/charlie', value: { at: 1500 } }),
    ]);
    mockKvListAll.mockResolvedValue([]);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: {
        delta: {
          new_following_count: 1,
        },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// (f) Deregister
// ---------------------------------------------------------------------------

describe('deregister', () => {
  beforeEach(() => {
    setupCaller('alice');
  });

  it('null-writes agent keys, follow edges, endorsement edges, and capability keys', async () => {
    // Give alice capabilities so cap/* keys exist
    const originalImpl = mockKvGetAgent.getMockImplementation()!;
    mockKvGetAgent.mockImplementation(
      async (accountId: string, key: string) => {
        if (key === 'profile') {
          const agent = mockAgent('alice');
          agent.capabilities = { skills: ['testing'] };
          return agent;
        }
        return originalImpl(accountId, key);
      },
    );

    // Agent has follow and endorsement edges
    mockKvListAgent.mockImplementation(
      async (_accountId: string, prefix: string) => {
        if (prefix === 'graph/follow/') {
          return [
            kvEntry({ key: 'graph/follow/bob', value: { at: 1000 } }),
            kvEntry({ key: 'graph/follow/charlie', value: { at: 1500 } }),
          ];
        }
        if (prefix === 'endorsing/') {
          return [
            kvEntry({ key: 'endorsing/bob/tags/ai', value: { at: 1000 } }),
          ];
        }
        return [];
      },
    );

    const result = await handleDeregister(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: { action: 'deregistered', account_id: 'alice.near' },
    });

    // Verify the write payload includes null-writes for edges
    const writeCall = mockFetchWithTimeout.mock.calls[0];
    const body = JSON.parse(writeCall[1]!.body as string);
    const args = body.args;
    expect(args.profile).toBeNull();
    expect(args['graph/follow/bob']).toBeNull();
    expect(args['graph/follow/charlie']).toBeNull();
    expect(args['endorsing/bob/tags/ai']).toBeNull();
    expect(args['tag/test']).toBeNull();
    expect(args['cap/skills/testing']).toBeNull();
  });

  it('returns STORAGE_ERROR when write fails', async () => {
    mockKvListAgent.mockResolvedValue([]);
    mockFetchWithTimeout.mockResolvedValue({ ok: false } as Response);

    const result = await handleDeregister(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: false,
      code: 'STORAGE_ERROR',
      status: 500,
    });
  });

  it('respects rate limit', async () => {
    mockCheckRateLimit.mockReturnValue({ ok: false, retryAfter: 60 });

    const result = await handleDeregister(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: false,
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: 60,
    });
  });
});
