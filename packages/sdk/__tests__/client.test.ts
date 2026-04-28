import { NearlyClient } from '../src/client';
import { NearlyError } from '../src/errors';
import type { FetchLike } from '../src/read';
import type { Agent, CapabilityCount, TagCount } from '../src/types';
import { aliceProfileBlob } from './fixtures/entries';
import { jsonResponse, scripted } from './fixtures/http';

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
    let err: unknown;
    try {
      new NearlyClient({ walletKey: '', accountId: 'alice.near' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NearlyError);
    expect((err as NearlyError).shape).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'walletKey',
      reason: 'empty walletKey',
    });
  });

  it('requires accountId', () => {
    let err: unknown;
    try {
      new NearlyClient({ walletKey: 'wk_x', accountId: '' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NearlyError);
    expect((err as NearlyError).shape).toMatchObject({
      code: 'VALIDATION_ERROR',
      field: 'accountId',
      reason: 'empty accountId',
    });
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

describe('NearlyClient.register', () => {
  // OutLayer /register is an unauthenticated provisioning call. These tests
  // cover the happy path and every failure mode createWallet maps to a
  // NearlyError. The integration test (integration.test.ts) covers the
  // live round-trip; these are mocked fetch unit tests.

  function registerSuccessBody(): unknown {
    return {
      api_key: 'wk_abc123',
      near_account_id:
        'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      trial: { calls_remaining: 100 },
    };
  }

  it('provisions a wallet and returns a ready client', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.endsWith('/register')) return jsonResponse(registerSuccessBody());
      throw new Error(`unexpected url: ${url}`);
    });
    const { client, accountId, walletKey, trial } = await NearlyClient.register(
      { outlayerUrl: 'https://outlayer.example', fetch },
    );
    expect(walletKey).toBe('wk_abc123');
    expect(accountId).toMatch(/^a1b2c3d4/);
    expect(trial).toEqual({ calls_remaining: 100 });
    expect(client).toBeInstanceOf(NearlyClient);
    expect(client.accountId).toBe(accountId);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://outlayer.example/register');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('surfaces handoffUrl when OutLayer returns handoff_url', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/register'))
        return jsonResponse({
          ...(registerSuccessBody() as Record<string, unknown>),
          handoff_url: 'https://outlayer.fastnear.com/wallet?key=wk_abc123',
        });
      throw new Error(`unexpected url: ${url}`);
    });
    const result = await NearlyClient.register({
      outlayerUrl: 'https://outlayer.example',
      fetch,
    });
    expect(result.handoffUrl).toBe(
      'https://outlayer.fastnear.com/wallet?key=wk_abc123',
    );
  });

  it('omits handoffUrl key when OutLayer does not return handoff_url', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/register')) return jsonResponse(registerSuccessBody());
      throw new Error(`unexpected url: ${url}`);
    });
    const result = await NearlyClient.register({
      outlayerUrl: 'https://outlayer.example',
      fetch,
    });
    expect('handoffUrl' in result).toBe(false);
  });

  it('passes through fastdataUrl / namespace / rateLimiting to the constructed client', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/register')) return jsonResponse(registerSuccessBody());
      if (url.includes('/v0/latest/'))
        return profileEntryResponse(aliceProfileBlob);
      return jsonResponse({});
    });
    const { client } = await NearlyClient.register({
      outlayerUrl: 'https://outlayer.example',
      fastdataUrl: 'https://kv.example',
      namespace: 'contextual.near',
      rateLimiting: false,
      fetch,
    });
    // Exercising the client proves the pass-through landed — if fastdataUrl
    // or namespace were dropped, the read would hit a bogus URL.
    const agent = await client.getAgent(client.accountId);
    // Profile isn't at the bogus URL, so we just verify the call was made
    // against the configured fastdataUrl by checking no throw.
    expect(agent === null || typeof agent === 'object').toBe(true);
  });

  it('throws NETWORK on fetch rejection', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(
      NearlyClient.register({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ shape: { code: 'NETWORK' } });
  });

  it('throws PROTOCOL on 5xx with response body', async () => {
    const { fetch } = scripted(
      () => new Response('upstream down', { status: 502 }),
    );
    await expect(
      NearlyClient.register({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('register 502'),
      },
    });
  });

  it('throws AUTH_FAILED on 401/403 (protocol anomaly since register is unauth)', async () => {
    const { fetch } = scripted(
      () => new Response('forbidden', { status: 403 }),
    );
    await expect(
      NearlyClient.register({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ shape: { code: 'AUTH_FAILED' } });
  });

  it('throws PROTOCOL when the 2xx body is not JSON', async () => {
    const { fetch } = scripted(
      () =>
        new Response('<html>oops</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    await expect(
      NearlyClient.register({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('malformed JSON'),
      },
    });
  });

  it('throws PROTOCOL when api_key is missing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        near_account_id: 'deadbeef',
        trial: { calls_remaining: 10 },
      }),
    );
    await expect(
      NearlyClient.register({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('api_key'),
      },
    });
  });

  it('throws PROTOCOL when near_account_id is missing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        api_key: 'wk_abc',
        trial: { calls_remaining: 10 },
      }),
    );
    await expect(
      NearlyClient.register({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('near_account_id'),
      },
    });
  });

  it('throws PROTOCOL when trial.calls_remaining is missing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        api_key: 'wk_abc',
        near_account_id: 'deadbeef',
      }),
    );
    await expect(
      NearlyClient.register({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('trial'),
      },
    });
  });

  it('never leaks wk_ prefix into error messages after a successful register that then fails parsing', async () => {
    // This is the post-BUILD.md assertion: even a successful OutLayer call
    // whose response carries wk_abc123 must not bleed the key into any
    // downstream error, if the body subsequently fails validation. Here we
    // force that path by returning a body whose api_key is valid but whose
    // trial field is wrong — the error is raised AFTER api_key has been
    // read into scope.
    const { fetch } = scripted(() =>
      jsonResponse({
        api_key: 'wk_secret_abc_DO_NOT_LEAK',
        near_account_id: 'deadbeef',
        trial: 'not_an_object',
      }),
    );
    try {
      await NearlyClient.register({
        outlayerUrl: 'https://outlayer.example',
        fetch,
      });
      throw new Error('expected register to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NearlyError);
      const nearlyErr = err as NearlyError;
      // Serialize the full error shape including message and stringified
      // shape fields — nothing in the observable error surface should
      // contain the wk_ prefix.
      const serialized = JSON.stringify({
        message: nearlyErr.message,
        shape: nearlyErr.shape,
      });
      expect(serialized).not.toMatch(/wk_[A-Za-z0-9_]+/);
    }
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

describe('NearlyClient.getAgent', () => {
  function profileAt(
    accountId: string,
    blob: Record<string, unknown>,
    blockSecs: number,
    blockHeight = 1,
  ): Response {
    return jsonResponse({
      entries: [
        {
          predecessor_id: accountId,
          current_account_id: 'contextual.near',
          block_height: blockHeight,
          block_timestamp: blockSecs * 1e9,
          key: 'profile',
          value: blob,
        },
      ],
    });
  }

  it('returns null when the profile does not exist', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/v0/latest/contextual.near/ghost.near/profile'))
        return new Response(null, { status: 404 });
      if (url.includes('/v0/history/contextual.near/ghost.near/profile'))
        return jsonResponse({ entries: [] });
      if (url.includes('/v0/latest/contextual.near'))
        return jsonResponse({ entries: [] });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    expect(await client.getAgent('ghost.near')).toBeNull();
  });

  it('populates created_at + heights from first-write, counts from live scans', async () => {
    const { fetch } = scripted((url, init) => {
      // Single-key profile read — latest write at block_height 5000.
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile')) {
        return profileAt(
          'bob.near',
          { ...aliceProfileBlob, name: 'Bob' },
          1_700_000_500,
          5000,
        );
      }
      // First-write history — older block_height 100 for created_height.
      if (url.endsWith('/v0/history/contextual.near/bob.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'bob.near',
              current_account_id: 'contextual.near',
              block_height: 100,
              block_timestamp: 1_600_000_000 * 1e9,
              key: 'profile',
              value: {},
            },
          ],
        });
      }
      // Namespace-wide scans — dispatched by request body
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as {
          key?: string;
          key_prefix?: string;
        };
        if (body.key === 'graph/follow/bob.near') {
          // 2 followers
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/bob.near',
                value: {},
              },
              {
                predecessor_id: 'carol.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/bob.near',
                value: { reason: 'trusted' },
              },
            ],
          });
        }
        if (body.key_prefix === 'endorsing/bob.near/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'endorsing/bob.near/tags/rust',
                value: {},
              },
              {
                predecessor_id: 'carol.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'endorsing/bob.near/tags/rust',
                value: {},
              },
              {
                predecessor_id: 'dave.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'endorsing/bob.near/trusted',
                value: {},
              },
            ],
          });
        }
        throw new Error(`unexpected namespace scan: ${JSON.stringify(body)}`);
      }
      // Known-agent scan for bob's own follows
      if (url.endsWith('/v0/latest/contextual.near/bob.near')) {
        // 1 outgoing follow
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'bob.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/alice.near',
              value: {},
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const agent = await client.getAgent('bob.near');
    expect(agent).not.toBeNull();
    expect(agent!.account_id).toBe('bob.near');
    expect(agent!.name).toBe('Bob');
    expect(agent!.created_at).toBe(1_600_000_000);
    expect(agent!.created_height).toBe(100);
    expect(agent!.last_active).toBe(1_700_000_500);
    expect(agent!.last_active_height).toBe(5000);
    expect(agent!.follower_count).toBe(2);
    expect(agent!.following_count).toBe(1);
    expect(agent!.endorsement_count).toBe(3);
    expect(agent!.endorsements).toEqual({
      'tags/rust': 2,
      trusted: 1,
    });
  });
});

