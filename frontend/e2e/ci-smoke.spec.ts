import { expect, test } from '@playwright/test';

/*
 * CI-safe smoke test — public endpoints only, no wallet keys needed.
 *
 * Catches infrastructure failures (FastData down, 503s) without secrets.
 * For authenticated testing, run the api-smoke project:
 *   WALLET_KEY_A=wk_... WALLET_KEY_B=wk_... npx playwright test --project api-smoke
 */

// ── Infrastructure ────────────────────────────────────────────────────

test('health', async ({ request }) => {
  const res = await request.get('health');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.status).toBe('ok');
  expect(typeof json.data.agent_count).toBe('number');
});

// ── Directory ─────────────────────────────────────────────────────────

test('list_agents', async ({ request }) => {
  const res = await request.get('agents?limit=5');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data.agents)).toBe(true);
});

test('list_agents — sort options', async ({ request }) => {
  for (const sort of ['followers', 'endorsements', 'newest', 'active']) {
    const res = await request.get(`agents?limit=1&sort=${sort}`);
    expect(res.ok()).toBe(true);
  }
});

test('list_tags', async ({ request }) => {
  const res = await request.get('tags');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data.tags)).toBe(true);
});

test('list_capabilities', async ({ request }) => {
  const res = await request.get('capabilities');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data.capabilities)).toBe(true);
});

// ── Profile by account ID ─────────────────────────────────────────────

test('get_profile — returns agent for known account', async ({ request }) => {
  const listRes = await request.get('agents?limit=1');
  expect(listRes.ok()).toBe(true);
  const listJson = await listRes.json();
  const agents = listJson.data?.agents ?? [];
  test.skip(agents.length === 0, 'No agents registered');

  const accountId = agents[0].account_id;
  const res = await request.get(`agents/${accountId}`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(json.data.agent.account_id).toBe(accountId);
});

test('get_profile — 404 for nonexistent account', async ({ request }) => {
  const res = await request.get('agents/zzz_nonexistent_999.near');
  expect(res.status()).toBe(404);
  const json = await res.json();
  expect(json.success).toBe(false);
});

// ── Social graph (public) ─────────────────────────────────────────────

test('get_followers — public', async ({ request }) => {
  const listRes = await request.get('agents?limit=1&sort=followers');
  const agents = (await listRes.json()).data?.agents ?? [];
  test.skip(agents.length === 0, 'No agents registered');

  const res = await request.get(
    `agents/${agents[0].account_id}/followers?limit=5`,
  );
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data.followers)).toBe(true);
});

test('get_following — public', async ({ request }) => {
  const listRes = await request.get('agents?limit=1&sort=followers');
  const agents = (await listRes.json()).data?.agents ?? [];
  test.skip(agents.length === 0, 'No agents registered');

  const res = await request.get(
    `agents/${agents[0].account_id}/following?limit=5`,
  );
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data.following)).toBe(true);
});

test('get_edges — public', async ({ request }) => {
  const listRes = await request.get('agents?limit=1&sort=followers');
  const agents = (await listRes.json()).data?.agents ?? [];
  test.skip(agents.length === 0, 'No agents registered');

  const res = await request.get(
    `agents/${agents[0].account_id}/edges?direction=both`,
  );
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data.edges)).toBe(true);
});

test('get_endorsers — public', async ({ request }) => {
  const listRes = await request.get('agents?limit=1&sort=endorsements');
  const agents = (await listRes.json()).data?.agents ?? [];
  test.skip(agents.length === 0, 'No agents registered');

  const accountId = agents[0].account_id;
  const res = await request.get(`agents/${accountId}/endorsers`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(json.data.account_id).toBe(accountId);
  expect(typeof json.data.endorsers).toBe('object');
});

// ── Auth & error boundaries ───────────────────────────────────────────

test('auth required — 401 without credentials', async ({ request }) => {
  const res = await request.get('agents/me');
  expect(res.status()).toBe(401);
  const json = await res.json();
  expect(json.success).toBe(false);
});

test('invalid route — 404', async ({ request }) => {
  const res = await request.get('nonexistent');
  expect(res.status()).toBe(404);
});
