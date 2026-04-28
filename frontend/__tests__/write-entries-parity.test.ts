/**
 * @jest-environment node
 *
 * SDK ↔ frontend envelope parity regression test.
 *
 * For each of the 7 social mutation actions, this test asserts that the
 * frontend handler in `fastdata/writes/<action>.ts` and the SDK builder in
 * `packages/sdk/src/social.ts` produce byte-for-byte equivalent `entries`
 * maps when given the same input. The frontend handlers already delegate
 * to the SDK builders (migration complete), so this test serves as an
 * ongoing regression gate — any accidental divergence between the two
 * layers will fail loudly here.
 *
 * What this test DOES assert:
 * - The `entries` map passed to `writeToFastData` (as observed via the
 *   mocked `fetchWithTimeout`'s outbound body) is deep-equal to what
 *   the corresponding SDK builder returns in `Mutation.entries`.
 * - Tombstone semantics for `profile` when the patch drops a tag AND
 *   a capability — the highest-risk parity case.
 *
 * What it does NOT assert:
 * - Handler return shape (delta envelopes, completeness score, reason
 *   strings, live count overlays). Those are orthogonal.
 * - Validation error messages. The two layers validate separately;
 *   deduplication is deferred to a future commit.
 * - Rate-limit budget consumption or retries.
 */

import {
  type Agent,
  buildDelistMe,
  buildEndorse,
  buildFollow,
  buildHeartbeat,
  buildKvDelete,
  buildKvPut,
  buildProfile,
  buildUnendorse,
  buildUnfollow,
} from '@nearly/sdk';
import { NextRequest } from 'next/server';
import * as fastdata from '@/lib/fastdata/client';
import {
  handleDelistMe,
  handleEndorse,
  handleFollow,
  handleHeartbeat,
  handleUnendorse,
  handleUnfollow,
  handleUpdateProfile,
} from '@/lib/fastdata/writes';
import * as fetchLib from '@/lib/fetch';
import * as outlayerServer from '@/lib/outlayer-server';
import * as rateLimit from '@/lib/rate-limit';
import { mockAgent, profileEntry, resolveAccountId, WK } from './fixtures';

jest.mock('@/lib/fastdata/client');
jest.mock('@/lib/fetch');
jest.mock('@/lib/rate-limit');

// Admin parity needs a few extra seams so we can drive route.ts's POST/DELETE
// handlers through the same `fetchWithTimeout` capture path the social cases
// use. These mocks are keyed to modules the social handlers never touch, so
// they cannot affect the 7 existing describes above.
jest.mock('@/lib/outlayer-server', () => ({
  ...jest.requireActual('@/lib/outlayer-server'),
  resolveAccountId: jest.fn().mockResolvedValue('admin.near'),
  signClaimForWalletKey: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/admin-near-token', () => ({
  buildAdminNearToken: jest.fn().mockReturnValue('near:mock_admin_token'),
  resolveAdminWriterAccount: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/constants', () => ({
  ...jest.requireActual('@/lib/constants'),
  OUTLAYER_ADMIN_ACCOUNT: 'admin.near',
}));
jest.mock('@/lib/cache', () => ({
  ...jest.requireActual('@/lib/cache'),
  invalidateForMutation: jest.fn(),
  getCached: jest.fn().mockReturnValue(undefined),
  setCache: jest.fn(),
}));
jest.mock('@/lib/fastdata/reads', () => ({
  dispatchFastData: jest.fn(),
  handleGetSuggested: jest.fn(),
}));

const mockKvGetAgent = fastdata.kvGetAgent as jest.MockedFunction<
  typeof fastdata.kvGetAgent
>;
const mockKvMultiAgent = fastdata.kvMultiAgent as jest.MockedFunction<
  typeof fastdata.kvMultiAgent
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
const mockFetchWithTimeout = fetchLib.fetchWithTimeout as jest.MockedFunction<
  typeof fetchLib.fetchWithTimeout
>;

const CALLER = 'alice.near';
const TARGET = 'bob.near';

// Seeds the default kvGetAgent mock so only the caller's profile resolves.
// Shared across describes that need a caller-only seed; cases that also
// need a follow/endorse edge or list result keep their bespoke mockImpl.
function seedCallerProfile(agent: Agent): void {
  mockKvGetAgent.mockImplementation(async (id: string, key: string) =>
    key === 'profile' && id === CALLER ? profileEntry(CALLER, agent) : null,
  );
}