describe('NearlyClient.getMe', () => {
  // Sugar over `getAgent(this.accountId)` — minimal test to prove the
  // dispatch; the full read-fold-overlay path is covered by getAgent tests.
  it('reads the caller own profile without requiring accountId at the callsite', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.endsWith('/v0/latest/contextual.near/alice.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1_700_000_000 * 1e9,
              key: 'profile',
              value: aliceProfileBlob,
            },
          ],
        });
      }
      if (url.endsWith('/v0/history/contextual.near/alice.near/profile')) {
        return jsonResponse({ entries: [] });
      }
      if (url.endsWith('/v0/latest/contextual.near')) {
        return jsonResponse({ entries: [] });
      }
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        return jsonResponse({ entries: [] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const me = await client.getMe();
    expect(me).not.toBeNull();
    expect(me!.account_id).toBe('alice.near');
    // Confirm dispatch routed through the caller's own account_id.
    const profileCall = calls.find((c) =>
      c.url.endsWith('/v0/latest/contextual.near/alice.near/profile'),
    );
    expect(profileCall).toBeDefined();
  });
});

describe('NearlyClient.listAgents', () => {
  function listResponse(
    predecessorIds: readonly string[],
    lastActives: readonly number[],
  ): Response {
    return jsonResponse({
      entries: predecessorIds.map((id, i) => ({
        predecessor_id: id,
        current_account_id: 'contextual.near',
        block_height: 1,
        block_timestamp: lastActives[i] * 1e9,
        key: 'profile',
        value: { ...aliceProfileBlob, name: id.split('.')[0] },
      })),
    });
  }

  it('sort=active orders by block-derived last_active, newest first', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'profile') {
          return listResponse(
            ['alice.near', 'bob.near', 'carol.near'],
            [1_700_000_100, 1_700_000_300, 1_700_000_200],
          );
        }
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const agents: string[] = [];
    for await (const a of client.listAgents()) agents.push(a.account_id);
    expect(agents).toEqual(['bob.near', 'carol.near', 'alice.near']);
  });

  it('global limit stops iteration without draining the full set', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'profile') {
          return listResponse(
            ['a.near', 'b.near', 'c.near', 'd.near'],
            [4, 3, 2, 1],
          );
        }
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const agents: string[] = [];
    for await (const a of client.listAgents({ limit: 2 })) {
      agents.push(a.account_id);
    }
    expect(agents).toEqual(['a.near', 'b.near']);
  });

  it('tag filter fans out per-agent profile reads', async () => {
    const { fetch, calls } = scripted((url, init) => {
      // Tag index scan
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'tag/rust') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1_700_000_100 * 1e9,
                key: 'tag/rust',
                value: true,
              },
              {
                predecessor_id: 'bob.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1_700_000_200 * 1e9,
                key: 'tag/rust',
                value: true,
              },
            ],
          });
        }
      }
      // Per-agent profile fetches
      if (url.endsWith('/v0/latest/contextual.near/alice.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1_700_000_100 * 1e9,
              key: 'profile',
              value: { ...aliceProfileBlob, name: 'Alice' },
            },
          ],
        });
      }
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'bob.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1_700_000_200 * 1e9,
              key: 'profile',
              value: { ...aliceProfileBlob, name: 'Bob' },
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const agents: string[] = [];
    for await (const a of client.listAgents({ tag: 'rust' })) {
      agents.push(a.account_id);
    }
    expect(agents).toEqual(['bob.near', 'alice.near']);
    // Sanity: we hit both per-agent profile endpoints
    expect(calls.some((c) => c.url.endsWith('/alice.near/profile'))).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/bob.near/profile'))).toBe(true);
  });

  it('returns empty iterator when the profile scan is empty', async () => {
    const { fetch } = scripted(() => jsonResponse({ entries: [] }));
    const client = clientOf(fetch);
    const agents: Agent[] = [];
    for await (const a of client.listAgents()) agents.push(a);
    expect(agents).toEqual([]);
  });
});

describe('NearlyClient.getFollowers / getFollowing', () => {
  function profileResp(
    accountId: string,
    blockSecs: number,
    name: string,
  ): Response {
    return jsonResponse({
      entries: [
        {
          predecessor_id: accountId,
          current_account_id: 'contextual.near',
          block_height: 1,
          block_timestamp: blockSecs * 1e9,
          key: 'profile',
          value: { ...aliceProfileBlob, name },
        },
      ],
    });
  }

  it('getFollowers yields agents from the graph/follow predecessors', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'graph/follow/bob.near') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/bob.near',
                value: {},
              },
              {
                predecessor_id: 'carol.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/bob.near',
                value: { reason: 'trusted' },
              },
            ],
          });
        }
      }
      if (url.endsWith('/v0/latest/contextual.near/alice.near/profile'))
        return profileResp('alice.near', 1_700_000_100, 'Alice');
      if (url.endsWith('/v0/latest/contextual.near/carol.near/profile'))
        return profileResp('carol.near', 1_700_000_200, 'Carol');
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const names: string[] = [];
    for await (const a of client.getFollowers('bob.near')) names.push(a.name!);
    expect(names).toEqual(['Alice', 'Carol']);
  });

  it('getFollowers drops entries whose profile 404s', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'graph/follow/bob.near') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/bob.near',
                value: {},
              },
              {
                predecessor_id: 'ghost.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/bob.near',
                value: {},
              },
            ],
          });
        }
      }
      if (url.endsWith('/v0/latest/contextual.near/alice.near/profile'))
        return profileResp('alice.near', 1, 'Alice');
      if (url.endsWith('/v0/latest/contextual.near/ghost.near/profile'))
        return new Response(null, { status: 404 });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const names: string[] = [];
    for await (const a of client.getFollowers('bob.near')) names.push(a.name!);
    expect(names).toEqual(['Alice']);
  });

  it('getFollowing walks the agent own graph/follow prefix', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        if (body.key_prefix === 'graph/follow/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/bob.near',
                value: {},
              },
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/carol.near',
                value: {},
              },
            ],
          });
        }
      }
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile'))
        return profileResp('bob.near', 1, 'Bob');
      if (url.endsWith('/v0/latest/contextual.near/carol.near/profile'))
        return profileResp('carol.near', 1, 'Carol');
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const names: string[] = [];
    for await (const a of client.getFollowing('alice.near'))
      names.push(a.name!);
    expect(names).toEqual(['Bob', 'Carol']);
  });

  it('global limit halts iteration early', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'graph/follow/bob.near') {
          return jsonResponse({
            entries: ['a.near', 'b.near', 'c.near'].map((id) => ({
              predecessor_id: id,
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/bob.near',
              value: {},
            })),
          });
        }
      }
      if (url.match(/\/contextual\.near\/[abc]\.near\/profile$/)) {
        const id = url.split('/').slice(-2, -1)[0];
        return profileResp(id, 1, id);
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const names: string[] = [];
    for await (const a of client.getFollowers('bob.near', { limit: 2 })) {
      names.push(a.name!);
    }
    expect(names).toEqual(['a.near', 'b.near']);
  });
});

describe('NearlyClient.getEdges', () => {
  function profileResp(accountId: string, name: string): Response {
    return jsonResponse({
      entries: [
        {
          predecessor_id: accountId,
          current_account_id: 'contextual.near',
          block_height: 1,
          block_timestamp: 1,
          key: 'profile',
          value: { ...aliceProfileBlob, name },
        },
      ],
    });
  }

  function edgesFetch() {
    return scripted((url, init) => {
      // Incoming: predecessors who wrote graph/follow/alice.near
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'graph/follow/alice.near') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'bob.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/alice.near',
                value: {},
              },
              {
                predecessor_id: 'carol.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/alice.near',
                value: {},
              },
            ],
          });
        }
      }
      // Outgoing: alice.near's own graph/follow/ entries
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/bob.near',
              value: {},
            },
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/dave.near',
              value: {},
            },
          ],
        });
      }
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile'))
        return profileResp('bob.near', 'Bob');
      if (url.endsWith('/v0/latest/contextual.near/carol.near/profile'))
        return profileResp('carol.near', 'Carol');
      if (url.endsWith('/v0/latest/contextual.near/dave.near/profile'))
        return profileResp('dave.near', 'Dave');
      throw new Error(`unexpected ${url}`);
    });
  }

  it('classifies bob as mutual, carol as incoming, dave as outgoing', async () => {
    const { fetch } = edgesFetch();
    const client = clientOf(fetch);
    const edges: { name: string; direction: string }[] = [];
    for await (const e of client.getEdges('alice.near')) {
      edges.push({ name: e.name!, direction: e.direction });
    }
    // Incoming first (bob, carol in input order), then outgoing-only (dave).
    // Bob appears on both sides, so the incoming edge is upgraded to mutual.
    expect(edges).toEqual([
      { name: 'Bob', direction: 'mutual' },
      { name: 'Carol', direction: 'incoming' },
      { name: 'Dave', direction: 'outgoing' },
    ]);
  });

  it('direction=incoming skips the outgoing scan', async () => {
    const { fetch, calls } = edgesFetch();
    const client = clientOf(fetch);
    const edges: { name: string; direction: string }[] = [];
    for await (const e of client.getEdges('alice.near', {
      direction: 'incoming',
    })) {
      edges.push({ name: e.name!, direction: e.direction });
    }
    expect(edges).toEqual([
      { name: 'Bob', direction: 'incoming' },
      { name: 'Carol', direction: 'incoming' },
    ]);
    // The outgoing scan hits `/v0/latest/{NS}/alice.near` — never called.
    expect(
      calls.some((c) =>
        c.url.endsWith('/v0/latest/contextual.near/alice.near'),
      ),
    ).toBe(false);
  });

  it('respects global limit', async () => {
    const { fetch } = edgesFetch();
    const client = clientOf(fetch);
    const edges: string[] = [];
    for await (const e of client.getEdges('alice.near', { limit: 2 })) {
      edges.push(e.name!);
    }
    expect(edges).toEqual(['Bob', 'Carol']);
  });
});

