#!/usr/bin/env node
// test-sign-claim.mjs — Real OutLayer claim round-trip.
//
// Uses a wk_ key from ~/.config/nearly/credentials.json to sign a NEP-413
// claim via OutLayer's /wallet/v1/sign-message, then submits it to the
// verifier and asserts valid: true. This is the only test that exercises
// the actual production signing path end-to-end (test-verify-claim.mjs
// uses local throwaway keypairs and does not touch OutLayer).
//
// Usage:
//   node scripts/test-sign-claim.mjs
//   node scripts/test-sign-claim.mjs --url https://nearly.social/api/v1/verify-claim
//   NEARLY_VERIFY_URL=https://... node scripts/test-sign-claim.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const DEFAULT_VERIFIER = 'https://nearly.social/api/v1/verify-claim';
const OUTLAYER_SIGN = 'https://api.outlayer.fastnear.com/wallet/v1/sign-message';
const CLAIM_DOMAIN = 'nearly.social';
const CLAIM_VERSION = 1;
const CREDS_FILE = path.join(os.homedir(), '.config/nearly/credentials.json');
const FETCH_TIMEOUT_MS = 15_000;

// Reads headers + body within a single timeout window. The naive pattern
// (clearTimeout right after `await fetch`) leaves body reads unbounded.
async function fetchJson(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: controller.signal });
    const text = await resp.text();
    return {
      status: resp.status,
      ok: resp.ok,
      text,
      json: () => JSON.parse(text),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argv) {
  const out = { verifier: process.env.NEARLY_VERIFY_URL ?? DEFAULT_VERIFIER };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) out.verifier = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('Usage: node scripts/test-sign-claim.mjs [--url <verifier>]');
      process.exit(0);
    }
  }
  return out;
}

function loadWalletKey() {
  if (!fs.existsSync(CREDS_FILE)) {
    console.error(`${RED}No credentials at ${CREDS_FILE}${RESET}`);
    console.error('Run ./scripts/smoke.sh first to create a wallet.');
    process.exit(2);
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  const entries = Object.entries(creds.accounts ?? {});
  if (entries.length === 0) {
    console.error(`${RED}No accounts in credentials file${RESET}`);
    process.exit(2);
  }
  // account_id is the map key; older files may not replicate it in the value.
  const [account_id, entry] = entries[0];
  return { api_key: entry.api_key, account_id };
}

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ${GREEN}✓${RESET} ${label}`);
    passed++;
  } else {
    console.log(`  ${RED}✗${RESET} ${label}`);
    if (detail) console.log(`    ${DIM}${detail}${RESET}`);
    failed++;
  }
}

async function signClaim(apiKey, accountId, action) {
  const message = JSON.stringify({
    action,
    domain: CLAIM_DOMAIN,
    account_id: accountId,
    version: CLAIM_VERSION,
    timestamp: Date.now(),
  });
  const resp = await fetchJson(OUTLAYER_SIGN, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, recipient: CLAIM_DOMAIN }),
  });
  if (!resp.ok) {
    throw new Error(`OutLayer sign failed: HTTP ${resp.status} ${resp.text}`);
  }
  const signed = resp.json();
  return {
    account_id: signed.account_id,
    public_key: signed.public_key,
    signature: signed.signature,
    nonce: signed.nonce,
    message,
  };
}

async function postVerify(url, body) {
  const resp = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: resp.json() };
}

async function run() {
  const { verifier } = parseArgs(process.argv.slice(2));
  const { api_key, account_id } = loadWalletKey();

  console.log(`Minting real OutLayer claim for ${account_id}`);
  console.log(`Verifier: ${verifier}\n`);

  console.log('1. Mint + verify happy path');
  const claim = await signClaim(api_key, account_id, 'login');
  check('claim.account_id matches credentials', claim.account_id === account_id,
    `got ${claim.account_id}`);
  check('claim.signature present', typeof claim.signature === 'string' && claim.signature.length > 0);
  check('claim.nonce present', typeof claim.nonce === 'string' && claim.nonce.length > 0);

  const v1 = await postVerify(verifier, { ...claim, recipient: CLAIM_DOMAIN });
  check('verifier status 200', v1.status === 200, `got ${v1.status}`);
  check('verifier valid: true', v1.body.valid === true,
    `reason=${v1.body.reason ?? 'none'}`);
  check('verifier echoes recipient', v1.body.recipient === CLAIM_DOMAIN);
  check('verifier parses message.action === login',
    v1.body.message?.action === 'login');

  console.log('\n2. Replay detection on real claim');
  const v2 = await postVerify(verifier, { ...claim, recipient: CLAIM_DOMAIN });
  check('verifier status 200', v2.status === 200, `got ${v2.status}`);
  check('replay valid: false', v2.body.valid === false);
  check("replay reason: 'replay'", v2.body.reason === 'replay',
    `got ${v2.body.reason}`);

  const total = passed + failed;
  const failedStr = failed > 0 ? `${RED}${failed} failed${RESET}` : '0 failed';
  console.log(`\n${total} checks — ${GREEN}${passed} passed${RESET}, ${failedStr}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(`${RED}Error: ${err.message}${RESET}`);
  process.exit(1);
});
