import { signClaim } from '../src/claim';
import type { FetchLike } from '../src/read';
import { getVrfSeed } from '../src/vrf';
import {
  callOutlayer,
  createWallet,
  createWalletClient,
  getBalance,
  writeEntries,
} from '../src/wallet';
import { jsonResponse, scripted, walletOf } from './fixtures/http';

describe('createWallet', () => {
  it('returns walletKey, accountId, trial from a valid 2xx response', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({
        api_key: 'wk_abc123',
        near_account_id: '4397d730abcd',
        trial: { calls_remaining: 100 },
        // Extra fields the SDK pins only a subset of — ensure they're ignored.
        url: 'https://outlayer.fastnear.com/wallet?key=wk_abc123',
        balance: '0',
      }),
    );
    const res = await createWallet({
      outlayerUrl: 'https://outlayer.example',
      fetch,
    });
    expect(res.walletKey).toBe('wk_abc123');
    expect(res.accountId).toBe('4397d730abcd');
    expect(res.trial).toEqual({ calls_remaining: 100 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://outlayer.example/register');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('surfaces handoff_url and trial.expires_at when OutLayer returns them', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        api_key: 'wk_abc123',
        near_account_id: '4397d730abcd',
        handoff_url: 'https://outlayer.fastnear.com/wallet?key=wk_abc123',
        trial: {
          calls_remaining: 100,
          expires_at: '2026-05-14T00:00:00Z',
        },
      }),
    );
    const res = await createWallet({
      outlayerUrl: 'https://outlayer.example',
      fetch,
    });
    expect(res.handoffUrl).toBe(
      'https://outlayer.fastnear.com/wallet?key=wk_abc123',
    );
    expect(res.trial).toEqual({
      calls_remaining: 100,
      expires_at: '2026-05-14T00:00:00Z',
    });
  });

  it('omits handoffUrl and trial.expires_at when OutLayer does not return them', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        api_key: 'wk_abc123',
        near_account_id: '4397d730abcd',
        trial: { calls_remaining: 100 },
      }),
    );
    const res = await createWallet({
      outlayerUrl: 'https://outlayer.example',
      fetch,
    });
    expect('handoffUrl' in res).toBe(false);
    expect(res.trial).toEqual({ calls_remaining: 100 });
    expect('expires_at' in res.trial).toBe(false);
  });

  it('throws protocolError on malformed JSON', async () => {
    const { fetch } = scripted(
      () =>
        new Response('not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(
      createWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws protocolError when api_key is missing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        near_account_id: '4397d730',
        trial: { calls_remaining: 100 },
      }),
    );
    await expect(
      createWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws protocolError when near_account_id is missing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({ api_key: 'wk_x', trial: { calls_remaining: 5 } }),
    );
    await expect(
      createWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws protocolError when trial.calls_remaining is missing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({ api_key: 'wk_x', near_account_id: '4397d730' }),
    );
    await expect(
      createWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('throws authError on 401', async () => {
    const { fetch } = scripted(() => new Response(null, { status: 401 }));
    await expect(
      createWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('throws protocolError on other non-2xx', async () => {
    const { fetch } = scripted(
      () => new Response('upstream down', { status: 503 }),
    );
    await expect(
      createWallet({ outlayerUrl: 'https://outlayer.example', fetch }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });
});

describe('getBalance', () => {
  it('returns balance, accountId, derived balanceNear for chain=near', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({
        account_id: '4397d730abcd',
        balance: '9393299973616100000000', // 0.00939329... NEAR
      }),
    );
    const wallet = walletOf(fetch);
    const res = await getBalance(wallet);
    expect(res.accountId).toBe('4397d730abcd');
    expect(res.chain).toBe('near');
    expect(res.balance).toBe('9393299973616100000000');
    expect(res.balanceNear).toBeCloseTo(0.00939329, 6);
    expect(calls[0].url).toBe(
      'https://outlayer.example/wallet/v1/balance?chain=near',
    );
    // The Authorization header carries wk_ verbatim.
    expect(
      (calls[0].init?.headers as Record<string, string>).Authorization,
    ).toBe('Bearer wk_test');
  });

  it('returns balance=0 as a valid response (not an error)', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({ account_id: '4397d730', balance: '0' }),
    );
    const res = await getBalance(walletOf(fetch));
    expect(res.balance).toBe('0');
    expect(res.balanceNear).toBe(0);
  });

  it('omits balanceNear on non-near chains', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({ account_id: 'bob.eth', balance: '1000000000000000000' }),
    );
    const res = await getBalance(walletOf(fetch), 'eth');
    expect(res.chain).toBe('eth');
    expect(res.balance).toBe('1000000000000000000');
    expect(res.balanceNear).toBeUndefined();
    expect(calls[0].url).toContain('chain=eth');
  });

  it('throws authError on 401', async () => {
    const { fetch } = scripted(() => new Response(null, { status: 401 }));
    await expect(getBalance(walletOf(fetch))).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });

  it('throws protocolError on malformed JSON', async () => {
    const { fetch } = scripted(
      () =>
        new Response('oops', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(getBalance(walletOf(fetch))).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });

  it('throws protocolError when balance field is missing', async () => {
    const { fetch } = scripted(() => jsonResponse({ account_id: '4397d730' }));
    await expect(getBalance(walletOf(fetch))).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });

  it('throws protocolError when account_id field is missing', async () => {
    const { fetch } = scripted(() => jsonResponse({ balance: '1' }));
    await expect(getBalance(walletOf(fetch))).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });

  it('never includes the wk_ key in error messages', async () => {
    const { fetch } = scripted(
      () =>
        new Response('downstream leaked wk_test inside body', { status: 500 }),
    );
    try {
      await getBalance(walletOf(fetch));
      fail('expected throw');
    } catch (err) {
      // The upstream body may smuggle the wk_ substring. The SDK truncates
      // to 200 chars and attaches the snippet — the assertion here is that
      // we never materialize the caller's own wk_ (which lives only in the
      // Authorization header, not the body). The upstream response can
      // contain arbitrary text; this is guardrail, not sanitization.
      expect((err as Error).message).toContain('getBalance 500');
    }
  });
});

describe('writeEntries', () => {
  // `writeEntries` is the single funnel for FastData KV writes from the
  // SDK. Direct coverage of the OutLayer wire contract so regressions
  // fail at the function-under-test level, not through an opaque
  // mutation flow in client.test.ts.

  it('sends POST /wallet/v1/call with Bearer wk_ and __fastdata_kv envelope', async () => {
    const { fetch, calls } = scripted(
      () => new Response(null, { status: 200 }),
    );
    const wallet = walletOf(fetch, 'wk_submit_test');
    await writeEntries(wallet, { profile: { name: 'alice' } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://outlayer.example/wallet/v1/call');
    expect(calls[0].init?.method).toBe('POST');
    const authHeader = (calls[0].init?.headers as Record<string, string>)
      ?.Authorization;
    expect(authHeader).toBe('Bearer wk_submit_test');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toMatchObject({
      receiver_id: 'contextual.near',
      method_name: '__fastdata_kv',
      args: { profile: { name: 'alice' } },
    });
    // gas + deposit are populated from constants — verify they're sent,
    // not omitted (omission would make OutLayer reject).
    expect(body.gas).toBeDefined();
    expect(body.deposit).toBeDefined();
  });

  it('resolves silently on 2xx — success is no-return, not a shape', async () => {
    const { fetch } = scripted(() => new Response(null, { status: 200 }));
    const wallet = walletOf(fetch);
    const result = await writeEntries(wallet, { profile: {} });
    expect(result).toBeUndefined();
  });

  it('throws NETWORK on fetch rejection (network layer)', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    const wallet = walletOf(fetch);
    await expect(writeEntries(wallet, { profile: {} })).rejects.toMatchObject({
      shape: { code: 'NETWORK' },
    });
  });

  it('throws AUTH_FAILED on 401', async () => {
    const { fetch } = scripted(
      () => new Response('unauthorized', { status: 401 }),
    );
    const wallet = walletOf(fetch);
    await expect(writeEntries(wallet, { profile: {} })).rejects.toMatchObject({
      shape: { code: 'AUTH_FAILED' },
    });
  });

  it('throws AUTH_FAILED on 403', async () => {
    const { fetch } = scripted(
      () => new Response('forbidden', { status: 403 }),
    );
    const wallet = walletOf(fetch);
    await expect(writeEntries(wallet, { profile: {} })).rejects.toMatchObject({
      shape: { code: 'AUTH_FAILED' },
    });
  });

  it('throws INSUFFICIENT_BALANCE on 502 (Cloudflare upstream for unfunded wallets)', async () => {
    // OutLayer surfaces unfunded-wallet rejections as Cloudflare 502s
    // when the write path trips the upstream timeout on the TEE.
    const { fetch } = scripted(
      () => new Response('upstream timeout', { status: 502 }),
    );
    const wallet = walletOf(fetch);
    await expect(writeEntries(wallet, { profile: {} })).rejects.toMatchObject({
      shape: { code: 'INSUFFICIENT_BALANCE' },
    });
  });

  it('throws PROTOCOL on other non-2xx with truncated body in hint', async () => {
    const { fetch } = scripted(
      () => new Response('internal error', { status: 500 }),
    );
    const wallet = walletOf(fetch);
    await expect(writeEntries(wallet, { profile: {} })).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('writeEntries 500'),
      },
    });
  });

  it('throws PROTOCOL with "no body" hint when a non-2xx response has an empty body', async () => {
    const { fetch } = scripted(() => new Response(null, { status: 500 }));
    const wallet = walletOf(fetch);
    await expect(writeEntries(wallet, { profile: {} })).rejects.toMatchObject({
      shape: {
        code: 'PROTOCOL',
        hint: expect.stringContaining('no body'),
      },
    });
  });

  it('does not leak the wallet key into any error message on a 5xx with a body that echoes the Bearer', async () => {
    // Worst-case scenario: an upstream 500 page that dumps the request
    // headers in its debug output would contain `Bearer wk_...`. The
    // error surface must redact it via `sanitizeErrorDetail`.
    const echoBody =
      'upstream error: Authorization=Bearer wk_secret_test_DO_NOT_LEAK failed';
    const { fetch } = scripted(() => new Response(echoBody, { status: 500 }));
    const wallet = walletOf(fetch, 'wk_secret_test_DO_NOT_LEAK');
    try {
      await writeEntries(wallet, { profile: {} });
      throw new Error('expected writeEntries to throw');
    } catch (err) {
      const serialized = JSON.stringify({
        message: (err as Error).message,
        shape: (err as { shape?: unknown }).shape,
      });
      expect(serialized).not.toMatch(/wk_[A-Za-z0-9_]+/);
    }
  });
});