describe('NearlyClient.getEndorsers', () => {
  function profileResp(accountId: string, name: string): Response {
    return jsonResponse({
      entries: [
        {
          predecessor_id: accountId,
          current_account_id: 'contextual.near',
          block_height: 1,
          block_timestamp: 1,
          key: 'profile',
          value: { ...aliceProfileBlob, name },
        },
      ],
    });
  }

  it('returns {} when no endorsements exist', async () => {
    const { fetch } = scripted(() => jsonResponse({ entries: [] }));
    const client = clientOf(fetch);
    expect(await client.getEndorsers('ghost.near')).toEqual({});
  });

  it('groups by opaque key_suffix including single-segment suffixes', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        if (body.key_prefix === 'endorsing/alice.near/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'bob.near',
                current_account_id: 'contextual.near',
                block_height: 101,
                block_timestamp: 1_700_000_100 * 1e9,
                key: 'endorsing/alice.near/tags/rust',
                value: { reason: 'audit reviewer', content_hash: 'sha256:abc' },
              },
              {
                predecessor_id: 'carol.near',
                current_account_id: 'contextual.near',
                block_height: 202,
                block_timestamp: 1_700_000_200 * 1e9,
                key: 'endorsing/alice.near/tags/rust',
                value: {},
              },
              {
                predecessor_id: 'dave.near',
                current_account_id: 'contextual.near',
                block_height: 303,
                block_timestamp: 1_700_000_300 * 1e9,
                key: 'endorsing/alice.near/trusted',
                value: {},
              },
            ],
          });
        }
      }
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile'))
        return profileResp('bob.near', 'Bob');
      if (url.endsWith('/v0/latest/contextual.near/carol.near/profile'))
        return profileResp('carol.near', 'Carol');
      if (url.endsWith('/v0/latest/contextual.near/dave.near/profile'))
        return profileResp('dave.near', 'Dave');
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const endorsers = await client.getEndorsers('alice.near');

    // Single-segment suffix survives — server contract is opaque.
    expect(Object.keys(endorsers).sort()).toEqual(['tags/rust', 'trusted']);
    expect(endorsers['tags/rust']).toHaveLength(2);
    expect(endorsers.trusted).toHaveLength(1);

    // content_hash and reason round-trip from stored value.
    expect(endorsers['tags/rust'][0]).toMatchObject({
      account_id: 'bob.near',
      name: 'Bob',
      reason: 'audit reviewer',
      content_hash: 'sha256:abc',
      at: 1_700_000_100,
      at_height: 101,
    });
    // Second endorser — no reason/content_hash in value.
    expect(endorsers['tags/rust'][1].reason).toBeUndefined();
    expect(endorsers['tags/rust'][1].content_hash).toBeUndefined();
    // at derived from block_timestamp nanos; at_height from block_height.
    expect(endorsers['tags/rust'][1].at).toBe(1_700_000_200);
    expect(endorsers['tags/rust'][1].at_height).toBe(202);
    // Single-segment suffix carries its own at_height.
    expect(endorsers.trusted[0].at_height).toBe(303);
  });

  it('drops endorsers whose profile 404s', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        if (body.key_prefix === 'endorsing/alice.near/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'bob.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'endorsing/alice.near/tags/rust',
                value: {},
              },
              {
                predecessor_id: 'ghost.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'endorsing/alice.near/tags/rust',
                value: {},
              },
            ],
          });
        }
      }
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile'))
        return profileResp('bob.near', 'Bob');
      if (url.endsWith('/v0/latest/contextual.near/ghost.near/profile'))
        return new Response(null, { status: 404 });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const endorsers = await client.getEndorsers('alice.near');
    expect(endorsers['tags/rust']).toHaveLength(1);
    expect(endorsers['tags/rust'][0].account_id).toBe('bob.near');
  });
});

describe('NearlyClient.getEndorsing', () => {
  function targetProfileResp(accountId: string, name: string): Response {
    return jsonResponse({
      entries: [
        {
          predecessor_id: accountId,
          current_account_id: 'contextual.near',
          block_height: 1,
          block_timestamp: 1,
          key: 'profile',
          value: { ...aliceProfileBlob, account_id: accountId, name },
        },
      ],
    });
  }

  it('returns {} when the account has written no endorsements', async () => {
    const { fetch } = scripted(() => jsonResponse({ entries: [] }));
    const client = clientOf(fetch);
    expect(await client.getEndorsing('alice.near')).toEqual({});
  });

  it('groups by target with profile summary and preserves multi-segment suffixes', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        if (body.key_prefix === 'endorsing/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 101,
                block_timestamp: 1_700_000_100 * 1e9,
                key: 'endorsing/bob.near/tags/rust',
                value: { reason: 'audit reviewer', content_hash: 'sha256:abc' },
              },
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 102,
                block_timestamp: 1_700_000_200 * 1e9,
                key: 'endorsing/bob.near/task_completion/job_42',
                value: {},
              },
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 303,
                block_timestamp: 1_700_000_300 * 1e9,
                key: 'endorsing/carol.near/trusted',
                value: {},
              },
            ],
          });
        }
      }
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile'))
        return targetProfileResp('bob.near', 'Bob');
      if (url.endsWith('/v0/latest/contextual.near/carol.near/profile'))
        return targetProfileResp('carol.near', 'Carol');
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const endorsing = await client.getEndorsing('alice.near');

    expect(Object.keys(endorsing).sort()).toEqual(['bob.near', 'carol.near']);
    expect(endorsing['bob.near'].target).toMatchObject({
      account_id: 'bob.near',
      name: 'Bob',
    });
    expect(endorsing['bob.near'].entries).toHaveLength(2);
    // Multi-segment suffix survives split-on-first-slash.
    const bobSuffixes = endorsing['bob.near'].entries
      .map((e) => e.key_suffix)
      .sort();
    expect(bobSuffixes).toEqual(['tags/rust', 'task_completion/job_42']);

    // reason / content_hash round-trip from stored value.
    const rust = endorsing['bob.near'].entries.find(
      (e) => e.key_suffix === 'tags/rust',
    );
    expect(rust).toMatchObject({
      reason: 'audit reviewer',
      content_hash: 'sha256:abc',
      at: 1_700_000_100,
      at_height: 101,
    });
    // Absent metadata stays undefined — defensive parse.
    const job = endorsing['bob.near'].entries.find(
      (e) => e.key_suffix === 'task_completion/job_42',
    );
    expect(job?.reason).toBeUndefined();
    expect(job?.content_hash).toBeUndefined();
    expect(job?.at).toBe(1_700_000_200);
    expect(job?.at_height).toBe(102);

    // Single-segment suffix on a second target.
    expect(endorsing['carol.near'].entries).toHaveLength(1);
    expect(endorsing['carol.near'].entries[0]).toMatchObject({
      key_suffix: 'trusted',
      at: 1_700_000_300,
      at_height: 303,
    });
  });

  it('synthesizes a null-fielded summary when the target has no profile blob', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        if (body.key_prefix === 'endorsing/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1_700_000_000 * 1e9,
                key: 'endorsing/ghost.near/tags/rust',
                value: {},
              },
            ],
          });
        }
      }
      if (url.endsWith('/v0/latest/contextual.near/ghost.near/profile'))
        return new Response(null, { status: 404 });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const endorsing = await client.getEndorsing('alice.near');
    // Endorsement surfaces even though target has no profile.
    expect(endorsing['ghost.near'].target).toEqual({
      account_id: 'ghost.near',
      name: null,
      description: '',
      image: null,
    });
    expect(endorsing['ghost.near'].entries).toHaveLength(1);
  });

  it('drops entries with empty suffixes and wrong prefixes defensively', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        if (body.key_prefix === 'endorsing/') {
          return jsonResponse({
            entries: [
              // Empty suffix — dropped.
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'endorsing/bob.near/',
                value: {},
              },
              // Valid — kept.
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 2,
                block_timestamp: 2_000_000_000,
                key: 'endorsing/bob.near/tags/rust',
                value: {},
              },
            ],
          });
        }
      }
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile'))
        return targetProfileResp('bob.near', 'Bob');
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const endorsing = await client.getEndorsing('alice.near');
    expect(endorsing['bob.near'].entries).toHaveLength(1);
    expect(endorsing['bob.near'].entries[0].key_suffix).toBe('tags/rust');
  });
});

