import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import {
  OUTLAYER_ADMIN_ACCOUNT,
  OUTLAYER_ADMIN_NEAR_KEY,
} from '@/lib/constants';
import { accountIdFromBalance } from '@/lib/outlayer-server';

// Admin writes signed by OUTLAYER_ADMIN_NEAR_KEY as hack.near; ±30s token TTL.

const B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(str: string): Uint8Array {
  const bytes = [0];
  for (const ch of str) {
    const val = B58_ALPHA.indexOf(ch);
    if (val < 0) throw new Error(`invalid base58 char: ${ch}`);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch === '1') bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

function b58encode(bytes: Uint8Array): string {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = digits.length - 1; i >= 0; i--) {
    out += B58_ALPHA[digits[i]];
  }
  for (const b of bytes) {
    if (b === 0) out = `1${out}`;
    else break;
  }
  return out || '1';
}

const ADMIN_SEED = 'admin';
const DER_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

let adminKeyParsed: {
  privateKey: ReturnType<typeof createPrivateKey>;
  pubkeyB58: string;
  accountId: string;
} | null = null;

function parseAdminNearKey(): typeof adminKeyParsed {
  if (adminKeyParsed) return adminKeyParsed;
  if (!OUTLAYER_ADMIN_NEAR_KEY) return null;
  const b58 = OUTLAYER_ADMIN_NEAR_KEY.replace(/^ed25519:/, '');
  const expanded = b58decode(b58);
  if (expanded.length !== 64) return null;
  const seed32 = expanded.slice(0, 32);
  const pub32 = expanded.slice(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([DER_PREFIX, seed32]),
    format: 'der',
    type: 'pkcs8',
  });
  const pubkeyB58 = `ed25519:${b58encode(pub32)}`;
  const accountId = process.env.OUTLAYER_ADMIN_ACCOUNT || '';
  adminKeyParsed = { privateKey, pubkeyB58, accountId };
  return adminKeyParsed;
}

export function buildAdminNearToken(): string | null {
  const parsed = parseAdminNearKey();
  if (!parsed) return null;
  const ts = Math.floor(Date.now() / 1000);
  const message = `auth:${ADMIN_SEED}:${ts}`;
  const sigBytes = cryptoSign(null, Buffer.from(message), parsed.privateKey);
  const signatureB58 = b58encode(new Uint8Array(sigBytes));
  const payload = JSON.stringify({
    account_id: parsed.accountId,
    seed: ADMIN_SEED,
    pubkey: parsed.pubkeyB58,
    timestamp: ts,
    signature: signatureB58,
  });
  return `near:${Buffer.from(payload).toString('base64url')}`;
}

let adminWriterAccountCached: string | null = null;

export async function resolveAdminWriterAccount(): Promise<string | null> {
  if (adminWriterAccountCached) return adminWriterAccountCached;
  const token = buildAdminNearToken();
  if (token) {
    const fromBalance = await accountIdFromBalance(token);
    if (fromBalance) {
      adminWriterAccountCached = fromBalance;
      return fromBalance;
    }
  }
  // Fallback: OUTLAYER_ADMIN_ACCOUNT is the custody wallet's account_id
  // (what /wallet/v1/balance returns for the admin wk_). Works without
  // OUTLAYER_ADMIN_NEAR_KEY — the env var is set to the same value the
  // near: token path would resolve to.
  if (OUTLAYER_ADMIN_ACCOUNT) {
    adminWriterAccountCached = OUTLAYER_ADMIN_ACCOUNT;
    return OUTLAYER_ADMIN_ACCOUNT;
  }
  return null;
}