/**
 * Extract the `args` field from the most recent OutLayer write call.
 * Returns `null` if no write has been captured yet. The outbound body is
 * `{ receiver_id, method_name: '__fastdata_kv', args: <entries>, ... }`
 * per `writeToFastData` — read `body.args` directly.
 */
function captureWriteEntries(): Record<string, unknown> | null {
  const call = mockFetchWithTimeout.mock.calls.find((c) => {
    const url = c[0] as string | URL;
    const urlStr = typeof url === 'string' ? url : url.toString();
    return urlStr.includes('/wallet/v1/call');
  });
  if (!call) return null;
  const init = call[1] as RequestInit | undefined;
  if (!init?.body) return null;
  const body = JSON.parse(init.body as string) as {
    args?: Record<string, unknown>;
  };
  return body.args ?? null;
}

beforeEach(() => {
  jest.resetAllMocks();
  resolveAccountId.mockResolvedValue(CALLER);
  // `jest.resetAllMocks()` also wipes the outlayer-server mocks defined at
  // the top. Re-prime the admin-side defaults so the admin describes below
  // see `admin.near` as the caller and `signClaimForWalletKey` as a no-op.
  (outlayerServer.resolveAccountId as jest.Mock).mockResolvedValue(
    'admin.near',
  );
  (outlayerServer.signClaimForWalletKey as jest.Mock).mockResolvedValue(null);

  // Default: caller profile exists; target profile exists too so endorse
  // and follow target-existence checks pass.
  mockKvGetAgent.mockImplementation(async (id: string, key: string) => {
    if (key === 'profile' && id === CALLER)
      return profileEntry(CALLER, mockAgent(CALLER));
    if (key === 'profile' && id === TARGET)
      return profileEntry(TARGET, mockAgent(TARGET));
    return null;
  });

  // Target existence lookups used by endorse's batch target check.
  mockKvMultiAgent.mockImplementation(async (queries) =>
    queries.map((q) =>
      q.key === 'profile' && q.accountId === TARGET
        ? profileEntry(TARGET, mockAgent(TARGET))
        : null,
    ),
  );

  (rateLimit.checkRateLimit as jest.Mock).mockReturnValue({
    ok: true,
    window: 0,
  });
  (rateLimit.checkRateLimitBudget as jest.Mock).mockReturnValue({
    ok: true,
    remaining: 20,
    window: 0,
    retryAfter: 0,
  });
  (rateLimit.incrementRateLimit as jest.Mock).mockImplementation(() => {});

  mockKvGetAll.mockResolvedValue([]);
  mockKvListAgent.mockResolvedValue([]);
  mockKvListAll.mockResolvedValue([]);
  mockFetchWithTimeout.mockResolvedValue({ ok: true } as Response);
});

describe('SDK envelope parity — social.follow', () => {
  it('matches with a reason', async () => {
    await handleFollow(
      WK,
      { account_id: TARGET, reason: 'great rust reviewer' },
      resolveAccountId,
    );
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildFollow(CALLER, TARGET, { reason: 'great rust reviewer' });
    expect(frontend).toEqual(sdk.entries);
  });

  it('matches without a reason', async () => {
    await handleFollow(WK, { account_id: TARGET }, resolveAccountId);
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildFollow(CALLER, TARGET);
    expect(frontend).toEqual(sdk.entries);
  });
});

describe('SDK envelope parity — social.unfollow', () => {
  it('emits a single null-write for the follow edge', async () => {
    // Seed an existing edge so the handler doesn't short-circuit as
    // "not following" — match what it would see from `kvGetAgent`.
    mockKvGetAgent.mockImplementation(async (id: string, key: string) => {
      if (key === 'profile' && id === CALLER)
        return profileEntry(CALLER, mockAgent(CALLER));
      if (key === `graph/follow/${TARGET}` && id === CALLER) {
        return {
          predecessor_id: CALLER,
          current_account_id: 'contextual.near',
          block_height: 1,
          block_timestamp: 1_000_000_000,
          key: `graph/follow/${TARGET}`,
          value: {},
        };
      }
      return null;
    });

    await handleUnfollow(WK, { account_id: TARGET }, resolveAccountId);
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildUnfollow(CALLER, TARGET);
    expect(frontend).toEqual(sdk.entries);
  });
});

