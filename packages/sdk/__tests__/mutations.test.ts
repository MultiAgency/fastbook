import { buildFollow, buildHeartbeat, submit } from '../src/mutations';
import { defaultRateLimiter, noopRateLimiter } from '../src/rateLimit';
import type { FetchLike } from '../src/read';
import type { Agent } from '../src/types';
import type { WalletClient } from '../src/wallet';
import { aliceProfileBlob } from './fixtures/entries';

function aliceAgent(overrides: Partial<Agent> = {}): Agent {
  return { ...aliceProfileBlob, ...overrides };
}

function mockWallet(fetch: FetchLike): WalletClient {
  return {
    outlayerUrl: 'https://outlayer.example',
    namespace: 'ns.near',
    walletKey: 'wk_test',
    fetch,
    timeoutMs: 5000,
  };
}

function okFetch(): {
  fetch: FetchLike;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response('{}', { status: 200 });
  };
  return { fetch, calls };
}

describe('buildHeartbeat', () => {
  it('preserves caller content fields and emits tag/cap indexes', () => {
    const before = aliceAgent({ last_active: 1 });
    const m = buildHeartbeat('alice.near', before);
    expect(m.action).toBe('heartbeat');
    expect(m.rateLimitKey).toBe('alice.near');
    const profile = m.entries.profile as Record<string, unknown>;
    expect(profile.name).toBe('Alice');
    expect(profile.description).toBe('rust reviewer');
    expect(profile.tags).toEqual(['rust']);
    // tag + cap existence indexes
    expect(m.entries['tag/rust']).toBe(true);
    expect(m.entries['cap/skills/code-review']).toBe(true);
  });

  it('creates a default profile on first write (null current)', () => {
    const m = buildHeartbeat('new.near', null);
    const profile = m.entries.profile as Record<string, unknown>;
    expect(profile.account_id).toBe('new.near');
    expect(profile.name).toBeNull();
    expect(profile.tags).toEqual([]);
  });

  it('strips derived AND time fields from the stored profile blob', () => {
    // Time fields (`last_active`, `created_at`) are read-derived from
    // FastData block timestamps, never written. Derived fields (counts,
    // endorsements) are also stripped.
    const agent = aliceAgent({
      follower_count: 99,
      endorsements: { 'skills/rust': 5 },
      last_active: 1_700_000_000,
    });
    const m = buildHeartbeat('alice.near', agent);
    const profile = m.entries.profile as Record<string, unknown>;
    expect(profile.follower_count).toBeUndefined();
    expect(profile.endorsements).toBeUndefined();
    expect(profile.last_active).toBeUndefined();
    expect(profile.created_at).toBeUndefined();
  });
});

describe('buildFollow', () => {
  it('produces a single graph/follow entry with reason but no at field', () => {
    const m = buildFollow('alice.near', 'bob.near', { reason: 'great rust' });
    expect(m.action).toBe('follow');
    expect(m.rateLimitKey).toBe('alice.near');
    const entry = m.entries['graph/follow/bob.near'] as Record<string, unknown>;
    expect(entry.reason).toBe('great rust');
    // No `at` field — block_timestamp is the only authoritative time.
    expect(entry.at).toBeUndefined();
  });

  it('produces an empty object entry when no reason is provided', () => {
    const m = buildFollow('alice.near', 'bob.near');
    const entry = m.entries['graph/follow/bob.near'] as Record<string, unknown>;
    expect(entry).toEqual({});
  });

  it('rejects self-follow', () => {
    expect(() => buildFollow('alice.near', 'alice.near')).toThrow(/yourself/);
  });

  it('rejects empty target', () => {
    expect(() => buildFollow('alice.near', '')).toThrow(/empty/);
  });

  it('rejects oversized reason', () => {
    const big = 'x'.repeat(281);
    expect(() =>
      buildFollow('alice.near', 'bob.near', { reason: big }),
    ).toThrow(/reason/);
  });

  it('omits reason field when not provided', () => {
    const m = buildFollow('alice.near', 'bob.near');
    const entry = m.entries['graph/follow/bob.near'] as Record<string, unknown>;
    expect('reason' in entry).toBe(false);
  });
});

describe('submit funnel', () => {
  it('calls wallet /call and records rate-limit usage', async () => {
    const { fetch, calls } = okFetch();
    const wallet = mockWallet(fetch);
    const rl = defaultRateLimiter();
    const m = buildFollow('alice.near', 'bob.near');
    await submit({ wallet, rateLimiter: rl }, m);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://outlayer.example/wallet/v1/call');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.receiver_id).toBe('ns.near');
    expect(body.method_name).toBe('__fastdata_kv');
    expect(body.args['graph/follow/bob.near']).toBeTruthy();
  });

  it('throws RATE_LIMITED when limiter rejects, without calling wallet', async () => {
    const { fetch, calls } = okFetch();
    const wallet = mockWallet(fetch);
    const rl = defaultRateLimiter();
    const m = buildFollow('alice.near', 'bob.near');
    // Saturate: follow limit is 10/60s
    for (let i = 0; i < 10; i++) rl.record('follow', 'alice.near');
    await expect(submit({ wallet, rateLimiter: rl }, m)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(calls).toHaveLength(0);
  });

  it('throws AUTH on 401 from wallet', async () => {
    const fetch: FetchLike = async () => new Response(null, { status: 401 });
    const wallet = mockWallet(fetch);
    const m = buildFollow('alice.near', 'bob.near');
    await expect(
      submit({ wallet, rateLimiter: noopRateLimiter() }, m),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('throws INSUFFICIENT_BALANCE on 402', async () => {
    const fetch: FetchLike = async () => new Response(null, { status: 402 });
    const wallet = mockWallet(fetch);
    const m = buildFollow('alice.near', 'bob.near');
    await expect(
      submit({ wallet, rateLimiter: noopRateLimiter() }, m),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('throws INSUFFICIENT_BALANCE on 502 (OutLayer Cloudflare upstream)', async () => {
    const fetch: FetchLike = async () => new Response(null, { status: 502 });
    const wallet = mockWallet(fetch);
    const m = buildFollow('alice.near', 'bob.near');
    await expect(
      submit({ wallet, rateLimiter: noopRateLimiter() }, m),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('never includes wk_ key in error messages', async () => {
    const fetch: FetchLike = async () =>
      new Response('some detail with wk_secret123 leaked', { status: 500 });
    const wallet = mockWallet(fetch);
    const m = buildFollow('alice.near', 'bob.near');
    try {
      await submit({ wallet, rateLimiter: noopRateLimiter() }, m);
      fail('expected throw');
    } catch (err) {
      const message = (err as Error).message;
      // The error carries the upstream body snippet — assert it did NOT smuggle
      // the caller's wk_ (which is in the Authorization header, not the body).
      expect(message).not.toMatch(/wk_test/);
    }
  });
});
