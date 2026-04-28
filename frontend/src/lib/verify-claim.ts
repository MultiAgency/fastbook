/**
 * General-purpose NEP-413 verifiable claim verifier.
 *
 * The caller pins the recipient (and optionally a message-layer domain) via
 * `recipient` / `expectedDomain` parameters. Pure function: decode → freshness → signature → replay →
 * on-chain binding. The in-memory nonce store is best-effort defense-in-depth
 * and resets on cold start — the signature + freshness checks are the security
 * boundary. For a multi-instance deployment, replace `seenNonce` / `forgetNonce`
 * with a shared TTL store; both call sites are isolated to this module.
 */

import { CLAIM_FRESHNESS_MS, NEAR_RPC_URL } from '@/lib/constants';
import { fetchWithTimeout } from '@/lib/fetch';
import type {
  VerifiableClaim,
  VerifyClaimFailure,
  VerifyClaimResponse,
} from '@/types';

const RPC_TIMEOUT_MS = 5_000;
const FUTURE_SKEW_MS = 60_000;
/** NEAR implicit account: 64 lowercase hex chars = hex(public_key_bytes). */
const IMPLICIT_ACCOUNT_RE = /^[0-9a-f]{64}$/;
/** NEP-413 Borsh tag = 2^31 + 413 = 2147484061 = 0x8000019D (little-endian). */
const CLAIM_TAG = new Uint8Array([0x9d, 0x01, 0x00, 0x80]);

const nonceStore = new Map<string, number>();
let nonceCalls = 0;
const NONCE_EVICTION_INTERVAL = 500;
// Hard cap on entries — when reached, an immediate sweep runs ahead of the
// next insertion. Bounds memory under bursts of valid signatures arriving
// faster than the 500-call sweep interval. Replay protection isn't
// affected: still-fresh entries survive the sweep, expired ones don't.
const NONCE_MAX_ENTRIES = 50_000;

function nonceKey(recipient: string, nonce: string): string {
  return `${recipient}:${nonce}`;
}

function seenNonce(recipient: string, nonce: string, ttlMs: number): boolean {
  const now = Date.now();
  if (
    ++nonceCalls >= NONCE_EVICTION_INTERVAL ||
    nonceStore.size >= NONCE_MAX_ENTRIES
  ) {
    nonceCalls = 0;
    for (const [k, expiresAt] of nonceStore) {
      if (expiresAt <= now) nonceStore.delete(k);
    }
  }
  const key = nonceKey(recipient, nonce);
  const existing = nonceStore.get(key);
  if (existing != null && existing > now) return true;
  nonceStore.set(key, now + ttlMs);
  return false;
}

function forgetNonce(recipient: string, nonce: string): void {
  nonceStore.delete(nonceKey(recipient, nonce));
}

/** Test-only: clear the nonce store. */
export function __resetNonceStoreForTests(): void {
  nonceStore.clear();
  nonceCalls = 0;
}

const B58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Int8Array(128).fill(-1);
for (let i = 0; i < B58_ALPHABET.length; i++) {
  B58_MAP[B58_ALPHABET.charCodeAt(i)] = i;
}

function base58Decode(str: string): Uint8Array | null {
  if (str.length === 0) return new Uint8Array(0);
  const bytes: number[] = [];
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  for (let i = zeros; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const val = code < 128 ? B58_MAP[code] : -1;
    if (val < 0) return null;
    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + bytes.length - 1 - i] = bytes[i];
  }
  return out;
}

function u32Le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
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

function buildClaimPayload(
  message: string,
  nonce: Uint8Array,
  recipient: string,
): Uint8Array {
  return concat([
    CLAIM_TAG,
    borshString(message),
    nonce,
    borshString(recipient),
    new Uint8Array([0x00]), // Option::None for callbackUrl
  ]);
}

function fail(
  reason: VerifyClaimFailure['reason'],
  detail?: string,
  account_id?: string,
): VerifyClaimResponse {
  return {
    valid: false,
    reason,
    ...(detail ? { detail } : {}),
    ...(account_id ? { account_id } : {}),
  };
}

