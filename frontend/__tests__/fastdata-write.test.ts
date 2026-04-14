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

/**
 * Wrap a profile value as a KvEntry so fetchProfile's trust-boundary
 * override (last_active := block_timestamp / 1e9) produces a value that
 * matches mockAgent's default `last_active: 2000`. That keeps the
 * existing delta-test epoch (edges written "since" a 2000-second caller)
 * working without rescaling every fixture: 2000s × 1e9 = 2e12 ns.
 */
function profileEntry(
  accountId: string,
  value: unknown,
  blockSecs = 2000,
): fastdata.KvEntry {
  return {
    predecessor_id: accountId,
    current_account_id: 'contextual.near',
    block_height: 100,
    block_timestamp: blockSecs * 1_000_000_000,
    key: 'profile',
    value,
  };
}
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
      return profileEntry(accountId, {
        ...mockAgent(accountId),
        ...overrides,
      });
    return prev(id, key);
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  resolveAccountId.mockResolvedValue('alice.near');
  // Default: caller profile exists, every other key is missing. A single
  // kvGetAgent mock handles both profile lookups (returning a KvEntry) and
  // edge-existence lookups (returning null for unset keys).
  mockKvGetAgent.mockImplementation(async (id: string, key: string) => {
    if (key === 'profile' && id === 'alice.near')
      return profileEntry('alice.near', mockAgent('alice.near'));
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
  mockKvListAll.mockResolvedValue([]);
  mockKvMultiAgent.mockResolvedValue([]);
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

  it('classifies an explicit 402 as insufficient_balance', async () => {
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 402,
      text: () => Promise.resolve('insufficient balance to cover storage'),
    } as unknown as Response);

    const outcome = await writeToFastData(WK, { profile: { name: 'x' } });
    expect(outcome).toEqual({ ok: false, reason: 'insufficient_balance' });
  });

  it('classifies a network error as storage_error', async () => {
    mockFetchWithTimeout.mockRejectedValue(new Error('ECONNRESET'));

    const outcome = await writeToFastData(WK, { profile: { name: 'x' } });
    expect(outcome).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('coerces 502 to insufficient_balance when the wallet is unfunded', async () => {
    // OutLayer returns 502 for writes on zero-balance wallets (verified
    // 2026-04-13). writeToFastData disambiguates by probing /balance and
    // folds into the same insufficient_balance reason.
    mockFetchWithTimeout
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.resolve('cloudflare error code: 502'),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ balance: '0', account_id: 'alice.near' }),
      } as unknown as Response);

    const outcome = await writeToFastData(WK, { profile: { name: 'x' } });
    expect(outcome).toEqual({ ok: false, reason: 'insufficient_balance' });
  });

  it('leaves 502 as storage_error when the wallet has a non-zero balance', async () => {
    // Genuine upstream outage on a funded wallet must not be misclassified
    // as unfunded — callers retry instead of prompting for funding.
    mockFetchWithTimeout
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.resolve('cloudflare error code: 502'),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            balance: '10000000000000000000000',
            account_id: 'alice.near',
          }),
      } as unknown as Response);

    const outcome = await writeToFastData(WK, { profile: { name: 'x' } });
    expect(outcome).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('leaves 502 as storage_error when the balance probe itself fails', async () => {
    // If the balance endpoint is also down we have no way to disambiguate;
    // never guess unfunded in that case.
    mockFetchWithTimeout
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: () => Promise.resolve('cloudflare error code: 502'),
      } as unknown as Response)
      .mockRejectedValueOnce(new Error('balance endpoint timeout'));

    const outcome = await writeToFastData(WK, { profile: { name: 'x' } });
    expect(outcome).toEqual({ ok: false, reason: 'storage_error' });
  });

  it('stays on the HTTP-error branch when res.text() itself rejects', async () => {
    // Defensive `.catch(() => '')` on `res.text()` matters: without it,
    // an aborted response body would throw from the await, fall through
    // to the outer catch, and still end up at storage_error — but via
    // the network-error path instead of the HTTP-error path.
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('aborted')),
    } as unknown as Response);

    const outcome = await writeToFastData(WK, { profile: { name: 'x' } });
    expect(outcome).toEqual({ ok: false, reason: 'storage_error' });
  });
});

// ---------------------------------------------------------------------------
// (a0) No-profile caller can mutate (gate dropped — regression guard)
// ---------------------------------------------------------------------------

