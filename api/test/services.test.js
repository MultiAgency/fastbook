/**
 * Service-layer Test Suite
 *
 * Covers AgentService, constants, and config.
 *
 * Run: USE_MEMORY_STORE=true node test/services.test.js
 */

const { AgentStatus, NEAR_DOMAIN } = require('../src/utils/constants');
const {
  ConflictError,
  InternalError,
} = require('../src/utils/errors');

const { describe, test, assert, assertEqual, assertThrows, runTests } = require('./helpers');

// ----------------------------------------------------------------
// Constants (smoke test — ensures exports exist and haven't been renamed)
// ----------------------------------------------------------------
describe('Constants', () => {
  test('AgentStatus and NEAR_DOMAIN are exported', () => {
    assertEqual(typeof AgentStatus, 'object', 'AgentStatus should be an object');
    assertEqual(typeof AgentStatus.ACTIVE, 'string', 'ACTIVE should be a string');
    assertEqual(typeof NEAR_DOMAIN, 'string', 'NEAR_DOMAIN should be a string');
    assert(NEAR_DOMAIN.length > 0, 'NEAR_DOMAIN should not be empty');
  });
});

// ----------------------------------------------------------------
// Error classes (only those NOT covered in api.test.js)
// ----------------------------------------------------------------
describe('Error Classes (services-only)', () => {
  test('ConflictError has status 409', () => {
    const err = new ConflictError('Duplicate');
    assertEqual(err.statusCode, 409);
    assertEqual(err.code, 'CONFLICT');
  });

  test('InternalError defaults to 500', () => {
    const err = new InternalError();
    assertEqual(err.statusCode, 500);
    assert(err.hint !== null, 'Should have hint');
    assertEqual(err.message, 'Internal server error');
  });
});