function isClaimShape(c: unknown): c is VerifiableClaim {
  return (
    typeof c === 'object' &&
    c !== null &&
    'account_id' in c &&
    typeof c.account_id === 'string' &&
    'public_key' in c &&
    typeof c.public_key === 'string' &&
    'signature' in c &&
    typeof c.signature === 'string' &&
    'nonce' in c &&
    typeof c.nonce === 'string' &&
    'message' in c &&
    typeof c.message === 'string'
  );
}

async function viewAccessKey(
  accountId: string,
  publicKey: string,
): Promise<'ok' | 'unknown_access_key' | 'unknown_account' | 'rpc_error'> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      NEAR_RPC_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'vk',
          method: 'query',
          params: {
            request_type: 'view_access_key',
            finality: 'final',
            account_id: accountId,
            public_key: publicKey,
          },
        }),
      },
      RPC_TIMEOUT_MS,
    );
  } catch {
    return 'rpc_error';
  }
  if (!resp.ok) return 'rpc_error';
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return 'rpc_error';
  }
  const r = body as Record<string, unknown>;
  if (r && typeof r === 'object') {
    const err = r.error as { cause?: { name?: string } } | undefined;
    if (err?.cause?.name === 'UNKNOWN_ACCESS_KEY') return 'unknown_access_key';
    if (err?.cause?.name === 'UNKNOWN_ACCOUNT') return 'unknown_account';
    if (r.result) return 'ok';
  }
  return 'rpc_error';
}

