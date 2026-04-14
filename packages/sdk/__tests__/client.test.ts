import { NearlyClient } from '../src/client';
import type { FetchLike } from '../src/read';
import type { Agent } from '../src/types';
import { aliceProfileBlob } from './fixtures/entries';

interface Call {
  url: string;
  init?: RequestInit;
}

function scripted(handler: (url: string, init?: RequestInit) => Response): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function profileEntryResponse(agent: Agent): Response {
  return jsonResponse({
    entries: [
      {
        predecessor_id: agent.account_id,
        current_account_id: 'contextual.near',
        block_height: 1,
        block_timestamp: 1,
        key: 'profile',
        value: agent,
      },
    ],
  });
}

function clientOf(fetch: FetchLike): NearlyClient {
  return new NearlyClient({
    walletKey: 'wk_test',
    accountId: 'alice.near',
    fastdataUrl: 'https://kv.example',
    outlayerUrl: 'https://outlayer.example',
    namespace: 'contextual.near',
    fetch,
    rateLimiting: false,
  });
}

describe('NearlyClient constructor', () => {
  it('requires walletKey', () => {
    expect(
      () =>
        new NearlyClient({
          walletKey: '',
          accountId: 'alice.near',
        }),
    ).toThrow(/walletKey/);
  });

  it('requires accountId', () => {
    expect(
      () =>
        new NearlyClient({
          walletKey: 'wk_x',
          accountId: '',
        }),
    ).toThrow(/accountId/);
  });

  it('two instances have independent rate limiters', async () => {
    const { fetch: f1, calls: c1 } = scripted((url) => {
      if (url.includes('/v0/latest/'))
        return profileEntryResponse(aliceProfileBlob);
      return jsonResponse({});
    });
    const { fetch: f2, calls: c2 } = scripted((url) => {
      if (url.includes('/v0/latest/'))
        return profileEntryResponse(aliceProfileBlob);
      return jsonResponse({});
    });
    const a = new NearlyClient({
      walletKey: 'wk_a',
      accountId: 'alice.near',
      fastdataUrl: 'https://kv.example',
      outlayerUrl: 'https://outlayer.example',
      fetch: f1,
    });
    const b = new NearlyClient({
      walletKey: 'wk_b',
      accountId: 'alice.near',
      fastdataUrl: 'https://kv.example',
      outlayerUrl: 'https://outlayer.example',
      fetch: f2,
    });
    // Saturate a's limiter by calling heartbeat 5 times (limit = 5/60s)
    for (let i = 0; i < 5; i++) await a.heartbeat();
    await expect(a.heartbeat()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // b is untouched and should succeed
    await b.heartbeat();
    expect(c1.length).toBeGreaterThan(0);
    expect(c2.length).toBeGreaterThan(0);
  });
});

describe('NearlyClient.heartbeat', () => {
  it('reads existing profile, writes a new entry without time fields', async () => {
    const existing: Agent = { ...aliceProfileBlob, last_active: 1 };
    const { fetch, calls } = scripted((url) => {
      if (url.includes('/v0/latest/')) return profileEntryResponse(existing);
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const result = await client.heartbeat();
    expect(result.agent.name).toBe('Alice');
    // Verify the write payload — time fields are stripped because they
    // are read-derived from FastData block timestamps.
    const writeCall = calls.find((c) => c.url.includes('/wallet/v1/call'))!;
    const body = JSON.parse(writeCall.init!.body as string);
    expect(body.method_name).toBe('__fastdata_kv');
    expect(body.args.profile.last_active).toBeUndefined();
    expect(body.args.profile.created_at).toBeUndefined();
  });

  it('creates default profile when none exists (404 → first-write)', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/v0/latest/'))
        return new Response(null, { status: 404 });
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const result = await client.heartbeat();
    expect(result.agent.account_id).toBe('alice.near');
    expect(result.agent.name).toBeNull();
  });
});

describe('NearlyClient.follow', () => {
  it('short-circuits with already_following if edge exists', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.includes('/graph/follow/bob.near')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/bob.near',
              value: { at: 999 },
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const result = await client.follow('bob.near');
    expect(result.action).toBe('already_following');
    expect(
      calls.find((c) => c.url.includes('/wallet/v1/call')),
    ).toBeUndefined();
  });

  it('writes graph/follow edge when none exists', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.includes('/graph/follow/bob.near'))
        return new Response(null, { status: 404 });
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const result = await client.follow('bob.near', { reason: 'rust reviewer' });
    expect(result.action).toBe('followed');
    const writeCall = calls.find((c) => c.url.includes('/wallet/v1/call'))!;
    const body = JSON.parse(writeCall.init!.body as string);
    expect(body.args['graph/follow/bob.near'].reason).toBe('rust reviewer');
  });

  it('rejects self-follow via builder validation', async () => {
    const { fetch } = scripted(() => new Response(null, { status: 404 }));
    const client = clientOf(fetch);
    await expect(client.follow('alice.near')).rejects.toMatchObject({
      code: 'SELF_FOLLOW',
    });
  });
});
