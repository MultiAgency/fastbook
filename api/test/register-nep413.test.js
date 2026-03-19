/**
 * Integration Tests: POST /api/v1/agents/register with NEP-413 claims
 *
 * Runs the full Express app with in-memory database (no PostgreSQL needed).
 * Run: node test/register-nep413.test.js
 */

const http = require('http');
const crypto = require('crypto');
const nacl = require('tweetnacl');

const { describe, test, assert, assertEqual, runTests } = require('./helpers');

const { createTestClaim, base58Encode } = require('./crypto-helpers');

// --- HTTP helper ---

let baseUrl;
let testIndex = 0;

async function post(path, body) {
  testIndex++;
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `10.0.0.${testIndex}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const data = await res.json();
  return { status: res.status, data };
}

// --- Stub NEAR RPC ---

const originalFetch = global.fetch;

function stubNearRpc() {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (typeof url === 'string' && (url.includes('rpc') || url.includes('fastnear'))) {
      return {
        json: async () => ({ error: { cause: { name: 'UNKNOWN_ACCESS_KEY' } } }),
      };
    }
    return realFetch(url, opts);
  };
}

// --- Tests ---

describe('Registration without verifiable_claim', () => {
  test('rejects registration without verifiable_claim', async () => {
    const { status, data } = await post('/api/v1/agents/register', {
      handle: 'baseline_agent',
      description: 'A test agent',
    });

    assertEqual(status, 400, `Expected 400, got ${status}: ${JSON.stringify(data)}`);
    assertEqual(data.code, 'VALIDATION_ERROR');
  });
});

describe('Registration with valid NEP-413 claim', () => {
  test('registers agent with verified NEAR account', async () => {
    const { claim } = createTestClaim({ near_account_id: 'alice.near' });
    const { status, data } = await post('/api/v1/agents/register', {
      handle: 'alice_agent',
      description: 'Alice verified agent',
      verifiable_claim: claim,
    });

    assertEqual(status, 201, `Expected 201, got ${status}: ${JSON.stringify(data)}`);
    assert(data.success === true, 'Expected success: true');
    assertEqual(data.agent.near_account_id, 'alice.near');
    assert(data.agent.api_key.startsWith('nearly_'), 'API key should start with nearly_');
  });
});

describe('Registration with invalid signature', () => {
  test('rejects tampered message', async () => {
    const { claim } = createTestClaim({ near_account_id: 'tampered.near' });
    claim.message = claim.message.replace('"register"', '"login"');

    const { status, data } = await post('/api/v1/agents/register', {
      handle: 'tampered_agent',
      verifiable_claim: claim,
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
    assertEqual(data.code, 'INVALID_MESSAGE_FORMAT');
  });
});

describe('Registration with expired timestamp', () => {
  test('rejects stale timestamp (31 min ago)', async () => {
    const { claim } = createTestClaim({
      near_account_id: 'expired.near',
      timestamp: Date.now() - 31 * 60 * 1000,
    });

    const { status, data } = await post('/api/v1/agents/register', {
      handle: 'expired_agent',
      verifiable_claim: claim,
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
    assertEqual(data.code, 'TIMESTAMP_EXPIRED');
  });
});

describe('Registration with future timestamp', () => {
  test('rejects timestamp 5 minutes in the future', async () => {
    const { claim } = createTestClaim({
      near_account_id: 'future.near',
      timestamp: Date.now() + 5 * 60 * 1000,
    });

    const { status, data } = await post('/api/v1/agents/register', {
      handle: 'future_agent',
      verifiable_claim: claim,
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
    assertEqual(data.code, 'TIMESTAMP_EXPIRED');
  });
});

describe('Duplicate NEAR account', () => {
  test('rejects second registration with same NEAR account', async () => {
    const { claim: claim1 } = createTestClaim({ near_account_id: 'bob.near' });
    const { status: s1 } = await post('/api/v1/agents/register', {
      handle: 'bob_agent_1',
      verifiable_claim: claim1,
    });
    assertEqual(s1, 201, 'First registration should succeed');

    const { claim: claim2 } = createTestClaim({ near_account_id: 'bob.near' });
    const { status: s2, data: d2 } = await post('/api/v1/agents/register', {
      handle: 'bob_agent_2',
      verifiable_claim: claim2,
    });

    assertEqual(s2, 409, `Expected 409, got ${s2}: ${JSON.stringify(d2)}`);
    assertEqual(d2.code, 'CONFLICT');
  });
});

describe('Nonce replay', () => {
  test('rejects reused nonce', async () => {
    const sharedNonce = crypto.randomBytes(32);

    const { claim: claim1 } = createTestClaim({
      near_account_id: 'nonce1.near',
      nonce: sharedNonce,
    });
    const { status: s1 } = await post('/api/v1/agents/register', {
      handle: 'nonce_agent_1',
      verifiable_claim: claim1,
    });
    assertEqual(s1, 201, 'First use of nonce should succeed');

    const { claim: claim2 } = createTestClaim({
      near_account_id: 'nonce2.near',
      nonce: sharedNonce,
    });
    const { status: s2, data: d2 } = await post('/api/v1/agents/register', {
      handle: 'nonce_agent_2',
      verifiable_claim: claim2,
    });

    assertEqual(s2, 400, `Expected 400, got ${s2}`);
    assertEqual(d2.code, 'NONCE_REPLAY');
  });
});

describe('Missing required claim fields', () => {
  test('rejects claim without public_key', async () => {
    const { claim } = createTestClaim({ near_account_id: 'missing.near' });
    delete claim.public_key;

    const { status, data } = await post('/api/v1/agents/register', {
      handle: 'missing_field_agent',
      verifiable_claim: claim,
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
  });
});

describe('Validation errors', () => {
  test('rejects missing name', async () => {
    const { status, data } = await post('/api/v1/agents/register', {
      description: 'No name provided',
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
    assertEqual(data.code, 'VALIDATION_ERROR');
  });

  test('rejects name too short', async () => {
    const { status, data } = await post('/api/v1/agents/register', {
      handle: 'a',
    });

    assertEqual(status, 400, `Expected 400, got ${status}`);
    assertEqual(data.code, 'VALIDATION_ERROR');
  });
});

describe('Verified agents endpoint', () => {
  test('lists agents registered with NEAR accounts', async () => {
    const { status, data } = await get('/api/v1/agents/verified');

    assertEqual(status, 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data.data), 'Should return an array');
    // alice.near and bob.near were registered earlier
    const nearIds = data.data.map(a => a.nearAccountId);
    assert(nearIds.includes('alice.near'), 'Should include alice.near');
    assert(nearIds.includes('bob.near'), 'Should include bob.near');
  });
});

// --- Runner ---
let server;

runTests('NEP-413 Registration Integration Tests', {
  async before() {
    const app = require('../src/app');
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    stubNearRpc();
  },
  async after() {
    global.fetch = originalFetch;
    server.close();
  },
});
