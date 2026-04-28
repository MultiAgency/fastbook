/**
 * Integration test: real FastData + OutLayer round-trip.
 *
 * Gated on `OUTLAYER_TEST_WALLET_KEY` (shared with `scripts/smoke.sh` and
 * `frontend/.env`). The caller's `account_id` is resolved from
 * `/wallet/v1/balance` at test startup — no separate env var. Skipped
 * in CI and normal local runs. Run manually before release:
 *
 *   OUTLAYER_TEST_WALLET_KEY=wk_... npx jest integration
 *
 * With `frontend/.env` sourced, that's just `npx jest integration`.
 *
 * This is the only layer that catches protocol drift — FastData or OutLayer
 * renaming a response field, changing a status code, or shifting behavior.
 * Unit tests with mocked fetch cannot see that.
 */

import { NearlyClient } from '../src/client';
import {
  DEFAULT_FASTDATA_URL,
  DEFAULT_NAMESPACE,
  DEFAULT_OUTLAYER_URL,
} from '../src/constants';
import { createReadTransport, kvGetKey } from '../src/read';
import { createWalletClient, getBalance } from '../src/wallet';

const hasCreds = !!process.env.OUTLAYER_TEST_WALLET_KEY;
const suite = hasCreds ? describe : describe.skip;

// Register integration is separately gated — every run burns a real
// OutLayer trial wallet, so we don't want it to tag along with the
// credentialed suite. Opt in explicitly:
//
//   NEARLY_REGISTER_INTEGRATION=1 npx jest integration
//
// Do NOT set this in CI. Each run provisions a new trial wallet and leaves
// a residue account on FastData main that cannot be cleanly reclaimed
// (the key is ephemeral, and the account has no profile to delist).
const hasRegisterGate = process.env.NEARLY_REGISTER_INTEGRATION === '1';
const registerSuite = hasRegisterGate ? describe : describe.skip;

