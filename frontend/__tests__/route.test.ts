/**
 * @jest-environment node
 */

import { NextRequest } from 'next/server';

const mockCallOutlayer = jest.fn();
const mockSignMessage = jest.fn();
jest.mock('@/lib/outlayer-server', () => ({
  getOutlayerPaymentKey: () => 'pk_test',
  sanitizePublic: jest.requireActual('@/lib/outlayer-server').sanitizePublic,
  callOutlayer: (...args: unknown[]) => mockCallOutlayer(...args),
  mintClaimForWalletKey: jest.fn().mockResolvedValue(null),
  resolveAccountId: jest.fn().mockResolvedValue('test.near'),
  signMessage: (...args: unknown[]) => mockSignMessage(...args),
}));

const mockDispatchFastData = jest.fn();
const mockHandleGetSuggested = jest.fn();
jest.mock('@/lib/fastdata-dispatch', () => ({
  dispatchFastData: (...args: unknown[]) => mockDispatchFastData(...args),
  handleGetSuggested: (...args: unknown[]) => mockHandleGetSuggested(...args),
}));

const mockDispatchWrite = jest.fn();
const mockWriteToFastData = jest.fn().mockResolvedValue({ ok: true });
jest.mock('@/lib/fastdata-write', () => ({
  dispatchWrite: (...args: unknown[]) => mockDispatchWrite(...args),
  writeToFastData: (...args: unknown[]) => mockWriteToFastData(...args),
  invalidatesFor: jest.fn().mockReturnValue(['hidden']),
}));

const mockKvGetAgent = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/fastdata', () => ({
  kvGetAgent: (...args: unknown[]) => mockKvGetAgent(...args),
}));

const mockGetHiddenSet = jest.fn().mockResolvedValue(new Set<string>());
jest.mock('@/lib/fastdata-utils', () => ({
  ...jest.requireActual('@/lib/fastdata-utils'),
  getHiddenSet: (...args: unknown[]) => mockGetHiddenSet(...args),
}));

jest.mock('@/lib/constants', () => ({
  ...jest.requireActual('@/lib/constants'),
  OUTLAYER_ADMIN_ACCOUNT: 'admin.near',
}));

jest.mock('@/lib/cache', () => ({
  getCached: jest.fn().mockReturnValue(undefined),
  setCache: jest.fn(),
  invalidateForMutation: jest.fn(),
  makeCacheKey: jest.fn((body: Record<string, unknown>) =>
    JSON.stringify(body),
  ),
}));

const mockCheckRateLimit = jest.fn().mockReturnValue({ ok: true });
const mockIncrementRateLimit = jest.fn();
jest.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  incrementRateLimit: (...args: unknown[]) => mockIncrementRateLimit(...args),
  checkRateLimitBudget: jest
    .fn()
    .mockReturnValue({ ok: true, remaining: Number.POSITIVE_INFINITY }),
}));

import { NextResponse } from 'next/server';
import { DELETE, GET, PATCH, POST } from '../src/app/api/v1/[...path]/route';

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
  mockCallOutlayer.mockResolvedValue({
    response: NextResponse.json({ success: true, data: {} }),
    decoded: { success: true, data: {} },
  });
  mockDispatchFastData.mockResolvedValue({ data: {} });
  mockHandleGetSuggested.mockResolvedValue({ data: [] });
  mockDispatchWrite.mockResolvedValue({
    success: true,
    data: {},
    invalidates: ['list_agents', 'profile'],
  });
  mockSignMessage.mockResolvedValue(null);
  // Authenticated GETs resolve caller account via resolveAccountId.
  // For tests that use wk_ keys, mock kvGetAgent to return a profile.
  mockKvGetAgent.mockResolvedValue('test_agent');
  // Rate limit defaults to pass-through; individual tests can override
  // via `mockReturnValueOnce` to simulate a 429.
  mockCheckRateLimit.mockReturnValue({ ok: true });
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
      extra: { nested: 'object' },
      limit: [1, 2, 3],
    });
    expect(result.action).toBe('list_agents');
    expect(result.extra).toBeUndefined();
    expect(result.limit).toBeUndefined();
  });

  it('passes through fields whitelisted for the action', () => {
    const input = {
      action: 'list_agents',
      limit: 10,
      cursor: 'abc',
      sort: 'newest',
    };
    expect(sanitizePublic(input)).toEqual(input);
  });

  it('strips fields not whitelisted for the action', () => {
    const result = sanitizePublic({
      action: 'list_agents',
      account_id: 'alice.near',
      direction: 'outgoing',
      since: 1700000000,
    });
    expect(result.account_id).toBe('alice.near');
    expect(result.direction).toBeUndefined();
    expect(result.since).toBeUndefined();
  });
});

