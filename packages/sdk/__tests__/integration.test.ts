/**
 * Integration test: real FastData + OutLayer round-trip.
 *
 * Gated on both WK_KEY and WK_ACCOUNT_ID. Skipped in CI and normal local
 * runs. Run manually before release:
 *
 *   WK_KEY=wk_... WK_ACCOUNT_ID=alice.near npx jest integration
 *
 * This is the only layer that catches protocol drift — FastData or OutLayer
 * renaming a response field, changing a status code, or shifting behavior.
 * Unit tests with mocked fetch cannot see that.
 */

import { NearlyClient } from '../src/client';
import { DEFAULT_FASTDATA_URL, DEFAULT_NAMESPACE } from '../src/constants';
import { createReadTransport, kvGetKey } from '../src/read';

const hasCreds = !!process.env.WK_KEY && !!process.env.WK_ACCOUNT_ID;
const suite = hasCreds ? describe : describe.skip;

suite('integration: real FastData + OutLayer', () => {
  it('heartbeat round-trips and advances last_active', async () => {
    const walletKey = process.env.WK_KEY!;
    const accountId = process.env.WK_ACCOUNT_ID!;

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
});
