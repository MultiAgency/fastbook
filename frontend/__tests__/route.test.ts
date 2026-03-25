/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { setupFetchMock, TEST_AUTH } from './fixtures';

const mockCallOutlayer = jest.fn();
jest.mock('@/lib/outlayer-route', () => ({
  getOutlayerPaymentKey: () => 'pk_test',
  sanitizePublic: jest.requireActual('@/lib/outlayer-route').sanitizePublic,
  callOutlayer: (...args: unknown[]) => mockCallOutlayer(...args),
}));

jest.mock('@/lib/cache', () => ({
  getCached: jest.fn().mockReturnValue(undefined),
  setCache: jest.fn(),
  clearCache: jest.fn(),
  makeCacheKey: jest.fn((body: Record<string, unknown>) =>
    JSON.stringify(body),
  ),
}));

import { NextResponse } from 'next/server';
import {
  DELETE,
  GET,
  OPTIONS,
  PATCH,
  POST,
  RATE_LIMIT_PER_IP,
  resetRateLimiter,
} from '../src/app/api/v1/[...path]/route';

function makeRequest(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): [NextRequest, { params: Promise<{ path: string[] }> }] {
  const url = `http://localhost:3000/api/v1/${path}`;
  const init: Record<string, unknown> = { method, headers: headers ?? {} };
  if (body) init.body = JSON.stringify(body);
  const req = new NextRequest(
    url,
    init as ConstructorParameters<typeof NextRequest>[1],
  );
  const pathOnly = path.split('?')[0];
  const segments = pathOnly.split('/').filter(Boolean);
  return [req, { params: Promise.resolve({ path: segments }) }];
}

async function json(res: NextResponse) {
  return res.json();
}

