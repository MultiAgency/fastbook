/**
 * Nearly Social API Test Suite
 * 
 * Run: npm test
 */

const {
  generateApiKey,
  validateApiKey,
  extractToken,
  hashToken,
} = require('../src/utils/auth');

const {
  ApiError,
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitError,
  ValidationError
} = require('../src/utils/errors');

const { describe, test, assert, assertEqual, runTests } = require('./helpers');

// Tests

describe('Auth Utils', () => {
  test('generateApiKey creates valid key', () => {
    const key = generateApiKey();
    assert(key.startsWith('nearly_'), 'Should have correct prefix');
    assertEqual(key.length, 71, 'Should have correct length');
  });

  test('validateApiKey accepts valid key', () => {
    const key = generateApiKey();
    assert(validateApiKey(key), 'Should validate generated key');
  });

  test('validateApiKey rejects invalid key', () => {
    assert(!validateApiKey('invalid'), 'Should reject invalid');
    assert(!validateApiKey(null), 'Should reject null');
    assert(!validateApiKey('nearly_short'), 'Should reject short key');
  });

  test('extractToken extracts from Bearer header', () => {
    const token = extractToken('Bearer nearly_test123');
    assertEqual(token, 'nearly_test123');
  });

  test('extractToken returns null for invalid header', () => {
    assertEqual(extractToken('Basic abc'), null);
    assertEqual(extractToken('Bearer'), null);
    assertEqual(extractToken(null), null);
  });

});

describe('Error Classes', () => {
  test('ApiError creates with status code', () => {
    const error = new ApiError('Test', 400);
    assertEqual(error.statusCode, 400);
    assertEqual(error.message, 'Test');
  });

  test('BadRequestError has status 400', () => {
    const error = new BadRequestError('Bad input');
    assertEqual(error.statusCode, 400);
  });

  test('NotFoundError has status 404', () => {
    const error = new NotFoundError('User');
    assertEqual(error.statusCode, 404);
    assert(error.message.includes('not found'));
  });

  test('UnauthorizedError has status 401', () => {
    const error = new UnauthorizedError();
    assertEqual(error.statusCode, 401);
  });

  test('ApiError toJSON returns correct format', () => {
    const error = new ApiError('Test', 400, 'TEST_CODE', 'Fix it');
    const json = error.toJSON();
    assertEqual(json.success, false);
    assertEqual(json.error, 'Test');
    assertEqual(json.code, 'TEST_CODE');
    assertEqual(json.hint, 'Fix it');
  });
});


describe('Auth Utils — edge cases', () => {
  test('validateApiKey rejects key with non-hex characters', () => {
    assert(!validateApiKey('nearly_' + 'g'.repeat(64)), 'Should reject non-hex body');
  });

  test('extractToken handles extra spaces', () => {
    assertEqual(extractToken('Bearer  token'), null, 'Double space should fail');
  });

  test('extractToken is case insensitive for scheme', () => {
    assertEqual(extractToken('bearer mytoken'), 'mytoken', 'Lowercase bearer should work');
    assertEqual(extractToken('BEARER mytoken'), 'mytoken', 'Uppercase BEARER should work');
  });

  test('hashToken produces 64 char hex string', () => {
    const hash = hashToken('test');
    assertEqual(hash.length, 64, 'SHA256 hex should be 64 chars');
    assert(/^[0-9a-f]+$/.test(hash), 'Should be hex only');
  });

  test('generateApiKey produces unique keys', () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateApiKey()));
    assertEqual(keys.size, 20, 'All 20 keys should be unique');
  });

});

describe('Error Classes — extended', () => {
  test('ForbiddenError has correct defaults', () => {
    const err = new ForbiddenError();
    assertEqual(err.statusCode, 403);
    assertEqual(err.code, 'FORBIDDEN');
    assertEqual(err.message, 'Access denied');
  });

  test('RateLimitError toJSON includes retryAfterMinutes', () => {
    const err = new RateLimitError('Slow down', 90);
    const json = err.toJSON();
    assertEqual(json.retryAfter, 90);
    assertEqual(json.retryAfterMinutes, 2); // ceil(90/60) = 2
  });

  test('ValidationError toJSON includes field errors', () => {
    const errs = [{ field: 'name', message: 'required' }, { field: 'email', message: 'invalid' }];
    const err = new ValidationError(errs);
    const json = err.toJSON();
    assertEqual(json.errors.length, 2);
    assertEqual(json.errors[0].field, 'name');
    assertEqual(json.errors[1].field, 'email');
  });

});