describe('no-profile caller (gate dropped)', () => {
  it('handleFollow succeeds when the caller has no profile blob', async () => {
    // Caller alice.near has no profile; target bob.near does.
    mockKvGetAgent.mockImplementation(async (id: string, key: string) => {
      if (key === 'profile' && id === 'bob.near')
        return profileEntry('bob.near', mockAgent('bob.near'));
      return null;
    });

    const result = await handleFollow(
      WK,
      { targets: ['bob.near'] },
      resolveAccountId,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        results: [{ account_id: 'bob.near', action: 'followed' }],
      },
    });

    // Write landed under the caller's predecessor, keyed by target.
    // Edge value has no `at` field — the FastData-indexed block_timestamp
    // is the only authoritative time. With no reason supplied, the value
    // is just an empty object (still "live" because non-null/object).
    const writeCall = mockFetchWithTimeout.mock.calls[0];
    const body = JSON.parse(writeCall[1]!.body as string);
    expect(body.args['graph/follow/bob.near']).toEqual({});
    // Crucially: no `profile` entry in the write — follow does not bootstrap
    // the caller's profile. They join the directory only via heartbeat /
    // update_me. This captures the soft-bootstrap contract.
    expect(body.args.profile).toBeUndefined();
  });

  it('handleEndorse succeeds when the caller has no profile blob', async () => {
    mockKvGetAgent.mockImplementation(async (id: string, key: string) => {
      if (key === 'profile' && id === 'bob.near')
        return profileEntry('bob.near', mockAgent('bob.near'));
      return null;
    });
    mockKvMultiAgent.mockResolvedValue([null]);

    const result = await handleEndorse(
      WK,
      { targets: ['bob.near'], key_suffixes: ['tags/ai'] },
      resolveAccountId,
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          {
            account_id: 'bob.near',
            action: 'endorsed',
            endorsed: ['tags/ai'],
          },
        ],
      },
    });
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
      { targets: ['alice.near'], key_suffixes: ['tags/test'] },
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
      { targets: ['alice.near'], key_suffixes: ['tags/test'] },
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
      if (key === 'graph/follow/bob.near') {
        return {
          predecessor_id: id,
          current_account_id: 'contextual.near',
          block_height: 100,
          block_timestamp: 1_000_000_000_000,
          key,
          value: { at: 1000 },
        };
      }
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

  it('handleEndorse returns already_endorsed when the same key_suffix exists', async () => {
    mockProfile('bob.near');
    mockKvMultiAgent.mockResolvedValue([
      kvEntry({ key: 'endorsing/bob.near/tags/ai', value: { at: 1000 } }),
    ]);

    const result = await handleEndorse(
      WK,
      { targets: ['bob.near'], key_suffixes: ['tags/ai'] },
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          {
            account_id: 'bob.near',
            action: 'endorsed',
            endorsed: [],
            already_endorsed: ['tags/ai'],
          },
        ],
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
        profile_completeness: expect.any(Number),
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
  /**
   * Entry block time in seconds. Maps to `block_timestamp: blockSecs * 1e9`.
   * Callers use this to control whether an entry counts as "new" relative
   * to a caller's `last_active` in delta tests — the trust boundary now
   * reads block-time, not caller-asserted `value.at`.
   */
  blockSecs?: number;
}): fastdata.KvEntry {
  const blockSecs = overrides.blockSecs ?? 1700;
  return {
    predecessor_id: overrides.predecessor_id ?? 'test.near',
    current_account_id: 'contextual.near',
    block_height: 100000,
    block_timestamp: blockSecs * 1_000_000_000,
    key: overrides.key,
    value: overrides.value,
  };
}