beforeEach(() => {
  jest.clearAllMocks();
  resetRateLimiter();
  jest.spyOn(console, 'warn');
  mockCallOutlayer.mockResolvedValue(
    NextResponse.json({ success: true, data: {} }),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('sanitizePublic', () => {
  const { sanitizePublic } = jest.requireActual('@/lib/outlayer-route') as {
    sanitizePublic: (body: Record<string, unknown>) => Record<string, unknown>;
  };

  it('strips keys not in PUBLIC_FIELDS', () => {
    const result = sanitizePublic({
      action: 'list_agents',
      verifiable_claim: { evil: true },
      password: 'secret',
      api_key: 'wk_stolen',
    });
    expect(result.action).toBe('list_agents');
    expect(result.verifiable_claim).toBeUndefined();
    expect(result.password).toBeUndefined();
    expect(result.api_key).toBeUndefined();
  });

  it('strips non-primitive values even for valid keys', () => {
    const result = sanitizePublic({
      action: 'list_agents',
      handle: { nested: 'object' },
      limit: [1, 2, 3],
    });
    expect(result.action).toBe('list_agents');
    expect(result.handle).toBeUndefined();
    expect(result.limit).toBeUndefined();
  });

  it('passes through fields whitelisted for the action', () => {
    const input = {
      action: 'list_agents',
      handle: 'alice',
      limit: 10,
      cursor: 'abc',
      sort: 'newest',
    };
    expect(sanitizePublic(input)).toEqual(input);
  });

  it('strips fields not whitelisted for the action', () => {
    const result = sanitizePublic({
      action: 'list_agents',
      handle: 'alice',
      direction: 'outgoing',
      since: 1700000000,
    });
    expect(result.handle).toBe('alice');
    expect(result.direction).toBeUndefined();
    expect(result.since).toBeUndefined();
  });

  it('allows structured values for endorser filters', () => {
    const result = sanitizePublic({
      action: 'get_endorsers',
      handle: 'alice',
      tags: ['rust', 'ai'],
      capabilities: { skills: ['chat'] },
    });
    expect(result.tags).toEqual(['rust', 'ai']);
    expect(result.capabilities).toEqual({ skills: ['chat'] });
  });

  it('returns empty object for empty input', () => {
    expect(sanitizePublic({})).toEqual({});
  });

  it('returns empty object when all keys are disallowed', () => {
    expect(sanitizePublic({ secret: 'x', token: 'y' })).toEqual({});
  });
});

describe('route resolution', () => {
  it.each([
    ['GET', 'health', 'health'],
    ['GET', 'tags', 'list_tags'],
    ['GET', 'agents', 'list_agents'],
    ['POST', 'agents/register', 'register'],
    ['GET', 'agents/suggested', 'get_suggested'],
    ['GET', 'agents/me', 'get_me'],
    ['PATCH', 'agents/me', 'update_me'],
    ['POST', 'agents/me/heartbeat', 'heartbeat'],
    ['GET', 'agents/me/activity', 'get_activity'],
    ['GET', 'agents/me/network', 'get_network'],
    ['GET', 'agents/me/notifications', 'get_notifications'],
    ['POST', 'agents/me/notifications/read', 'read_notifications'],
    ['GET', 'agents/alice', 'get_profile'],
    ['POST', 'agents/alice/follow', 'follow'],
    ['DELETE', 'agents/alice/follow', 'unfollow'],
    ['GET', 'agents/alice/followers', 'get_followers'],
    ['GET', 'agents/alice/following', 'get_following'],
    ['GET', 'agents/alice/edges', 'get_edges'],
    ['POST', 'agents/alice/endorse', 'endorse'],
    ['DELETE', 'agents/alice/endorse', 'unendorse'],
    ['GET', 'agents/alice/endorsers', 'get_endorsers'],
    ['POST', 'agents/alice/endorsers', 'get_endorsers'],
  ])('%s %s → %s', async (method: string, path: string, expectedAction: string) => {
    const handlers: Record<string, typeof GET> = { GET, POST, PATCH, DELETE };
    const handler = handlers[method]!;
    const headers: Record<string, string> = {};

    const { PUBLIC_ACTIONS } = jest.requireActual('@/lib/routes') as {
      PUBLIC_ACTIONS: Set<string>;
    };
    if (!PUBLIC_ACTIONS.has(expectedAction)) {
      headers['x-payment-key'] = 'pk_user';
    }

    const [req, params] = makeRequest(method, path, undefined, headers);
    await handler(req, params);

    expect(mockCallOutlayer).toHaveBeenCalledTimes(1);
    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.action).toBe(expectedAction);
  });

  it('returns 404 for unknown routes', async () => {
    const [req, params] = makeRequest('GET', 'unknown/path');
    const res = await GET(req, params);
    expect(res.status).toBe(404);
  });
});

describe('query params', () => {
  it('parses limit as integer', async () => {
    const [req, params] = makeRequest('GET', 'agents?limit=25');
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.limit).toBe(25);
  });

  it('passes since as validated string for authenticated actions', async () => {
    const [req, params] = makeRequest(
      'GET',
      'agents/me/activity?since=1700000000',
      undefined,
      {
        authorization: 'Bearer wk_test',
      },
    );
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.since).toBe('1700000000');
  });

  it('parses include_history as boolean', async () => {
    const [req, params] = makeRequest(
      'GET',
      'agents/alice/edges?include_history=true',
    );
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.include_history).toBe(true);
  });

  it('passes string params through', async () => {
    const [req, params] = makeRequest(
      'GET',
      'agents?sort=newest&cursor=agent_42',
    );
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.sort).toBe('newest');
    expect(wasmBody.cursor).toBe('agent_42');
  });

  it('drops non-parseable integer params', async () => {
    const [req, params] = makeRequest('GET', 'agents?limit=abc');
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.limit).toBeUndefined();
  });

  it('parses include_history=false as false', async () => {
    const [req, params] = makeRequest(
      'GET',
      'agents/alice/edges?include_history=false',
    );
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.include_history).toBe(false);
  });
});

describe('injection prevention', () => {
  it('route params override body action to prevent action injection', async () => {
    const [req, params] = makeRequest(
      'POST',
      'agents/register',
      { action: 'get_me', handle: 'alice' },
      { 'x-payment-key': 'pk_user' },
    );
    await POST(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.action).toBe('register');
  });

  it('route params override body handle to prevent handle injection', async () => {
    const [req, params] = makeRequest(
      'POST',
      'agents/alice/follow',
      { handle: 'mallory' },
      { 'x-payment-key': 'pk_user' },
    );
    await POST(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.handle).toBe('alice');
  });

  it('sanitizePublic strips verifiable_claim and unknown fields on public reads', async () => {
    const [req, params] = makeRequest(
      'GET',
      'agents?limit=10&verifiable_claim=evil&password=secret',
    );
    await GET(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.verifiable_claim).toBeUndefined();
    expect(wasmBody.password).toBeUndefined();
    expect(wasmBody.limit).toBe(10);
  });
});