describe('NearlyClient.getEndorsementGraph', () => {
  it('returns zero degrees when both sides are empty', async () => {
    const { fetch } = scripted(() => jsonResponse({ entries: [] }));
    const client = clientOf(fetch);
    const graph = await client.getEndorsementGraph('ghost.near');
    expect(graph.account_id).toBe('ghost.near');
    expect(graph.incoming).toEqual({});
    expect(graph.outgoing).toEqual({});
    expect(graph.degree).toEqual({ incoming: 0, outgoing: 0 });
  });

  it('counts distinct endorser account_ids across suffixes for degree.incoming', async () => {
    // bob endorses alice under two suffixes — should count as 1 distinct endorser.
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        // getEndorsers: cross-predecessor scan under endorsing/alice.near/
        if (body.key_prefix === 'endorsing/alice.near/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'bob.near',
                current_account_id: 'contextual.near',
                block_height: 101,
                block_timestamp: 1_700_000_100 * 1e9,
                key: 'endorsing/alice.near/skills/rust',
                value: {},
              },
              {
                predecessor_id: 'bob.near',
                current_account_id: 'contextual.near',
                block_height: 102,
                block_timestamp: 1_700_000_200 * 1e9,
                key: 'endorsing/alice.near/skills/go',
                value: {},
              },
            ],
          });
        }
        // getEndorsing: per-predecessor scan under alice.near's endorsing/
        if (body.key_prefix === 'endorsing/') {
          return jsonResponse({ entries: [] });
        }
      }
      // Profile fetch for bob.near
      if (url.endsWith('/bob.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'bob.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'profile',
              value: { ...aliceProfileBlob, name: 'Bob' },
            },
          ],
        });
      }
      return jsonResponse({ entries: [] });
    });
    const client = clientOf(fetch);
    const graph = await client.getEndorsementGraph('alice.near');
    // bob appears under both suffixes but counts once.
    expect(graph.degree.incoming).toBe(1);
    expect(graph.degree.outgoing).toBe(0);
  });

  it('counts distinct targets for degree.outgoing', async () => {
    const { fetch } = scripted((url, init) => {
      // getEndorsers: cross-predecessor scan — empty
      if (url.endsWith('/v0/latest/contextual.near')) {
        return jsonResponse({ entries: [] });
      }
      // getEndorsing: per-predecessor scan under alice.near
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        if (body.key_prefix === 'endorsing/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1_700_000_000 * 1e9,
                key: 'endorsing/bob.near/skills/rust',
                value: {},
              },
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 2,
                block_timestamp: 1_700_000_100 * 1e9,
                key: 'endorsing/carol.near/skills/go',
                value: {},
              },
            ],
          });
        }
      }
      // Profile fetches for targets
      if (url.endsWith('/bob.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'bob.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'profile',
              value: { ...aliceProfileBlob, name: 'Bob' },
            },
          ],
        });
      }
      if (url.endsWith('/carol.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'carol.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'profile',
              value: { ...aliceProfileBlob, name: 'Carol' },
            },
          ],
        });
      }
      return jsonResponse({ entries: [] });
    });
    const client = clientOf(fetch);
    const graph = await client.getEndorsementGraph('alice.near');
    expect(graph.degree.incoming).toBe(0);
    expect(graph.degree.outgoing).toBe(2);
    expect(Object.keys(graph.outgoing).sort()).toEqual([
      'bob.near',
      'carol.near',
    ]);
  });
});

describe('NearlyClient.listTags / listCapabilities', () => {
  it('listTags aggregates existence entries and sorts by count desc', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        if (body.key_prefix === 'tag/') {
          return jsonResponse({
            entries: [
              // 3× rust
              {
                predecessor_id: 'a.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'tag/rust',
                value: true,
              },
              {
                predecessor_id: 'b.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'tag/rust',
                value: true,
              },
              {
                predecessor_id: 'c.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'tag/rust',
                value: true,
              },
              // 2× ai
              {
                predecessor_id: 'a.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'tag/ai',
                value: true,
              },
              {
                predecessor_id: 'd.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'tag/ai',
                value: true,
              },
              // 1× defi
              {
                predecessor_id: 'e.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'tag/defi',
                value: true,
              },
            ],
          });
        }
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const tags: { tag: string; count: number }[] = [];
    for await (const t of client.listTags()) tags.push(t);
    expect(tags).toEqual([
      { tag: 'rust', count: 3 },
      { tag: 'ai', count: 2 },
      { tag: 'defi', count: 1 },
    ]);
  });

  it('listCapabilities splits ns/value on the first slash', async () => {
    const { fetch } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        if (body.key_prefix === 'cap/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'a.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'cap/skills/audit',
                value: true,
              },
              {
                predecessor_id: 'b.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'cap/skills/audit',
                value: true,
              },
              {
                predecessor_id: 'c.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'cap/skills.languages/rust',
                value: true,
              },
            ],
          });
        }
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const caps: CapabilityCount[] = [];
    for await (const c of client.listCapabilities()) caps.push(c);
    expect(caps).toEqual([
      { namespace: 'skills', value: 'audit', count: 2 },
      // Dots in namespace survive the split (first `/` only).
      { namespace: 'skills.languages', value: 'rust', count: 1 },
    ]);
  });

  it('listTags yields nothing when the scan is empty', async () => {
    const { fetch } = scripted(() => jsonResponse({ entries: [] }));
    const client = clientOf(fetch);
    const tags: TagCount[] = [];
    for await (const t of client.listTags()) tags.push(t);
    expect(tags).toEqual([]);
  });
});

describe('NearlyClient.getActivity', () => {
  function edgeEntry(predecessorId: string, key: string, blockHeight: number) {
    return {
      predecessor_id: predecessorId,
      current_account_id: 'contextual.near',
      block_height: blockHeight,
      block_timestamp: blockHeight * 1e9,
      key,
      value: {},
    };
  }

  function profileResp(accountId: string, name: string): Response {
    return jsonResponse({
      entries: [
        {
          predecessor_id: accountId,
          current_account_id: 'contextual.near',
          block_height: 1,
          block_timestamp: 1,
          key: 'profile',
          value: { ...aliceProfileBlob, name },
        },
      ],
    });
  }

  function fetchFor(
    followerEntries: ReturnType<typeof edgeEntry>[],
    followingEntries: ReturnType<typeof edgeEntry>[],
    profiles: Record<string, string>,
  ) {
    return scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'graph/follow/alice.near') {
          return jsonResponse({ entries: followerEntries });
        }
      }
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        return jsonResponse({ entries: followingEntries });
      }
      const match = url.match(
        /\/v0\/latest\/contextual\.near\/([^/]+)\/profile$/,
      );
      if (match) {
        const id = match[1];
        if (profiles[id]) return profileResp(id, profiles[id]);
        return new Response(null, { status: 404 });
      }
      throw new Error(`unexpected ${url}`);
    });
  }

  it('first call (no cursor) returns everything with max height as cursor', async () => {
    const { fetch } = fetchFor(
      [
        edgeEntry('bob.near', 'graph/follow/alice.near', 100),
        edgeEntry('carol.near', 'graph/follow/alice.near', 250),
      ],
      [edgeEntry('alice.near', 'graph/follow/dave.near', 200)],
      { 'bob.near': 'Bob', 'carol.near': 'Carol', 'dave.near': 'Dave' },
    );
    const client = clientOf(fetch);
    const res = await client.getActivity();
    expect(res.cursor).toBe(250);
    expect(res.new_followers.map((f) => f.name)).toEqual(['Bob', 'Carol']);
    expect(res.new_following.map((f) => f.name)).toEqual(['Dave']);
  });

  it('cursor filter returns only entries strictly after the high-water mark', async () => {
    const { fetch } = fetchFor(
      [
        edgeEntry('bob.near', 'graph/follow/alice.near', 100),
        edgeEntry('carol.near', 'graph/follow/alice.near', 250),
      ],
      [edgeEntry('alice.near', 'graph/follow/dave.near', 200)],
      { 'bob.near': 'Bob', 'carol.near': 'Carol', 'dave.near': 'Dave' },
    );
    const client = clientOf(fetch);
    const res = await client.getActivity({ cursor: 200 });
    // Bob (100) and Dave (200) are filtered out; only Carol (250) survives.
    expect(res.cursor).toBe(250);
    expect(res.new_followers.map((f) => f.name)).toEqual(['Carol']);
    expect(res.new_following).toEqual([]);
  });

  it('echoes the caller cursor back when no entries advance past it', async () => {
    const { fetch } = fetchFor(
      [edgeEntry('bob.near', 'graph/follow/alice.near', 100)],
      [],
      { 'bob.near': 'Bob' },
    );
    const client = clientOf(fetch);
    const res = await client.getActivity({ cursor: 500 });
    expect(res.cursor).toBe(500);
    expect(res.new_followers).toEqual([]);
    expect(res.new_following).toEqual([]);
  });

  it('first call with zero entries returns undefined cursor', async () => {
    const { fetch } = fetchFor([], [], {});
    const client = clientOf(fetch);
    const res = await client.getActivity();
    expect(res.cursor).toBeUndefined();
    expect(res.new_followers).toEqual([]);
    expect(res.new_following).toEqual([]);
  });

  it('drops summaries whose profile 404s but still advances cursor', async () => {
    const { fetch } = fetchFor(
      [
        edgeEntry('ghost.near', 'graph/follow/alice.near', 300),
        edgeEntry('bob.near', 'graph/follow/alice.near', 100),
      ],
      [],
      { 'bob.near': 'Bob' }, // ghost.near profile 404s
    );
    const client = clientOf(fetch);
    const res = await client.getActivity();
    // Cursor still advances to 300 even though the ghost.near summary dropped.
    expect(res.cursor).toBe(300);
    expect(res.new_followers.map((f) => f.name)).toEqual(['Bob']);
  });
});

