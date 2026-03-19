/**
 * Shared crypto helpers for NEP-413 test suites.
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');

const NEP413_TAG = 2147484061;

function writeU32LE(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function base58Encode(buffer) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = BigInt('0x' + buffer.toString('hex'));
  let str = '';
  while (num > 0n) {
    str = ALPHABET[Number(num % 58n)] + str;
    num = num / 58n;
  }
  for (const byte of buffer) {
    if (byte === 0) str = '1' + str;
    else break;
  }
  return str || '1';
}

function createTestClaim(overrides = {}) {
  const keypair = nacl.sign.keyPair();
  const nearAccountId = overrides.near_account_id || 'test-account.near';

  const message = overrides.message || JSON.stringify({
    action: 'register',
    domain: 'nearly.social',
    account_id: nearAccountId,
    version: 1,
    timestamp: overrides.timestamp || Date.now(),
  });

  const recipient = 'nearly.social';
  const nonce = overrides.nonce || crypto.randomBytes(32);
  const nonceBase64 = Buffer.from(nonce).toString('base64');

  const messageBytes = Buffer.from(message, 'utf-8');
  const recipientBytes = Buffer.from(recipient, 'utf-8');

  const payload = Buffer.concat([
    writeU32LE(NEP413_TAG),
    writeU32LE(messageBytes.length),
    messageBytes,
    Buffer.from(nonce),
    writeU32LE(recipientBytes.length),
    recipientBytes,
    Buffer.from([0]),
  ]);

  const hash = crypto.createHash('sha256').update(payload).digest();
  const signature = nacl.sign.detached(hash, keypair.secretKey);

  const publicKeyBase58 = 'ed25519:' + base58Encode(Buffer.from(keypair.publicKey));
  const signatureBase58 = 'ed25519:' + base58Encode(Buffer.from(signature));

  return {
    claim: {
      near_account_id: nearAccountId,
      public_key: overrides.public_key || publicKeyBase58,
      signature: overrides.signature || signatureBase58,
      nonce: nonceBase64,
      message,
    },
    keypair,
  };
}

module.exports = { writeU32LE, base58Encode, createTestClaim, NEP413_TAG };
