import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { validationError } from './errors';

export interface ParsedEd25519Key {
  // 64-byte tweetnacl secretKey (seed || publicKey). Do not log or persist.
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

const ED25519_PREFIX = 'ed25519:';

// Throws typed validationError(field='privateKey'); reason never echoes the raw key bytes.
export function parseEd25519SecretKey(str: string): ParsedEd25519Key {
  if (typeof str !== 'string' || !str) {
    throw validationError('privateKey', 'expected ed25519:<base58> string');
  }
  if (!str.startsWith(ED25519_PREFIX)) {
    throw validationError('privateKey', 'expected ed25519: prefix');
  }
  const body = str.slice(ED25519_PREFIX.length);
  if (!body) {
    throw validationError('privateKey', 'empty key body after ed25519: prefix');
  }

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(body);
  } catch {
    throw validationError('privateKey', 'invalid base58 encoding');
  }

  // tweetnacl's "secret key" is the 64-byte concat of seed + public; accept either shape and normalize.
  if (decoded.length === 32) {
    const kp = nacl.sign.keyPair.fromSeed(decoded);
    return { secretKey: kp.secretKey, publicKey: kp.publicKey };
  }
  if (decoded.length === 64) {
    const seed = decoded.slice(0, 32);
    const storedPublic = decoded.slice(32);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    if (!constantTimeEquals(kp.publicKey, storedPublic)) {
      throw validationError(
        'privateKey',
        'stored public key does not match derived public key',
      );
    }
    return { secretKey: kp.secretKey, publicKey: kp.publicKey };
  }
  throw validationError(
    'privateKey',
    `expected 32 or 64 byte key, got ${decoded.length}`,
  );
}

// Raw ed25519, not NEP-413 — OutLayer's deterministic /register wants the raw signature.
export function signRegisterMessage(
  message: string,
  secretKey: Uint8Array,
): Uint8Array {
  return nacl.sign.detached(new TextEncoder().encode(message), secretKey);
}

export function encodeEd25519PublicKey(publicKey: Uint8Array): string {
  return `${ED25519_PREFIX}${bs58.encode(publicKey)}`;
}

export function encodeSignatureBase58(signature: Uint8Array): string {
  return bs58.encode(signature);
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
