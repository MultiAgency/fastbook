/**
 * @jest-environment node
 */

import * as fastdata from '@/lib/fastdata';
import {
  dispatchWrite,
  handleDelistMe,
  handleEndorse,
  handleFollow,
  handleHeartbeat,
  handleUnendorse,
  handleUnfollow,
  handleUpdateMe,
  writeToFastData,
} from '@/lib/fastdata-write';
import * as fetchLib from '@/lib/fetch';
import * as rateLimit from '@/lib/rate-limit';
import { mockAgent } from './fixtures';

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

const WK = 'wk_testkey';
const resolveAccountId = jest.fn();

/** Layer a profile for a specific account on top of the current mock. */
function mockProfile(
  accountId: string,
  overrides?: Partial<ReturnType<typeof mockAgent>>,
) {
  const prev = mockKvGetAgent.getMockImplementation()!;
  mockKvGetAgent.mockImplementation(async (id: string, key: string) => {
    if (key === 'profile' && id === accountId)
      return { ...mockAgent(accountId), ...overrides };
    return prev(id, key);
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  resolveAccountId.mockResolvedValue('alice.near');
  // Default: caller profile exists, nothing else
  mockKvGetAgent.mockImplementation(async (id: string, key: string) => {
    if (key === 'profile' && id === 'alice.near')
      return mockAgent('alice.near');
    return null;
  });
  mockCheckRateLimit.mockReturnValue({ ok: true });
  (rateLimit.checkRateLimitBudget as jest.Mock).mockReturnValue({
    ok: true,
    remaining: 20,
    retryAfter: 0,
  });
  (rateLimit.incrementRateLimit as jest.Mock).mockImplementation(() => {});
  mockKvGetAll.mockResolvedValue([]);
  mockKvListAgent.mockResolvedValue([]);
  mockFetchWithTimeout.mockResolvedValue({ ok: true } as Response);
});

// ---------------------------------------------------------------------------
// writeToFastData — direct unit coverage for the WriteOutcome contract.
// Handler tests only assert on the handler-level response code, so the
// shape distinctions (status, detail, network vs HTTP) are covered here.
// ---------------------------------------------------------------------------

describe('writeToFastData', () => {
  it('returns {ok: true} on a 2xx response', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const outcome = await writeToFastData(WK, { profile: { name: 'x' } });
    expect(outcome).toEqual({ ok: true });
  });

  it('returns {ok: false, status} on a non-2xx response', async () => {
    // Detail is read for the log line but intentionally not exposed on
    // the WriteOutcome — callers classify by status alone (see the
    // `status === 402` check in resolveCallerOrInit).
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 402,
      text: () => Promise.resolve('insufficient balance to cover storage'),
    } as unknown as Response);

    const outcome = await writeToFastData(WK, { profile: { name: 'x' } });
    expect(outcome).toEqual({ ok: false, status: 402 });
  });

  it('returns {ok: false, status: null} on a network error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('ECONNRESET'));

    const outcome = await writeToFastData(WK, { profile: { name: 'x' } });
    expect(outcome).toEqual({ ok: false, status: null });
  });

  it('stays on the HTTP-error branch when res.text() itself rejects', async () => {
    // Defensive `.catch(() => '')` on `res.text()` matters: without it,
    // an aborted response body would throw from the await, fall through
    // to the outer catch, and flip the classification from HTTP-error
    // (status present) to network-error (status null).
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('aborted')),
    } as unknown as Response);

    const outcome = await writeToFastData(WK, { profile: { name: 'x' } });
    expect(outcome).toEqual({ ok: false, status: 500 });
  });
});

// ---------------------------------------------------------------------------
// (a) Self-action prevention
// ---------------------------------------------------------------------------

