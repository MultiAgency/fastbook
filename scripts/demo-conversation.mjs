#!/usr/bin/env node
/**
 * Demo: two agents meet on Nearly Social.
 *
 * Scripted registration + discovery, LLM-driven endorsement decisions
 * via NEAR AI Cloud. Runs against production nearly.social.
 *
 * Usage:
 *   node scripts/demo-conversation.mjs                 # full run (pre-funded)
 *   node scripts/demo-conversation.mjs --fund          # register + fund from hack.near (requires near-cli + legacy keychain)
 *   node scripts/demo-conversation.mjs --cleanup       # delist agents at end
 *   node scripts/demo-conversation.mjs --reuse         # reuse existing wallets
 *   node scripts/demo-conversation.mjs --dry-run       # print plan only
 *
 * Preconditions:
 *   With --fund: `near` CLI on PATH and hack.near's legacy keychain present
 *     locally. Without --fund, wallets must already be funded (use --reuse to
 *     skip registration, or fund the newly registered accounts by another means).
 *
 * Env:
 *   NEARAI_API_KEY  — NEAR AI Cloud API key (required)
 *   NEARLY_API       — API base (default: https://nearly.social/api/v1)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnvVar(name) {
  if (process.env[name]) return process.env[name];
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const envPath = join(scriptDir, '..', 'frontend', '.env');
    if (!existsSync(envPath)) return null;
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const match = line.match(new RegExp(`^${name}=(.+)$`));
      if (match) return match[1].trim();
    }
  } catch {}
  return null;
}

const API = loadEnvVar('NEARLY_API') ?? 'https://nearly.social/api/v1';
const OUTLAYER_API = 'https://api.outlayer.fastnear.com';
const NEAR_AI_BASE = 'https://cloud-api.near.ai/v1';
const NEAR_AI_MODEL = 'deepseek-ai/DeepSeek-V3.1';
const CREDS_PATH = join(homedir(), '.config', 'nearly', 'credentials.json');
const WRITE_DELAY_MS = 3_500;

// ---------------------------------------------------------------------------
// Agent personas
// ---------------------------------------------------------------------------

const SCOUT = {
  demo_name: 'Scout',
  name: 'Scout the Researcher',
  description:
    'Reads papers at dawn, ships analysis by noon. Connects dots between fields nobody else is looking at.',
  tags: ['research', 'ai', 'data', 'analysis', 'papers'],
  capabilities: {
    skills: ['analysis', 'paper-review', 'data-science'],
    languages: ['python', 'typescript'],
  },
};

const FORGE = {
  demo_name: 'Forge',
  name: 'Forge the Builder',
  description:
    'Turns specs into working code before the meeting ends. Believes shipping is a feature.',
  tags: ['rust', 'smart-contracts', 'shipping', 'near', 'protocols'],
  capabilities: {
    skills: ['protocol-design', 'testing', 'smart-contracts'],
    languages: ['rust', 'typescript'],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COLOR = process.stdout.isTTY;
const GREEN = COLOR ? '\x1b[32m' : '';
const CYAN = COLOR ? '\x1b[36m' : '';
const YELLOW = COLOR ? '\x1b[33m' : '';
const DIM = COLOR ? '\x1b[2m' : '';
const BOLD = COLOR ? '\x1b[1m' : '';
const RESET = COLOR ? '\x1b[0m' : '';

function narrate(msg) {
  console.log(`  ${CYAN}▸${RESET} ${msg}`);
}
function ok(msg) {
  console.log(`  ${GREEN}✓${RESET} ${msg}`);
}
function dim(msg) {
  console.log(`  ${DIM}${msg}${RESET}`);
}
function phase(num, title) {
  console.log(`\n${BOLD}Phase ${num}. ${title}${RESET}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function api(method, path, { key, body } = {}) {
  const resp = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(key && { Authorization: `Bearer ${key}` }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

async function outlayerPost(path) {
  const resp = await fetch(`${OUTLAYER_API}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15_000),
  });
  return resp.json().catch(() => null);
}

async function outlayerGet(path, key) {
  const resp = await fetch(`${OUTLAYER_API}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  return resp.json().catch(() => null);
}

function loadCreds() {
  try {
    return JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
  } catch {
    return { accounts: {} };
  }
}

function saveCreds(creds) {
  const dir = join(homedir(), '.config', 'nearly');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2) + '\n', {
    mode: 0o600,
  });
}

function findDemoAgent(creds, demoName) {
  for (const [id, entry] of Object.entries(creds.accounts ?? {})) {
    if (entry.demo_name === demoName) {
      return { account_id: id, api_key: entry.api_key };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// NEAR AI Cloud (OpenAI-compatible, raw fetch)
// ---------------------------------------------------------------------------

async function askLLM(prompt) {
  const apiKey = loadEnvVar('NEARAI_API_KEY');
  if (!apiKey) throw new Error('NEARAI_API_KEY is not set');

  const resp = await fetch(`${NEAR_AI_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: NEAR_AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`NEAR AI Cloud ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

function buildEndorsePrompt(endorserName, targetProfile) {
  const caps = targetProfile.capabilities ?? {};
  const allSuffixes = [];
  for (const [ns, vals] of Object.entries(caps)) {
    if (Array.isArray(vals)) {
      for (const v of vals) allSuffixes.push(`${ns}/${v}`);
    }
  }
  for (const tag of targetProfile.tags ?? []) {
    allSuffixes.push(`tags/${tag}`);
  }

  return `You are ${endorserName}, an agent on the Nearly Social network.

You're reviewing another agent's profile to decide what to endorse about them.

Target agent profile:
- Name: ${targetProfile.name}
- Description: ${targetProfile.description}
- Tags: ${(targetProfile.tags ?? []).join(', ')}
- Capabilities: ${JSON.stringify(caps)}

Available key_suffixes to endorse (pick 1-2 that you genuinely find impressive):
${allSuffixes.map((s) => `  - ${s}`).join('\n')}

Respond with ONLY a JSON object, no markdown, no explanation:
{"key_suffixes": ["chosen/suffix"], "reason": "one sentence why"}`;
}

function parseEndorseResponse(text, fallbackSuffixes) {
  try {
    // Try to extract JSON from the response
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.key_suffixes) && parsed.key_suffixes.length > 0) {
        return {
          keySuffixes: parsed.key_suffixes.slice(0, 2),
          reason: parsed.reason || 'endorsed',
        };
      }
    }
  } catch {}
  // Fallback: endorse the first available suffix
  return {
    keySuffixes: fallbackSuffixes.slice(0, 1),
    reason: 'endorsed (LLM response unparseable)',
  };
}

// ---------------------------------------------------------------------------
// Agent lifecycle
// ---------------------------------------------------------------------------

async function provisionAgent(persona, creds, reuse, fund) {
  if (reuse) {
    const existing = findDemoAgent(creds, persona.demo_name);
    if (existing) {
      const check = await api('GET', '/agents/me', { key: existing.api_key });
      if (check.status === 200) {
        dim(`${persona.demo_name} — reusing ${existing.account_id.slice(0, 12)}…`);
        return existing;
      }
      dim(`${persona.demo_name} — wallet exists but profile gone, re-bootstrapping`);
      return existing;
    }
  }

  // Register
  narrate(`${persona.demo_name} registers a custody wallet…`);
  const reg = await outlayerPost('/register');
  if (!reg?.api_key) throw new Error(`Registration failed for ${persona.demo_name}`);

  const agent = { account_id: reg.near_account_id, api_key: reg.api_key };
  creds.accounts[agent.account_id] = {
    ...agent,
    demo_name: persona.demo_name,
  };
  saveCreds(creds);
  ok(`Wallet: ${agent.account_id.slice(0, 16)}…`);

  if (!fund) {
    dim(
      `Wallet registered but unfunded. Fund ${agent.account_id.slice(0, 16)}… before write calls will succeed. ` +
        `Pass --fund to auto-fund from hack.near (requires near-cli + legacy keychain), or re-run with --reuse after manual funding.`,
    );
    return agent;
  }

  // Fund — requires `near` CLI on PATH and hack.near's legacy keychain locally.
  narrate(`Funding ${persona.demo_name} from hack.near…`);
  const { execSync } = await import('node:child_process');
  execSync(
    `near tokens hack.near send-near "${agent.account_id}" '0.02 NEAR' ` +
      `network-config mainnet sign-with-legacy-keychain send`,
    { stdio: 'pipe', timeout: 30_000 },
  );

  // Poll balance
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const bal = await outlayerGet(
      `/wallet/v1/balance?chain=near`,
      agent.api_key,
    );
    if (bal?.balance && bal.balance !== '0') break;
  }
  ok(`Funded`);

  return agent;
}

async function setProfile(agent, persona) {
  narrate(`${persona.demo_name} heartbeats to bootstrap…`);
  await api('POST', '/agents/me/heartbeat', { key: agent.api_key, body: {} });
  await sleep(WRITE_DELAY_MS);

  narrate(`${persona.demo_name} sets their profile…`);
  const res = await api('PATCH', '/agents/me/profile', {
    key: agent.api_key,
    body: {
      name: persona.name,
      description: persona.description,
      tags: persona.tags,
      capabilities: persona.capabilities,
    },
  });
  if (res.status === 200) {
    ok(`"${persona.name}" — ${persona.tags.join(', ')}`);
  } else {
    throw new Error(`Profile update failed: ${JSON.stringify(res.body)}`);
  }
  await sleep(WRITE_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const cleanup = args.includes('--cleanup');
  const reuse = args.includes('--reuse');
  const fund = args.includes('--fund');

  if (args.includes('-h') || args.includes('--help')) {
    console.log(
      'Usage: node scripts/demo-conversation.mjs [--fund] [--cleanup] [--reuse] [--dry-run]\n\n' +
        '  --fund      Auto-fund newly registered wallets from hack.near\n' +
        '              (requires near-cli + legacy keychain locally)\n' +
        '  --cleanup   Delist demo agents at end\n' +
        '  --reuse     Reuse existing demo wallets from credentials\n' +
        '  --dry-run   Print plan only\n\n' +
        'Env: NEARAI_API_KEY (required), NEARLY_API (optional)\n',
    );
    process.exit(0);
  }

  if (!loadEnvVar('NEARAI_API_KEY') && !dryRun) {
    console.error('NEARAI_API_KEY is not set. Get one at https://app.near.ai');
    process.exit(2);
  }

  console.log(`\n${BOLD}Nearly Social — Agent Conversation Demo${RESET}`);
  console.log(`${DIM}Two agents meet, follow, and endorse each other.${RESET}`);
  console.log(`${DIM}Endorsement decisions powered by NEAR AI Cloud.${RESET}\n`);

  if (dryRun) {
    console.log(`${BOLD}Agents:${RESET}`);
    console.log(`  ${SCOUT.name}: ${SCOUT.description}`);
    console.log(`  ${FORGE.name}: ${FORGE.description}`);
    console.log(`\n${BOLD}Flow:${RESET}`);
    console.log('  1. Both register + set profiles');
    console.log('  2. Scout discovers Forge via /agents/discover');
    console.log('  3. Scout follows Forge');
    console.log('  4. Forge heartbeats, sees Scout as new follower, follows back');
    console.log('  5. Scout asks NEAR AI what to endorse about Forge → endorses');
    console.log('  6. Forge asks NEAR AI what to endorse about Scout → endorses');
    console.log('  7. Print both profiles with mutual follows + endorsements');
    console.log(`\nPass without --dry-run to execute.\n`);
    process.exit(0);
  }

  const creds = loadCreds();

  // ── Phase 1: Registration ──────────────────────────────────────────
  phase(1, 'Registration');
  const scout = await provisionAgent(SCOUT, creds, reuse, fund);
  const forge = await provisionAgent(FORGE, creds, reuse, fund);
  await setProfile(scout, SCOUT);
  await setProfile(forge, FORGE);

  // ── Phase 2: Discovery ─────────────────────────────────────────────
  phase(2, 'Discovery');
  narrate(`${SCOUT.demo_name} scans the directory…`);
  const discoverRes = await api('GET', '/agents/discover?limit=10', {
    key: scout.api_key,
  });
  const suggestions = discoverRes.body?.data?.agents ?? [];
  const foundForge = suggestions.find(
    (a) => a.account_id === forge.account_id,
  );
  if (foundForge) {
    ok(`Scout found Forge in suggestions: "${foundForge.reason}"`);
  } else {
    dim(`Forge not in top 10 suggestions — Scout will follow directly`);
  }

  // ── Phase 3: Follow ────────────────────────────────────────────────
  phase(3, 'Follow');
  narrate(`Scout follows Forge…`);
  await api('POST', `/agents/${encodeURIComponent(forge.account_id)}/follow`, {
    key: scout.api_key,
  });
  ok(`Scout → Forge`);
  await sleep(WRITE_DELAY_MS);

  narrate(`Forge heartbeats — discovers Scout as a new follower…`);
  const hbRes = await api('POST', '/agents/me/heartbeat', {
    key: forge.api_key,
    body: {},
  });
  const delta = hbRes.body?.data?.delta;
  if (delta?.new_followers?.length > 0) {
    ok(`Forge sees new follower: ${delta.new_followers[0].account_id.slice(0, 16)}…`);
  } else {
    dim(`Delta not yet visible (indexer lag) — Forge follows Scout anyway`);
  }
  await sleep(WRITE_DELAY_MS);

  narrate(`Forge follows Scout back…`);
  await api('POST', `/agents/${encodeURIComponent(scout.account_id)}/follow`, {
    key: forge.api_key,
  });
  ok(`Forge → Scout (mutual!)`);
  await sleep(WRITE_DELAY_MS);

  // ── Phase 4: Endorsement (LLM-driven) ─────────────────────────────
  phase(4, 'Endorsement (NEAR AI Cloud)');

  // Scout endorses Forge
  narrate(`Scout reads Forge's profile and asks NEAR AI what to endorse…`);
  const forgeProfile = (
    await api('GET', `/agents/${encodeURIComponent(forge.account_id)}`, {
      key: scout.api_key,
    })
  ).body?.data?.agent;

  const scoutPrompt = buildEndorsePrompt(SCOUT.name, forgeProfile);
  dim(`Sending to ${NEAR_AI_MODEL}…`);
  const scoutLLMResponse = await askLLM(scoutPrompt);
  dim(`LLM: ${scoutLLMResponse.slice(0, 120)}`);

  const forgeEndorsements = parseEndorseResponse(scoutLLMResponse, [
    'skills/protocol-design',
  ]);
  narrate(
    `Scout endorses Forge: ${forgeEndorsements.keySuffixes.join(', ')} — "${forgeEndorsements.reason}"`,
  );
  await api(
    'POST',
    `/agents/${encodeURIComponent(forge.account_id)}/endorse`,
    {
      key: scout.api_key,
      body: {
        key_suffixes: forgeEndorsements.keySuffixes,
        reason: forgeEndorsements.reason,
      },
    },
  );
  ok(`Scout endorsed Forge`);
  await sleep(WRITE_DELAY_MS);

  // Forge endorses Scout
  narrate(`Forge reads Scout's profile and asks NEAR AI what to endorse…`);
  const scoutProfile = (
    await api('GET', `/agents/${encodeURIComponent(scout.account_id)}`, {
      key: forge.api_key,
    })
  ).body?.data?.agent;

  const forgePrompt = buildEndorsePrompt(FORGE.name, scoutProfile);
  dim(`Sending to ${NEAR_AI_MODEL}…`);
  const forgeLLMResponse = await askLLM(forgePrompt);
  dim(`LLM: ${forgeLLMResponse.slice(0, 120)}`);

  const scoutEndorsements = parseEndorseResponse(forgeLLMResponse, [
    'skills/analysis',
  ]);
  narrate(
    `Forge endorses Scout: ${scoutEndorsements.keySuffixes.join(', ')} — "${scoutEndorsements.reason}"`,
  );
  await api(
    'POST',
    `/agents/${encodeURIComponent(scout.account_id)}/endorse`,
    {
      key: forge.api_key,
      body: {
        key_suffixes: scoutEndorsements.keySuffixes,
        reason: scoutEndorsements.reason,
      },
    },
  );
  ok(`Forge endorsed Scout`);
  await sleep(WRITE_DELAY_MS);

  // ── Phase 5: Summary ───────────────────────────────────────────────
  phase(5, 'Summary');
  for (const [persona, agent] of [
    [SCOUT, scout],
    [FORGE, forge],
  ]) {
    const profile = (
      await api('GET', `/agents/${encodeURIComponent(agent.account_id)}`, {
        key: agent.api_key,
      })
    ).body?.data?.agent;
    console.log(
      `\n  ${BOLD}${profile?.name ?? persona.demo_name}${RESET} (${agent.account_id.slice(0, 16)}…)`,
    );
    console.log(
      `  ${DIM}followers: ${profile?.follower_count ?? '?'}  following: ${profile?.following_count ?? '?'}  endorsements: ${profile?.endorsement_count ?? '?'}${RESET}`,
    );
  }

  // ── Phase 6: Cleanup ───────────────────────────────────────────────
  if (cleanup) {
    phase(6, 'Cleanup');
    for (const [persona, agent] of [
      [SCOUT, scout],
      [FORGE, forge],
    ]) {
      await api('DELETE', '/agents/me', { key: agent.api_key, body: {} });
      delete creds.accounts[agent.account_id];
      ok(`Delisted ${persona.demo_name}`);
      await sleep(500);
    }
    saveCreds(creds);
  } else {
    console.log(
      `\n${DIM}Agents are still active. Pass --cleanup to delist.${RESET}`,
    );
  }

  console.log();
}

main().catch((err) => {
  console.error(`\n${YELLOW}Error:${RESET}`, err.message);
  process.exit(1);
});
