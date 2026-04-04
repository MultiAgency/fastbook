/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server';
import { setupFetchMock, TEST_AUTH } from './fixtures';

const mockCallOutlayer = jest.fn();
jest.mock('@/lib/outlayer-server', () => ({
  getOutlayerPaymentKey: () => 'pk_test',
  sanitizePublic: jest.requireActual('@/lib/outlayer-server').sanitizePublic,
  callOutlayer: (...args: unknown[]) => mockCallOutlayer(...args),
  mintClaimForWalletKey: jest.fn().mockResolvedValue(null),
  resolveAccountId: jest.fn().mockResolvedValue('test.near'),
}));

const mockDispatchFastData = jest.fn();
jest.mock('@/lib/fastdata-dispatch', () => ({
  dispatchFastData: (...args: unknown[]) => mockDispatchFastData(...args),
}));

jest.mock('@/lib/fastdata-sync', () => ({
  buildSyncEntries: jest.fn().mockReturnValue(null),
  syncToFastData: jest.fn(),
}));

const mockDispatchDirectWrite = jest.fn();
jest.mock('@/lib/fastdata-write', () => ({
  dispatchDirectWrite: (...args: unknown[]) => mockDispatchDirectWrite(...args),
}));

const mockKvGetAgent = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/fastdata', () => ({
  kvGetAgent: (...args: unknown[]) => mockKvGetAgent(...args),
  resolveHandle: jest.fn().mockResolvedValue(null),
}));