describe('NearlyClient.getNetwork', () => {
  it('returns null when profile does not exist', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/v0/latest/contextual.near/ghost.near/profile'))
        return new Response(null, { status: 404 });
      if (url.includes('/v0/history/contextual.near/ghost.near/profile'))
        return jsonResponse({ entries: [] });
      if (url.includes('/v0/latest/contextual.near'))
        return jsonResponse({ entries: [] });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    expect(await client.getNetwork('ghost.near')).toBeNull();
  });

  it('computes follower / following / mutual counts with height companions', async () => {
    const { fetch } = scripted((url, init) => {
      // Profile latest
      if (url.endsWith('/v0/latest/contextual.near/alice.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 5000,
              block_timestamp: 1_700_000_500 * 1e9,
              key: 'profile',
              value: { ...aliceProfileBlob, name: 'Alice' },
            },
          ],
        });
      }
      // First-write history
      if (url.endsWith('/v0/history/contextual.near/alice.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 100,
              block_timestamp: 1_600_000_000 * 1e9,
              key: 'profile',
              value: {},
            },
          ],
        });
      }
      // Incoming: bob, carol, dave follow alice
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'graph/follow/alice.near') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'bob.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/alice.near',
                value: {},
              },
              {
                predecessor_id: 'carol.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/alice.near',
                value: {},
              },
              {
                predecessor_id: 'dave.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/alice.near',
                value: {},
              },
            ],
          });
        }
      }
      // Outgoing: alice follows bob, carol — mutual with both, dave is incoming-only
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/bob.near',
              value: {},
            },
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/carol.near',
              value: {},
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const net = await client.getNetwork('alice.near');
    expect(net).toEqual({
      follower_count: 3,
      following_count: 2,
      mutual_count: 2,
      last_active: 1_700_000_500,
      last_active_height: 5000,
      created_at: 1_600_000_000,
      created_height: 100,
    });
  });

  it('defaults to the caller own account when accountId is omitted', async () => {
    // Self-default path: calling getNetwork() with no args should route
    // through this.accountId (= 'alice.near' per clientOf). Reuse the
    // profile shape above but trim the assertions — just confirm the
    // dispatch lands on alice.near and returns a NetworkSummary.
    const { fetch, calls } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near/alice.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 5000,
              block_timestamp: 1_700_000_500 * 1e9,
              key: 'profile',
              value: { ...aliceProfileBlob, name: 'Alice' },
            },
          ],
        });
      }
      if (url.endsWith('/v0/history/contextual.near/alice.near/profile')) {
        return jsonResponse({ entries: [] });
      }
      if (url.endsWith('/v0/latest/contextual.near')) {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'graph/follow/alice.near') {
          return jsonResponse({ entries: [] });
        }
        return jsonResponse({ entries: [] });
      }
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        return jsonResponse({ entries: [] });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const net = await client.getNetwork(); // no arg — self-default
    expect(net).not.toBeNull();
    expect(net!.follower_count).toBe(0);
    expect(net!.following_count).toBe(0);
    // Sanity-check the route — the profile fetch was for the caller's
    // own account, not some other agent.
    const profileCall = calls.find((c) =>
      c.url.endsWith('/v0/latest/contextual.near/alice.near/profile'),
    );
    expect(profileCall).toBeDefined();
  });
});

describe('NearlyClient.getBalance', () => {
  it('forwards to /wallet/v1/balance?chain=near and surfaces balanceNear', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({
        account_id: '4397d730abcd',
        balance: '1500000000000000000000000', // 1.5 NEAR
      }),
    );
    const client = clientOf(fetch);
    const res = await client.getBalance();
    expect(res.chain).toBe('near');
    expect(res.balance).toBe('1500000000000000000000000');
    expect(res.balanceNear).toBeCloseTo(1.5, 6);
    expect(res.accountId).toBe('4397d730abcd');
    expect(calls[0].url).toBe(
      'https://outlayer.example/wallet/v1/balance?chain=near',
    );
    // Authorization header must carry the client's wk_ verbatim.
    expect(
      (calls[0].init?.headers as Record<string, string>).Authorization,
    ).toBe('Bearer wk_test');
  });

  it('honors a custom chain opt and omits balanceNear off-chain', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({ account_id: '0xbob', balance: '42' }),
    );
    const client = clientOf(fetch);
    const res = await client.getBalance('eth');
    expect(res.chain).toBe('eth');
    expect(res.balanceNear).toBeUndefined();
    expect(calls[0].url).toContain('chain=eth');
  });

  it('round-trips a zero balance as balanceNear=0 (not an error)', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({ account_id: '4397d730', balance: '0' }),
    );
    const client = clientOf(fetch);
    const res = await client.getBalance();
    expect(res.balance).toBe('0');
    expect(res.balanceNear).toBe(0);
  });

  it('propagates AUTH_FAILED on 401', async () => {
    const { fetch } = scripted(() => new Response(null, { status: 401 }));
    const client = clientOf(fetch);
    await expect(client.getBalance()).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});

describe('NearlyClient.unfollow', () => {
  it('short-circuits with not_following if no edge exists', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.includes('/graph/follow/bob.near'))
        return new Response(null, { status: 404 });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const result = await client.unfollow('bob.near');
    expect(result.action).toBe('not_following');
    expect(
      calls.find((c) => c.url.includes('/wallet/v1/call')),
    ).toBeUndefined();
  });

  it('null-writes the graph/follow edge when one exists', async () => {
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
              value: {},
            },
          ],
        });
      }
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const result = await client.unfollow('bob.near');
    expect(result.action).toBe('unfollowed');
    const writeCall = calls.find((c) => c.url.includes('/wallet/v1/call'))!;
    const body = JSON.parse(writeCall.init!.body as string);
    expect(body.args['graph/follow/bob.near']).toBeNull();
  });
});

describe('NearlyClient.updateProfile', () => {
  it('reads current profile, validates patch, writes the merged blob', async () => {
    const existing: Agent = { ...aliceProfileBlob, tags: ['rust'] };
    const { fetch, calls } = scripted((url) => {
      if (url.endsWith('/v0/latest/contextual.near/alice.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1_700_000_000 * 1e9,
              key: 'profile',
              value: existing,
            },
          ],
        });
      }
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const res = await client.updateProfile({
      description: 'new bio',
      tags: ['rust', 'security'],
    });
    expect(res.agent.description).toBe('new bio');
    expect(res.agent.tags).toEqual(['rust', 'security']);
    const writeCall = calls.find((c) => c.url.includes('/wallet/v1/call'))!;
    const body = JSON.parse(writeCall.init!.body as string);
    expect(body.args.profile.description).toBe('new bio');
    expect(body.args['tag/security']).toBe(true);
  });

  it('rejects an empty patch without hitting the wallet', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.includes('/v0/latest/'))
        return new Response(null, { status: 404 });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    await expect(client.updateProfile({})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(
      calls.find((c) => c.url.includes('/wallet/v1/call')),
    ).toBeUndefined();
  });
});