export async function verifyClaim(
  input: unknown,
  recipient: string,
  expectedDomain?: string,
): Promise<VerifyClaimResponse> {
  if (!isClaimShape(input))
    return fail('malformed', 'Missing required claim fields');
  const claim = input;

  let parsed: Record<string, unknown>;
  try {
    const p = JSON.parse(claim.message);
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      return fail(
        'malformed',
        'Message is not a JSON object',
        claim.account_id,
      );
    }
    parsed = p as Record<string, unknown>;
  } catch {
    return fail('malformed', 'Message is not valid JSON', claim.account_id);
  }

  const action = parsed.action;
  const domain = parsed.domain;
  const version = parsed.version;
  const timestamp = parsed.timestamp;
  if (typeof timestamp !== 'number') {
    return fail(
      'malformed',
      'Message must include a numeric timestamp',
      claim.account_id,
    );
  }
  if (action !== undefined && typeof action !== 'string') {
    return fail(
      'malformed',
      'Message action must be a string',
      claim.account_id,
    );
  }
  if (domain !== undefined && typeof domain !== 'string') {
    return fail(
      'malformed',
      'Message domain must be a string',
      claim.account_id,
    );
  }
  if (version !== undefined && typeof version !== 'number') {
    return fail(
      'malformed',
      'Message version must be a number',
      claim.account_id,
    );
  }

  // If the signed message asserts an account_id, it must match the outer claim.
  // Without this guard a partner reading result.message.account_id would accept
  // a spoofed identity: OutLayer signs arbitrary JSON, so an attacker with a
  // valid wk_ wallet for attacker.near could sign a message claiming to be
  // victim.near. The outer claim.account_id stays honest (bound by the access
  // key check below) — this closes the inner field.
  if (
    typeof parsed.account_id === 'string' &&
    parsed.account_id !== claim.account_id
  ) {
    return fail(
      'malformed',
      'Message account_id does not match claim account_id',
      claim.account_id,
    );
  }

  if (expectedDomain !== undefined) {
    if (typeof domain !== 'string' || domain !== expectedDomain) {
      return fail(
        'malformed',
        `Message domain must be ${expectedDomain}`,
        claim.account_id,
      );
    }
  }

  const now = Date.now();
  if (timestamp > now + FUTURE_SKEW_MS) {
    return fail('expired', 'Timestamp is in the future', claim.account_id);
  }
  if (timestamp < now - CLAIM_FRESHNESS_MS) {
    return fail(
      'expired',
      'Claim is older than freshness window',
      claim.account_id,
    );
  }

  if (!claim.public_key.startsWith('ed25519:')) {
    return fail(
      'malformed',
      'Public key missing ed25519: prefix',
      claim.account_id,
    );
  }
  const pubKeyBytes = base58Decode(claim.public_key.slice('ed25519:'.length));
  if (!pubKeyBytes || pubKeyBytes.length !== 32) {
    return fail('malformed', 'Public key is not 32 bytes', claim.account_id);
  }

  // NEAR wire format is base58 (ed25519: prefix optional). /wallet/v1/sign-message
  // also returns `signature_base64`; partners may pass either form, so try base58
  // first and fall back to base64 on length mismatch.
  const sigRaw = claim.signature.startsWith('ed25519:')
    ? claim.signature.slice('ed25519:'.length)
    : claim.signature;
  let sigBytes = base58Decode(sigRaw);
  if (!sigBytes || sigBytes.length !== 64) {
    const alt = Uint8Array.from(Buffer.from(sigRaw, 'base64'));
    if (alt.length === 64) sigBytes = alt;
  }
  if (!sigBytes || sigBytes.length !== 64) {
    return fail('malformed', 'Signature is not 64 bytes', claim.account_id);
  }

  const nonceBytes = Uint8Array.from(Buffer.from(claim.nonce, 'base64'));
  if (nonceBytes.length !== 32) {
    return fail('malformed', 'Nonce is not 32 bytes', claim.account_id);
  }
  // Canonicalize the nonce for the replay store. `Buffer.from(x, 'base64')`
  // tolerates padding variations, whitespace, and base64url characters, so
  // two different strings can decode to the same 32 bytes. Keying the store
  // by the raw string would let an attacker tweak encoding to bypass replay
  // protection — the decoded-hex form is the only canonical identifier.
  const nonceHex = Buffer.from(nonceBytes).toString('hex');

  const payload = buildClaimPayload(claim.message, nonceBytes, recipient);
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', payload as BufferSource),
  );

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      pubKeyBytes as BufferSource,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch {
    return fail('malformed', 'Could not import public key', claim.account_id);
  }
  const ok = await crypto.subtle.verify(
    'Ed25519',
    key,
    sigBytes as BufferSource,
    hash as BufferSource,
  );
  if (!ok) {
    return fail('signature', 'Signature does not verify', claim.account_id);
  }

  // Replay check — only valid signatures may claim a nonce slot, so bogus
  // traffic can't fill the store. Keyed per recipient so two platforms can
  // safely pick matching nonces without cross-platform replay risk.
  if (seenNonce(recipient, nonceHex, CLAIM_FRESHNESS_MS)) {
    return fail('replay', 'Nonce has already been used', claim.account_id);
  }

  // Implicit accounts bind structurally — account_id is hex(pubkey), so the
  // RPC round-trip is unnecessary. Named accounts still query view_access_key.
  if (IMPLICIT_ACCOUNT_RE.test(claim.account_id)) {
    const expectedHex = Buffer.from(pubKeyBytes).toString('hex');
    if (expectedHex !== claim.account_id) {
      return fail(
        'account_binding',
        'Implicit account does not match public key',
        claim.account_id,
      );
    }
  } else {
    const binding = await viewAccessKey(claim.account_id, claim.public_key);
    if (binding === 'rpc_error') {
      // Transient upstream failure isn't the caller's fault — release the
      // nonce so they can retry the same claim.
      forgetNonce(recipient, nonceHex);
      return fail('rpc_error', 'NEAR RPC query failed', claim.account_id);
    }
    if (binding === 'unknown_access_key') {
      return fail(
        'account_binding',
        'Public key is not an access key of this account',
        claim.account_id,
      );
    }
    if (binding === 'unknown_account') {
      return fail(
        'account_binding',
        'NEAR account does not exist',
        claim.account_id,
      );
    }
  }

  return {
    valid: true,
    account_id: claim.account_id,
    public_key: claim.public_key,
    recipient,
    nonce: claim.nonce,
    message: {
      ...(typeof action === 'string' ? { action } : {}),
      ...(typeof domain === 'string' ? { domain } : {}),
      ...(typeof parsed.account_id === 'string'
        ? { account_id: parsed.account_id }
        : {}),
      ...(typeof version === 'number' ? { version } : {}),
      timestamp,
    },
    verified_at: now,
  };
}