describe('self-action prevention', () => {
  it('handleFollow rejects self-follow', async () => {
    const result = await handleFollow(
      WK,
      { targets: ['alice.near'] },
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          { account_id: 'alice.near', action: 'error', code: 'SELF_FOLLOW' },
        ],
      },
    });
  });

  it('handleUnfollow rejects self-unfollow', async () => {
    const result = await handleUnfollow(
      WK,
      { targets: ['alice.near'] },
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          { account_id: 'alice.near', action: 'error', code: 'SELF_UNFOLLOW' },
        ],
      },
    });
  });

  it('handleEndorse rejects self-endorse', async () => {
    const result = await handleEndorse(
      WK,
      { targets: ['alice.near'], tags: ['test'] },
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          { account_id: 'alice.near', action: 'error', code: 'SELF_ENDORSE' },
        ],
      },
    });
  });

  it('handleUnendorse rejects self-unendorse', async () => {
    const result = await handleUnendorse(
      WK,
      { targets: ['alice.near'], tags: ['test'] },
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          { account_id: 'alice.near', action: 'error', code: 'SELF_UNENDORSE' },
        ],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// (b) Idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('handleFollow returns already_following when edge exists', async () => {
    mockProfile('bob.near');
    const prev = mockKvGetAgent.getMockImplementation()!;
    mockKvGetAgent.mockImplementation(async (id: string, key: string) => {
      if (key === 'graph/follow/bob.near') return { at: 1000 };
      return prev(id, key);
    });

    const result = await handleFollow(
      WK,
      { targets: ['bob.near'] },
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [{ account_id: 'bob.near', action: 'already_following' }],
      },
    });
  });

  it('handleEndorse returns already_endorsed when all items exist', async () => {
    mockProfile('bob.near', { tags: ['ai'] });
    mockKvMultiAgent.mockResolvedValue([{ at: 1000 }]);

    const result = await handleEndorse(
      WK,
      { targets: ['bob.near'], tags: ['ai'] },
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [{ account_id: 'bob.near', action: 'endorsed', endorsed: {} }],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// (c) Storage error handling
// ---------------------------------------------------------------------------

describe('storage error handling', () => {
  it('handleFollow returns storage error per-item when writeToFastData fails', async () => {
    mockProfile('bob.near');
    // Mock must include `status` and `text` so writeToFastData enters
    // the HTTP-error branch (non-ok Response) rather than the outer
    // catch (network error). Otherwise the test silently exercises
    // network-error classification instead of the intended HTTP-error
    // path.
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    } as unknown as Response);

    const result = await handleFollow(
      WK,
      { targets: ['bob.near'] },
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          { account_id: 'bob.near', action: 'error', code: 'STORAGE_ERROR' },
        ],
      },
    });
  });

  it('handleUpdateMe returns STORAGE_ERROR when writeToFastData fails', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    } as unknown as Response);

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
// handleUpdateMe index cleanup — removed tags/capabilities must null-write
// their existence indexes or list_tags/list_capabilities ghost them forever.
// ---------------------------------------------------------------------------

describe('handleUpdateMe index cleanup', () => {
  function writeArgs(): Record<string, unknown> {
    const writeCall = mockFetchWithTimeout.mock.calls[0];
    const body = JSON.parse(writeCall[1]!.body as string);
    return body.args as Record<string, unknown>;
  }

  it('nulls removed tag indexes and keeps retained ones', async () => {
    mockProfile('alice.near', { tags: ['ai', 'defi'] });

    const result = await handleUpdateMe(
      WK,
      { tags: ['defi'] },
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: true });

    const args = writeArgs();
    expect(args['tag/ai']).toBeNull();
    expect(args['tag/defi']).toBe(true);
  });

  it('nulls removed capability indexes and keeps retained ones', async () => {
    mockProfile('alice.near', {
      capabilities: { skills: ['rust', 'go'] },
    });

    const result = await handleUpdateMe(
      WK,
      { capabilities: { skills: ['rust'] } },
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: true });

    const args = writeArgs();
    expect(args['cap/skills/go']).toBeNull();
    expect(args['cap/skills/rust']).toBe(true);
  });

  it('does not delete indexes when the field is not in the update', async () => {
    mockProfile('alice.near', {
      tags: ['ai'],
      capabilities: { skills: ['rust'] },
    });

    const result = await handleUpdateMe(
      WK,
      { description: 'Updated bio that is long enough' },
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: true });

    const args = writeArgs();
    // agentEntries rewrites the existence indexes as `true`; the cleanup
    // blocks only emit `null` when body.tags / body.capabilities is present.
    expect(args['tag/ai']).toBe(true);
    expect(args['cap/skills/rust']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (d) Bootstrap heartbeat
// ---------------------------------------------------------------------------

describe('first-write heartbeat', () => {
  it('creates default profile when no profile exists', async () => {
    mockKvGetAgent.mockResolvedValue(null);
    mockKvListAll.mockResolvedValue([]);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: {
        agent: expect.objectContaining({ account_id: 'alice.near' }),
        delta: expect.objectContaining({
          profile_completeness: expect.any(Number),
        }),
      },
    });
    expect(mockFetchWithTimeout).toHaveBeenCalled();
  });

  it('returns AUTH_FAILED when account resolution fails', async () => {
    resolveAccountId.mockResolvedValue(null);
    mockKvGetAgent.mockResolvedValue(null);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({ success: false, code: 'AUTH_FAILED' });
  });

  it('returns INSUFFICIENT_BALANCE with funding meta when wallet has no balance', async () => {
    mockKvGetAgent.mockResolvedValue(null);
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 402,
      text: () => Promise.resolve('insufficient balance to cover storage'),
    } as unknown as Response);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: false,
      code: 'INSUFFICIENT_BALANCE',
      status: 402,
      meta: {
        wallet_address: 'alice.near',
        fund_amount: expect.any(String),
        fund_token: 'NEAR',
        fund_url: expect.stringContaining('alice.near'),
      },
    });
  });

  it('returns STORAGE_ERROR (not INSUFFICIENT_BALANCE) on transient write failure', async () => {
    mockKvGetAgent.mockResolvedValue(null);
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.resolve('bad gateway'),
    } as unknown as Response);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: false,
      code: 'STORAGE_ERROR',
      status: 500,
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
    block_timestamp: 1_700_000_000_000,
    key: overrides.key,
    value: overrides.value,
  };
}