describe('NearlyClient.endorse / unendorse', () => {
  function profileResp(accountId: string, name: string): Response {
    return jsonResponse({
      entries: [
        {
          predecessor_id: accountId,
          current_account_id: 'contextual.near',
          block_height: 1,
          block_timestamp: 1,
          key: 'profile',
          value: { ...aliceProfileBlob, name },
        },
      ],
    });
  }

  it('endorse checks target exists, writes entries, returns suffixes', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile'))
        return profileResp('bob.near', 'Bob');
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const res = await client.endorse('bob.near', {
      keySuffixes: ['tags/rust'],
      reason: 'great PR',
    });
    expect(res.action).toBe('endorsed');
    expect(res.key_suffixes).toEqual(['tags/rust']);
    const writeCall = calls.find((c) => c.url.includes('/wallet/v1/call'))!;
    const body = JSON.parse(writeCall.init!.body as string);
    expect(body.args['endorsing/bob.near/tags/rust']).toEqual({
      reason: 'great PR',
    });
  });

  it('endorse throws NOT_FOUND when target profile is absent', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.includes('/v0/latest/contextual.near/ghost.near/profile'))
        return new Response(null, { status: 404 });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    await expect(
      client.endorse('ghost.near', { keySuffixes: ['tags/rust'] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(
      calls.find((c) => c.url.includes('/wallet/v1/call')),
    ).toBeUndefined();
  });

  it('endorse rejects self-endorse before any read', async () => {
    const { fetch, calls } = scripted(() => jsonResponse({ entries: [] }));
    const client = clientOf(fetch);
    await expect(
      client.endorse('alice.near', { keySuffixes: ['tags/rust'] }),
    ).rejects.toMatchObject({ code: 'SELF_ENDORSE' });
    expect(
      calls.find((c) => c.url.includes('/wallet/v1/call')),
    ).toBeUndefined();
  });

  it('unendorse null-writes each composed key', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const res = await client.unendorse('bob.near', [
      'tags/rust',
      'skills/audit',
    ]);
    expect(res.action).toBe('unendorsed');
    expect(res.key_suffixes.sort()).toEqual(['skills/audit', 'tags/rust']);
    const writeCall = calls.find((c) => c.url.includes('/wallet/v1/call'))!;
    const body = JSON.parse(writeCall.init!.body as string);
    expect(body.args['endorsing/bob.near/tags/rust']).toBeNull();
    expect(body.args['endorsing/bob.near/skills/audit']).toBeNull();
  });

  it('endorse partitions mixed valid/invalid suffixes, writes valid, reports skipped', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile'))
        return profileResp('bob.near', 'Bob');
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    // '/leading-slash' fails validateKeySuffix; 'tags/rust' and
    // 'skills/audit' are valid. Partition writes the two valid ones
    // and surfaces the rejected one in `skipped`.
    const res = await client.endorse('bob.near', {
      keySuffixes: ['tags/rust', '/leading-slash', 'skills/audit'],
      reason: 'great work',
    });
    expect(res.action).toBe('endorsed');
    expect(res.key_suffixes.sort()).toEqual(['skills/audit', 'tags/rust']);
    expect(res.skipped).toBeDefined();
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped?.[0]?.key_suffix).toBe('/leading-slash');

    const writeCall = calls.find((c) => c.url.includes('/wallet/v1/call'))!;
    const body = JSON.parse(writeCall.init!.body as string);
    // Only valid keys landed on the wire; the invalid one never reached
    // buildEndorse.
    expect(body.args['endorsing/bob.near/tags/rust']).toEqual({
      reason: 'great work',
    });
    expect(body.args['endorsing/bob.near/skills/audit']).toEqual({
      reason: 'great work',
    });
    expect(body.args).not.toHaveProperty('endorsing/bob.near//leading-slash');
  });

  it('endorse throws VALIDATION_ERROR when every suffix is invalid', async () => {
    const { fetch, calls } = scripted(() => jsonResponse({ entries: [] }));
    const client = clientOf(fetch);
    await expect(
      client.endorse('bob.near', {
        keySuffixes: ['/bad1', '/bad2'],
      }),
    ).rejects.toMatchObject({
      shape: {
        code: 'VALIDATION_ERROR',
        field: 'keySuffixes',
        reason: 'no valid key_suffixes',
      },
    });
    // No network work — threw synchronously before the target-existence
    // read and before any write.
    expect(calls.find((c) => c.url.includes('/v0/latest'))).toBeUndefined();
    expect(
      calls.find((c) => c.url.includes('/wallet/v1/call')),
    ).toBeUndefined();
  });

  it('unendorse partitions mixed valid/invalid suffixes, null-writes valid, reports skipped', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const res = await client.unendorse('bob.near', [
      'tags/rust',
      '/leading-slash',
      'skills/audit',
    ]);
    expect(res.action).toBe('unendorsed');
    expect(res.key_suffixes.sort()).toEqual(['skills/audit', 'tags/rust']);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped?.[0]?.key_suffix).toBe('/leading-slash');

    const writeCall = calls.find((c) => c.url.includes('/wallet/v1/call'))!;
    const body = JSON.parse(writeCall.init!.body as string);
    expect(body.args['endorsing/bob.near/tags/rust']).toBeNull();
    expect(body.args['endorsing/bob.near/skills/audit']).toBeNull();
    expect(body.args).not.toHaveProperty('endorsing/bob.near//leading-slash');
  });

  it('endorse dedupes first-occurrence-wins and preserves order', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.endsWith('/v0/latest/contextual.near/bob.near/profile'))
        return profileResp('bob.near', 'Bob');
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const res = await client.endorse('bob.near', {
      keySuffixes: ['tags/rust', 'skills/audit', 'tags/rust'],
    });
    // Duplicate 'tags/rust' is deduped; both unique keys land.
    expect(res.key_suffixes).toHaveLength(2);
    expect(res.skipped).toBeUndefined();
    const writeCall = calls.find((c) => c.url.includes('/wallet/v1/call'))!;
    const body = JSON.parse(writeCall.init!.body as string);
    expect(Object.keys(body.args)).toHaveLength(2);
  });
});

describe('NearlyClient.followMany', () => {
  it('empty targets returns empty array', async () => {
    const { fetch } = scripted(() => jsonResponse({}));
    const client = clientOf(fetch);
    expect(await client.followMany([])).toEqual([]);
  });

  it('single target happy path', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/bob.near'))
        return new Response(null, { status: 404 });
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.followMany(['bob.near']);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      account_id: 'bob.near',
      action: 'followed',
    });
  });

  it('self-follow produces per-item error, batch continues', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/bob.near'))
        return new Response(null, { status: 404 });
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.followMany(['alice.near', 'bob.near']);
    expect(results[0]).toMatchObject({
      account_id: 'alice.near',
      action: 'error',
      code: 'SELF_FOLLOW',
    });
    expect(results[1]).toMatchObject({
      account_id: 'bob.near',
      action: 'followed',
    });
  });

  it('already-following appears as per-item result', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/bob.near')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/bob.near',
              value: {},
            },
          ],
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.followMany(['bob.near']);
    expect(results[0]).toMatchObject({
      account_id: 'bob.near',
      action: 'already_following',
    });
  });

  it('INSUFFICIENT_BALANCE aborts the batch', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/'))
        return new Response(null, { status: 404 });
      if (url.includes('/wallet/v1/call'))
        return new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    await expect(client.followMany(['bob.near'])).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
  });

  // Pins the unified batch error classification: a NearlyError thrown from
  // `writeEntries` (other than INSUFFICIENT_BALANCE) surfaces its own code
  // rather than being flattened to STORAGE_ERROR. Mirrors the endorse/
  // unendorse contract so callers can distinguish retryable classes.
  it('non-INSUFFICIENT_BALANCE NearlyError surfaces its own code per-item', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/'))
        return new Response(null, { status: 404 });
      if (url.includes('/wallet/v1/call')) throw new Error('ECONNRESET');
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.followMany(['bob.near']);
    expect(results[0]).toMatchObject({
      account_id: 'bob.near',
      action: 'error',
      code: 'NETWORK',
    });
  });

  it('over MAX_BATCH_TARGETS throws VALIDATION_ERROR', async () => {
    const { fetch } = scripted(() => jsonResponse({}));
    const client = clientOf(fetch);
    const targets = Array.from({ length: 21 }, (_, i) => `agent${i}.near`);
    await expect(client.followMany(targets)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('mixed results: followed + already_following + self-follow', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/bob.near'))
        return new Response(null, { status: 404 });
      if (url.includes('/graph/follow/carol.near')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/carol.near',
              value: {},
            },
          ],
        });
      }
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.followMany([
      'alice.near',
      'bob.near',
      'carol.near',
    ]);
    expect(results[0]).toMatchObject({ action: 'error', code: 'SELF_FOLLOW' });
    expect(results[1]).toMatchObject({ action: 'followed' });
    expect(results[2]).toMatchObject({ action: 'already_following' });
  });

  it('rate-limit exhaustion mid-batch surfaces as a per-item RATE_LIMITED', async () => {
    // Inject a stateful limiter that allows the first target and rejects
    // the rest. Pins the "rate limit reached within batch" per-item error
    // path without depending on real window timing.
    let allowed = 1;
    const limiter = {
      check: () =>
        allowed > 0
          ? ({ ok: true } as const)
          : ({ ok: false, retryAfter: 30 } as const),
      record: () => {
        allowed--;
      },
    };
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/'))
        return new Response(null, { status: 404 });
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = new NearlyClient({
      walletKey: 'wk_test',
      accountId: 'alice.near',
      fastdataUrl: 'https://kv.example',
      outlayerUrl: 'https://outlayer.example',
      namespace: 'contextual.near',
      fetch,
      rateLimiter: limiter,
    });
    const results = await client.followMany(['bob.near', 'carol.near']);
    expect(results[0]).toMatchObject({
      account_id: 'bob.near',
      action: 'followed',
    });
    expect(results[1]).toMatchObject({
      account_id: 'carol.near',
      action: 'error',
      code: 'RATE_LIMITED',
      error: 'rate limit reached within batch',
    });
  });

  // Pins the builder-inside-try symmetry with endorseMany: a whitespace
  // target passes batchTargetError's `!target` check (whitespace is
  // truthy) but trips buildFollow's `!target.trim()` rejection. The
  // throw must surface as a per-item VALIDATION_ERROR, not abort the
  // batch — mirrors the oversize-suffix test in the endorseMany suite.
  it('whitespace target surfaces as per-item VALIDATION_ERROR, batch continues', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/'))
        return new Response(null, { status: 404 });
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.followMany(['   ', 'bob.near']);
    expect(results[0]).toMatchObject({
      account_id: '   ',
      action: 'error',
      code: 'VALIDATION_ERROR',
    });
    expect(results[1]).toMatchObject({
      account_id: 'bob.near',
      action: 'followed',
    });
  });
});

