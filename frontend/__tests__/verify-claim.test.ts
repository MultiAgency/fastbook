/**
 * @jest-environment node
 */
import { __resetNonceStoreForTests, verifyClaim } from '@/lib/verify-claim';
import type { VerifiableClaim, VerifyClaimResponse } from '@/types';

// ---------------------------------------------------------------------------
// Fixture helpers — build and sign a claim the way the verifier expects.
// ---------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < zeros; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function u32Le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function borshString(s: string): Uint8Array {
  const utf8 = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + utf8.length);
  out.set(u32Le(utf8.length), 0);
  out.set(utf8, 4);
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

interface Fixture {
  claim: VerifiableClaim;
  privateKey: CryptoKey;
  signatureBytes: Uint8Array;
}

interface BuildOpts {
  accountId?: string;
  /** If true, derive accountId as hex(public_key) — an implicit NEAR account. */
  implicit?: boolean;
  action?: string;
  domain?: string;
  recipient?: string;
  timestamp?: number;
  version?: number;
  includeAccountIdInMessage?: boolean;
  /** If provided, reuse these nonce bytes instead of generating fresh. */
  nonceBytes?: Uint8Array;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function buildClaim(opts: BuildOpts = {}): Promise<Fixture> {
  const recipient = opts.recipient ?? 'nearly.social';
  const kp = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(
    await crypto.subtle.exportKey('raw', kp.publicKey),
  );
  const publicKey = `ed25519:${base58Encode(rawPub)}`;
  const accountId =
    opts.accountId ?? (opts.implicit ? toHex(rawPub) : 'alice.near');

  const message = JSON.stringify({
    action: opts.action ?? 'register',
    domain: opts.domain ?? 'nearly.social',
    ...(opts.includeAccountIdInMessage === false
      ? {}
      : { account_id: accountId }),
    version: opts.version ?? 1,
    timestamp: opts.timestamp ?? Date.now(),
  });

  const nonceBytes =
    opts.nonceBytes ?? crypto.getRandomValues(new Uint8Array(32));
  const payload = concat([
    new Uint8Array([0x9d, 0x01, 0x00, 0x80]),
    borshString(message),
    nonceBytes,
    borshString(recipient),
    new Uint8Array([0x00]),
  ]);
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', payload as BufferSource),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', kp.privateKey, hash as BufferSource),
  );

  return {
    claim: {
      account_id: accountId,
      public_key: publicKey,
      signature: base58Encode(sig),
      nonce: Buffer.from(nonceBytes).toString('base64'),
      message,
    },
    privateKey: kp.privateKey,
    signatureBytes: sig,
  };
}

/**
 * Test helper: call verifyClaim with the nearly.social defaults the bulk of
 * tests use. New tests that exercise other recipients or opt out of domain
 * pinning call verifyClaim directly.
 */
function verify(input: unknown): Promise<VerifyClaimResponse> {
  return verifyClaim(input, 'nearly.social', 'nearly.social');
}

// ---------------------------------------------------------------------------
// Global RPC mock — each test sets its own behavior.
// ---------------------------------------------------------------------------

let originalFetch: typeof global.fetch;
let fetchMock: jest.Mock;

function mockRpcOk() {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'vk',
      result: {
        permission: 'FullAccess',
        nonce: 1,
        block_height: 1,
        block_hash: '',
      },
    }),
  } as unknown as Response);
}

function mockRpcUnknownKey() {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'vk',
      error: { cause: { name: 'UNKNOWN_ACCESS_KEY' } },
    }),
  } as unknown as Response);
}

function mockRpcNetworkError() {
  fetchMock.mockRejectedValue(new Error('connection refused'));
}

beforeAll(() => {
  originalFetch = global.fetch;
});

