import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { createDeterministicWallet } from '../src/wallet';
import { jsonResponse, scripted } from './fixtures/http';

function freshKey(): { privateKey: string; pubkeyWire: string } {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i * 13 + 5) & 0xff;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    privateKey: `ed25519:${bs58.encode(seed)}`,
    pubkeyWire: `ed25519:${bs58.encode(kp.publicKey)}`,
  };
}

const OK_BODY = {
  wallet_id: 'uuid-aaa-bbb',
  near_account_id:
    '36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88',
  trial: { calls_remaining: 100 },
};

describe('createDeterministicWallet', () => {
  it('POSTs the signed body and returns the derived wallet fields', async () => {
    const { privateKey, pubkeyWire } = freshKey();
    const now = () => 1_712_000_000_000;
    const { fetch, calls } = scripted(() => jsonResponse(OK_BODY));
    const res = await createDeterministicWallet({
      outlayerUrl: 'https://outlayer.example',
      accountId: 'alice.near',
      seed: 'task-42',
      privateKey,
      fetch,
      now,
    });

    expect(res.walletId).toBe('uuid-aaa-bbb');
    expect(res.nearAccountId).toBe(OK_BODY.near_account_id);
    expect(res.trial).toEqual({ calls_remaining: 100 });
    expect('handoffUrl' in res).toBe(false);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://outlayer.example/register');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      account_id: 'alice.near',
      seed: 'task-42',
      pubkey: pubkeyWire,
      message: 'register:task-42:1712000000',
      signature: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]+$/),
    });
    // Signature is plain base58 — no ed25519: prefix on the wire.
    expect(body.signature.startsWith('ed25519:')).toBe(false);
  });

  it('defaults the timestamp to the current wall clock (±5 min window)', async () => {
    const { privateKey } = freshKey();
    const { fetch, calls } = scripted(() => jsonResponse(OK_BODY));
    const beforeSec = Math.floor(Date.now() / 1000);
    await createDeterministicWallet({
      outlayerUrl: 'https://outlayer.example',
      accountId: 'alice.near',
      seed: 'now-test',
      privateKey,
      fetch,
    });
    const afterSec = Math.floor(Date.now() / 1000);
    const body = JSON.parse(calls[0].init?.body as string);
    const ts = Number(body.message.split(':').pop());
    expect(ts).toBeGreaterThanOrEqual(beforeSec);
    expect(ts).toBeLessThanOrEqual(afterSec);
  });

  it('surfaces handoff_url and trial.expires_at when present', async () => {
    const { privateKey } = freshKey();
    const { fetch } = scripted(() =>
      jsonResponse({
        ...OK_BODY,
        handoff_url: 'https://outlayer.fastnear.com/wallet?key=wk_deadbeef',
        trial: { calls_remaining: 100, expires_at: '2026-05-14T00:00:00Z' },
      }),
    );
    const res = await createDeterministicWallet({
      outlayerUrl: 'https://outlayer.example',
      accountId: 'alice.near',
      seed: 's',
      privateKey,
      fetch,
      now: () => 1_712_000_000_000,
    });
    expect(res.handoffUrl).toBe(
      'https://outlayer.fastnear.com/wallet?key=wk_deadbeef',
    );
    expect(res.trial?.expires_at).toBe('2026-05-14T00:00:00Z');
  });

  it('bubbles a VALIDATION_ERROR for an invalid privateKey format', async () => {
    const { fetch } = scripted(() => jsonResponse(OK_BODY));
    await expect(
      createDeterministicWallet({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: 's',
        privateKey: 'not-a-key',
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws a VALIDATION_ERROR when accountId is empty', async () => {
    const { privateKey } = freshKey();
    const { fetch } = scripted(() => jsonResponse(OK_BODY));
    await expect(
      createDeterministicWallet({
        outlayerUrl: 'https://outlayer.example',
        accountId: '',
        seed: 's',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws a VALIDATION_ERROR when seed is empty (local guard before wire)', async () => {
    const { privateKey } = freshKey();
    const { fetch, calls } = scripted(() => jsonResponse(OK_BODY));
    await expect(
      createDeterministicWallet({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: '',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // Never reached the wire — the local guard fired first.
    expect(calls).toHaveLength(0);
  });

  it('throws authError on 401', async () => {
    const { privateKey } = freshKey();
    const { fetch } = scripted(() => new Response('bad sig', { status: 401 }));
    await expect(
      createDeterministicWallet({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: 's',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('throws protocolError on other non-2xx with truncated body', async () => {
    const { privateKey } = freshKey();
    const { fetch } = scripted(
      () => new Response('seed must not be empty', { status: 400 }),
    );
    await expect(
      createDeterministicWallet({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: 's',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({
      code: 'PROTOCOL',
      shape: {
        hint: expect.stringContaining('seed must not be empty'),
      },
    });
  });

  it('throws protocolError on malformed JSON in 2xx', async () => {
    const { privateKey } = freshKey();
    const { fetch } = scripted(
      () =>
        new Response('not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(
      createDeterministicWallet({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: 's',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it.each([
    ['wallet_id', { near_account_id: 'x', trial: { calls_remaining: 1 } }],
    ['near_account_id', { wallet_id: 'x', trial: { calls_remaining: 1 } }],
    [
      'malformed trial (present but calls_remaining missing)',
      { wallet_id: 'x', near_account_id: 'x', trial: {} },
    ],
  ])('throws protocolError when response is missing %s', async (_label, body) => {
    const { privateKey } = freshKey();
    const { fetch } = scripted(() => jsonResponse(body));
    await expect(
      createDeterministicWallet({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: 's',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('accepts idempotent re-registration response with trial omitted', async () => {
    // OutLayer returns {wallet_id, near_account_id} only when re-hitting an
    // already-derived wallet. Regression pin: do not re-add trial to the
    // required-fields check.
    const { privateKey } = freshKey();
    const { fetch } = scripted(() =>
      jsonResponse({
        wallet_id: 'idempotent-uuid',
        near_account_id:
          'acc0db31c0f891620dc774efd71daa8313260a4a6c3ecccff9a5fd1b4b235e2d',
      }),
    );
    const res = await createDeterministicWallet({
      outlayerUrl: 'https://outlayer.example',
      accountId: 'alice.near',
      seed: 'already-registered',
      privateKey,
      fetch,
    });
    expect(res.walletId).toBe('idempotent-uuid');
    expect(res.nearAccountId).toBe(
      'acc0db31c0f891620dc774efd71daa8313260a4a6c3ecccff9a5fd1b4b235e2d',
    );
    expect('trial' in res).toBe(false);
  });

  it('does not echo the private key body into any error', async () => {
    // Construct a private key and verify its base58 body never appears in
    // any of the error paths this SDK surfaces.
    const { privateKey } = freshKey();
    const privBody = privateKey.slice('ed25519:'.length);

    const errorScenarios: Array<() => Response> = [
      () => new Response('bad sig', { status: 401 }),
      () => new Response('upstream crash', { status: 500 }),
      () =>
        new Response('not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      () => jsonResponse({ wallet_id: 'x' }),
    ];

    for (const handler of errorScenarios) {
      const { fetch } = scripted(handler);
      try {
        await createDeterministicWallet({
          outlayerUrl: 'https://outlayer.example',
          accountId: 'alice.near',
          seed: 's',
          privateKey,
          fetch,
        });
        fail('should have thrown');
      } catch (e) {
        const msg = (e as Error).message;
        const serialized = JSON.stringify(
          (e as { shape?: unknown }).shape ?? {},
        );
        expect(msg).not.toContain(privBody);
        expect(serialized).not.toContain(privBody);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Integration — opt-in, real-network. Follows the existing SDK integration
// pattern (`integration.test.ts`): describe.skip if the gating env var is
// absent, so CI and normal local runs are unaffected.
// ---------------------------------------------------------------------------

const nearKey = process.env.OUTLAYER_TEST_NEAR_KEY;
const nearAccount = process.env.OUTLAYER_TEST_NEAR_ACCOUNT_ID;
const hasNearCreds = !!(nearKey && nearAccount);
const nearSuite = hasNearCreds ? describe : describe.skip;

nearSuite(
  'createDeterministicWallet (integration, OUTLAYER_TEST_NEAR_KEY)',
  () => {
    it('returns a deterministic near_account_id for the same (accountId, seed)', async () => {
      // Determinism contract: if this assertion fails, the bug is in
      // OutLayer's derivation layer — same inputs must produce the same
      // wallet per the SKILL doc and per project_outlayer_bearer_near_identity_model.md.
      // Do NOT add SDK-side retry / caching to work around; report upstream.
      const seed = `nearly-sdk-test-${Date.now()}`;
      const first = await createDeterministicWallet({
        outlayerUrl:
          process.env.OUTLAYER_URL ?? 'https://api.outlayer.fastnear.com',
        accountId: nearAccount as string,
        seed,
        privateKey: nearKey as string,
      });
      const second = await createDeterministicWallet({
        outlayerUrl:
          process.env.OUTLAYER_URL ?? 'https://api.outlayer.fastnear.com',
        accountId: nearAccount as string,
        seed,
        privateKey: nearKey as string,
      });
      expect(second.nearAccountId).toBe(first.nearAccountId);
      expect(second.walletId).toBe(first.walletId);
    }, 30_000);
  },
);
