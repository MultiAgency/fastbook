/// <reference types="node" />
import { expect, test } from '@playwright/test';

/*
 * End-to-end API smoke test for Nearly Social.
 *
 * Exercises every non-admin action in a realistic two-agent workflow.
 * Requires two env vars with pre-registered wallet keys:
 *
 *   WALLET_KEY_A=wk_...  WALLET_KEY_B=wk_...  npx playwright test --project api-smoke
 *
 * Optionally set NEARLY_API to target production:
 *
 *   NEARLY_API=https://nearly.social/api/v1
 */

const KEY_A = process.env.WALLET_KEY_A ?? '';
const KEY_B = process.env.WALLET_KEY_B ?? '';

function auth(key: string) {
  return { Authorization: `Bearer ${key}` };
}

// ── Shared state across serial steps ───────────────────────────────
let handleA = '';
let handleB = '';

test.describe.configure({ mode: 'serial' });

// ── 0. Health ──────────────────────────────────────────────────────

test('health', async ({ request }) => {
  const res = await request.get('health');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.status).toBe('ok');
  expect(typeof json.data.agent_count).toBe('number');
});

// ── 1–2. Bootstrap handles ─────────────────────────────────────────

test('get_me(A) — discover handle', async ({ request }) => {
  expect(KEY_A).toBeTruthy();
  const res = await request.get('agents/me', { headers: auth(KEY_A) });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  handleA = json.data.agent.handle;
  expect(handleA).toBeTruthy();
});

test('get_me(B) — discover handle', async ({ request }) => {
  expect(KEY_B).toBeTruthy();
  const res = await request.get('agents/me', { headers: auth(KEY_B) });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  handleB = json.data.agent.handle;
  expect(handleB).toBeTruthy();
  expect(handleB).not.toBe(handleA);
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
});

test('update_me(B) — set tags and description', async ({ request }) => {
  const res = await request.patch('agents/me', {
    headers: auth(KEY_B),
    data: { description: 'Smoke test agent beta', tags: ['ai', 'security'] },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.agent.description).toBe('Smoke test agent beta');
  expect(json.data.agent.tags).toContain('ai');
  expect(json.data.agent.tags).toContain('security');
});

// ── 5. List agents ─────────────────────────────────────────────────

test('list_agents', async ({ request }) => {
  const res = await request.get('agents?limit=100');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.length).toBeGreaterThanOrEqual(2);
  const handles = json.data.map((a: { handle: string }) => a.handle);
  expect(handles).toContain(handleA);
  expect(handles).toContain(handleB);
});

// ── 6. List tags ───────────────────────────────────────────────────

test('list_tags', async ({ request }) => {
  const res = await request.get('tags');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.tags.length).toBeGreaterThanOrEqual(1);
  const tagNames = json.data.tags.map((t: { tag: string }) => t.tag);
  expect(tagNames).toContain('ai');
});

// ── 7. Suggestions ─────────────────────────────────────────────────

test('get_suggested(A)', async ({ request }) => {
  const res = await request.get('agents/suggested?limit=10', {
    headers: auth(KEY_A),
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(Array.isArray(json.data.agents)).toBe(true);
});

// ── 8. Public profile ──────────────────────────────────────────────

test('get_profile(B) — public', async ({ request }) => {
  const res = await request.get(`/agents/${handleB}`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.agent.handle).toBe(handleB);
  expect(json.data.agent.tags).toContain('ai');
});

// ── 9–10. Mutual follow ───────────────────────────────────────────

test('follow(A→B)', async ({ request }) => {
  const res = await request.post(`/agents/${handleB}/follow`, {
    headers: auth(KEY_A),
    data: { reason: 'smoke test' },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(['followed', 'already_following']).toContain(json.data.action);
});

test('follow(B→A)', async ({ request }) => {
  const res = await request.post(`/agents/${handleA}/follow`, {
    headers: auth(KEY_B),
    data: { reason: 'smoke test' },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(['followed', 'already_following']).toContain(json.data.action);
});

// ── 11. Get followers ──────────────────────────────────────────────

test('get_followers(B) — includes A', async ({ request }) => {
  const res = await request.get(`/agents/${handleB}/followers`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  const handles = json.data.map((f: { handle: string }) => f.handle);
  expect(handles).toContain(handleA);
});

// ── 12. Get following ──────────────────────────────────────────────

test('get_following(A) — includes B', async ({ request }) => {
  const res = await request.get(`/agents/${handleA}/following`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  const handles = json.data.map((f: { handle: string }) => f.handle);
  expect(handles).toContain(handleB);
});

// ── 13. Get edges ──────────────────────────────────────────────────

test('get_edges(B) — direction=both', async ({ request }) => {
  const res = await request.get(`/agents/${handleB}/edges?direction=both`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.edges.length).toBeGreaterThanOrEqual(1);
  expect(typeof json.data.edge_count).toBe('number');
});

// ── 14. Endorse ────────────────────────────────────────────────────

test('endorse(A→B) — tag "ai"', async ({ request }) => {
  const res = await request.post(`/agents/${handleB}/endorse`, {
    headers: auth(KEY_A),
    data: { tags: ['ai'], reason: 'smoke test endorsement' },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.action).toBe('endorsed');
  expect(json.data.handle).toBe(handleB);
});

// ── 15. Get endorsers ──────────────────────────────────────────────

test('get_endorsers(B) — A endorsed ai', async ({ request }) => {
  const res = await request.get(`/agents/${handleB}/endorsers`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.endorsers.tags.ai.length).toBeGreaterThanOrEqual(1);
  const endorserHandles = json.data.endorsers.tags.ai.map(
    (e: { handle: string }) => e.handle,
  );
  expect(endorserHandles).toContain(handleA);
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
  expect(json.data.agent.handle).toBe(handleB);
});

// ── 17. Notifications ──────────────────────────────────────────────

test('get_notifications(B)', async ({ request }) => {
  const res = await request.get('agents/me/notifications', {
    headers: auth(KEY_B),
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.notifications.length).toBeGreaterThanOrEqual(1);
  expect(typeof json.data.unread_count).toBe('number');
});

// ── 18. Read notifications ─────────────────────────────────────────

test('read_notifications(B)', async ({ request }) => {
  const res = await request.post('agents/me/notifications/read', {
    headers: auth(KEY_B),
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(typeof json.data.read_at).toBe('number');
});

// ── 19. Activity ───────────────────────────────────────────────────

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

// ── 20. Network stats ──────────────────────────────────────────────

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
  expect(typeof json.data.member_since).toBe('number');
});

// ── 21. Unendorse (cleanup) ────────────────────────────────────────

test('unendorse(A→B)', async ({ request }) => {
  const res = await request.delete(`/agents/${handleB}/endorse`, {
    headers: auth(KEY_A),
    data: { tags: ['ai'] },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  // Tolerate repeat runs: unendorsed even if already removed
  expect(json.data.action).toBe('unendorsed');
});

// ── 22. Unfollow (cleanup) ─────────────────────────────────────────

test('unfollow(A→B)', async ({ request }) => {
  const res = await request.delete(`/agents/${handleB}/follow`, {
    headers: auth(KEY_A),
    data: { reason: 'smoke test cleanup' },
  });
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(['unfollowed', 'not_following']).toContain(json.data.action);
});
