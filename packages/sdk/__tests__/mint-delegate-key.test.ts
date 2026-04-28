import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { bytesToHex, hmacSha256, sha256 } from '../src/hashes';
import { mintDelegateKey } from '../src/wallet';
import { jsonResponse, scripted } from './fixtures/http';

function freshKey(): {
  privateKey: string;
  seed32: Uint8Array;
  publicKey: Uint8Array;
} {
  const seed32 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed32[i] = (i * 17 + 2) & 0xff;
  const kp = nacl.sign.keyPair.fromSeed(seed32);
  return {
    privateKey: `ed25519:${bs58.encode(seed32)}`,
    seed32,
    publicKey: kp.publicKey,
  };
}

const OK_BODY = {
  wallet_id: 'uuid-delegate-1',
  near_account_id:
    '36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88',
};

describe('hashes primitives (known vectors)', () => {
  it('hmacSha256 matches RFC 4231 Test Case 1', async () => {
    const key = new Uint8Array(20).fill(0x0b);
    const mac = await hmacSha256(key, new TextEncoder().encode('Hi There'));
    expect(bytesToHex(mac)).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('sha256 matches the NIST vector for "abc"', async () => {
    const h = await sha256(new TextEncoder().encode('abc'));
    expect(bytesToHex(h)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('mintDelegateKey', () => {
  it('derives wk_ locally from HMAC-SHA256(seed, "<seed>:<index>") and sends only the hash', async () => {
    const { privateKey, seed32 } = freshKey();
    const now = () => 1_712_000_000_000;
    const { fetch, calls } = scripted(() => jsonResponse(OK_BODY));

    const res = await mintDelegateKey({
      outlayerUrl: 'https://outlayer.example',
      accountId: 'alice.near',
      seed: 'sub-task',
      privateKey,
      fetch,
      now,
    });

    // Expected derivation: wk_ + hex(HMAC-SHA256(seed32, "sub-task:0"))
    const expectedHmac = await hmacSha256(
      seed32,
      new TextEncoder().encode('sub-task:0'),
    );
    const expectedWalletKey = `wk_${bytesToHex(expectedHmac)}`;
    expect(res.walletKey).toBe(expectedWalletKey);

    const expectedKeyHashBytes = await sha256(
      new TextEncoder().encode(expectedWalletKey),
    );
    const expectedKeyHash = bytesToHex(expectedKeyHashBytes);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://outlayer.example/wallet/v1/api-key');
    expect(calls[0].init?.method).toBe('PUT');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.account_id).toBe('alice.near');
    expect(body.seed).toBe('sub-task');
    expect(body.key_hash).toBe(expectedKeyHash);
    expect(body.message).toBe('api-key:sub-task:1712000000');
    // Request must NOT contain the derived wk_ itself — only its hash.
    const bodyString = calls[0].init?.body as string;
    expect(bodyString).not.toContain(expectedWalletKey);
    expect(bodyString).not.toContain(expectedWalletKey.slice(3)); // body without wk_ prefix
  });

  it('same (accountId, seed, keyIndex) produces the same walletKey — idempotent derivation', async () => {
    const { privateKey } = freshKey();
    const { fetch } = scripted(() => jsonResponse(OK_BODY));
    const first = await mintDelegateKey({
      outlayerUrl: 'https://outlayer.example',
      accountId: 'alice.near',
      seed: 'task',
      privateKey,
      fetch,
    });
    const second = await mintDelegateKey({
      outlayerUrl: 'https://outlayer.example',
      accountId: 'alice.near',
      seed: 'task',
      privateKey,
      fetch,
    });
    expect(second.walletKey).toBe(first.walletKey);
  });

  it('different keyIndex produces different walletKey', async () => {
    const { privateKey } = freshKey();
    const { fetch } = scripted(() => jsonResponse(OK_BODY));
    const k0 = await mintDelegateKey({
      outlayerUrl: 'https://outlayer.example',
      accountId: 'alice.near',
      seed: 's',
      privateKey,
      fetch,
      keyIndex: 0,
    });
    const k1 = await mintDelegateKey({
      outlayerUrl: 'https://outlayer.example',
      accountId: 'alice.near',
      seed: 's',
      privateKey,
      fetch,
      keyIndex: 1,
    });
    expect(k1.walletKey).not.toBe(k0.walletKey);
  });

  it('bubbles VALIDATION_ERROR for an invalid privateKey', async () => {
    const { fetch } = scripted(() => jsonResponse(OK_BODY));
    await expect(
      mintDelegateKey({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: 's',
        privateKey: 'not-a-key',
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws a VALIDATION_ERROR when accountId is empty (local guard before wire)', async () => {
    const { privateKey } = freshKey();
    const { fetch, calls } = scripted(() => jsonResponse(OK_BODY));
    await expect(
      mintDelegateKey({
        outlayerUrl: 'https://outlayer.example',
        accountId: '',
        seed: 's',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(calls).toHaveLength(0);
  });

  it('throws a VALIDATION_ERROR when seed is empty (local guard before wire)', async () => {
    const { privateKey } = freshKey();
    const { fetch, calls } = scripted(() => jsonResponse(OK_BODY));
    await expect(
      mintDelegateKey({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: '',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(calls).toHaveLength(0);
  });

  it('throws authError on 401', async () => {
    const { privateKey } = freshKey();
    const { fetch } = scripted(() => new Response('bad sig', { status: 401 }));
    await expect(
      mintDelegateKey({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: 's',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
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
      mintDelegateKey({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: 's',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it.each([
    ['wallet_id', { near_account_id: 'x' }],
    ['near_account_id', { wallet_id: 'x' }],
  ])('throws protocolError when response is missing %s', async (_label, body) => {
    const { privateKey } = freshKey();
    const { fetch } = scripted(() => jsonResponse(body));
    await expect(
      mintDelegateKey({
        outlayerUrl: 'https://outlayer.example',
        accountId: 'alice.near',
        seed: 's',
        privateKey,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('does not echo the private key body into any error', async () => {
    const { privateKey } = freshKey();
    const privBody = privateKey.slice('ed25519:'.length);

    const scenarios: Array<() => Response> = [
      () => new Response('bad sig', { status: 401 }),
      () => new Response('upstream crash', { status: 500 }),
      () =>
        new Response('not-json', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      () => jsonResponse({ wallet_id: 'x' }),
    ];

    for (const handler of scenarios) {
      const { fetch } = scripted(handler);
      try {
        await mintDelegateKey({
          outlayerUrl: 'https://outlayer.example',
          accountId: 'alice.near',
          seed: 's',
          privateKey,
          fetch,
        });
        fail('should have thrown');
      } catch (e) {
        const msg = (e as Error).message;
        const shape = JSON.stringify((e as { shape?: unknown }).shape ?? {});
        expect(msg).not.toContain(privBody);
        expect(shape).not.toContain(privBody);
      }
    }
  });
});