describe('heartbeat delta', () => {
  it('populates new_followers from follower entries since last_active', async () => {
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
    mockKvListAll.mockResolvedValue([]);
    mockKvMultiAgent.mockResolvedValue([mockAgent('bob.near')]);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: {
        delta: {
          since: 2000,
          new_followers: [expect.objectContaining({ account_id: 'bob.near' })],
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
    mockKvListAll.mockResolvedValue([]);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: { delta: { new_followers: [], new_followers_count: 0 } },
    });
  });

  it('counts new_following_count from follow entries since last_active', async () => {
    mockKvListAgent.mockResolvedValue([
      kvEntry({ key: 'graph/follow/bob', value: { at: 2500 } }),
      kvEntry({ key: 'graph/follow/charlie', value: { at: 1500 } }),
    ]);
    mockKvListAll.mockResolvedValue([]);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: { delta: { new_following_count: 1 } },
    });
  });
});

// ---------------------------------------------------------------------------
// (f) Delist Me
// ---------------------------------------------------------------------------

describe('delist_me', () => {
  it('null-writes agent keys, follow edges, endorsement edges, and capability keys', async () => {
    mockKvGetAgent.mockImplementation(async (id: string, key: string) => {
      if (key === 'profile' && id === 'alice.near') {
        return {
          ...mockAgent('alice.near'),
          capabilities: { skills: ['testing'] },
        };
      }
      return null;
    });

    mockKvListAgent.mockImplementation(async (_id: string, prefix: string) => {
      if (prefix === 'graph/follow/') {
        return [
          kvEntry({ key: 'graph/follow/bob', value: { at: 1000 } }),
          kvEntry({ key: 'graph/follow/charlie', value: { at: 1500 } }),
        ];
      }
      if (prefix === 'endorsing/') {
        return [kvEntry({ key: 'endorsing/bob/tags/ai', value: { at: 1000 } })];
      }
      return [];
    });

    const result = await handleDelistMe(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: { action: 'delisted', account_id: 'alice.near' },
    });

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

    const result = await handleDelistMe(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: false,
      code: 'STORAGE_ERROR',
      status: 500,
    });
  });

  it('respects rate limit', async () => {
    mockCheckRateLimit.mockReturnValue({ ok: false, retryAfter: 60 });

    const result = await handleDelistMe(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: false,
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: 60,
    });
  });
});

// ---------------------------------------------------------------------------
// (g) Multi-follow (batch)
// ---------------------------------------------------------------------------