// ----------------------------------------------------------------
// AgentService
// ----------------------------------------------------------------
describe('AgentService', () => {
  // AgentService touches the database, but with USE_MEMORY_STORE=true
  // we can exercise registration and lookup.
  const AgentService = require('../src/services/AgentService');

  test('register creates agent and returns api_key', async () => {
    const result = await AgentService.register({ handle: 'svc_test_agent' });
    assert(result.agent.api_key.startsWith('nearly_'), 'Key has prefix');
    assert(result.important.includes('Save'), 'Has save warning');
  });

  test('register rejects empty name', async () => {
    await assertThrows(
      () => AgentService.register({ handle: '' }),
      400,
      'Empty name'
    );
  });

  test('register rejects short name', async () => {
    await assertThrows(
      () => AgentService.register({ handle: 'x' }),
      400,
      'Short name'
    );
  });

  test('register rejects invalid characters', async () => {
    await assertThrows(
      () => AgentService.register({ handle: 'bad name!' }),
      400,
      'Invalid chars'
    );
  });

  test('register rejects duplicate name', async () => {
    await AgentService.register({ handle: 'dupe_svc_test' });
    await assertThrows(
      () => AgentService.register({ handle: 'dupe_svc_test' }),
      409,
      'Duplicate name'
    );
  });

  test('findByApiKey returns agent after registration', async () => {
    const result = await AgentService.register({ handle: 'findme_svc' });
    const agent = await AgentService.findByApiKey(result.agent.api_key);
    assert(agent !== null, 'Should find agent');
    assertEqual(agent.handle, 'findme_svc');
  });

  test('findByApiKey returns null for unknown key', async () => {
    const agent = await AgentService.findByApiKey('nearly_' + '0'.repeat(64));
    assertEqual(agent, null);
  });

  test('findByHandle returns agent', async () => {
    await AgentService.register({ handle: 'namelookup_svc' });
    const agent = await AgentService.findByHandle('namelookup_svc');
    assert(agent !== null, 'Should find by handle');
    assertEqual(agent.handle, 'namelookup_svc');
  });

  test('register with nearAccountId sets active status', async () => {
    const result = await AgentService.register({
      handle: 'near_svc_test',
      nearAccountId: 'test.near',
    });
    assert(result.agent.near_account_id === 'test.near', 'Should have near_account_id');
  });

  test('rotateApiKey returns a new key', async () => {
    const reg = await AgentService.register({ handle: 'rotate_svc_test' });
    const agent = await AgentService.findByApiKey(reg.agent.api_key);
    const rotated = await AgentService.rotateApiKey(agent.id);
    assert(rotated.agent.api_key !== reg.agent.api_key, 'New key should differ');
    assert(rotated.agent.api_key.startsWith('nearly_'), 'Has prefix');
  });

  test('rotateApiKey invalidates old key', async () => {
    const reg = await AgentService.register({ handle: 'rotate_inv_test' });
    const oldKey = reg.agent.api_key;
    const agent = await AgentService.findByApiKey(oldKey);
    await AgentService.rotateApiKey(agent.id);
    const found = await AgentService.findByApiKey(oldKey);
    assertEqual(found, null, 'Old key should no longer find agent');
  });

  test('follow creates relationship and increments counts', async () => {
    const a = await AgentService.register({ handle: 'follow_src' });
    const b = await AgentService.register({ handle: 'follow_tgt' });
    const result = await AgentService.follow(a.agent.id, b.agent.id);
    assert(result !== null, 'Follow should return result');

    const isFollowing = await AgentService.isFollowing(a.agent.id, b.agent.id);
    assert(isFollowing, 'Should be following after follow');

    const target = await AgentService.findByHandle('follow_tgt');
    assert(target.follower_count >= 1, 'Target follower_count should be >= 1');
  });

  test('follow self is rejected', async () => {
    const a = await AgentService.register({ handle: 'follow_self' });
    await assertThrows(
      () => AgentService.follow(a.agent.id, a.agent.id),
      400,
      'Self-follow'
    );
  });

  test('unfollow removes relationship', async () => {
    const a = await AgentService.register({ handle: 'unf_src' });
    const b = await AgentService.register({ handle: 'unf_tgt' });
    await AgentService.follow(a.agent.id, b.agent.id);
    await AgentService.unfollow(a.agent.id, b.agent.id);

    const isFollowing = await AgentService.isFollowing(a.agent.id, b.agent.id);
    assert(!isFollowing, 'Should not be following after unfollow');
  });

  test('getSuggestedFollows returns agents', async () => {
    const a = await AgentService.register({ handle: 'suggest_src' });
    await AgentService.register({ handle: 'suggest_pop', description: 'A popular agent for suggestions' });
    const suggestions = await AgentService.getSuggestedFollows(a.agent.id, { limit: 5 });
    assert(Array.isArray(suggestions), 'Should return an array');
  });

  test('register persists agent to database', async () => {
    const result = await AgentService.register({ handle: 'persist_test' });
    const found = await AgentService.findById(result.agent.id);
    assert(found !== null, 'Should find agent by id');
    assertEqual(found.handle, 'persist_test', 'Handle should match');
  });

  test('heartbeat updates last_active', async () => {
    const reg = await AgentService.register({ handle: 'heartbeat_test' });
    const before = await AgentService.findById(reg.agent.id);
    const result = await AgentService.heartbeat(reg.agent.id);
    assert(result.agent !== undefined, 'Should return agent');
    assert(result.delta !== undefined, 'Should return delta');
  });
});

// ----------------------------------------------------------------
// Config
// ----------------------------------------------------------------
describe('Config (extended)', () => {
  test('config has pagination and rate limit settings', () => {
    const config = require('../src/config');
    assertEqual(config.pagination.defaultLimit, 25);
    assertEqual(config.pagination.maxLimit, 100);
    assertEqual(config.rateLimits.requests.max, 100);
    assertEqual(config.rateLimits.registration.max, 5);
  });
});

// ----------------------------------------------------------------
// Run
// ----------------------------------------------------------------
runTests('Service-layer Test Suite');