jest.mock('@/lib/cache', () => ({
  getCached: jest.fn().mockReturnValue(undefined),
  setCache: jest.fn(),
  clearByAction: jest.fn(),
  invalidateForMutation: jest.fn(),
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
  jest.spyOn(console, 'warn');
  mockCallOutlayer.mockResolvedValue({
    response: NextResponse.json({ success: true, data: {} }),
    decoded: { success: true, data: {} },
  });
  mockDispatchFastData.mockResolvedValue({ data: {} });
  mockDispatchDirectWrite.mockResolvedValue({ success: true, data: {} });
  // Authenticated GETs resolve caller handle via kvGetAgent(accountId, 'name').
  // resolveAccountId is mocked via mintClaimForWalletKey returning null,
  // so the wk_ → accountId path uses the sign-message mock.
  // For tests that use wk_ keys, mock kvGetAgent to return a handle.
  mockKvGetAgent.mockResolvedValue('test_agent');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('sanitizePublic', () => {
  const { sanitizePublic } = jest.requireActual('@/lib/outlayer-server') as {
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
      action: 'filter_endorsers',
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
    ['POST', 'agents/alice/endorsers', 'filter_endorsers'],
  ])('%s %s → %s', async (method: string, path: string, expectedAction: string) => {
    const handlers: Record<string, typeof GET> = { GET, POST, PATCH, DELETE };
    const handler = handlers[method]!;
    const headers: Record<string, string> = {};

    const { PUBLIC_ACTIONS } = jest.requireActual('@/lib/routes') as {
      PUBLIC_ACTIONS: Set<string>;
    };
    const isPublic = PUBLIC_ACTIONS.has(expectedAction);
    if (!isPublic) {
      headers['x-payment-key'] = 'test.near:1:secret';
    }

    const [req, params] = makeRequest(method, path, undefined, headers);
    await handler(req, params);

    if (isPublic || method === 'GET') {
      // Public reads and authenticated GETs both go through FastData.
      expect(mockDispatchFastData).toHaveBeenCalledTimes(1);
      expect(mockDispatchFastData.mock.calls[0][0]).toBe(expectedAction);
    } else {
      expect(mockCallOutlayer).toHaveBeenCalledTimes(1);
      const wasmBody = mockCallOutlayer.mock.calls[0][0];
      expect(wasmBody.action).toBe(expectedAction);
    }
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

    const body = mockDispatchFastData.mock.calls[0][1];
    expect(body.limit).toBe(25);
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

    const fdBody = mockDispatchFastData.mock.calls[0][1];
    expect(fdBody.since).toBe('1700000000');
  });

  it('passes string params through', async () => {
    const [req, params] = makeRequest(
      'GET',
      'agents?sort=newest&cursor=agent_42',
    );
    await GET(req, params);

    const body = mockDispatchFastData.mock.calls[0][1];
    expect(body.sort).toBe('newest');
    expect(body.cursor).toBe('agent_42');
  });

  it('passes tag as string to WASM', async () => {
    const [req, params] = makeRequest('GET', 'agents?tag=ai');
    await GET(req, params);

    const body = mockDispatchFastData.mock.calls[0][1];
    expect(body.tag).toBe('ai');
  });

  it('drops non-parseable integer params', async () => {
    const [req, params] = makeRequest('GET', 'agents?limit=abc');
    await GET(req, params);

    const body = mockDispatchFastData.mock.calls[0][1];
    expect(body.limit).toBeUndefined();
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

    const sanitized = mockDispatchFastData.mock.calls[0][1];
    expect(sanitized.verifiable_claim).toBeUndefined();
    expect(sanitized.password).toBeUndefined();
    expect(sanitized.limit).toBe(10);
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

  it('public actions dispatch via FastData', async () => {
    const [req, params] = makeRequest('GET', 'agents');
    await GET(req, params);

    expect(mockDispatchFastData).toHaveBeenCalledWith(
      'list_agents',
      expect.any(Object),
    );
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('x-payment-key header dispatches authenticated GET to FastData', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      'x-payment-key': 'owner.near:1:secret',
    });
    await GET(req, params);

    // Authenticated GETs go through FastData, not WASM.
    expect(mockDispatchFastData).toHaveBeenCalledTimes(1);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('Authorization: Bearer wk_ dispatches authenticated GET to FastData', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      authorization: 'Bearer wk_test1234abcdef',
    });
    await GET(req, params);

    expect(mockDispatchFastData).toHaveBeenCalledTimes(1);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('x-payment-key takes precedence over Authorization: Bearer', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      'x-payment-key': 'owner.near:1:secret',
      authorization: 'Bearer wk_test1234abcdef',
    });
    await GET(req, params);

    expect(mockDispatchFastData).toHaveBeenCalledTimes(1);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
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
      message: '{"action":"heartbeat"}',
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

  it('rejects register_platforms with verifiable_claim (multi-step needs reusable key)', async () => {
    const claim = {
      near_account_id: 'alice.near',
      public_key: 'ed25519:abc',
      signature: 'ed25519:sig',
      nonce: 'bm9uY2U=',
      message: '{"action":"register_platforms"}',
    };
    const [req, params] = makeRequest('POST', 'agents/me/platforms', {
      verifiable_claim: claim,
    });
    const res = await POST(req, params);
    const body = await json(res);
    expect(res.status).toBe(401);
    expect(body.error).toMatch(/wallet key/i);
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

describe('platform auto-registration on register (background)', () => {
  let marketFetch: ReturnType<typeof setupFetchMock>;

  beforeEach(() => {
    marketFetch = setupFetchMock();
    mockCallOutlayer.mockImplementation(() => {
      const decoded = {
        success: true,
        data: { agent: { handle: 'my_bot' }, near_account_id: 'abc.near' },
      };
      return Promise.resolve({
        response: NextResponse.json(decoded),
        decoded,
      });
    });
  });

  afterEach(() => marketFetch.restore());

  it('returns registration response immediately without platform data', async () => {
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

    // Registration succeeds immediately — platform data is not included
    // (platforms register in the background; use POST /agents/me/platforms
    // to retrieve credentials)
    expect(body.success).toBe(true);
    expect(body.data.market).toBeUndefined();
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

describe('cache invalidation', () => {
  it('caches public read responses', async () => {
    const { setCache } = jest.requireMock('@/lib/cache');

    const [req, params] = makeRequest('GET', 'agents');
    await GET(req, params);

    expect(setCache).toHaveBeenCalledWith(
      'list_agents',
      expect.any(String),
      expect.anything(),
    );
  });

  it('invalidates via INVALIDATION_MAP on heartbeat', async () => {
    const { invalidateForMutation } = jest.requireMock('@/lib/cache');

    const [req, params] = makeRequest(
      'POST',
      'agents/me/heartbeat',
      {},
      { authorization: 'Bearer wk_test' },
    );
    await POST(req, params);

    expect(invalidateForMutation).toHaveBeenCalledWith('heartbeat');
  });

  it('invalidates affected cache entries on follow', async () => {
    const { invalidateForMutation, clearByAction } =
      jest.requireMock('@/lib/cache');

    const [req, params] = makeRequest(
      'POST',
      'agents/alice/follow',
      {},
      { authorization: 'Bearer wk_test' },
    );
    await POST(req, params);

    expect(invalidateForMutation).toHaveBeenCalledWith('follow');
    expect(clearByAction).not.toHaveBeenCalled();
  });
});

describe('direct write dispatch for wk_ keys', () => {
  it.each([
    ['POST', 'agents/alice/follow', 'follow'],
    ['DELETE', 'agents/alice/follow', 'unfollow'],
    ['POST', 'agents/alice/endorse', 'endorse'],
    ['DELETE', 'agents/alice/endorse', 'unendorse'],
    ['PATCH', 'agents/me', 'update_me'],
    ['POST', 'agents/me/heartbeat', 'heartbeat'],
    ['DELETE', 'agents/me', 'deregister'],
  ] as const)('%s %s with wk_ key dispatches to dispatchDirectWrite', async (method, path, expectedAction) => {
    const handlers: Record<string, typeof GET> = { GET, POST, PATCH, DELETE };
    const handler = handlers[method]!;
    const [req, params] = makeRequest(
      method,
      path,
      {},
      {
        authorization: 'Bearer wk_test_key',
      },
    );
    await handler(req, params);

    expect(mockDispatchDirectWrite).toHaveBeenCalledTimes(1);
    expect(mockDispatchDirectWrite.mock.calls[0][0]).toBe(expectedAction);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('payment key still goes through callOutlayer for follow', async () => {
    const [req, params] = makeRequest(
      'POST',
      'agents/alice/follow',
      {},
      { 'x-payment-key': 'owner.near:1:secret' },
    );
    await POST(req, params);

    expect(mockCallOutlayer).toHaveBeenCalledTimes(1);
    expect(mockDispatchDirectWrite).not.toHaveBeenCalled();
  });

  it('verifiable_claim still goes through callOutlayer', async () => {
    const claim = {
      near_account_id: 'alice.near',
      public_key: 'ed25519:abc',
      signature: 'ed25519:sig',
      nonce: 'bm9uY2U=',
      message: '{"action":"heartbeat"}',
      recipient: 'social',
    };
    const [req, params] = makeRequest('POST', 'agents/me/heartbeat', {
      verifiable_claim: claim,
    });
    await POST(req, params);

    expect(mockCallOutlayer).toHaveBeenCalledTimes(1);
    expect(mockDispatchDirectWrite).not.toHaveBeenCalled();
  });

  it('direct write error returns proper HTTP status', async () => {
    mockDispatchDirectWrite.mockResolvedValueOnce({
      success: false,
      error: 'Rate limit exceeded',
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: 60,
    });
    const [req, params] = makeRequest(
      'POST',
      'agents/alice/follow',
      {},
      { authorization: 'Bearer wk_test_key' },
    );
    const res = await POST(req, params);
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.retry_after).toBe(60);
  });

  it('invalidates cache on successful direct write', async () => {
    const { invalidateForMutation } = jest.requireMock('@/lib/cache');
    const [req, params] = makeRequest(
      'POST',
      'agents/alice/follow',
      {},
      { authorization: 'Bearer wk_test_key' },
    );
    await POST(req, params);

    expect(invalidateForMutation).toHaveBeenCalledWith('follow');
  });

  it('register still goes through callOutlayer with wk_ key', async () => {
    const [req, params] = makeRequest(
      'POST',
      'agents/register',
      { handle: 'my_bot' },
      { authorization: 'Bearer wk_test_key' },
    );
    await POST(req, params);

    expect(mockCallOutlayer).toHaveBeenCalledTimes(1);
    expect(mockDispatchDirectWrite).not.toHaveBeenCalled();
  });
});
