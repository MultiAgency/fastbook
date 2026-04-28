#!/usr/bin/env node
/**
 * Seed a polished profile + optional outgoing edges for the demo
 * directory on nearly.social.
 *
 * Reads a JSON config file describing the profile shape and any
 * endorsements / follows to write. Defaults to DRY-RUN — no network
 * writes happen unless `--execute` is passed. The dry-run prints the
 * parsed plan so you can review exactly what would land before
 * committing to it.
 *
 *
 * Usage:
 *   node scripts/seed-demo.mjs --config /path/to/seed.json           # dry-run
 *   node scripts/seed-demo.mjs --config /path/to/seed.json --execute
 *   node scripts/seed-demo.mjs --config /path/to/seed.json --api http://localhost:3000/api/v1
 *
 * Credentials (shell env first, then frontend/.env):
 *   OUTLAYER_TEST_WALLET_KEY — the wallet whose profile gets seeded
 *
 *
 * Config file shape:
 *
 *   {
 *     "profile": {
 *       "name":         "string",
 *       "description":  "string",
 *       "image":        "https://... | null",
 *       "tags":         ["tag1", "tag2", ...],
 *       "capabilities": { "skills": ["..."], "worked_on": ["..."], ... }
 *     },
 *     "endorse": [
 *       {
 *         "target":       "account.near",
 *         "key_suffixes": ["skills/rust", "task_completion/job_42"],
 *         "reason":       "optional free-text annotation"
 *       }
 *     ],
 *     "follow": [
 *       { "target": "account.near", "reason": "optional" }
 *     ]
 *   }
 *
 * `profile` is required; `endorse` and `follow` are optional arrays.
 *
 *
 * Product-judgment note:
 *   This script writes content that becomes visible to every NEAR
 *   community visitor on the directory. The seed config is NOT
 *   committed to the repo — you maintain it yourself. The script
 *   will not run without a config file, and even with one will
 *   dry-run by default. Review the printed plan before passing
 *   --execute. The alignment-doc commitments still apply to seeded
 *   content: no "reputation" framing in tags/descriptions, no
 *   gatekeeping affordances, tags/capabilities must pass the same
 *   validators the handler enforces.
 *
 *
 * Exit codes:
 *   0 — dry-run completed, or --execute succeeded
 *   1 — at least one write failed during --execute
 *   2 — configuration error (missing env var, missing/invalid config)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API = 'https://nearly.social/api/v1';
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Argument + env loading
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    api: process.env.NEARLY_API ?? DEFAULT_API,
    config: null,
    execute: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--api' && argv[i + 1]) out.api = argv[++i];
    else if (argv[i] === '--config' && argv[i + 1]) out.config = argv[++i];
    else if (argv[i] === '--execute') out.execute = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(
        'Usage: node scripts/seed-demo.mjs --config <file> [--execute] [--api <base>]\n' +
          '\n' +
          'Env:\n' +
          '  OUTLAYER_TEST_WALLET_KEY  wallet whose profile gets seeded\n' +
          '  NEARLY_API               API base URL (default: production)\n' +
          '\n' +
          'Default is dry-run — use --execute to actually write.\n',
      );
      process.exit(0);
    }
  }
  return out;
}

function loadEnvVar(name) {
  if (process.env[name]) return process.env[name];
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const envPath = join(scriptDir, '..', 'frontend', '.env');
    if (!existsSync(envPath)) return null;
    const content = readFileSync(envPath, 'utf8');
    const pattern = new RegExp(`^${name}=(.+)$`);
    for (const line of content.split('\n')) {
      const match = line.match(pattern);
      if (match) return match[1].trim();
    }
  } catch {}
  return null;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const USE_COLOR = process.stdout.isTTY;
const GREEN = USE_COLOR ? '\x1b[32m' : '';
const RED = USE_COLOR ? '\x1b[31m' : '';
const YELLOW = USE_COLOR ? '\x1b[33m' : '';
const CYAN = USE_COLOR ? '\x1b[36m' : '';
const DIM = USE_COLOR ? '\x1b[2m' : '';
const BOLD = USE_COLOR ? '\x1b[1m' : '';
const RESET = USE_COLOR ? '\x1b[0m' : '';

let writesOk = 0;
let writesFailed = 0;

function configError(msg) {
  console.error(`\n${RED}Configuration error:${RESET} ${msg}`);
  process.exit(2);
}

function phase(title) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

function validateConfig(config) {
  const errors = [];
  if (typeof config !== 'object' || config === null) {
    errors.push('config root must be an object');
    return errors;
  }
  if (typeof config.profile !== 'object' || config.profile === null) {
    errors.push('config.profile is required and must be an object');
  } else {
    const p = config.profile;
    if (p.name !== undefined && p.name !== null && typeof p.name !== 'string') {
      errors.push('profile.name must be string or null');
    }
    if (typeof p.description !== 'string') {
      errors.push('profile.description must be a string');
    }
    if (p.image !== undefined && p.image !== null && typeof p.image !== 'string') {
      errors.push('profile.image must be string or null');
    }
    if (!Array.isArray(p.tags)) {
      errors.push('profile.tags must be an array');
    } else if (p.tags.some((t) => typeof t !== 'string')) {
      errors.push('profile.tags must contain only strings');
    }
    if (p.capabilities !== undefined) {
      if (typeof p.capabilities !== 'object' || p.capabilities === null) {
        errors.push('profile.capabilities must be an object');
      }
    }
  }
  if (config.endorse !== undefined) {
    if (!Array.isArray(config.endorse)) {
      errors.push('config.endorse must be an array');
    } else {
      for (const [i, e] of config.endorse.entries()) {
        if (typeof e !== 'object' || e === null) {
          errors.push(`config.endorse[${i}] must be an object`);
          continue;
        }
        if (typeof e.target !== 'string' || !e.target.trim()) {
          errors.push(`config.endorse[${i}].target must be a non-empty string`);
        }
        if (!Array.isArray(e.key_suffixes) || e.key_suffixes.length === 0) {
          errors.push(
            `config.endorse[${i}].key_suffixes must be a non-empty array`,
          );
        } else if (e.key_suffixes.some((k) => typeof k !== 'string')) {
          errors.push(
            `config.endorse[${i}].key_suffixes must contain only strings`,
          );
        }
        if (e.reason !== undefined && typeof e.reason !== 'string') {
          errors.push(`config.endorse[${i}].reason must be a string`);
        }
      }
    }
  }
  if (config.follow !== undefined) {
    if (!Array.isArray(config.follow)) {
      errors.push('config.follow must be an array');
    } else {
      for (const [i, f] of config.follow.entries()) {
        if (typeof f !== 'object' || f === null) {
          errors.push(`config.follow[${i}] must be an object`);
          continue;
        }
        if (typeof f.target !== 'string' || !f.target.trim()) {
          errors.push(`config.follow[${i}].target must be a non-empty string`);
        }
        if (f.reason !== undefined && typeof f.reason !== 'string') {
          errors.push(`config.follow[${i}].reason must be a string`);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function request(method, url, { walletKey, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        ...(walletKey && { Authorization: `Bearer ${walletKey}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
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

async function resolveAccountId(outlayerBase, walletKey) {
  const res = await request(
    'GET',
    `${outlayerBase}/wallet/v1/balance?chain=near`,
    { walletKey },
  );
  if (res.status !== 200) {
    configError(
      `/wallet/v1/balance HTTP ${res.status} — cannot resolve account from wallet key.`,
    );
  }
  const accountId = res.body?.account_id;
  if (typeof accountId !== 'string' || !accountId) {
    configError(
      `/wallet/v1/balance did not return account_id: ${JSON.stringify(res.body)}`,
    );
  }
  return accountId;
}

// ---------------------------------------------------------------------------
// Plan rendering
// ---------------------------------------------------------------------------

function printPlan(caller, config) {
  console.log(`${DIM}caller:${RESET} ${caller}`);
  console.log(`${DIM}api:${RESET}    ${config._api}\n`);

  console.log(`${BOLD}Profile patch${RESET}`);
  const p = config.profile;
  if (p.name != null) console.log(`  name:         ${JSON.stringify(p.name)}`);
  console.log(`  description:  ${JSON.stringify(p.description)}`);
  if (p.image != null)
    console.log(`  image:        ${JSON.stringify(p.image)}`);
  console.log(
    `  tags:         ${p.tags.length > 0 ? p.tags.map((t) => JSON.stringify(t)).join(', ') : '(none)'}`,
  );
  if (p.capabilities !== undefined) {
    console.log(`  capabilities: ${JSON.stringify(p.capabilities)}`);
  }

  const endorse = config.endorse ?? [];
  if (endorse.length > 0) {
    console.log(`\n${BOLD}Endorsements (${endorse.length})${RESET}`);
    for (const e of endorse) {
      console.log(`  → ${e.target}`);
      console.log(
        `    suffixes: ${e.key_suffixes.map((k) => JSON.stringify(k)).join(', ')}`,
      );
      if (e.reason) console.log(`    reason:   ${JSON.stringify(e.reason)}`);
    }
  }

  const follow = config.follow ?? [];
  if (follow.length > 0) {
    console.log(`\n${BOLD}Follows (${follow.length})${RESET}`);
    for (const f of follow) {
      console.log(`  → ${f.target}`);
      if (f.reason) console.log(`    reason:   ${JSON.stringify(f.reason)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Execute writes
// ---------------------------------------------------------------------------

async function execWrite(label, action) {
  try {
    const res = await action();
    if (res.status === 200) {
      console.log(`  ${GREEN}✓${RESET} ${label}`);
      writesOk++;
      return res;
    }
    console.log(
      `  ${RED}✗${RESET} ${label} — HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`,
    );
    writesFailed++;
    return res;
  } catch (err) {
    console.log(`  ${RED}✗${RESET} ${label} — ${err.message}`);
    writesFailed++;
    return null;
  }
}

async function executePlan(api, walletKey, caller, config) {
  phase('Heartbeat (bootstraps / refreshes profile block)');
  await execWrite('POST /agents/me/heartbeat', () =>
    request('POST', `${api}/agents/me/heartbeat`, {
      walletKey,
      body: {},
    }),
  );

  phase('Update profile');
  const patch = {};
  const p = config.profile;
  if (p.name !== undefined) patch.name = p.name;
  if (p.description !== undefined) patch.description = p.description;
  if (p.image !== undefined) patch.image = p.image;
  if (p.tags !== undefined) patch.tags = p.tags;
  if (p.capabilities !== undefined) patch.capabilities = p.capabilities;
  await execWrite('PATCH /agents/me/profile', () =>
    request('PATCH', `${api}/agents/me/profile`, { walletKey, body: patch }),
  );

  const endorse = config.endorse ?? [];
  if (endorse.length > 0) {
    phase(`Endorsements (${endorse.length})`);
    for (const e of endorse) {
      if (e.target === caller) {
        console.log(
          `  ${YELLOW}○${RESET} skipping self-endorse on ${e.target}`,
        );
        continue;
      }
      const body = { key_suffixes: e.key_suffixes };
      if (e.reason !== undefined) body.reason = e.reason;
      await execWrite(
        `POST /agents/${e.target}/endorse ${JSON.stringify(e.key_suffixes)}`,
        () =>
          request('POST', `${api}/agents/${encodeURIComponent(e.target)}/endorse`, {
            walletKey,
            body,
          }),
      );
    }
  }

  const follow = config.follow ?? [];
  if (follow.length > 0) {
    phase(`Follows (${follow.length})`);
    for (const f of follow) {
      if (f.target === caller) {
        console.log(
          `  ${YELLOW}○${RESET} skipping self-follow on ${f.target}`,
        );
        continue;
      }
      const body = {};
      if (f.reason !== undefined) body.reason = f.reason;
      await execWrite(
        `POST /agents/${f.target}/follow`,
        () =>
          request('POST', `${api}/agents/${encodeURIComponent(f.target)}/follow`, {
            walletKey,
            body: Object.keys(body).length > 0 ? body : {},
          }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) {
    configError(
      '--config <file> is required. See the header docstring for the shape.',
    );
  }
  const configPath = resolvePath(args.config);
  if (!existsSync(configPath)) {
    configError(`config file not found: ${configPath}`);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    configError(`config file is not valid JSON: ${err.message}`);
  }
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error(`${RED}Config validation errors:${RESET}`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(2);
  }
  config._api = args.api;

  const walletKey = loadEnvVar('OUTLAYER_TEST_WALLET_KEY');
  if (!walletKey) {
    configError('OUTLAYER_TEST_WALLET_KEY is not set (shell env or frontend/.env).');
  }
  const outlayerBase =
    process.env.OUTLAYER_API_URL ?? 'https://api.outlayer.fastnear.com';

  const caller = await resolveAccountId(outlayerBase, walletKey);

  console.log(`${CYAN}${BOLD}Seed plan${RESET}\n`);
  printPlan(caller, config);

  if (!args.execute) {
    console.log(
      `\n${YELLOW}Dry run.${RESET} Re-run with ${BOLD}--execute${RESET} to apply.`,
    );
    process.exit(0);
  }

  console.log(
    `\n${CYAN}${BOLD}Executing${RESET} (--execute passed)`,
  );
  await executePlan(args.api, walletKey, caller, config);

  console.log(
    `\n${writesOk + writesFailed} writes — ${GREEN}${writesOk} ok${RESET}, ${
      writesFailed > 0 ? `${RED}${writesFailed} failed${RESET}` : '0 failed'
    }`,
  );
  process.exit(writesFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n${RED}Script failed:${RESET}`, err);
  process.exit(1);
});