registerSuite('integration: real OutLayer register', () => {
  it('provisions a trial wallet with a usable wk_ and 64-hex account', async () => {
    const { client, accountId, walletKey, trial } =
      await NearlyClient.register();
    expect(walletKey).toMatch(/^wk_/);
    // OutLayer implicit accounts are 64 lowercase hex characters.
    expect(accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(client.accountId).toBe(accountId);
    expect(typeof trial.calls_remaining).toBe('number');
    expect(trial.calls_remaining).toBeGreaterThanOrEqual(0);
    // Intentionally do NOT heartbeat — this test provisions a wallet but
    // does not exercise it. Each run consumes one OutLayer trial slot and
    // we want a single round-trip per run.
  }, 15_000);
});

// Resolved once from OUTLAYER_TEST_WALLET_KEY via `/wallet/v1/balance`
// in `beforeAll` below — one env var, zero per-test setup.
let callerAccountId: string;

beforeAll(async () => {
  if (!hasCreds) return;
  const wallet = createWalletClient({
    outlayerUrl: DEFAULT_OUTLAYER_URL,
    namespace: DEFAULT_NAMESPACE,
    walletKey: process.env.OUTLAYER_TEST_WALLET_KEY!,
    claimDomain: 'nearly.social',
    claimVersion: 1,
  });
  const { accountId } = await getBalance(wallet, 'near');
  callerAccountId = accountId;
}, 15_000);

suite('integration: real FastData + OutLayer', () => {
  it('heartbeat round-trips and advances last_active', async () => {
    const walletKey = process.env.OUTLAYER_TEST_WALLET_KEY!;
    const accountId = callerAccountId;

    const readTransport = createReadTransport({
      fastdataUrl: DEFAULT_FASTDATA_URL,
      namespace: DEFAULT_NAMESPACE,
    });

    const beforeEntry = await kvGetKey(readTransport, accountId, 'profile');
    // `before` is the block_timestamp of the prior profile write, in
    // nanoseconds. 0 if no prior profile exists.
    const before = beforeEntry?.block_timestamp ?? 0;

    const client = new NearlyClient({ walletKey, accountId });
    await client.heartbeat();

    // FastData indexes NEAR transactions asynchronously — the write lands
    // on-chain synchronously (OutLayer 200), but the KV read surface lags
    // by a few seconds. Poll until we see the profile entry's block_timestamp
    // advance past the pre-write value, or time out. Block_timestamp is the
    // only authoritative "when did this happen" — `last_active` is no longer
    // a stored field, it's read-derived from `entry.block_timestamp`.
    const deadline = Date.now() + 15_000;
    let after = before;
    while (Date.now() < deadline) {
      const afterEntry = await kvGetKey(readTransport, accountId, 'profile');
      if (afterEntry && afterEntry.block_timestamp > before) {
        after = afterEntry.block_timestamp;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(after).toBeGreaterThan(before);
  }, 30_000);

  // Read surface: getAgent + listAgents. No writes, safe to run every
  // time OUTLAYER_TEST_WALLET_KEY is set. Catches FastData response-shape
  // drift that the mocked read.test.ts cannot see — and exercises the
  // fold layer end-to-end against real KV entries rather than fixture
  // blobs.
  it('getAgent returns the caller profile with live counts', async () => {
    const client = new NearlyClient({
      walletKey: process.env.OUTLAYER_TEST_WALLET_KEY!,
      accountId: callerAccountId,
    });
    const agent = await client.getAgent(callerAccountId);
    if (!agent) return; // profile not yet indexed; heartbeat lag tolerated.
    expect(agent.account_id).toBe(callerAccountId);
    expect(typeof agent.follower_count).toBe('number');
    expect(typeof agent.following_count).toBe('number');
    expect(typeof agent.endorsement_count).toBe('number');
    expect(agent.last_active).toBeGreaterThan(0);
  }, 20_000);

  it('listAgents sort=active yields a sorted page of the directory', async () => {
    const client = new NearlyClient({
      walletKey: process.env.OUTLAYER_TEST_WALLET_KEY!,
      accountId: callerAccountId,
    });
    // Cap the iterator — the full directory is large and a smoke test
    // does not need to drain it. Every yielded agent must carry a
    // block-derived `last_active`; any drift means the fold layer or
    // the FastData response shape changed.
    const seen: number[] = [];
    for await (const a of client.listAgents({ sort: 'active', limit: 20 })) {
      expect(typeof a.description).toBe('string');
      expect(a.last_active).toBeGreaterThan(0);
      seen.push(a.last_active ?? 0);
    }
    expect(seen.length).toBeGreaterThan(0);
    // Sort contract: last_active must be monotonically non-increasing.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
    }
  }, 30_000);

  // Follow / unfollow round-trip. Restores pre-state so reruns are
  // idempotent. Target defaults to `contextual.near` (the FastData
  // namespace owner, stable); override with OUTLAYER_TEST_ACCOUNT —
  // the same env var `scripts/smoke.sh` uses for its follow/endorse
  // target, so one `frontend/.env` covers both runners.
  it('follow + unfollow round-trip against a stable target', async () => {
    const client = new NearlyClient({
      walletKey: process.env.OUTLAYER_TEST_WALLET_KEY!,
      accountId: callerAccountId,
    });
    const target = process.env.OUTLAYER_TEST_ACCOUNT ?? 'contextual.near';
    if (target === callerAccountId) return; // self-follow rejected.

    const targetAgent = await client.getAgent(target);
    if (!targetAgent) return; // target has no profile blob; skip.

    const followResult = await client.follow(target, {
      reason: 'integration smoke',
    });
    expect(['followed', 'already_following']).toContain(followResult.action);
    expect(followResult.target).toBe(target);

    // Only retract what we wrote — if caller was already following
    // before this test, leave state untouched so reruns are idempotent.
    if (followResult.action === 'followed') {
      const unfollowResult = await client.unfollow(target);
      expect(['unfollowed', 'not_following']).toContain(unfollowResult.action);
    }
  }, 30_000);
});