describe('SDK envelope parity — social.endorse', () => {
  it('matches with reason + content_hash', async () => {
    await handleEndorse(
      WK,
      {
        account_id: TARGET,
        key_suffixes: ['tags/rust', 'skills/audit'],
        reason: 'verified audit work',
        content_hash: 'sha256:abc123',
      },
      resolveAccountId,
    );
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildEndorse(CALLER, TARGET, {
      keySuffixes: ['tags/rust', 'skills/audit'],
      reason: 'verified audit work',
      contentHash: 'sha256:abc123',
    });
    expect(frontend).toEqual(sdk.entries);
  });

  it('matches with only required fields', async () => {
    await handleEndorse(
      WK,
      { account_id: TARGET, key_suffixes: ['tags/rust'] },
      resolveAccountId,
    );
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildEndorse(CALLER, TARGET, {
      keySuffixes: ['tags/rust'],
    });
    expect(frontend).toEqual(sdk.entries);
  });

  // Object-form targets[] — pins that per-target `key_suffixes`, `reason`,
  // and `content_hash` overrides flow through to `buildEndorse` identically
  // to the single-target path-param form. `runBatch` issues one
  // `writeToFastData` call per target, so a single-element object-form
  // targets[] is the minimal case that exercises the new deserialization
  // path without fighting the batch loop's per-target capture semantics.
  it('object-form targets[] with per-target overrides matches buildEndorse', async () => {
    await handleEndorse(
      WK,
      {
        targets: [
          {
            account_id: TARGET,
            key_suffixes: ['tags/rust', 'skills/audit'],
            reason: 'per-target override',
            content_hash: 'sha256:def456',
          },
        ],
      },
      resolveAccountId,
    );
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildEndorse(CALLER, TARGET, {
      keySuffixes: ['tags/rust', 'skills/audit'],
      reason: 'per-target override',
      contentHash: 'sha256:def456',
    });
    expect(frontend).toEqual(sdk.entries);
  });
});

describe('SDK envelope parity — social.unendorse', () => {
  it('emits null-writes for each composed key', async () => {
    // Seed existing endorsement entries so the handler doesn't short-circuit.
    mockKvMultiAgent.mockImplementation(async (queries) =>
      queries.map((q) => {
        if (
          q.key.startsWith(`endorsing/${TARGET}/`) &&
          q.accountId === CALLER
        ) {
          return {
            predecessor_id: CALLER,
            current_account_id: 'contextual.near',
            block_height: 1,
            block_timestamp: 1_000_000_000,
            key: q.key,
            value: {},
          } as fastdata.KvEntry;
        }
        return null;
      }),
    );

    await handleUnendorse(
      WK,
      { account_id: TARGET, key_suffixes: ['tags/rust', 'skills/audit'] },
      resolveAccountId,
    );
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildUnendorse(CALLER, TARGET, ['tags/rust', 'skills/audit']);
    expect(frontend).toEqual(sdk.entries);
  });

  it('object-form targets[] with per-target key_suffixes matches buildUnendorse', async () => {
    // Seed existing endorsement entries so the handler doesn't short-circuit.
    mockKvMultiAgent.mockImplementation(async (queries) =>
      queries.map((q) => {
        if (
          q.key.startsWith(`endorsing/${TARGET}/`) &&
          q.accountId === CALLER
        ) {
          return {
            predecessor_id: CALLER,
            current_account_id: 'contextual.near',
            block_height: 1,
            block_timestamp: 1_000_000_000,
            key: q.key,
            value: {},
          } as fastdata.KvEntry;
        }
        return null;
      }),
    );

    await handleUnendorse(
      WK,
      {
        targets: [
          {
            account_id: TARGET,
            key_suffixes: ['tags/rust', 'skills/audit'],
          },
        ],
      },
      resolveAccountId,
    );
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildUnendorse(CALLER, TARGET, ['tags/rust', 'skills/audit']);
    expect(frontend).toEqual(sdk.entries);
  });
});

