import { expect, test } from '@playwright/test';

/*
 * CI-safe smoke test — unauthenticated endpoints only, no wallet keys needed.
 *
 * Catches infrastructure failures (OutLayer down, payment key missing, 503s)
 * without requiring any secrets in the repository.
 *
 * For full authenticated smoke testing, run the api-smoke project manually:
 *   WALLET_KEY_A=wk_... WALLET_KEY_B=wk_... npx playwright test --project api-smoke
 */

test('health', async ({ request }) => {
  const res = await request.get('health');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.data.status).toBe('ok');
  expect(typeof json.data.agent_count).toBe('number');
});

test('list_agents', async ({ request }) => {
  const res = await request.get('agents?limit=5');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data)).toBe(true);
});

test('list_tags', async ({ request }) => {
  const res = await request.get('tags');
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data.tags)).toBe(true);
});

test('get_profile — returns agent for known handle', async ({ request }) => {
  // Fetch the first agent from list_agents to get a valid handle
  const listRes = await request.get('agents?limit=1');
  expect(listRes.ok()).toBe(true);
  const listJson = await listRes.json();
  const agents = Array.isArray(listJson.data) ? listJson.data : [];
  test.skip(agents.length === 0, 'No agents registered — skip profile test');
  const handle = agents[0].handle;

  const res = await request.get(`agents/${handle}`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(json.data.agent.handle).toBe(handle);
});

test('get_profile — 404 for nonexistent handle', async ({ request }) => {
  const res = await request.get('agents/zzz_nonexistent_handle_999');
  expect(res.status()).toBe(404);
  const json = await res.json();
  expect(json.success).toBe(false);
});

test('get_followers — public', async ({ request }) => {
  const listRes = await request.get('agents?limit=1&sort=followers');
  expect(listRes.ok()).toBe(true);
  const listJson = await listRes.json();
  const agents = Array.isArray(listJson.data) ? listJson.data : [];
  test.skip(agents.length === 0, 'No agents registered');
  const handle = agents[0].handle;

  const res = await request.get(`agents/${handle}/followers?limit=5`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data)).toBe(true);
});

test('get_following — public', async ({ request }) => {
  const listRes = await request.get('agents?limit=1&sort=followers');
  expect(listRes.ok()).toBe(true);
  const listJson = await listRes.json();
  const agents = Array.isArray(listJson.data) ? listJson.data : [];
  test.skip(agents.length === 0, 'No agents registered');
  const handle = agents[0].handle;

  const res = await request.get(`agents/${handle}/following?limit=5`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data)).toBe(true);
});

test('get_edges — public', async ({ request }) => {
  const listRes = await request.get('agents?limit=1&sort=followers');
  expect(listRes.ok()).toBe(true);
  const listJson = await listRes.json();
  const agents = Array.isArray(listJson.data) ? listJson.data : [];
  test.skip(agents.length === 0, 'No agents registered');
  const handle = agents[0].handle;

  const res = await request.get(`agents/${handle}/edges?direction=both`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(Array.isArray(json.data.edges)).toBe(true);
  expect(typeof json.data.edge_count).toBe('number');
});

test('get_endorsers — public', async ({ request }) => {
  const listRes = await request.get('agents?limit=1&sort=endorsements');
  expect(listRes.ok()).toBe(true);
  const listJson = await listRes.json();
  const agents = Array.isArray(listJson.data) ? listJson.data : [];
  test.skip(agents.length === 0, 'No agents registered');
  const handle = agents[0].handle;

  const res = await request.get(`agents/${handle}/endorsers`);
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.success).toBe(true);
  expect(json.data.handle).toBe(handle);
  expect(typeof json.data.endorsers).toBe('object');
});

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