describe('auth dispatch', () => {
  it('returns cached response without calling callOutlayer', async () => {
    const { getCached } = jest.requireMock('@/lib/cache');
    const cachedData = { success: true, data: [{ handle: 'cached_bot' }] };
    (getCached as jest.Mock).mockReturnValueOnce(cachedData);

    const [req, params] = makeRequest('GET', 'agents');
    const res = await GET(req, params);
    const body = await json(res);

    expect(body).toEqual(cachedData);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('public actions use payment key from env', async () => {
    const [req, params] = makeRequest('GET', 'agents');
    await GET(req, params);

    const paymentKey = mockCallOutlayer.mock.calls[0][1];
    expect(paymentKey).toBe('pk_test');
  });

  it('x-payment-key header forwards for authenticated actions', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      'x-payment-key': 'owner.near:1:secret',
    });
    await GET(req, params);

    const authKey = mockCallOutlayer.mock.calls[0][1];
    expect(authKey).toBe('owner.near:1:secret');
  });

  it('Authorization: Bearer wk_ forwards wallet key for authenticated actions', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      authorization: 'Bearer wk_test1234abcdef',
    });
    await GET(req, params);

    const authKey = mockCallOutlayer.mock.calls[0][1];
    expect(authKey).toBe('wk_test1234abcdef');
  });

  it('x-payment-key takes precedence over Authorization: Bearer', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      'x-payment-key': 'owner.near:1:secret',
      authorization: 'Bearer wk_test1234abcdef',
    });
    await GET(req, params);

    const authKey = mockCallOutlayer.mock.calls[0][1];
    expect(authKey).toBe('owner.near:1:secret');
  });

  it('ignores non-wk_ bearer tokens', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      authorization: 'Bearer some_other_token',
    });
    const res = await GET(req, params);
    expect(res.status).toBe(401);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('body verifiable_claim uses env payment key', async () => {
    const claim = {
      near_account_id: 'alice.near',
      public_key: 'ed25519:abc',
      signature: 'ed25519:sig',
      nonce: 'bm9uY2U=',
      message: 'hello',
      recipient: 'social',
    };
    const [req, params] = makeRequest('POST', 'agents/me/heartbeat', {
      verifiable_claim: claim,
    });
    await POST(req, params);

    const wasmBody = mockCallOutlayer.mock.calls[0][0];
    expect(wasmBody.verifiable_claim).toEqual(claim);
    const paymentKey = mockCallOutlayer.mock.calls[0][1];
    expect(paymentKey).toBe('pk_test');
  });

  it('rejects malformed verifiable_claim (missing fields)', async () => {
    const claim = { near_account_id: 'alice.near', signature: 'sig' };
    const [req, params] = makeRequest('POST', 'agents/me/heartbeat', {
      verifiable_claim: claim,
    });
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('rejects verifiable_claim with wrong field types', async () => {
    const claim = {
      near_account_id: 123,
      public_key: 'ed25519:abc',
      signature: 'ed25519:sig',
      nonce: 'bm9uY2U=',
      message: '{}',
    };
    const [req, params] = makeRequest('POST', 'agents/me/heartbeat', {
      verifiable_claim: claim,
    });
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('returns 401 when no auth provided for private action', async () => {
    const [req, params] = makeRequest('GET', 'agents/me');
    const res = await GET(req, params);
    expect(res.status).toBe(401);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });
});

describe('CORS', () => {
  it('includes CORS headers on responses', async () => {
    const [req, params] = makeRequest('GET', 'agents');
    const res = await GET(req, params);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain(
      'Authorization',
    );
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain(
      'X-Payment-Key',
    );
  });

  it('handles OPTIONS preflight', () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });
});

describe('error handling', () => {
  it('returns 413 for oversized request body', async () => {
    const largeBody = 'x'.repeat(65_537);
    const url = 'http://localhost:3000/api/v1/agents/register';
    const req = new NextRequest(url, {
      method: 'POST',
      body: largeBody,
      headers: {
        'x-payment-key': 'pk_user',
        'content-type': 'application/json',
      },
    });
    const params = {
      params: Promise.resolve({ path: ['agents', 'register'] }),
    };
    const res = await POST(req, params);
    expect(res.status).toBe(413);
    const body = await json(res);
    expect(body.error).toContain('too large');
  });

  it('returns 400 for invalid JSON body', async () => {
    const url = 'http://localhost:3000/api/v1/agents/register';
    const req = new NextRequest(url, {
      method: 'POST',
      body: 'not json{{{',
      headers: {
        'x-payment-key': 'pk_user',
        'content-type': 'application/json',
      },
    });
    const params = {
      params: Promise.resolve({ path: ['agents', 'register'] }),
    };
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('Invalid JSON');
  });
});

describe('market auto-registration on register', () => {
  let marketFetch: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    marketFetch = setupFetchMock();
    mockCallOutlayer.mockImplementation(() =>
      Promise.resolve(
        NextResponse.json({
          success: true,
          data: { agent: { handle: 'my_bot' }, near_account_id: 'abc.near' },
        }),
      ),
    );
  });

  afterEach(() => marketFetch.restore());

  it('merges market credentials into response on success', async () => {
    marketFetch.mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          api_key: 'sk_live_x',
          agent_id: 'uuid',
          near_account_id: 'mkt.near',
        }),
    });

    const [req, params] = makeRequest(
      'POST',
      'agents/register',
      { handle: 'my_bot', tags: ['ai'], verifiable_claim: TEST_AUTH },
      { 'x-payment-key': 'pk_user' },
    );
    const res = await POST(req, params);
    const body = await json(res);

    expect(body.success).toBe(true);
    expect(body.data.market).toEqual({
      api_key: 'sk_live_x',
      agent_id: 'uuid',
      near_account_id: 'mkt.near',
    });
    expect(body.warnings).toBeUndefined();
  });

  it('adds warning when market handle is taken', async () => {
    marketFetch.mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Handle already registered' }),
    });

    const [req, params] = makeRequest(
      'POST',
      'agents/register',
      { handle: 'my_bot' },
      { 'x-payment-key': 'pk_user' },
    );
    const res = await POST(req, params);
    const body = await json(res);

    expect(body.success).toBe(true);
    expect(body.data.market).toBeUndefined();
    expect(body.warnings).toEqual([
      'market.near.ai: Handle already registered',
    ]);
  });

  it('adds warning when market is unreachable', async () => {
    marketFetch.mockFetch.mockRejectedValue(new Error('Network error'));

    const [req, params] = makeRequest(
      'POST',
      'agents/register',
      { handle: 'my_bot' },
      { 'x-payment-key': 'pk_user' },
    );
    const res = await POST(req, params);
    const body = await json(res);

    expect(body.success).toBe(true);
    expect(body.warnings).toEqual([
      'market.near.ai: could not reserve handle (service unreachable)',
    ]);
  });

  it('forwards tags and capabilities to market registration', async () => {
    marketFetch.mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          api_key: 'sk_live_x',
          agent_id: 'uuid',
          near_account_id: 'mkt.near',
        }),
    });

    const [req, params] = makeRequest(
      'POST',
      'agents/register',
      {
        handle: 'my_bot',
        tags: ['ai', 'rust'],
        capabilities: { skills: ['chat'] },
      },
      { 'x-payment-key': 'pk_user' },
    );
    await POST(req, params);

    const marketBody = JSON.parse(marketFetch.mockFetch.mock.calls[0][1].body);
    expect(marketBody.handle).toBe('my_bot');
    expect(marketBody.tags).toEqual(['ai', 'rust']);
    expect(marketBody.capabilities).toEqual({ skills: ['chat'] });
  });

  it('does not call market for non-register actions', async () => {
    const [req, params] = makeRequest(
      'POST',
      'agents/me/heartbeat',
      {},
      { authorization: 'Bearer wk_test' },
    );
    await POST(req, params);

    expect(marketFetch.mockFetch).not.toHaveBeenCalled();
  });
});

describe('rate limiting', () => {
  it('rate-limits unauthenticated requests to auth-required endpoints', async () => {
    // Exhaust the global rate limit with unauthenticated requests
    for (let i = 0; i < RATE_LIMIT_PER_IP; i++) {
      const [req, params] = makeRequest('POST', 'agents/me/heartbeat');
      await POST(req, params);
    }
    // The next request should be rate-limited, not just 401
    const [req, params] = makeRequest('POST', 'agents/me/heartbeat');
    const res = await POST(req, params);
    expect(res.status).toBe(429);
  });

  it('rate-limits authenticated requests after global limit', async () => {
    for (let i = 0; i < RATE_LIMIT_PER_IP; i++) {
      const [req, params] = makeRequest(
        'POST',
        'agents/me/heartbeat',
        {},
        { authorization: 'Bearer wk_test' },
      );
      await POST(req, params);
    }
    const [req, params] = makeRequest(
      'POST',
      'agents/me/heartbeat',
      {},
      { authorization: 'Bearer wk_test' },
    );
    const res = await POST(req, params);
    expect(res.status).toBe(429);
  });
});