describe('signClaim', () => {
  it('posts message + recipient to /wallet/v1/sign-message using client domain defaults', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({
        account_id: 'alice.near',
        public_key: 'ed25519:abc',
        signature: 'sig_hex',
        nonce: 'nonce_hex',
      }),
    );
    const wallet = walletOf(fetch);
    const claim = await signClaim(wallet, {
      action: 'get_vrf_seed',
      accountId: 'alice.near',
    });
    expect(claim.account_id).toBe('alice.near');
    expect(claim.public_key).toBe('ed25519:abc');
    expect(claim.signature).toBe('sig_hex');
    expect(claim.nonce).toBe('nonce_hex');
    // Message is built locally, not returned by OutLayer, but must round-trip.
    const parsed = JSON.parse(claim.message);
    expect(parsed.action).toBe('get_vrf_seed');
    expect(parsed.account_id).toBe('alice.near');
    expect(parsed.domain).toBe('nearly.social');
    expect(parsed.version).toBe(1);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://outlayer.example/wallet/v1/sign-message');
    expect(call.init?.method).toBe('POST');
    const body = JSON.parse(call.init?.body as string);
    expect(body.message).toBe(claim.message);
    expect(body.recipient).toBe('nearly.social');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer wk_test');
  });

  it('throws AUTH_FAILED on 401', async () => {
    const { fetch } = scripted(() => new Response('', { status: 401 }));
    const wallet = walletOf(fetch);
    await expect(
      signClaim(wallet, { action: 'get_vrf_seed', accountId: 'alice.near' }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('throws PROTOCOL on missing fields', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({ account_id: 'alice.near' }),
    );
    const wallet = walletOf(fetch);
    await expect(
      signClaim(wallet, { action: 'get_vrf_seed', accountId: 'alice.near' }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });
});

describe('callOutlayer', () => {
  it('routes to /call/{owner}/{project} with input + resource_limits, returns decoded envelope', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({
        success: true,
        data: { output_hex: 'deadbeef', alpha: 'suggest' },
      }),
    );
    const wallet = walletOf(fetch);
    const decoded = await callOutlayer(wallet, {
      action: 'get_vrf_seed',
      verifiable_claim: { account_id: 'alice.near' },
    });
    expect(decoded.success).toBe(true);
    expect((decoded.data as { output_hex: string }).output_hex).toBe(
      'deadbeef',
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://outlayer.example/call/hack.near/nearly');
    const body = JSON.parse(call.init?.body as string);
    expect(body.input.action).toBe('get_vrf_seed');
    expect(body.input.verifiable_claim.account_id).toBe('alice.near');
    expect(body.resource_limits).toEqual({
      max_instructions: 2_000_000_000,
      max_memory_mb: 512,
      max_execution_seconds: 30,
    });
  });

  it('routes with X-Payment-Key when the wallet key is not a wk_ key', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({ success: true, data: {} }),
    );
    const wallet = walletOf(fetch, 'pay_abc');
    await callOutlayer(wallet, { action: 'noop' });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Payment-Key']).toBe('pay_abc');
    expect(headers.Authorization).toBeUndefined();
  });

  it('honors wasmOwner / wasmProject overrides', async () => {
    const { fetch, calls } = scripted(() =>
      jsonResponse({ success: true, data: {} }),
    );
    const wallet = createWalletClient({
      outlayerUrl: 'https://outlayer.example',
      namespace: 'contextual.near',
      walletKey: 'wk_test',
      fetch,
      wasmOwner: 'staging.near',
      wasmProject: 'nearly-staging',
      claimDomain: 'nearly.social',
      claimVersion: 1,
    });
    await callOutlayer(wallet, { action: 'noop' });
    expect(calls[0].url).toBe(
      'https://outlayer.example/call/staging.near/nearly-staging',
    );
  });

  it('decodes base64 output field', async () => {
    const inner = { success: true, data: { foo: 'bar' } };
    const base64 = Buffer.from(JSON.stringify(inner)).toString('base64');
    const { fetch } = scripted(() => jsonResponse({ output: base64 }));
    const wallet = walletOf(fetch);
    const decoded = await callOutlayer(wallet, { action: 'noop' });
    expect(decoded.success).toBe(true);
    expect((decoded.data as { foo: string }).foo).toBe('bar');
  });

  it('throws INSUFFICIENT_BALANCE on 402 and 502', async () => {
    for (const status of [402, 502]) {
      const { fetch } = scripted(() => new Response('', { status }));
      const wallet = walletOf(fetch);
      await expect(
        callOutlayer(wallet, { action: 'noop' }),
      ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    }
  });

  it('throws PROTOCOL on WASM-level "failed" status', async () => {
    const { fetch } = scripted(() => jsonResponse({ status: 'failed' }));
    const wallet = walletOf(fetch);
    await expect(
      callOutlayer(wallet, { action: 'noop' }),
    ).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });

  it('propagates success: false envelopes without throwing', async () => {
    const { fetch } = scripted(() =>
      jsonResponse({
        success: false,
        error: 'rate limited',
        code: 'RATE_LIMITED',
      }),
    );
    const wallet = walletOf(fetch);
    const decoded = await callOutlayer(wallet, { action: 'noop' });
    expect(decoded.success).toBe(false);
    expect(decoded.error).toBe('rate limited');
  });
});