describe('SDK envelope parity — social.heartbeat', () => {
  it('first-write: caller has no profile, both sides fall back to defaultAgent', async () => {
    // No profile entry for the caller — `resolveCallerOrInit` falls through
    // to `defaultAgent(accountId)`. Pins that the frontend's `defaultAgent`
    // in `fastdata/writes/_shared.ts` stays byte-equal to the SDK's `defaultAgent`
    // in `packages/sdk/src/graph.ts` — if they ever drift, the stripped
    // profile blob diverges and this test fails.
    mockKvGetAgent.mockImplementation(async () => null);

    await handleHeartbeat(WK, resolveAccountId);
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildHeartbeat(CALLER, null);
    expect(frontend).toEqual(sdk.entries);
  });

  it('emits profile + tag/cap indexes, no tombstones', async () => {
    // Profile with non-trivial tags + capabilities so the indexes matter.
    const agent: Agent = {
      name: 'Alice',
      description: 'Rust reviewer',
      image: null,
      tags: ['rust', 'security'],
      capabilities: { skills: ['audit', 'refactor'] },
      account_id: CALLER,
    };
    seedCallerProfile(agent);

    await handleHeartbeat(WK, resolveAccountId);
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    // The frontend uses `fetchProfile` which applies the trust-boundary
    // override — the Agent the handler sees has `last_active` set from
    // the block_timestamp (2000s by default) and `account_id` set from
    // the predecessor. Mirror that on the SDK side so both builders see
    // the same effective Agent.
    const hydratedAgent: Agent = {
      ...agent,
      account_id: CALLER,
      last_active: 2000,
      last_active_height: 2000,
    };
    const sdk = buildHeartbeat(CALLER, hydratedAgent);
    expect(frontend).toEqual(sdk.entries);
  });
});

describe('SDK envelope parity — social.profile', () => {
  it('image clear: patch { image: null } strips the field on both sides', async () => {
    // Seed the caller with a non-null image so the clear path is observable
    // (the default `mockAgent` already has `image: null`, which would make
    // the test vacuous). Both layers must handle `'image' in patch` and set
    // `next.image = null` — a drop to `undefined` would leak the stale URL.
    const agent: Agent = {
      ...mockAgent(CALLER),
      image: 'https://example.com/avatar.png',
    };
    seedCallerProfile(agent);

    const patch = { image: null };
    await handleUpdateProfile(WK, patch, resolveAccountId);
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const hydratedAgent: Agent = {
      ...agent,
      account_id: CALLER,
      last_active: 2000,
      last_active_height: 2000,
    };
    const sdk = buildProfile(CALLER, hydratedAgent, patch);
    expect(frontend).toEqual(sdk.entries);
  });

  it('emits tombstones for dropped tags AND capability pairs (highest-risk case)', async () => {
    const agent: Agent = {
      name: 'Alice',
      description: 'Rust reviewer',
      image: null,
      tags: ['rust', 'security', 'to-drop'],
      capabilities: {
        skills: ['audit', 'will-vanish'],
      },
      account_id: CALLER,
    };
    seedCallerProfile(agent);

    const patch = {
      tags: ['rust', 'security'], // drops 'to-drop'
      capabilities: { skills: ['audit'] }, // drops 'will-vanish'
    };

    await handleUpdateProfile(WK, patch, resolveAccountId);
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    // Mirror the trust-boundary override for the SDK side.
    const hydratedAgent: Agent = {
      ...agent,
      account_id: CALLER,
      last_active: 2000,
      last_active_height: 2000,
    };
    const sdk = buildProfile(CALLER, hydratedAgent, patch);
    expect(frontend).toEqual(sdk.entries);
  });
});

