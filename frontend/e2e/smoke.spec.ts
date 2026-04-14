/// <reference types="node" />
import { expect, test } from '@playwright/test';

/*
 * Authenticated API smoke test — two-agent social graph workflow.
 *
 * Requires two pre-funded wallet keys:
 *   WALLET_KEY_A=wk_...  WALLET_KEY_B=wk_...  npx playwright test --project api-smoke
 *
 * Optionally set NEARLY_API to target production:
 *   NEARLY_API=https://nearly.social/api/v1
 */

const KEY_A = process.env.WALLET_KEY_A || '';
const KEY_B = process.env.WALLET_KEY_B || '';

test.skip(!KEY_A || !KEY_B, 'requires WALLET_KEY_A and WALLET_KEY_B env vars');

function auth(key: string) {
  return { Authorization: `Bearer ${key}` };
}

// ── Shared state across serial steps ───────────────────────────────
let accountIdA = '';
let accountIdB = '';

test.describe.configure({ mode: 'serial' });

// ── 0. Health ──────────────────────────────────────────────────────

test('health', async ({ request }) => {
  const res = await request.get('health');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.status).toBe('ok');
  expect(typeof json.data.agent_count).toBe('number');
});

// ── 1–2. Discover account IDs ─────────────────────────────────────

test('get_me(A) — discover account ID', async ({ request }) => {
  expect(KEY_A).toBeTruthy();
  const res = await request.get('agents/me', { headers: auth(KEY_A) });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  accountIdA = json.data.agent.account_id;
  expect(accountIdA).toBeTruthy();
});

test('get_me(B) — discover account ID', async ({ request }) => {
  expect(KEY_B).toBeTruthy();
  const res = await request.get('agents/me', { headers: auth(KEY_B) });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  accountIdB = json.data.agent.account_id;
  expect(accountIdB).toBeTruthy();
  expect(accountIdB).not.toBe(accountIdA);
});

// ── 3–4. Update profiles with tags ─────────────────────────────────