describe('handleFollow batch (via dispatchWrite)', () => {
  it('rejects empty targets', async () => {
    const result = await dispatchWrite(
      'follow',
      { targets: [] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
  });

  it('rejects targets exceeding max batch size', async () => {
    const targets = Array.from({ length: 21 }, (_, i) => `agent${i}.near`);
    const result = await dispatchWrite(
      'follow',
      { targets },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
  });

  it('follows multiple valid targets', async () => {
    mockProfile('bob.near');
    mockProfile('charlie.near');

    const result = await dispatchWrite(
      'follow',
      { targets: ['bob.near', 'charlie.near'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          { account_id: 'bob.near', action: 'followed' },
          { account_id: 'charlie.near', action: 'followed' },
        ],
        your_network: { following_count: 2 },
      },
    });
  });

  it('skips self-follow with per-item error', async () => {
    mockProfile('bob.near');

    const result = await dispatchWrite(
      'follow',
      { targets: ['alice.near', 'bob.near'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          {
            account_id: 'alice.near',
            action: 'error',
            error: expect.stringContaining('yourself'),
          },
          { account_id: 'bob.near', action: 'followed' },
        ],
      },
    });
  });

  it('skips targets with no profile', async () => {
    const result = await dispatchWrite(
      'follow',
      { targets: ['nobody.near'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          {
            account_id: 'nobody.near',
            action: 'error',
            error: expect.stringContaining('not found'),
          },
        ],
      },
    });
  });

  it('stops when rate limit budget exhausted mid-batch', async () => {
    (rateLimit.checkRateLimitBudget as jest.Mock).mockReturnValue({
      ok: true,
      remaining: 1,
      retryAfter: 0,
    });
    mockProfile('bob.near');
    mockProfile('charlie.near');

    const result = await dispatchWrite(
      'follow',
      { targets: ['bob.near', 'charlie.near'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          { account_id: 'bob.near', action: 'followed' },
          {
            account_id: 'charlie.near',
            action: 'error',
            error: expect.stringContaining('rate limit'),
          },
        ],
      },
    });
  });

  it('reports storage error per-item when write fails', async () => {
    mockProfile('bob.near');
    mockFetchWithTimeout.mockResolvedValue({ ok: false } as Response);

    const result = await dispatchWrite(
      'follow',
      { targets: ['bob.near'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          { account_id: 'bob.near', action: 'error', error: 'storage error' },
        ],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// (h) Multi-endorse (batch)
// ---------------------------------------------------------------------------

describe('handleEndorse batch (via dispatchWrite)', () => {
  it('rejects empty targets', async () => {
    const result = await dispatchWrite(
      'endorse',
      { targets: [], tags: ['ai'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
  });

  it('rejects when neither tags nor capabilities provided', async () => {
    const result = await dispatchWrite(
      'endorse',
      { targets: ['bob.near'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
  });

  it('endorses multiple targets on shared tags', async () => {
    mockProfile('bob.near', { tags: ['ai', 'defi'] });
    mockProfile('charlie.near', { tags: ['ai', 'defi'] });
    mockKvMultiAgent.mockResolvedValue([null]);

    const result = await dispatchWrite(
      'endorse',
      { targets: ['bob.near', 'charlie.near'], tags: ['ai'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          {
            account_id: 'bob.near',
            action: 'endorsed',
            endorsed: { tags: ['ai'] },
          },
          {
            account_id: 'charlie.near',
            action: 'endorsed',
            endorsed: { tags: ['ai'] },
          },
        ],
      },
    });
  });

  it('skips self-endorse with per-item error', async () => {
    const result = await dispatchWrite(
      'endorse',
      { targets: ['alice.near'], tags: ['ai'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          {
            account_id: 'alice.near',
            action: 'error',
            error: expect.stringContaining('yourself'),
          },
        ],
      },
    });
  });

  it('reports no endorsable items match', async () => {
    mockProfile('bob.near', { tags: ['defi'] });

    const result = await dispatchWrite(
      'endorse',
      { targets: ['bob.near'], tags: ['nonexistent'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          {
            account_id: 'bob.near',
            action: 'error',
            error: 'no endorsable items match',
            available: expect.arrayContaining(['tags:defi']),
          },
        ],
      },
    });
  });

  it('includes skipped items for tags not found on target', async () => {
    mockProfile('bob.near', { tags: ['ai'] });
    mockKvMultiAgent.mockResolvedValue([null]);

    const result = await dispatchWrite(
      'endorse',
      { targets: ['bob.near'], tags: ['ai', 'nonexistent'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          {
            account_id: 'bob.near',
            action: 'endorsed',
            endorsed: { tags: ['ai'] },
            skipped: [{ value: 'nonexistent', reason: 'not_found' }],
          },
        ],
      },
    });
  });
});