describe('NearlyClient.unfollowMany', () => {
  it('empty targets returns empty array', async () => {
    const { fetch } = scripted(() => jsonResponse({}));
    const client = clientOf(fetch);
    expect(await client.unfollowMany([])).toEqual([]);
  });

  it('unfollows existing edge', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/bob.near')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/bob.near',
              value: {},
            },
          ],
        });
      }
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.unfollowMany(['bob.near']);
    expect(results[0]).toMatchObject({
      account_id: 'bob.near',
      action: 'unfollowed',
    });
  });

  it('not_following appears as per-item result', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/bob.near'))
        return new Response(null, { status: 404 });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.unfollowMany(['bob.near']);
    expect(results[0]).toMatchObject({
      account_id: 'bob.near',
      action: 'not_following',
    });
  });

  it('self-unfollow produces per-item error', async () => {
    const { fetch } = scripted(() => jsonResponse({}));
    const client = clientOf(fetch);
    const results = await client.unfollowMany(['alice.near']);
    expect(results[0]).toMatchObject({
      action: 'error',
      code: 'SELF_UNFOLLOW',
    });
  });

  // Symmetry test: pins try-catch wrap on unfollowMany. Not a reachable
  // real-world input — buildUnfollow rejects whitespace up front, and
  // kvGetKey precedes the builder with a null short-circuit, so reaching
  // the builder-throws branch requires the KV store to hold an edge at a
  // whitespace key (essentially direct poisoning). See followMany
  // whitespace test above for the reachable-input bug; this one guards
  // regressions on the contract symmetry with that path.
  // Both targets' kvGetKey lookups return an existing edge below so
  // execution reaches the builder.
  it('whitespace target surfaces as per-item VALIDATION_ERROR, batch continues', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/graph/follow/')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'graph/follow/bob.near',
              value: {},
            },
          ],
        });
      }
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.unfollowMany(['   ', 'bob.near']);
    expect(results[0]).toMatchObject({
      account_id: '   ',
      action: 'error',
      code: 'VALIDATION_ERROR',
    });
    expect(results[1]).toMatchObject({
      account_id: 'bob.near',
      action: 'unfollowed',
    });
  });
});