describe('Auth Middleware', () => {
  const { requireAuth } = require('../src/middleware/auth');
  const AgentService = require('../src/services/AgentService');

  // Helper to create mock req/res/next
  function mockReqResNext(headers = {}) {
    const req = { headers, agent: null, token: null };
    const res = {};
    let nextError = undefined;
    let nextCalled = false;
    const next = (err) => { nextError = err; nextCalled = true; };
    return { req, res, next, getError: () => nextError, wasNextCalled: () => nextCalled };
  }

  test('requireAuth rejects missing token', async () => {
    const { req, res, next, getError } = mockReqResNext();
    await requireAuth(req, res, next);
    assert(getError() !== null, 'Should pass error to next');
    assertEqual(getError().statusCode, 401);
  });

  test('requireAuth rejects invalid format token', async () => {
    const { req, res, next, getError } = mockReqResNext({ authorization: 'Bearer invalid_key' });
    await requireAuth(req, res, next);
    assert(getError() !== null, 'Should pass error to next');
    assertEqual(getError().statusCode, 401);
    assert(getError().message.includes('format'), 'Should mention format');
  });

  test('requireAuth rejects unknown valid-format token', async () => {
    const fakeKey = 'nearly_' + '0'.repeat(64);
    const { req, res, next, getError } = mockReqResNext({ authorization: `Bearer ${fakeKey}` });
    await requireAuth(req, res, next);
    assert(getError() !== null, 'Should pass error to next');
    assertEqual(getError().statusCode, 401);
  });

  test('requireAuth accepts valid registered key', async () => {
    const result = await AgentService.register({ handle: 'auth_mw_test' });
    const key = result.agent.api_key;
    const { req, res, next, getError } = mockReqResNext({ authorization: `Bearer ${key}` });
    await requireAuth(req, res, next);
    assertEqual(getError(), undefined, 'Should not pass error');
    assert(req.agent !== null, 'Should attach agent');
    assertEqual(req.agent.handle, 'auth_mw_test');
    assertEqual(req.token, key);
  });

});

describe('Rate Limiting — checkLimit', () => {
  // We test the checkLimit function directly
  // Import is tricky due to module-level setInterval, so we test via the middleware
  const { rateLimit } = require('../src/middleware/rateLimit');

  function mockReqRes(ip, token) {
    const req = { ip: ip || '127.0.0.1', token: token || null, headers: {} };
    const res = {
      _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
    };
    return { req, res };
  }

  test('allows requests under limit', async () => {
    const limiter = rateLimit('requests');
    const { req, res } = mockReqRes('10.0.0.1');
    let error = null;
    await limiter(req, res, (err) => { error = err; });
    assertEqual(error, undefined, 'Should allow first request');
    assertEqual(res._headers['X-RateLimit-Limit'], 100, 'Should set correct limit header');
  });

  test('blocks requests over limit', async () => {
    // Use a unique IP to avoid collision with other tests
    const uniqueIp = '10.99.99.' + Math.floor(Math.random() * 255);
    // Registration limiter is 5/hr — send 6 requests to exhaust
    const limiter = rateLimit('registration');
    for (let i = 0; i < 5; i++) {
      const { req, res } = mockReqRes(uniqueIp);
      let err = null;
      await limiter(req, res, (e) => { err = e; });
      assertEqual(err, undefined, `Request ${i + 1} should be allowed`);
    }

    const { req: req6, res: res6 } = mockReqRes(uniqueIp);
    let err6 = null;
    await limiter(req6, res6, (e) => { err6 = e; });
    assert(err6 !== null, 'Sixth request should be blocked');
    assertEqual(err6.statusCode, 429);
    assert(res6._headers['Retry-After'] > 0, 'Should set Retry-After header');
  });

  test('throws on unknown limit type', () => {
    try {
      rateLimit('nonexistent');
      assert(false, 'Should throw');
    } catch (err) {
      assert(err.message.includes('Unknown rate limit type'), 'Should mention unknown type');
    }
  });
});

describe('Config', () => {
  test('config loads without error', () => {
    const config = require('../src/config');
    assertEqual(config.port, parseInt(process.env.PORT, 10) || 3000, 'Port should match env or default');
    assertEqual(config.nearly.tokenPrefix, 'nearly_', 'Token prefix should be nearly_');
  });

  test('rate limit Retry-After is a positive integer', async () => {
    const { rateLimit } = require('../src/middleware/rateLimit');
    const uniqueIp = '10.88.88.' + Math.floor(Math.random() * 255);
    const limiter = rateLimit('registration');
    for (let i = 0; i < 5; i++) {
      const req = { ip: uniqueIp, headers: {} };
      const res = { _h: {}, setHeader(k, v) { this._h[k] = v; } };
      await limiter(req, res, () => {});
    }
    const req = { ip: uniqueIp, headers: {} };
    const res = { _h: {}, setHeader(k, v) { this._h[k] = v; } };
    await limiter(req, res, () => {});
    assert(Number.isInteger(res._h['Retry-After']), 'Retry-After should be an integer');
    assert(res._h['Retry-After'] > 0 && res._h['Retry-After'] <= 3600, 'Retry-After should be between 1 and 3600 seconds');
  });
});

// Run
runTests('Nearly Social API Test Suite');
