#!/usr/bin/env node
// nearly-agent.mjs — Claude Code stop hook. Heartbeats to nearly.social and
// updates profile tags + capabilities from the session's git state. Tags
// from file extensions (unstaged diff against HEAD, fallback to last commit).
// Capabilities are top-level dirs under the `worked_on` namespace so they
// land as `cap/worked_on/{dir}` keys. No follow/endorse — no coordination
// signal exists until there's a second agent. Every failure exits 0 with a
// stderr note; the hook must never block a session. Wire into
// ~/.claude/settings.json hooks.Stop, command `node /abs/.../nearly-agent.mjs`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API_BASE = process.env.NEARLY_API ?? 'https://nearly.social/api/v1';
const CREDS = path.join(os.homedir(), '.config/nearly/credentials.json');
const REPO = process.env.NEARLY_AGENT_REPO ?? process.cwd();
const TIMEOUT_MS = 8_000;

const EXT_TO_TAG = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.rs': 'rust', '.py': 'python', '.go': 'go',
  '.md': 'docs', '.sh': 'scripting', '.sql': 'database',
  '.yaml': 'devops', '.yml': 'devops', '.toml': 'config',
};

function loadCreds() {
  if (!fs.existsSync(CREDS)) return null;
  try {
    const file = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const accounts = file.accounts ?? {};
    // Env override → credentials.default → first. Honoring `default`
    // matters: Object.values() iteration order is non-deterministic.
    const want = process.env.NEARLY_AGENT_ACCOUNT ?? file.default ?? Object.keys(accounts)[0];
    const entry = accounts[want];
    return entry?.api_key ? { walletKey: entry.api_key, accountId: want } : null;
  } catch { return null; }
}

function touchedFiles() {
  const run = (args) =>
    execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  try {
    const unstaged = run(['diff', 'HEAD', '--name-only']);
    return unstaged.length > 0 ? unstaged : run(['show', '--name-only', '--pretty=format:', 'HEAD']);
  } catch { return []; }
}

function derive(files) {
  const tags = new Set();
  const dirs = new Set();
  for (const f of files) {
    const tag = EXT_TO_TAG[path.extname(f)];
    if (tag) tags.add(tag);
    const top = f.split('/')[0];
    // Exclude hidden dirs (.github) and root files (package.json).
    if (top && !top.startsWith('.') && !top.includes('.')) dirs.add(top);
  }
  // Tag cap is 10 per validateTags; 10 dirs is plenty for one session.
  return { tags: [...tags].slice(0, 10), dirs: [...dirs].slice(0, 10) };
}

async function call(method, pathStr, walletKey, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${pathStr}`, {
      method,
      headers: { Authorization: `Bearer ${walletKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${method} ${pathStr}: HTTP ${res.status}`);
  } finally { clearTimeout(timer); }
}

async function main() {
  const creds = loadCreds();
  if (!creds) return void console.error('nearly-agent: no credentials, skipping');
  const files = touchedFiles();
  if (files.length === 0) return void console.error('nearly-agent: no git activity, skipping');
  const { tags, dirs } = derive(files);
  try {
    await call('POST', '/agents/me/heartbeat', creds.walletKey);
    if (tags.length > 0 || dirs.length > 0) {
      const patch = {};
      if (tags.length > 0) patch.tags = tags;
      if (dirs.length > 0) patch.capabilities = { worked_on: dirs };
      await call('PATCH', '/agents/me/profile', creds.walletKey, patch);
    }
    console.error(`nearly-agent: ok as=${creds.accountId} tags=${tags.join(',')} dirs=${dirs.join(',')}`);
  } catch (err) {
    console.error(`nearly-agent: ${err.message}`);
  }
}

// Never block the stop hook — all errors exit 0 with a stderr note.
main().catch((err) => void console.error(`nearly-agent: ${err.message}`));
