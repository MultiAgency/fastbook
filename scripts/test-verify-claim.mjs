#!/usr/bin/env node
/**
 * End-to-end test script for the general-purpose NEP-413 verifier.
 *
 * Usage:
 *   node scripts/test-verify-claim.mjs
 *   node scripts/test-verify-claim.mjs --url https://nearly.social/api/v1/verify-claim
 *   NEARLY_VERIFY_URL=https://... node scripts/test-verify-claim.mjs
 *
 * Mints fresh NEP-413 claims using local Node 22 WebCrypto, posts them to the
 * verify-claim endpoint, and asserts the expected shape for each scenario.
 * All tests use implicit NEAR accounts (account_id = hex(pubkey)) so the
 * server never has to touch NEAR RPC — the script runs offline-end-to-end
 * against a local `next dev` or any deployed instance.
 *
 * Exits 0 on all pass, 1 otherwise.
 */

const DEFAULT_URL = 'http://localhost:3000/api/v1/verify-claim';
const FETCH_TIMEOUT_MS = 10_000;

function parseArgs(argv) {
  const out = { url: process.env.NEARLY_VERIFY_URL ?? DEFAULT_URL };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(
        'Usage: node scripts/test-verify-claim.mjs [--url <endpoint>]',
      );
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base58 encoder (Bitcoin alphabet) — NEAR's wire format for keys/signatures.
// ---------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  if (bytes.length === 0) return '';
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
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

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// NEP-413 payload construction + signing
// ---------------------------------------------------------------------------

/** NEP-413 Borsh tag = 2^31 + 413 = 0x8000019D (little-endian). */
const NEP413_TAG = new Uint8Array([0x9d, 0x01, 0x00, 0x80]);

function u32Le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function borshString(s) {
  const utf8 = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + utf8.length);
  out.set(u32Le(utf8.length), 0);
  out.set(utf8, 4);
  return out;
}

function concat(parts) {
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

/**
 * Sign a fresh NEP-413 claim with a throwaway Ed25519 keypair, using
 * `account_id = hex(pubkey)` so the verifier's implicit-account fast path
 * binds the claim without touching NEAR RPC.
 */
async function signClaim({
  action = 'login',
  domain = 'nearly.social',
  recipient = 'nearly.social',
  timestamp = Date.now(),
  nonceBytes,
} = {}) {
  const kp = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);
  const pubkeyBytes = new Uint8Array(
    await crypto.subtle.exportKey('raw', kp.publicKey),
  );
  const accountId = toHex(pubkeyBytes);

  const message = JSON.stringify({
    action,
    domain,
    account_id: accountId,
    version: 1,
    timestamp,
  });

  const nonce = nonceBytes ?? crypto.getRandomValues(new Uint8Array(32));
  const payload = concat([
    NEP413_TAG,
    borshString(message),
    nonce,
    borshString(recipient),
    new Uint8Array([0x00]),
  ]);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign('Ed25519', kp.privateKey, hash),
  );

  return {
    account_id: accountId,
    public_key: `ed25519:${base58Encode(pubkeyBytes)}`,
    signature: base58Encode(sig),
    nonce: Buffer.from(nonce).toString('base64'),
    message,
  };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function post(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    return { status: 0, body: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = await resp.json();
  } catch {}
  return { status: resp.status, body: json };
}

let passed = 0;
let failed = 0;
const USE_COLOR = process.stdout.isTTY;
const GREEN = USE_COLOR ? '\x1b[32m' : '';
const RED = USE_COLOR ? '\x1b[31m' : '';
const DIM = USE_COLOR ? '\x1b[2m' : '';
const RESET = USE_COLOR ? '\x1b[0m' : '';

function assert(name, cond, detail) {
  if (cond) {
    console.log(`  ${GREEN}✓${RESET} ${name}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${name}`);
    if (detail) console.log(`      ${DIM}${detail}${RESET}`);
    failed++;
  }
}