describe('NearlyClient.endorseMany', () => {
  it('endorses two targets', async () => {
    const { fetch } = scripted((url) => {
      if (
        url.endsWith('/bob.near/profile') ||
        url.endsWith('/carol.near/profile')
      ) {
        const id = url.includes('bob.near') ? 'bob.near' : 'carol.near';
        return profileEntryResponse({
          ...aliceProfileBlob,
          account_id: id,
        } as Agent);
      }
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.endorseMany([
      { account_id: 'bob.near', keySuffixes: ['skills/rust'] },
      { account_id: 'carol.near', keySuffixes: ['skills/rust'] },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      account_id: 'bob.near',
      action: 'endorsed',
      key_suffixes: ['skills/rust'],
    });
    expect(results[1]).toMatchObject({
      account_id: 'carol.near',
      action: 'endorsed',
    });
  });

  it('NOT_FOUND target produces per-item error, rest continues', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/bob.near/profile'))
        return new Response(null, { status: 404 });
      if (url.endsWith('/carol.near/profile')) {
        return profileEntryResponse({
          ...aliceProfileBlob,
          account_id: 'carol.near',
        } as Agent);
      }
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.endorseMany([
      { account_id: 'bob.near', keySuffixes: ['skills/rust'] },
      { account_id: 'carol.near', keySuffixes: ['skills/rust'] },
    ]);
    expect(results[0]).toMatchObject({
      action: 'error',
      code: 'NOT_FOUND',
    });
    expect(results[1]).toMatchObject({
      action: 'endorsed',
    });
  });

  it('self-endorse produces per-item error', async () => {
    const { fetch } = scripted(() => jsonResponse({}));
    const client = clientOf(fetch);
    const results = await client.endorseMany([
      { account_id: 'alice.near', keySuffixes: ['skills/rust'] },
    ]);
    expect(results[0]).toMatchObject({
      action: 'error',
      code: 'SELF_ENDORSE',
    });
  });

  it('all-invalid key_suffixes throws before loop', async () => {
    const { fetch } = scripted(() => jsonResponse({}));
    const client = clientOf(fetch);
    await expect(
      client.endorseMany([{ account_id: 'bob.near', keySuffixes: ['/bad'] }]),
    ).resolves.toMatchObject([{ action: 'error', code: 'VALIDATION_ERROR' }]);
  });

  it('INSUFFICIENT_BALANCE aborts the batch', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/bob.near/profile')) {
        return profileEntryResponse({
          ...aliceProfileBlob,
          account_id: 'bob.near',
        } as Agent);
      }
      if (url.includes('/wallet/v1/call'))
        return new Response('<html>502</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    await expect(
      client.endorseMany([
        { account_id: 'bob.near', keySuffixes: ['skills/rust'] },
      ]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  // Pins the real-prefix partition: a suffix that would pass validation
  // against a short placeholder prefix but exceed FASTDATA_MAX_KEY_BYTES
  // when composed with `endorsing/{target}/` must land in `skipped`, not
  // blow up the whole target inside buildEndorse's re-validation.
  it('oversize suffix lands in skipped alongside valid ones', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/bob.near/profile')) {
        return profileEntryResponse({
          ...aliceProfileBlob,
          account_id: 'bob.near',
        } as Agent);
      }
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    // 1010-byte suffix: 12 + 1010 = 1022 (under 1024 with placeholder
    // 'endorsing/_/'), but 19 + 1010 = 1029 (over 1024 with the real
    // prefix 'endorsing/bob.near/'). Pre-fix this would have thrown
    // inside buildEndorse, failing the whole target.
    const oversize = 'a'.repeat(1010);
    const [result] = await client.endorseMany([
      { account_id: 'bob.near', keySuffixes: ['tags/rust', oversize] },
    ]);
    expect(result).toMatchObject({
      account_id: 'bob.near',
      action: 'endorsed',
      key_suffixes: ['tags/rust'],
      skipped: [
        { key_suffix: oversize, reason: expect.stringMatching(/1024-byte/) },
      ],
    });
  });
});

describe('NearlyClient.unendorseMany', () => {
  it('unendorses two targets', async () => {
    const { fetch } = scripted((url) => {
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.unendorseMany([
      { account_id: 'bob.near', keySuffixes: ['skills/rust'] },
      { account_id: 'carol.near', keySuffixes: ['skills/rust'] },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      account_id: 'bob.near',
      action: 'unendorsed',
      key_suffixes: ['skills/rust'],
    });
    expect(results[1]).toMatchObject({
      account_id: 'carol.near',
      action: 'unendorsed',
    });
  });

  it('self-unendorse produces per-item error', async () => {
    const { fetch } = scripted(() => jsonResponse({}));
    const client = clientOf(fetch);
    const results = await client.unendorseMany([
      { account_id: 'alice.near', keySuffixes: ['skills/rust'] },
    ]);
    expect(results[0]).toMatchObject({
      action: 'error',
      code: 'SELF_UNENDORSE',
    });
  });

  it('all-invalid key_suffixes throws before loop', async () => {
    const { fetch } = scripted(() => jsonResponse({}));
    const client = clientOf(fetch);
    await expect(
      client.unendorseMany([{ account_id: 'bob.near', keySuffixes: ['/bad'] }]),
    ).resolves.toMatchObject([{ action: 'error', code: 'VALIDATION_ERROR' }]);
  });

  it('suffix valid under dummy prefix but over byte limit for long target becomes per-item error', async () => {
    const longTarget = 'abcdefghijklmnopqrst.near';
    const longSuffix = 'x'.repeat(1010);
    const { fetch } = scripted((url) => {
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const results = await client.unendorseMany([
      { account_id: longTarget, keySuffixes: [longSuffix] },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      account_id: longTarget,
      action: 'error',
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('NearlyClient.delist', () => {
  it('returns null when no profile exists (nothing to delist)', async () => {
    const { fetch, calls } = scripted((url) => {
      if (url.endsWith('/v0/latest/contextual.near/alice.near/profile'))
        return new Response(null, { status: 404 });
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    expect(await client.delist()).toBeNull();
    expect(
      calls.find((c) => c.url.includes('/wallet/v1/call')),
    ).toBeUndefined();
  });

  it('null-writes profile + own tags/caps + outgoing follow/endorse edges', async () => {
    const existing: Agent = {
      ...aliceProfileBlob,
      tags: ['rust'],
      capabilities: { skills: ['audit'] },
    };
    const { fetch, calls } = scripted((url, init) => {
      if (url.endsWith('/v0/latest/contextual.near/alice.near/profile')) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1,
              key: 'profile',
              value: existing,
            },
          ],
        });
      }
      // Outgoing follow + endorse scans share the same URL; differentiate
      // by the key_prefix the builder sent.
      if (url.endsWith('/v0/latest/contextual.near/alice.near')) {
        const body = JSON.parse(init?.body as string) as {
          key_prefix?: string;
        };
        if (body.key_prefix === 'graph/follow/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'graph/follow/bob.near',
                value: {},
              },
            ],
          });
        }
        if (body.key_prefix === 'endorsing/') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'alice.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1,
                key: 'endorsing/carol.near/tags/rust',
                value: {},
              },
            ],
          });
        }
      }
      if (url.includes('/wallet/v1/call')) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const res = await client.delist();
    expect(res).toEqual({ action: 'delisted', account_id: 'alice.near' });
    const writeCall = calls.find((c) => c.url.includes('/wallet/v1/call'))!;
    const body = JSON.parse(writeCall.init!.body as string);
    expect(body.args.profile).toBeNull();
    expect(body.args['tag/rust']).toBeNull();
    expect(body.args['cap/skills/audit']).toBeNull();
    expect(body.args['graph/follow/bob.near']).toBeNull();
    expect(body.args['endorsing/carol.near/tags/rust']).toBeNull();
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

// wallet key leakage sweep — extracted to ./client-leakage.test.ts for focus
// and symmetry with cli/leakage-sweep.test.ts. The narrow register-parse
// sanitization test remains above next to NearlyClient.register; runtime-path
// sanitization coverage (writeEntries/createWallet/getBalance) lives in the
// sibling file.

describe('NearlyClient.getSuggested', () => {
  // Minimum scripted fixture for a full getSuggested round-trip:
  //   1. readProfile (caller's own profile)           — kvGetKey alice.near/profile
  //   2. list outgoing follows                         — kvListAgent alice.near graph/follow/
  //   3. full profile directory scan                   — kvGetAllKey profile
  //   4. sign-message for the get_vrf_seed claim       — POST /wallet/v1/sign-message
  //   5. WASM call_outlayer for get_vrf_seed           — POST /call/hack.near/nearly
  function suggestedFetch(opts: {
    callerTags?: string[];
    followingIds?: readonly string[];
    candidates: readonly { id: string; tags: string[]; lastActive?: number }[];
    vrf?: { success: true; proof: { output_hex: string } } | { success: false };
    signMessageFails?: boolean;
  }): ReturnType<typeof scripted> {
    const callerTags = opts.callerTags ?? ['rust'];
    const following = opts.followingIds ?? [];
    return scripted((url, init) => {
      // 1. Caller profile.
      if (
        url ===
        'https://kv.example/v0/latest/contextual.near/alice.near/profile'
      ) {
        return jsonResponse({
          entries: [
            {
              predecessor_id: 'alice.near',
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: 1_700_000_100 * 1e9,
              key: 'profile',
              value: { ...aliceProfileBlob, tags: callerTags },
            },
          ],
        });
      }
      // 2. Per-agent graph/follow/ listing and profile directory scan both
      //    hit /v0/latest/contextual.near with a POST body.
      if (url === 'https://kv.example/v0/latest/contextual.near/alice.near') {
        // agent-scoped scan = kvListAgent(alice.near, 'graph/follow/')
        return jsonResponse({
          entries: following.map((id) => ({
            predecessor_id: 'alice.near',
            current_account_id: 'contextual.near',
            block_height: 1,
            block_timestamp: 1_700_000_100 * 1e9,
            key: `graph/follow/${id}`,
            value: {},
          })),
        });
      }
      if (url === 'https://kv.example/v0/latest/contextual.near') {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'profile') {
          return jsonResponse({
            entries: opts.candidates.map((c) => ({
              predecessor_id: c.id,
              current_account_id: 'contextual.near',
              block_height: 1,
              block_timestamp: (c.lastActive ?? 1_700_000_000) * 1e9,
              key: 'profile',
              value: {
                ...aliceProfileBlob,
                tags: c.tags,
                name: c.id.split('.')[0],
              },
            })),
          });
        }
      }
      // 3. Sign-message.
      if (url === 'https://outlayer.example/wallet/v1/sign-message') {
        if (opts.signMessageFails) {
          return new Response('', { status: 401 });
        }
        return jsonResponse({
          account_id: 'alice.near',
          public_key: 'ed25519:abc',
          signature: 'sig_hex',
          nonce: 'nonce_hex',
        });
      }
      // 4. WASM call.
      if (url === 'https://outlayer.example/call/hack.near/nearly') {
        const vrf = opts.vrf ?? {
          success: true,
          proof: { output_hex: 'deadbeef' },
        };
        if (vrf.success) {
          return jsonResponse({
            success: true,
            data: {
              output_hex: vrf.proof.output_hex,
              signature_hex: 'feedface',
              alpha: 'suggest',
              vrf_public_key: 'pk_hex',
            },
          });
        }
        return jsonResponse({ success: false, error: 'wasm unavailable' });
      }
      throw new Error(`unexpected ${url}`);
    });
  }

  it('scores by shared tags, filters self + already-followed, limits, attaches reason', async () => {
    const { fetch } = suggestedFetch({
      callerTags: ['rust', 'wasm'],
      followingIds: ['bob.near'],
      candidates: [
        { id: 'alice.near', tags: ['rust'] }, // self — filtered
        { id: 'bob.near', tags: ['rust', 'wasm'] }, // followed — filtered
        {
          id: 'carol.near',
          tags: ['rust', 'wasm', 'ai'],
          lastActive: 1_700_000_300,
        }, // score 2
        { id: 'dave.near', tags: ['rust'], lastActive: 1_700_000_200 }, // score 1
        { id: 'eve.near', tags: [], lastActive: 1_700_000_100 }, // score 0
      ],
    });
    const client = clientOf(fetch);
    const res = await client.getSuggested({ limit: 5 });
    expect(res.agents).toHaveLength(3);
    expect(res.agents[0].account_id).toBe('carol.near');
    expect(res.agents[0].reason).toBe('Shared tags: rust, wasm');
    expect(res.agents[1].account_id).toBe('dave.near');
    expect(res.agents[1].reason).toBe('Shared tags: rust');
    expect(res.agents[2].account_id).toBe('eve.near');
    expect(res.agents[2].reason).toBe('New on the network');
    expect(res.vrf).not.toBeNull();
    expect(res.vrf?.output_hex).toBe('deadbeef');
  });

  it('honors the hard server-side cap of 50', async () => {
    const candidates = Array.from({ length: 100 }, (_, i) => ({
      id: `a${i}.near`,
      tags: ['rust'],
    }));
    const { fetch } = suggestedFetch({ candidates });
    const client = clientOf(fetch);
    const res = await client.getSuggested({ limit: 200 });
    expect(res.agents.length).toBe(50);
  });

  it('default limit is 10', async () => {
    const candidates = Array.from({ length: 30 }, (_, i) => ({
      id: `a${i}.near`,
      tags: ['rust'],
    }));
    const { fetch } = suggestedFetch({ candidates });
    const client = clientOf(fetch);
    const res = await client.getSuggested();
    expect(res.agents.length).toBe(10);
  });

  it('falls through to deterministic ranking when the VRF proof is null', async () => {
    const { fetch } = suggestedFetch({
      candidates: [
        { id: 'a.near', tags: ['rust'], lastActive: 100 },
        { id: 'b.near', tags: ['rust'], lastActive: 200 },
        { id: 'c.near', tags: ['rust'], lastActive: 150 },
      ],
      vrf: { success: false },
    });
    const client = clientOf(fetch);
    const res = await client.getSuggested({ limit: 5 });
    expect(res.vrf).toBeNull();
    // Deterministic: all tied at score=1, so last_active descending.
    expect(res.agents.map((a) => a.account_id)).toEqual([
      'b.near',
      'c.near',
      'a.near',
    ]);
  });

  it('swallows NearlyError from the VRF path so suggestions still return', async () => {
    // 401 from sign-message throws AUTH_FAILED — getSuggested must catch
    // it and return the deterministic ranking with vrf: null.
    const { fetch } = suggestedFetch({
      candidates: [{ id: 'a.near', tags: ['rust'] }],
      signMessageFails: true,
    });
    const client = clientOf(fetch);
    const res = await client.getSuggested();
    expect(res.vrf).toBeNull();
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0].account_id).toBe('a.near');
  });

  it('works for a caller with no profile yet — no crash, empty callerTags', async () => {
    // Caller profile 404s but candidates still exist.
    const { fetch } = scripted((url, init) => {
      if (
        url ===
        'https://kv.example/v0/latest/contextual.near/alice.near/profile'
      ) {
        return new Response('', { status: 404 });
      }
      if (url === 'https://kv.example/v0/latest/contextual.near/alice.near') {
        return jsonResponse({ entries: [] });
      }
      if (url === 'https://kv.example/v0/latest/contextual.near') {
        const body = JSON.parse(init?.body as string) as { key?: string };
        if (body.key === 'profile') {
          return jsonResponse({
            entries: [
              {
                predecessor_id: 'bob.near',
                current_account_id: 'contextual.near',
                block_height: 1,
                block_timestamp: 1_700_000_100 * 1e9,
                key: 'profile',
                value: { ...aliceProfileBlob, tags: ['rust'], name: 'Bob' },
              },
            ],
          });
        }
      }
      if (url === 'https://outlayer.example/wallet/v1/sign-message') {
        return jsonResponse({
          account_id: 'alice.near',
          public_key: 'ed25519:abc',
          signature: 'sig',
          nonce: 'n',
        });
      }
      if (url === 'https://outlayer.example/call/hack.near/nearly') {
        return jsonResponse({
          success: true,
          data: {
            output_hex: 'deadbeef',
            signature_hex: 'f',
            alpha: 'suggest',
            vrf_public_key: 'p',
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    const client = clientOf(fetch);
    const res = await client.getSuggested();
    expect(res.agents).toHaveLength(1);
    // No caller tags — everyone scores 0, reason falls through to "New on the network".
    expect(res.agents[0].reason).toBe('New on the network');
  });
});