beforeEach(() => {
  __resetNonceStoreForTests();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifyClaim', () => {
  it('accepts a known-good claim', async () => {
    const { claim } = await buildClaim();
    mockRpcOk();
    const r = await verify(claim);
    expect(r.valid).toBe(true);
    if (r.valid) {
      expect(r.account_id).toBe('alice.near');
      expect(r.recipient).toBe('nearly.social');
      expect(r.message.action).toBe('register');
      expect(r.message.domain).toBe('nearly.social');
      expect(typeof r.verified_at).toBe('number');
    }
  });

  it('rejects a tampered signature without calling RPC', async () => {
    const { claim } = await buildClaim();
    const other = await buildClaim();
    const tampered = { ...claim, signature: other.claim.signature };
    const r = await verify(tampered);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('signature');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the signed message account_id differs from the claim account_id', async () => {
    // Build a valid claim for victim.near, then spoof the outer account_id
    // to attacker.near. The signature is still valid (it's over the unchanged
    // message bytes which still say account_id: 'victim.near'), so without
    // the spoof guard a naive partner reading result.message.account_id would
    // see 'victim.near' while the authoritative claim is from 'attacker.near'.
    const { claim } = await buildClaim({ accountId: 'victim.near' });
    const spoofed = { ...claim, account_id: 'attacker.near' };
    const r = await verify(spoofed);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('malformed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when the public key is not bound to the account', async () => {
    const { claim } = await buildClaim();
    mockRpcUnknownKey();
    const r = await verify(claim);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('account_binding');
  });

  it('rejects when the NEAR account does not exist', async () => {
    const { claim } = await buildClaim();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        id: 'vk',
        error: { cause: { name: 'UNKNOWN_ACCOUNT' } },
      }),
    } as unknown as Response);
    const r = await verify(claim);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('account_binding');
  });

  it('rejects stale claims', async () => {
    const { claim } = await buildClaim({ timestamp: Date.now() - 10 * 60_000 });
    const r = await verify(claim);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('expired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects future-dated claims', async () => {
    const { claim } = await buildClaim({ timestamp: Date.now() + 5 * 60_000 });
    const r = await verify(claim);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('expired');
  });

  it('rejects a replayed nonce', async () => {
    const { claim } = await buildClaim();
    mockRpcOk();
    const r1 = await verify(claim);
    expect(r1.valid).toBe(true);
    const r2 = await verify(claim);
    expect(r2.valid).toBe(false);
    if (!r2.valid) expect(r2.reason).toBe('replay');
  });

  it('rejects malformed claims (missing field)', async () => {
    const { claim } = await buildClaim();
    const broken = { ...claim } as Partial<VerifiableClaim>;
    delete broken.signature;
    const r = await verify(broken);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('malformed');
  });

  it('rejects unparseable message JSON', async () => {
    const { claim } = await buildClaim();
    const broken = { ...claim, message: '{not json' };
    const r = await verify(broken);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('malformed');
  });

  it('rejects when RPC query fails with a network error', async () => {
    const { claim } = await buildClaim();
    mockRpcNetworkError();
    const r = await verify(claim);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('rpc_error');
  });

  it('rejects when RPC returns a non-2xx HTTP status', async () => {
    const { claim } = await buildClaim();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    } as unknown as Response);
    const r = await verify(claim);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('rpc_error');
  });

  it('allows retrying the same claim after a transient RPC failure', async () => {
    const { claim } = await buildClaim();
    mockRpcNetworkError();
    const first = await verify(claim);
    expect(first.valid).toBe(false);
    if (!first.valid) expect(first.reason).toBe('rpc_error');
    mockRpcOk();
    const second = await verify(claim);
    expect(second.valid).toBe(true);
  });

  it('rejects claims signed for a different recipient', async () => {
    const { claim } = await buildClaim({ recipient: 'near.fm' });
    const r = await verify(claim);
    expect(r.valid).toBe(false);
    // Recipient is bound inside the hashed payload, so tampering shows up
    // as a signature failure.
    if (!r.valid) expect(r.reason).toBe('signature');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects claims whose message domain fails the expected_domain pin', async () => {
    const { claim } = await buildClaim({ domain: 'near.fm' });
    const r = await verify(claim);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('malformed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies implicit accounts without calling RPC', async () => {
    const { claim } = await buildClaim({ implicit: true });
    const r = await verify(claim);
    expect(r.valid).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an implicit account whose hex does not match the public key', async () => {
    const { claim, privateKey } = await buildClaim({ implicit: true });
    const wrongHex = 'f'.repeat(64);
    const parsed = JSON.parse(claim.message);
    parsed.account_id = wrongHex;
    const newMessage = JSON.stringify(parsed);
    const nonceBytes = Uint8Array.from(Buffer.from(claim.nonce, 'base64'));
    const payload = concat([
      new Uint8Array([0x9d, 0x01, 0x00, 0x80]),
      borshString(newMessage),
      nonceBytes,
      borshString('nearly.social'),
      new Uint8Array([0x00]),
    ]);
    const hash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', payload as BufferSource),
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign('Ed25519', privateKey, hash as BufferSource),
    );
    const broken = {
      ...claim,
      account_id: wrongHex,
      message: newMessage,
      signature: base58Encode(sig),
    };
    const r = await verify(broken);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('account_binding');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a signature encoded as raw base64 (signature_base64 interop)', async () => {
    const { claim, signatureBytes } = await buildClaim({ implicit: true });
    const sigBase64 = Buffer.from(signatureBytes).toString('base64');
    const asBase64Claim = { ...claim, signature: sigBase64 };
    const r = await verify(asBase64Claim);
    expect(r.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // General-purpose verifier — non-nearly.social recipients and pinning knobs
  // -------------------------------------------------------------------------

  it('verifies a claim for a non-nearly recipient (market.near.ai)', async () => {
    const { claim } = await buildClaim({
      implicit: true,
      recipient: 'market.near.ai',
      domain: 'market.near.ai',
    });
    const r = await verifyClaim(claim, 'market.near.ai', 'market.near.ai');
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.recipient).toBe('market.near.ai');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when caller-supplied recipient does not match the signed envelope', async () => {
    const { claim } = await buildClaim({
      implicit: true,
      recipient: 'market.near.ai',
      domain: 'market.near.ai',
    });
    // Claim was signed for market.near.ai; verifier pins near.fm. Hash
    // reconstructed with near.fm won't match, so signature verify fails.
    const r = await verifyClaim(claim, 'near.fm');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('signature');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts when expected_domain matches the message domain', async () => {
    const { claim } = await buildClaim({
      implicit: true,
      recipient: 'market.near.ai',
      domain: 'market.near.ai',
    });
    const r = await verifyClaim(claim, 'market.near.ai', 'market.near.ai');
    expect(r.valid).toBe(true);
  });

  it('rejects when expected_domain is set but mismatches the message domain', async () => {
    const { claim } = await buildClaim({
      implicit: true,
      recipient: 'market.near.ai',
      domain: 'market.near.ai',
    });
    const r = await verifyClaim(claim, 'market.near.ai', 'something.else');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('malformed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips the domain check when expected_domain is unset', async () => {
    const { claim } = await buildClaim({
      implicit: true,
      recipient: 'market.near.ai',
      domain: 'anything.xyz',
    });
    // No third argument — message.domain is free to be whatever.
    const r = await verifyClaim(claim, 'market.near.ai');
    expect(r.valid).toBe(true);
  });

  it('rejects a direct call with a recipient that does not match the signed envelope', async () => {
    // Empty or tampered recipients reconstruct a different Borsh payload,
    // so the signature fails to verify — no pre-check needed.
    const { claim } = await buildClaim({ implicit: true });
    const r = await verifyClaim(claim, '');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toBe('signature');
  });

  it('canonicalizes the nonce so encoding variations cannot bypass replay', async () => {
    // Build a valid implicit claim, submit it once, then resubmit the same
    // claim with padding stripped from the nonce string. Both decode to the
    // same 32 bytes, so the second submission must be rejected as a replay.
    const { claim } = await buildClaim({ implicit: true });
    const first = await verifyClaim(claim, 'nearly.social');
    expect(first.valid).toBe(true);

    // Node's Buffer.from('base64') tolerates missing padding — strip the `==`
    // and confirm it still decodes to 32 bytes (otherwise the attack premise
    // doesn't apply and the test is meaningless).
    const unpadded = claim.nonce.replace(/=+$/, '');
    expect(unpadded).not.toBe(claim.nonce);
    expect(Buffer.from(unpadded, 'base64').length).toBe(32);

    const replay = await verifyClaim(
      { ...claim, nonce: unpadded },
      'nearly.social',
    );
    expect(replay.valid).toBe(false);
    if (!replay.valid) expect(replay.reason).toBe('replay');
  });

  it('isolates replay protection per recipient', async () => {
    // Same 32 nonce bytes used for two different recipients — both succeed
    // because the nonce store is keyed per recipient.
    const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
    const a = await buildClaim({
      implicit: true,
      recipient: 'market.near.ai',
      domain: 'market.near.ai',
      nonceBytes,
    });
    const b = await buildClaim({
      implicit: true,
      recipient: 'near.fm',
      domain: 'near.fm',
      nonceBytes,
    });
    const ra = await verifyClaim(a.claim, 'market.near.ai', 'market.near.ai');
    expect(ra.valid).toBe(true);
    const rb = await verifyClaim(b.claim, 'near.fm', 'near.fm');
    expect(rb.valid).toBe(true);
    // Replaying A against its own recipient now fails.
    const raReplay = await verifyClaim(
      a.claim,
      'market.near.ai',
      'market.near.ai',
    );
    expect(raReplay.valid).toBe(false);
    if (!raReplay.valid) expect(raReplay.reason).toBe('replay');
  });
});