async function run(url) {
  console.log(`Testing verify-claim at ${url}\n`);

  // 1. Happy path — implicit account, valid claim, expected_domain matches.
  {
    console.log('1. Happy path (implicit account, recipient+domain pinned)');
    const claim = await signClaim();
    const result = await post(url, {
      ...claim,
      recipient: 'nearly.social',
      expected_domain: 'nearly.social',
    });
    if (result.error) {
      console.error(
        `\n${RED}Could not reach ${url}: ${result.error}${RESET}\n` +
          'Start the dev server (cd frontend && npm run dev) or pass --url.',
      );
      process.exit(2);
    }
    const { status, body } = result;
    assert('status 200', status === 200, `got ${status}`);
    assert('valid: true', body?.valid === true, JSON.stringify(body));
    assert('recipient echoed', body?.recipient === 'nearly.social');
    assert("message.action === 'login'", body?.message?.action === 'login');
    assert('verified_at present', typeof body?.verified_at === 'number');
  }

  // 2. Wrong recipient — caller pins a different recipient than the signer used.
  {
    console.log('\n2. Wrong recipient (signed for A, verifier pins B)');
    const claim = await signClaim({
      recipient: 'market.near.ai',
      domain: 'market.near.ai',
    });
    const { status, body } = await post(url, {
      ...claim,
      recipient: 'nearly.social',
    });
    assert('status 200', status === 200);
    assert('valid: false', body?.valid === false);
    assert("reason: 'signature'", body?.reason === 'signature');
  }

  // 3. Missing recipient — route handler rejects with 400.
  {
    console.log('\n3. Missing recipient field');
    const claim = await signClaim();
    const { status, body } = await post(url, { ...claim });
    assert('status 400', status === 400, `got ${status}`);
    assert('success: false', body?.success === false);
  }

  // 4. Replay — submit the same claim twice, second must be rejected.
  {
    console.log('\n4. Replay detection');
    const claim = await signClaim();
    const first = await post(url, { ...claim, recipient: 'nearly.social' });
    assert('first valid: true', first.body?.valid === true);
    const second = await post(url, { ...claim, recipient: 'nearly.social' });
    assert('second valid: false', second.body?.valid === false);
    assert("second reason: 'replay'", second.body?.reason === 'replay');
  }

  // 5. Expected-domain mismatch — message.domain does not match the pin.
  {
    console.log('\n5. Expected-domain mismatch');
    const claim = await signClaim({ domain: 'nearly.social' });
    const { body } = await post(url, {
      ...claim,
      recipient: 'nearly.social',
      expected_domain: 'something.else',
    });
    assert('valid: false', body?.valid === false);
    assert("reason: 'malformed'", body?.reason === 'malformed');
  }

  // 6. Expected domain unset — domain pinning is opt-in.
  {
    console.log('\n6. Domain pin skipped when expected_domain is unset');
    const claim = await signClaim({
      recipient: 'market.near.ai',
      domain: 'whatever.xyz',
    });
    const { body } = await post(url, {
      ...claim,
      recipient: 'market.near.ai',
    });
    assert('valid: true', body?.valid === true, JSON.stringify(body));
  }

  // 7. Stale timestamp — older than the freshness window.
  {
    console.log('\n7. Stale timestamp');
    const claim = await signClaim({ timestamp: Date.now() - 10 * 60_000 });
    const { body } = await post(url, {
      ...claim,
      recipient: 'nearly.social',
    });
    assert('valid: false', body?.valid === false);
    assert("reason: 'expired'", body?.reason === 'expired');
  }

  // 8. Nonce canonicalization — strip base64 padding and retry; must replay.
  {
    console.log('\n8. Nonce canonicalization (padding-strip replay attempt)');
    const claim = await signClaim();
    const first = await post(url, { ...claim, recipient: 'nearly.social' });
    assert('first valid: true', first.body?.valid === true);
    const unpadded = claim.nonce.replace(/=+$/, '');
    const replay = await post(url, {
      ...claim,
      nonce: unpadded,
      recipient: 'nearly.social',
    });
    assert('replay valid: false', replay.body?.valid === false);
    assert("replay reason: 'replay'", replay.body?.reason === 'replay');
  }

  console.log(
    `\n${passed + failed} checks — ${GREEN}${passed} passed${RESET}, ${failed > 0 ? `${RED}${failed} failed${RESET}` : '0 failed'}`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

const { url } = parseArgs(process.argv.slice(2));
run(url).catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