describe('route resolution', () => {
  it.each([
    ['GET', 'health', 'health'],
    ['GET', 'tags', 'list_tags'],
    ['GET', 'agents', 'list_agents'],
    ['GET', 'agents/discover', 'discover_agents'],
    ['GET', 'agents/me', 'me'],
    ['PATCH', 'agents/me', 'update_me'],
    ['POST', 'agents/me/heartbeat', 'heartbeat'],
    ['GET', 'agents/me/activity', 'activity'],
    ['GET', 'agents/me/network', 'network'],
    ['GET', 'agents/alice.near', 'profile'],
    ['POST', 'agents/alice.near/follow', 'follow'],
    ['DELETE', 'agents/alice.near/follow', 'unfollow'],
    ['GET', 'agents/alice.near/followers', 'followers'],
    ['GET', 'agents/alice.near/following', 'following'],
    ['GET', 'agents/alice.near/edges', 'edges'],
    ['POST', 'agents/alice.near/endorse', 'endorse'],
    ['DELETE', 'agents/alice.near/endorse', 'unendorse'],
    ['GET', 'agents/alice.near/endorsers', 'endorsers'],
  ])('%s %s → %s', async (method: string, path: string, expectedAction: string) => {
    const handlers: Record<string, typeof GET> = { GET, POST, PATCH, DELETE };
    const handler = handlers[method]!;
    const headers: Record<string, string> = {};

    const { PUBLIC_ACTIONS } = jest.requireActual('@/lib/routes') as {
      PUBLIC_ACTIONS: Set<string>;
    };
    const isPublic = PUBLIC_ACTIONS.has(expectedAction);
    if (!isPublic) {
      headers.authorization = 'Bearer wk_test';
    }

    const [req, params] = makeRequest(method, path, undefined, headers);
    await handler(req, params);

    const DIRECT_WRITE_ACTIONS = new Set([
      'follow',
      'unfollow',
      'endorse',
      'unendorse',
      'update_me',
      'heartbeat',
      'delist_me',
    ]);

    if (expectedAction === 'discover_agents') {
      // discover_agents uses handleGetSuggested, not dispatchFastData.
      expect(mockHandleGetSuggested).toHaveBeenCalledTimes(1);
    } else if (isPublic || method === 'GET') {
      // Public reads and authenticated GETs both go through FastData.
      expect(mockDispatchFastData).toHaveBeenCalledTimes(1);
      expect(mockDispatchFastData.mock.calls[0][0]).toBe(expectedAction);
    } else if (DIRECT_WRITE_ACTIONS.has(expectedAction)) {
      expect(mockDispatchWrite).toHaveBeenCalledTimes(1);
      expect(mockDispatchWrite.mock.calls[0][0]).toBe(expectedAction);
      expect(mockCallOutlayer).not.toHaveBeenCalled();
    }
    // Other POST actions (e.g. register_platforms) are handled by
    // dedicated proxy paths, not callOutlayer.
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

  it('rejects unsupported sort values with 400', async () => {
    const [req, params] = makeRequest('GET', 'agents?sort=followers');
    const res = await GET(req, params);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toContain('Invalid sort');
    expect(mockDispatchFastData).not.toHaveBeenCalled();
  });
});

describe('profile caller context', () => {
  it('anonymous profile read does not set caller_account_id', async () => {
    const [req, params] = makeRequest('GET', 'agents/alice.near');
    await GET(req, params);

    expect(mockDispatchFastData).toHaveBeenCalledTimes(1);
    const [action, body] = mockDispatchFastData.mock.calls[0];
    expect(action).toBe('profile');
    expect(body.account_id).toBe('alice.near');
    expect(body.caller_account_id).toBeUndefined();
  });

  it('authenticated profile read resolves caller and passes caller_account_id', async () => {
    const [req, params] = makeRequest('GET', 'agents/alice.near', undefined, {
      authorization: 'Bearer wk_test',
    });
    await GET(req, params);

    expect(mockDispatchFastData).toHaveBeenCalledTimes(1);
    const [action, body] = mockDispatchFastData.mock.calls[0];
    expect(action).toBe('profile');
    expect(body.account_id).toBe('alice.near');
    expect(body.caller_account_id).toBe('test.near');
  });

  it('returns 401 when bearer token cannot be resolved', async () => {
    const { resolveAccountId } = jest.requireMock('@/lib/outlayer-server');
    (resolveAccountId as jest.Mock).mockResolvedValueOnce(null);

    const [req, params] = makeRequest('GET', 'agents/alice.near', undefined, {
      authorization: 'Bearer wk_bogus',
    });
    const res = await GET(req, params);

    expect(res.status).toBe(401);
    expect(mockDispatchFastData).not.toHaveBeenCalled();
  });

  it('anonymous profile read still writes to the cache', async () => {
    const { setCache } = jest.requireMock('@/lib/cache');

    const [req, params] = makeRequest('GET', 'agents/alice.near');
    await GET(req, params);

    expect(setCache).toHaveBeenCalledWith(
      'profile',
      expect.any(String),
      expect.anything(),
    );
  });

  it('authenticated profile read skips the cache', async () => {
    const { setCache, getCached } = jest.requireMock('@/lib/cache');

    const [req, params] = makeRequest('GET', 'agents/alice.near', undefined, {
      authorization: 'Bearer wk_test',
    });
    await GET(req, params);

    expect(getCached).not.toHaveBeenCalled();
    expect(setCache).not.toHaveBeenCalled();
  });
});

describe('injection prevention', () => {
  it('route params override body action to prevent action injection', async () => {
    const [req, params] = makeRequest(
      'POST',
      'agents/alice.near/follow',
      { action: 'delist_me' },
      { authorization: 'Bearer wk_test' },
    );
    await POST(req, params);

    // Even though body.action was 'delist_me', the route resolved to 'follow'
    // and dispatchWrite was called with the follow action.
    expect(mockDispatchWrite).toHaveBeenCalledTimes(1);
    expect(mockDispatchWrite.mock.calls[0][0]).toBe('follow');
  });

  it('route params override body account_id to prevent injection', async () => {
    const [req, params] = makeRequest(
      'POST',
      'agents/alice.near/follow',
      { account_id: 'mallory.near' },
      { authorization: 'Bearer wk_test' },
    );
    await POST(req, params);

    expect(mockDispatchWrite).toHaveBeenCalledTimes(1);
    expect(mockDispatchWrite.mock.calls[0][1].account_id).toBe('alice.near');
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
    const cachedData = {
      success: true,
      data: [{ account_id: 'cached_bot.near' }],
    };
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

  it('Authorization: Bearer wk_ dispatches authenticated GET to FastData', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      authorization: 'Bearer wk_test1234abcdef',
    });
    await GET(req, params);

    expect(mockDispatchFastData).toHaveBeenCalledTimes(1);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('ignores non-wk_ and non-near: bearer tokens', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      authorization: 'Bearer some_other_token',
    });
    const res = await GET(req, params);
    expect(res.status).toBe(401);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('Bearer near: token dispatches authenticated GET to FastData', async () => {
    const token = Buffer.from(
      JSON.stringify({
        account_id: 'test.near',
        seed: 'my-seed',
        pubkey: 'ed25519:abc',
        timestamp: Date.now(),
        signature: 'sig',
      }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      authorization: `Bearer near:${token}`,
    });
    await GET(req, params);

    expect(mockDispatchFastData).toHaveBeenCalledTimes(1);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('Bearer near: token does NOT dispatch direct writes (wk_-only for mutations)', async () => {
    const token = Buffer.from(
      JSON.stringify({
        account_id: 'test.near',
        seed: 'my-seed',
        pubkey: 'ed25519:abc',
        timestamp: Date.now(),
        signature: 'sig',
      }),
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const [req, params] = makeRequest(
      'POST',
      'agents/alice.near/follow',
      {},
      { authorization: `Bearer near:${token}` },
    );
    const res = await POST(req, params);

    // near: tokens are not accepted for mutations — FastData writes require wk_
    expect(mockDispatchWrite).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it('rejects malformed near: token', async () => {
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      authorization: 'Bearer near:not-valid-base64!!!',
    });
    const res = await GET(req, params);
    expect(res.status).toBe(401);
  });

  it('verifiable_claim without wk_ key returns 401 for non-register mutations', async () => {
    const claim = {
      account_id: 'alice.near',
      public_key: 'ed25519:abc',
      signature: 'ed25519:sig',
      nonce: 'bm9uY2U=',
      message: '{"action":"heartbeat"}',
      recipient: 'social',
    };
    const [req, params] = makeRequest('POST', 'agents/me/heartbeat', {
      verifiable_claim: claim,
    });
    const res = await POST(req, params);
    expect(res.status).toBe(401);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('rejects register_platforms with verifiable_claim (requires wk_ key)', async () => {
    const claim = {
      account_id: 'alice.near',
      public_key: 'ed25519:abc',
      signature: 'ed25519:sig',
      nonce: 'bm9uY2U=',
      message: '{"action":"register_platforms"}',
    };
    const [req, params] = makeRequest('POST', 'agents/me/platforms', {
      verifiable_claim: claim,
    });
    const res = await POST(req, params);
    expect(res.status).toBe(401);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('returns 401 when no auth provided for private action', async () => {
    const [req, params] = makeRequest('GET', 'agents/me');
    const res = await GET(req, params);
    expect(res.status).toBe(401);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });
});

describe('error handling', () => {
  it('returns 413 for oversized request body', async () => {
    const largeBody = 'x'.repeat(65_537);
    const url = 'http://localhost:3000/api/v1/agents/me/heartbeat';
    const req = new NextRequest(url, {
      method: 'POST',
      body: largeBody,
      headers: {
        authorization: 'Bearer wk_test_key',
        'content-type': 'application/json',
      },
    });
    const params = {
      params: Promise.resolve({ path: ['agents', 'me', 'heartbeat'] }),
    };
    const res = await POST(req, params);
    expect(res.status).toBe(413);
    const body = await json(res);
    expect(body.error).toContain('too large');
  });

  it('returns 400 for invalid JSON body', async () => {
    const url = 'http://localhost:3000/api/v1/agents/me/heartbeat';
    const req = new NextRequest(url, {
      method: 'POST',
      body: 'not json{{{',
      headers: {
        authorization: 'Bearer wk_test_key',
        'content-type': 'application/json',
      },
    });
    const params = {
      params: Promise.resolve({ path: ['agents', 'me', 'heartbeat'] }),
    };
    const res = await POST(req, params);
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toContain('Invalid JSON');
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

  it('invalidates cache on heartbeat', async () => {
    const { invalidateForMutation } = jest.requireMock('@/lib/cache');

    const [req, params] = makeRequest(
      'POST',
      'agents/me/heartbeat',
      {},
      { authorization: 'Bearer wk_test' },
    );
    await POST(req, params);

    expect(invalidateForMutation).toHaveBeenCalledWith(
      expect.arrayContaining(['list_agents', 'profile']),
    );
  });
});

describe('direct write dispatch for wk_ keys', () => {
  it.each([
    ['POST', 'agents/alice.near/follow', 'follow'],
    ['DELETE', 'agents/alice.near/follow', 'unfollow'],
    ['POST', 'agents/alice/endorse', 'endorse'],
    ['DELETE', 'agents/alice/endorse', 'unendorse'],
    ['PATCH', 'agents/me', 'update_me'],
    ['POST', 'agents/me/heartbeat', 'heartbeat'],
    ['DELETE', 'agents/me', 'delist_me'],
  ] as const)('%s %s with wk_ key dispatches to dispatchWrite', async (method, path, expectedAction) => {
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

    expect(mockDispatchWrite).toHaveBeenCalledTimes(1);
    expect(mockDispatchWrite.mock.calls[0][0]).toBe(expectedAction);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
  });

  it('x-payment-key without wk_ returns 401 for follow', async () => {
    const [req, params] = makeRequest(
      'POST',
      'agents/alice.near/follow',
      {},
      { 'x-payment-key': 'owner.near:1:secret' },
    );
    const res = await POST(req, params);

    expect(res.status).toBe(401);
    expect(mockCallOutlayer).not.toHaveBeenCalled();
    expect(mockDispatchWrite).not.toHaveBeenCalled();
  });

  it('direct write error returns proper HTTP status', async () => {
    mockDispatchWrite.mockResolvedValueOnce({
      success: false,
      error: 'Rate limit exceeded',
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: 60,
    });
    const [req, params] = makeRequest(
      'POST',
      'agents/alice.near/follow',
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
      'agents/alice.near/follow',
      {},
      { authorization: 'Bearer wk_test_key' },
    );
    await POST(req, params);

    expect(invalidateForMutation).toHaveBeenCalledWith(
      expect.arrayContaining(['list_agents', 'profile']),
    );
  });
});

describe('admin /admin/hidden', () => {
  const mockResolveAccountId = jest.requireMock('@/lib/outlayer-server')
    .resolveAccountId as jest.Mock;

  // Default every admin-path call to "caller is admin" so tests that issue
  // multiple writes don't silently fall back to the outer test.near default
  // and hit a 403 on the second call. Individual tests override via
  // `mockResolvedValueOnce` when they need a non-admin caller.
  beforeEach(() => {
    mockResolveAccountId.mockResolvedValue('admin.near');
  });

  describe('GET /admin/hidden (public)', () => {
    it('returns the hidden set as an array', async () => {
      mockGetHiddenSet.mockResolvedValueOnce(
        new Set(['spam.near', 'bot.near']),
      );
      const [req, params] = makeRequest('GET', 'admin/hidden');
      const res = await GET(req, params);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.success).toBe(true);
      expect(body.data.hidden).toEqual(
        expect.arrayContaining(['spam.near', 'bot.near']),
      );
      expect(body.data.hidden).toHaveLength(2);
    });

    it('returns an empty array when nothing is hidden', async () => {
      mockGetHiddenSet.mockResolvedValueOnce(new Set());
      const [req, params] = makeRequest('GET', 'admin/hidden');
      const res = await GET(req, params);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.hidden).toEqual([]);
    });

    it('does not require authentication', async () => {
      mockGetHiddenSet.mockResolvedValueOnce(new Set());
      const [req, params] = makeRequest('GET', 'admin/hidden');
      const res = await GET(req, params);
      expect(res.status).toBe(200);
    });

    it('returns 429 with Retry-After header when rate-limited', async () => {
      mockCheckRateLimit.mockReturnValueOnce({ ok: false, retryAfter: 42 });
      const [req, params] = makeRequest('GET', 'admin/hidden');
      const res = await GET(req, params);
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('42');
      // The rate-limit check must happen before the upstream read, not
      // after — 429s should do zero work.
      expect(mockGetHiddenSet).not.toHaveBeenCalled();
      expect(mockIncrementRateLimit).not.toHaveBeenCalled();
    });
  });

  describe('POST /admin/hidden/{accountId} (admin auth)', () => {
    it('hides an agent when admin wk_ key is provided', async () => {
      const [req, params] = makeRequest(
        'POST',
        'admin/hidden/spam.near',
        undefined,
        { authorization: 'Bearer wk_admin_test' },
      );
      const res = await POST(req, params);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.action).toBe('hidden');
      expect(body.data.account_id).toBe('spam.near');
      expect(mockWriteToFastData).toHaveBeenCalledWith(
        'wk_admin_test',
        expect.objectContaining({
          'hidden/spam.near': expect.objectContaining({
            at: expect.any(Number),
          }),
        }),
      );
    });

    it('hides two agents back-to-back in one test (regression: mockResolvedValue stickiness)', async () => {
      const [req1, params1] = makeRequest(
        'POST',
        'admin/hidden/spam1.near',
        undefined,
        { authorization: 'Bearer wk_admin_test' },
      );
      const res1 = await POST(req1, params1);
      expect(res1.status).toBe(200);

      const [req2, params2] = makeRequest(
        'POST',
        'admin/hidden/spam2.near',
        undefined,
        { authorization: 'Bearer wk_admin_test' },
      );
      const res2 = await POST(req2, params2);
      expect(res2.status).toBe(200);

      expect(mockWriteToFastData).toHaveBeenCalledTimes(2);
    });

    it('rejects writes without auth', async () => {
      const [req, params] = makeRequest('POST', 'admin/hidden/spam.near');
      const res = await POST(req, params);
      expect(res.status).toBe(401);
      expect(mockWriteToFastData).not.toHaveBeenCalled();
    });

    it('rejects writes from non-admin wk_ keys', async () => {
      mockResolveAccountId.mockResolvedValueOnce('not-admin.near');
      const [req, params] = makeRequest(
        'POST',
        'admin/hidden/spam.near',
        undefined,
        { authorization: 'Bearer wk_user_test' },
      );
      const res = await POST(req, params);
      expect(res.status).toBe(403);
      expect(mockWriteToFastData).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /admin/hidden/{accountId} (admin auth)', () => {
    it('unhides an agent when admin wk_ key is provided', async () => {
      const [req, params] = makeRequest(
        'DELETE',
        'admin/hidden/spam.near',
        undefined,
        { authorization: 'Bearer wk_admin_test' },
      );
      const res = await DELETE(req, params);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.action).toBe('unhidden');
      expect(body.data.account_id).toBe('spam.near');
      expect(mockWriteToFastData).toHaveBeenCalledWith(
        'wk_admin_test',
        expect.objectContaining({
          'hidden/spam.near': null,
        }),
      );
    });
  });

  describe('unknown admin paths', () => {
    it('returns 404 for unknown authed admin subpaths', async () => {
      const [req, params] = makeRequest(
        'POST',
        'admin/unknown/action',
        undefined,
        { authorization: 'Bearer wk_admin_test' },
      );
      const res = await POST(req, params);
      expect(res.status).toBe(404);
    });

    it('404s a write to /admin/hidden without an account id', async () => {
      const [req, params] = makeRequest('POST', 'admin/hidden', undefined, {
        authorization: 'Bearer wk_admin_test',
      });
      const res = await POST(req, params);
      expect(res.status).toBe(404);
    });
  });
});