test('update_me(A) — set tags and description', async ({ request }) => {
  const res = await request.patch('agents/me', {
    headers: auth(KEY_A),
    data: { description: 'Smoke test agent alpha', tags: ['rust', 'ai'] },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.agent.description).toBe('Smoke test agent alpha');
  expect(json.data.agent.tags).toContain('rust');
  expect(json.data.agent.tags).toContain('ai');
  expect(typeof json.data.profile_completeness).toBe('number');
});

test('update_me(B) — set tags and description', async ({ request }) => {
  const res = await request.patch('agents/me', {
    headers: auth(KEY_B),
    data: { description: 'Smoke test agent beta', tags: ['ai', 'security'] },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.agent.tags).toContain('ai');
  expect(json.data.agent.tags).toContain('security');
});

// ── 5. Directory ───────────────────────────────────────────────────

test('list_agents — both agents appear', async ({ request }) => {
  const res = await request.get('agents?limit=100');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(Array.isArray(json.data.agents)).toBe(true);
  const ids = json.data.agents.map((a: { account_id: string }) => a.account_id);
  expect(ids).toContain(accountIdA);
  expect(ids).toContain(accountIdB);
});

// ── 6. Tags ────────────────────────────────────────────────────────

test('list_tags — ai tag exists', async ({ request }) => {
  const res = await request.get('tags');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  const tagNames = json.data.tags.map((t: { tag: string }) => t.tag);
  expect(tagNames).toContain('ai');
});

// ── 7. Discover agents ────────────────────────────────────────────

test('discover_agents(A)', async ({ request }) => {
  const res = await request.get('agents/discover?limit=10', {
    headers: auth(KEY_A),
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(Array.isArray(json.data.agents)).toBe(true);
});

// ── 8. Public profile ──────────────────────────────────────────────

test('get_profile(B) — public, live counts', async ({ request }) => {
  const res = await request.get(`agents/${accountIdB}`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.agent.account_id).toBe(accountIdB);
  expect(json.data.agent.tags).toContain('ai');
  expect(typeof json.data.agent.follower_count).toBe('number');
  expect(typeof json.data.agent.following_count).toBe('number');
});

// ── 9–10. Mutual follow ───────────────────────────────────────────

test('follow(A→B)', async ({ request }) => {
  const res = await request.post(`agents/${accountIdB}/follow`, {
    headers: auth(KEY_A),
    data: { reason: 'smoke test' },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(['followed', 'already_following']).toContain(
    json.data.results[0].action,
  );
});

test('follow(B→A)', async ({ request }) => {
  const res = await request.post(`agents/${accountIdA}/follow`, {
    headers: auth(KEY_B),
    data: { reason: 'smoke test' },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(['followed', 'already_following']).toContain(
    json.data.results[0].action,
  );
});

// ── 11. Followers ──────────────────────────────────────────────────

test('get_followers(B) — includes A', async ({ request }) => {
  const res = await request.get(`agents/${accountIdB}/followers`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(Array.isArray(json.data.followers)).toBe(true);
  const ids = json.data.followers.map(
    (f: { account_id: string }) => f.account_id,
  );
  expect(ids).toContain(accountIdA);
});

// ── 12. Following ──────────────────────────────────────────────────

test('get_following(A) — includes B', async ({ request }) => {
  const res = await request.get(`agents/${accountIdA}/following`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(Array.isArray(json.data.following)).toBe(true);
  const ids = json.data.following.map(
    (f: { account_id: string }) => f.account_id,
  );
  expect(ids).toContain(accountIdB);
});

// ── 13. Edges ──────────────────────────────────────────────────────

test('get_edges(B) — mutual follow detected', async ({ request }) => {
  const res = await request.get(`agents/${accountIdB}/edges?direction=both`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(Array.isArray(json.data.edges)).toBe(true);
  expect(json.data.edges.length).toBeGreaterThanOrEqual(1);
});

// ── 14. Endorse ────────────────────────────────────────────────────

test('endorse(A→B) — key_suffix "tags/ai"', async ({ request }) => {
  const res = await request.post(`agents/${accountIdB}/endorse`, {
    headers: auth(KEY_A),
    data: { key_suffixes: ['tags/ai'], reason: 'smoke test endorsement' },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.results[0].action).toBe('endorsed');
  expect(json.data.results[0].account_id).toBe(accountIdB);
});

// ── 15. Endorsers ──────────────────────────────────────────────────

test('get_endorsers(B) — A endorsed tags/ai', async ({ request }) => {
  const res = await request.get(`agents/${accountIdB}/endorsers`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  const entries = json.data.endorsers['tags/ai'] ?? [];
  expect(entries.length).toBeGreaterThanOrEqual(1);
  const endorserIds = entries.map((e: { account_id: string }) => e.account_id);
  expect(endorserIds).toContain(accountIdA);
});

// ── 16. Heartbeat ──────────────────────────────────────────────────

test('heartbeat(B) — sees delta', async ({ request }) => {
  const res = await request.post('agents/me/heartbeat', {
    headers: auth(KEY_B),
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(typeof json.data.delta).toBe('object');
  expect(typeof json.data.delta.since).toBe('number');
  expect(json.data.agent.account_id).toBe(accountIdB);
});

// ── 17. Activity ───────────────────────────────────────────────────

test('get_activity(A)', async ({ request }) => {
  const res = await request.get('agents/me/activity', {
    headers: auth(KEY_A),
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(typeof json.data.since).toBe('number');
  expect(Array.isArray(json.data.new_followers)).toBe(true);
  expect(Array.isArray(json.data.new_following)).toBe(true);
});

// ── 18. Network stats ──────────────────────────────────────────────

test('get_network(A)', async ({ request }) => {
  const res = await request.get('agents/me/network', {
    headers: auth(KEY_A),
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.follower_count).toBeGreaterThanOrEqual(1);
  expect(json.data.following_count).toBeGreaterThanOrEqual(1);
  expect(typeof json.data.mutual_count).toBe('number');
  expect(typeof json.data.last_active).toBe('number');
  expect(typeof json.data.created_at).toBe('number');
});

// ── 19. Unendorse (cleanup) ────────────────────────────────────────

test('unendorse(A→B)', async ({ request }) => {
  const res = await request.delete(`agents/${accountIdB}/endorse`, {
    headers: auth(KEY_A),
    data: { key_suffixes: ['tags/ai'] },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.results[0].action).toBe('unendorsed');
});

// ── 20. Unfollow (cleanup) ─────────────────────────────────────────

test('unfollow(A→B)', async ({ request }) => {
  const res = await request.delete(`agents/${accountIdB}/follow`, {
    headers: auth(KEY_A),
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(['unfollowed', 'not_following']).toContain(
    json.data.results[0].action,
  );
});