describe('heartbeat delta', () => {
  // The delta is driven by each edge's FastData-indexed `block_timestamp`
  // compared against the caller's previous `last_active` (which is itself
  // `profileEntry.block_timestamp / 1e9` post-audit — defaulting to 2000s).
  // `value.at` is now ignored for delta purposes; it stays in the fixtures
  // only as inert cosmetic metadata a caller might have written.
  it('populates new_followers from follower entries since last_active', async () => {
    mockKvGetAll.mockResolvedValue([
      kvEntry({
        predecessor_id: 'bob.near',
        key: 'graph/follow/alice',
        value: { at: 2500 },
        blockSecs: 2500, // newer than 2000 → counts as new
      }),
      kvEntry({
        predecessor_id: 'charlie.near',
        key: 'graph/follow/alice',
        value: { at: 1500 },
        blockSecs: 1500, // older than 2000 → stale
      }),
    ]);
    mockKvListAll.mockResolvedValue([]);
    mockKvMultiAgent.mockResolvedValue([
      profileEntry('bob.near', mockAgent('bob.near')),
    ]);

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
        blockSecs: 1000,
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
      kvEntry({
        key: 'graph/follow/bob',
        value: { at: 2500 },
        blockSecs: 2500,
      }),
      kvEntry({
        key: 'graph/follow/charlie',
        value: { at: 1500 },
        blockSecs: 1500,
      }),
    ]);
    mockKvListAll.mockResolvedValue([]);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: { delta: { new_following_count: 1 } },
    });
  });

  it('ignores caller-asserted value.at — only block_timestamp counts', async () => {
    // Adversarial case: the follower (or a misbehaving caller) writes a
    // recent `at` into the edge value, but the FastData-indexed
    // `block_timestamp` is stale. Pre-audit this entry would have shown
    // up in the delta; post-audit the override makes it stale.
    mockKvGetAll.mockResolvedValue([
      kvEntry({
        predecessor_id: 'forger.near',
        key: 'graph/follow/alice',
        value: { at: 9_999_999_999 }, // claims far future
        blockSecs: 1000, // but the block was older than `previousActive` (2000)
      }),
    ]);
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

  it('ignores caller-asserted value.at — stale value but fresh block counts', async () => {
    // Mirror case: the caller wrote a stale `at` but the FastData block
    // is newer than `previousActive`. The follower still appears in the
    // delta because block time is the only thing that matters.
    mockKvGetAll.mockResolvedValue([
      kvEntry({
        predecessor_id: 'honest.near',
        key: 'graph/follow/alice',
        value: { at: 1 }, // claims ancient, but...
        blockSecs: 2500, // the block is newer than previousActive (2000)
      }),
    ]);
    mockKvListAll.mockResolvedValue([]);
    mockKvMultiAgent.mockResolvedValue([
      profileEntry('honest.near', mockAgent('honest.near')),
    ]);

    const result = await handleHeartbeat(WK, resolveAccountId);
    expect(result).toMatchObject({
      success: true,
      data: {
        delta: {
          new_followers: [
            expect.objectContaining({ account_id: 'honest.near' }),
          ],
          new_followers_count: 1,
        },
      },
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
        return profileEntry('alice.near', {
          ...mockAgent('alice.near'),
          capabilities: { skills: ['testing'] },
        });
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
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '',
    } as Response);

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
    mockFetchWithTimeout.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '',
    } as Response);

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
// (h) Endorse key_suffixes surface
// ---------------------------------------------------------------------------

function parseWriteArgs(): Record<string, unknown> {
  const writeCall = mockFetchWithTimeout.mock.calls[0];
  const body = JSON.parse(writeCall[1]!.body as string);
  return body.args as Record<string, unknown>;
}

describe('handleEndorse key_suffixes', () => {
  it('rejects empty targets', async () => {
    const result = await dispatchWrite(
      'endorse',
      { targets: [], key_suffixes: ['tags/ai'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
  });

  it('rejects when key_suffixes missing or empty', async () => {
    const result = await dispatchWrite(
      'endorse',
      { targets: ['bob.near'] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });

    const result2 = await dispatchWrite(
      'endorse',
      { targets: ['bob.near'], key_suffixes: [] },
      WK,
      resolveAccountId,
    );
    expect(result2).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
  });

  it('rejects when key_suffixes exceeds the per-call cap of 20', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `tags/k${i}`);
    const result = await dispatchWrite(
      'endorse',
      { targets: ['bob.near'], key_suffixes: tooMany },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: false,
      code: 'VALIDATION_ERROR',
      error: expect.stringContaining('Too many key_suffixes'),
    });
  });

  it('accepts an opaque key_suffix and writes it under endorsing/{target}/{key_suffix}', async () => {
    mockProfile('bob.near');
    mockKvMultiAgent.mockResolvedValue([null]);

    const result = await dispatchWrite(
      'endorse',
      { targets: ['bob.near'], key_suffixes: ['task_completion/job_123'] },
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
            endorsed: ['task_completion/job_123'],
          },
        ],
      },
    });

    const args = parseWriteArgs();
    // Edge value has no `at` field — block_timestamp is the only
    // authoritative time. With no reason or content_hash, the value is
    // an empty object (still "live" because object, not null).
    expect(args['endorsing/bob.near/task_completion/job_123']).toEqual({});
  });

  it('rejects key_suffixes with leading slash and null bytes', async () => {
    mockProfile('bob.near');
    mockKvMultiAgent.mockResolvedValue([]);

    const result = await dispatchWrite(
      'endorse',
      {
        targets: ['bob.near'],
        key_suffixes: ['/absolute/path', 'has\u0000null'],
      },
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
            code: 'VALIDATION_ERROR',
          },
        ],
      },
    });
    const res = (
      result as unknown as { data: { results: Record<string, unknown>[] } }
    ).data.results[0]!;
    expect(res.skipped).toHaveLength(2);
  });

  it('rejects an oversized full key (> 1024 bytes)', async () => {
    mockProfile('bob.near');
    mockKvMultiAgent.mockResolvedValue([]);
    const huge = 'a'.repeat(1100);

    const result = await dispatchWrite(
      'endorse',
      { targets: ['bob.near'], key_suffixes: [huge] },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          expect.objectContaining({
            action: 'error',
            code: 'VALIDATION_ERROR',
          }),
        ],
      },
    });
  });

  it('rejects endorsement when the target does not exist', async () => {
    const result = await dispatchWrite(
      'endorse',
      { targets: ['nobody.near'], key_suffixes: ['tags/ai'] },
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
            code: 'NOT_FOUND',
          },
        ],
      },
    });
  });

  it('writes multiple key_suffixes on a single target in one call', async () => {
    mockProfile('bob.near');
    mockKvMultiAgent.mockResolvedValue([null, null, null]);

    const result = await dispatchWrite(
      'endorse',
      {
        targets: ['bob.near'],
        key_suffixes: ['tags/rust', 'tags/security', 'skills/audit'],
      },
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
            endorsed: expect.arrayContaining([
              'tags/rust',
              'tags/security',
              'skills/audit',
            ]),
          },
        ],
      },
    });

    const args = parseWriteArgs();
    expect(args['endorsing/bob.near/tags/rust']).toBeDefined();
    expect(args['endorsing/bob.near/tags/security']).toBeDefined();
    expect(args['endorsing/bob.near/skills/audit']).toBeDefined();
  });

  it('round-trips content_hash into the stored entry', async () => {
    mockProfile('bob.near');
    mockKvMultiAgent.mockResolvedValue([null]);

    await dispatchWrite(
      'endorse',
      {
        targets: ['bob.near'],
        key_suffixes: ['task/job_42'],
        content_hash: 'sha256:abc',
      },
      WK,
      resolveAccountId,
    );

    const args = parseWriteArgs();
    // Value carries content_hash but no `at` — block_timestamp is the
    // authoritative time, surfaced via `entryBlockSecs` on the read path.
    expect(args['endorsing/bob.near/task/job_42']).toEqual({
      content_hash: 'sha256:abc',
    });
  });

  it('last-write-wins: re-endorse with a different content_hash overwrites without error', async () => {
    mockProfile('bob.near');
    mockKvMultiAgent.mockResolvedValue([
      kvEntry({
        key: 'endorsing/bob.near/task/job_42',
        value: { at: 1000, content_hash: 'sha256:old' },
      }),
    ]);

    const result = await dispatchWrite(
      'endorse',
      {
        targets: ['bob.near'],
        key_suffixes: ['task/job_42'],
        content_hash: 'sha256:new',
      },
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
            endorsed: ['task/job_42'],
          },
        ],
      },
    });

    const args = parseWriteArgs();
    expect(args['endorsing/bob.near/task/job_42']).toMatchObject({
      content_hash: 'sha256:new',
    });
  });

  it('dedupes an identical re-endorse into already_endorsed', async () => {
    mockProfile('bob.near');
    mockKvMultiAgent.mockResolvedValue([
      kvEntry({
        key: 'endorsing/bob.near/task/job_42',
        value: { at: 1000, content_hash: 'sha256:same' },
      }),
    ]);

    const result = await dispatchWrite(
      'endorse',
      {
        targets: ['bob.near'],
        key_suffixes: ['task/job_42'],
        content_hash: 'sha256:same',
      },
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
            endorsed: [],
            already_endorsed: ['task/job_42'],
          },
        ],
      },
    });
  });

  it('skips self-endorse with per-item error', async () => {
    const result = await dispatchWrite(
      'endorse',
      { targets: ['alice.near'], key_suffixes: ['tags/ai'] },
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
});

describe('handleUnendorse key_suffixes', () => {
  it('null-writes existing keys for the caller', async () => {
    mockProfile('bob.near');
    mockKvMultiAgent.mockImplementation(async (queries) => {
      return queries.map((q) => {
        if (q.key === 'endorsing/bob.near/tags/ai')
          return kvEntry({ key: q.key, value: { at: 1000 } });
        if (q.key === 'endorsing/bob.near/task/job_1')
          return kvEntry({ key: q.key, value: { at: 1000 } });
        return null;
      });
    });

    const result = await dispatchWrite(
      'unendorse',
      {
        targets: ['bob.near'],
        key_suffixes: ['tags/ai', 'task/job_1', 'task/not_there'],
      },
      WK,
      resolveAccountId,
    );
    expect(result).toMatchObject({
      success: true,
      data: {
        results: [
          {
            account_id: 'bob.near',
            action: 'unendorsed',
            removed: expect.arrayContaining(['tags/ai', 'task/job_1']),
          },
        ],
      },
    });

    const args = parseWriteArgs();
    expect(args['endorsing/bob.near/tags/ai']).toBeNull();
    expect(args['endorsing/bob.near/task/job_1']).toBeNull();
    expect(args['endorsing/bob.near/task/not_there']).toBeUndefined();
  });
});