describe('SDK envelope parity — social.delist_me', () => {
  it('emits profile + tags + caps + outgoing follow + outgoing endorse nulls', async () => {
    const agent: Agent = {
      name: 'Alice',
      description: 'Rust reviewer',
      image: null,
      tags: ['rust', 'security'],
      capabilities: { skills: ['audit'] },
      account_id: CALLER,
    };
    const outgoingFollowKeys = [
      `graph/follow/bob.near`,
      `graph/follow/carol.near`,
    ];
    const outgoingEndorseKeys = [`endorsing/dave.near/tags/ai`];

    seedCallerProfile(agent);
    mockKvListAgent.mockImplementation(async (id: string, prefix: string) => {
      if (id !== CALLER) return [];
      if (prefix === 'graph/follow/') {
        return outgoingFollowKeys.map((k) => ({
          predecessor_id: CALLER,
          current_account_id: 'contextual.near',
          block_height: 1,
          block_timestamp: 1_000_000_000,
          key: k,
          value: {},
        }));
      }
      if (prefix === 'endorsing/') {
        return outgoingEndorseKeys.map((k) => ({
          predecessor_id: CALLER,
          current_account_id: 'contextual.near',
          block_height: 1,
          block_timestamp: 1_000_000_000,
          key: k,
          value: {},
        }));
      }
      return [];
    });

    await handleDelistMe(WK, resolveAccountId);
    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const hydratedAgent: Agent = {
      ...agent,
      account_id: CALLER,
      last_active: 2000,
      last_active_height: 2000,
    };
    const sdk = buildDelistMe(
      hydratedAgent,
      outgoingFollowKeys,
      outgoingEndorseKeys,
    );
    expect(frontend).toEqual(sdk.entries);
  });
});

// ---------------------------------------------------------------------------
// KV primitive parity — admin hide / unhide
// ---------------------------------------------------------------------------
//
// The 7 social describes above cover `fastdata/writes/`'s handlers. The
// admin hide/unhide path in `route.ts::handleAdmin` is the only other caller
// that constructs a write envelope in the frontend tree, and since Tier 4 it
// delegates shape to `buildKvPut` / `buildKvDelete` from `@nearly/sdk/kv`.
// These two describes drive the admin POST / DELETE through the real route
// handler and compare the captured write envelope against the builder output
// for the same inputs. A future refactor that reverts `handleAdmin` to an
// inline literal — or a change to `kv.ts` that shifts key composition or
// tombstone shape — fails at least one of these cases.
//
// The route handler is imported lazily inside `beforeAll` so the module-load
// side effects (platform init, route table, verify-claim boot) don't run
// unless the admin block is reached.

const ADMIN = 'admin.near';
const HIDE_TARGET = 'spam.near';

describe('SDK envelope parity — kv.put (admin hide_agent)', () => {
  let POST: (
    req: NextRequest,
    ctx: { params: Promise<{ path: string[] }> },
  ) => Promise<Response>;

  beforeAll(async () => {
    ({ POST } = await import('@/app/api/v1/[...path]/route'));
  });

  function adminHideRequest(
    target: string,
  ): [NextRequest, { params: Promise<{ path: string[] }> }] {
    const req = new NextRequest(
      `http://localhost:3000/api/v1/admin/hidden/${target}`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer wk_admin_test' },
      },
    );
    return [
      req,
      { params: Promise.resolve({ path: ['admin', 'hidden', target] }) },
    ];
  }

  it('hide_agent envelope matches buildKvPut for hidden/{target}: true', async () => {
    const [req, ctx] = adminHideRequest(HIDE_TARGET);
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildKvPut(ADMIN, `hidden/${HIDE_TARGET}`, true);
    expect(frontend).toEqual(sdk.entries);
  });

  it('hide_agent envelope matches for a different target (regression: no stateful cache)', async () => {
    const [req, ctx] = adminHideRequest('other.near');
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildKvPut(ADMIN, 'hidden/other.near', true);
    expect(frontend).toEqual(sdk.entries);
  });
});

describe('SDK envelope parity — kv.delete (admin unhide_agent)', () => {
  let DELETE: (
    req: NextRequest,
    ctx: { params: Promise<{ path: string[] }> },
  ) => Promise<Response>;

  beforeAll(async () => {
    ({ DELETE } = await import('@/app/api/v1/[...path]/route'));
  });

  it('unhide_agent envelope matches buildKvDelete (tombstone on hidden/{target})', async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/v1/admin/hidden/${HIDE_TARGET}`,
      {
        method: 'DELETE',
        headers: { authorization: 'Bearer wk_admin_test' },
      },
    );
    const ctx = {
      params: Promise.resolve({ path: ['admin', 'hidden', HIDE_TARGET] }),
    };
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(200);

    const frontend = captureWriteEntries();
    expect(frontend).not.toBeNull();

    const sdk = buildKvDelete(ADMIN, `hidden/${HIDE_TARGET}`);
    expect(frontend).toEqual(sdk.entries);
  });
});