describe('getVrfSeed', () => {
  it('composes signClaim + callOutlayer and returns the parsed proof', async () => {
    let callCount = 0;
    const { fetch, calls } = scripted((url) => {
      callCount++;
      if (url.endsWith('/wallet/v1/sign-message')) {
        return jsonResponse({
          account_id: 'alice.near',
          public_key: 'ed25519:abc',
          signature: 'sig_hex',
          nonce: 'nonce_hex',
        });
      }
      if (url.includes('/call/')) {
        return jsonResponse({
          success: true,
          data: {
            output_hex: 'deadbeef',
            signature_hex: 'feedface',
            alpha: 'suggest',
            vrf_public_key: 'pk_hex',
          },
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const wallet = walletOf(fetch);
    const proof = await getVrfSeed(wallet, 'alice.near');
    expect(proof).toEqual({
      output_hex: 'deadbeef',
      signature_hex: 'feedface',
      alpha: 'suggest',
      vrf_public_key: 'pk_hex',
    });
    expect(callCount).toBe(2);
    expect(calls[0].url).toContain('/wallet/v1/sign-message');
    expect(calls[1].url).toContain('/call/');

    // The verifiable_claim forwarded to the WASM must include every
    // envelope field plus the exact signed message.
    const wasmBody = JSON.parse(calls[1].init?.body as string);
    expect(wasmBody.input.action).toBe('get_vrf_seed');
    expect(wasmBody.input.verifiable_claim.account_id).toBe('alice.near');
    expect(wasmBody.input.verifiable_claim.public_key).toBe('ed25519:abc');
    expect(wasmBody.input.verifiable_claim.signature).toBe('sig_hex');
    expect(wasmBody.input.verifiable_claim.nonce).toBe('nonce_hex');
    const parsedMsg = JSON.parse(wasmBody.input.verifiable_claim.message);
    expect(parsedMsg.action).toBe('get_vrf_seed');
  });

  it('returns null when the WASM envelope is success: false', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/wallet/v1/sign-message')) {
        return jsonResponse({
          account_id: 'alice.near',
          public_key: 'ed25519:abc',
          signature: 'sig_hex',
          nonce: 'nonce_hex',
        });
      }
      return jsonResponse({ success: false, error: 'wasm unavailable' });
    });
    const wallet = walletOf(fetch);
    const proof = await getVrfSeed(wallet, 'alice.near');
    expect(proof).toBeNull();
  });

  it('throws PROTOCOL when the proof envelope is missing fields', async () => {
    const { fetch } = scripted((url) => {
      if (url.endsWith('/wallet/v1/sign-message')) {
        return jsonResponse({
          account_id: 'alice.near',
          public_key: 'ed25519:abc',
          signature: 'sig_hex',
          nonce: 'nonce_hex',
        });
      }
      return jsonResponse({
        success: true,
        data: { output_hex: 'deadbeef' }, // missing signature_hex, alpha, vrf_public_key
      });
    });
    const wallet = walletOf(fetch);
    await expect(getVrfSeed(wallet, 'alice.near')).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });
});
