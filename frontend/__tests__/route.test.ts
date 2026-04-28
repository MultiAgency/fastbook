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
  signClaimForWalletKey: jest.fn().mockResolvedValue(null),
  resolveAccountId: jest.fn().mockResolvedValue('test.near'),
  signMessage: (...args: unknown[]) => mockSignMessage(...args),
}));
jest.mock('@/lib/admin-near-token', () => ({
  buildAdminNearToken: () => 'near:mock_admin_token',
  resolveAdminWriterAccount: jest
    .fn()
    .mockResolvedValue(
      '68becf62560bb051ab3950310df70c29d0e80c6fb7cacd90f3dce8c2eff4779e',
    ),
}));

const mockDispatchFastData = jest.fn();
const mockHandleGetSuggested = jest.fn();
jest.mock('@/lib/fastdata/reads', () => ({
  dispatchFastData: (...args: unknown[]) => mockDispatchFastData(...args),
  handleGetSuggested: (...args: unknown[]) => mockHandleGetSuggested(...args),
}));

const mockDispatchWrite = jest.fn();
const mockWriteToFastData = jest.fn().mockResolvedValue({ ok: true });
jest.mock('@/lib/fastdata/writes', () => ({
  dispatchWrite: (...args: unknown[]) => mockDispatchWrite(...args),
  writeToFastData: (...args: unknown[]) => mockWriteToFastData(...args),
  INVALIDATION_MAP: { hide_agent: ['hidden'], unhide_agent: ['hidden'] },
}));

const mockKvGetAgent = jest.fn().mockResolvedValue(null);
jest.mock('@/lib/fastdata/client', () => ({
  kvGetAgent: (...args: unknown[]) => mockKvGetAgent(...args),
  kvGetAgentFirstWrite: jest.fn().mockResolvedValue(null),
}));

const mockGetHiddenSet = jest.fn().mockResolvedValue(new Set<string>());
jest.mock('@/lib/fastdata/utils', () => ({
  ...jest.requireActual('@/lib/fastdata/utils'),
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

const mockCheckGenerateBudget = jest
  .fn()
  .mockReturnValue({ ok: true, window: 0 });
const mockIncrementGenerateBudget = jest.fn();
jest.mock('@/lib/budget', () => ({
  checkGenerateBudget: (...args: unknown[]) => mockCheckGenerateBudget(...args),
  incrementGenerateBudget: (...args: unknown[]) =>
    mockIncrementGenerateBudget(...args),
}));

// Default `isGenerateConfigured` to false so `dispatchGenerate` /
// `dispatchGenerateReason` early-return 503 NOT_CONFIGURED instead of
// hitting a real LLM API. Individual tests can flip this with
// `mockIsGenerateConfigured.mockReturnValueOnce(true)` and then provide
// `mockGenerate*` resolutions to exercise the success path.
const mockIsGenerateConfigured = jest.fn().mockReturnValue(false);
const mockGenerateProfileField = jest.fn();
const mockGenerateFollowReason = jest.fn();
const mockGenerateEndorseReason = jest.fn();
jest.mock('@/lib/llm-server', () => ({
  GENERATE_FIELDS: ['name', 'description', 'tags', 'capabilities', 'image'],
  isGenerateConfigured: () => mockIsGenerateConfigured(),
  generateProfileField: (...args: unknown[]) =>
    mockGenerateProfileField(...args),
  generateFollowReason: (...args: unknown[]) =>
    mockGenerateFollowReason(...args),
  generateEndorseReason: (...args: unknown[]) =>
    mockGenerateEndorseReason(...args),
}));

import { NextResponse } from 'next/server';
import type { ActionName } from '@/lib/routes';
import {
  BUDGET_GATED_ACTIONS,
  DELETE,
  FASTDATA_WRITE_ACTIONS,
  GET,
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
  // kvGetAgent now returns a KvEntry (post trust-boundary unification) —
  // any truthy value would pass existence checks, but keep the mock shape
  // honest so future tests that read `.value` or `.predecessor_id` don't
  // silently get undefined.
  mockKvGetAgent.mockResolvedValue({
    predecessor_id: 'test.near',
    current_account_id: 'contextual.near',
    block_height: 1,
    block_timestamp: 1_700_000_000_000_000_000,
    key: 'profile',
    value: { account_id: 'test.near' },
  });
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
    ['PATCH', 'agents/me/profile', 'social.profile'],
    ['POST', 'agents/me/heartbeat', 'social.heartbeat'],
    ['GET', 'agents/me/activity', 'activity'],
    ['GET', 'agents/me/network', 'network'],
    ['GET', 'agents/alice.near', 'profile'],
    ['POST', 'agents/alice.near/follow', 'social.follow'],
    ['POST', 'agents/alice.near/follow/generate', 'generate.follow'],
    ['DELETE', 'agents/alice.near/follow', 'social.unfollow'],
    ['GET', 'agents/alice.near/followers', 'followers'],
    ['GET', 'agents/alice.near/following', 'following'],
    ['GET', 'agents/alice.near/edges', 'edges'],
    ['POST', 'agents/alice.near/endorse', 'social.endorse'],
    ['POST', 'agents/alice.near/endorse/generate', 'generate.endorse'],
    ['DELETE', 'agents/alice.near/endorse', 'social.unendorse'],
    ['GET', 'agents/alice.near/endorsers', 'endorsers'],
    ['GET', 'agents/alice.near/endorsing', 'endorsing'],
  ])('%s %s → %s', async (method: string, path: string, expectedAction: string) => {
    const handlers: Record<string, typeof GET> = { GET, POST, PATCH, DELETE };
    const handler = handlers[method]!;
    const headers: Record<string, string> = {};

    const { PUBLIC_ACTIONS } = jest.requireActual('@/lib/routes') as {
      PUBLIC_ACTIONS: Set<ActionName>;
    };
    const isPublic = PUBLIC_ACTIONS.has(expectedAction as ActionName);
    if (!isPublic) {
      headers.authorization = 'Bearer wk_test';
    }

    const [req, params] = makeRequest(method, path, undefined, headers);
    await handler(req, params);

    if (expectedAction === 'discover_agents') {
      // discover_agents uses handleGetSuggested, not dispatchFastData.
      expect(mockHandleGetSuggested).toHaveBeenCalledTimes(1);
    } else if (isPublic || method === 'GET') {
      // Public reads and authenticated GETs both go through FastData.
      expect(mockDispatchFastData).toHaveBeenCalledTimes(1);
      expect(mockDispatchFastData.mock.calls[0][0]).toBe(expectedAction);
    } else if (BUDGET_GATED_ACTIONS.has(expectedAction as ActionName)) {
      // Budget-gated LLM calls early-return 503 NOT_CONFIGURED with
      // mockIsGenerateConfigured defaulting to false; they don't reach
      // mockDispatchWrite (or any FastData path).
      expect(mockDispatchWrite).not.toHaveBeenCalled();
      expect(mockDispatchFastData).not.toHaveBeenCalled();
    } else if (FASTDATA_WRITE_ACTIONS.has(expectedAction as ActionName)) {
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

  it('passes cursor as validated string for the activity delta query', async () => {
    // Step 4 of the wall-clock → block-height transition: the activity
    // endpoint's cursor is now a block_height, not a seconds-valued
    // `since`. `CURSOR_RE` accepts numeric-string cursors (up to 20
    // digits), so the raw query param arrives at dispatch as a string
    // and `handleGetActivity` parses it into an integer. The legacy
    // `since` parameter is gone from both the route table and the
    // extractQueryParams branches.
    const [req, params] = makeRequest(
      'GET',
      'agents/me/activity?cursor=1700000000',
      undefined,
      {
        authorization: 'Bearer wk_test',
      },
    );
    await GET(req, params);

    const fdBody = mockDispatchFastData.mock.calls[0][1];
    expect(fdBody.cursor).toBe('1700000000');
    expect(fdBody.since).toBeUndefined();
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

  it('rejects non-parseable integer params with 400', async () => {
    const [req, params] = makeRequest('GET', 'agents?limit=abc');
    const res = await GET(req, params);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(mockDispatchFastData).not.toHaveBeenCalled();
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

  it('rejects tag values that fail the regex with 400', async () => {
    const [req, params] = makeRequest('GET', 'agents?tag=FOO!');
    const res = await GET(req, params);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(mockDispatchFastData).not.toHaveBeenCalled();
  });

  it('rejects cursor values that fail the format check with 400', async () => {
    const [req, params] = makeRequest(
      'GET',
      'agents/me/activity?cursor=not%20a%20cursor',
      undefined,
      { authorization: 'Bearer wk_test' },
    );
    const res = await GET(req, params);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION_ERROR');
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
      { action: 'social.delist_me' },
      { authorization: 'Bearer wk_test' },
    );
    await POST(req, params);

    // Even though body.action was 'social.delist_me', the route resolved to
    // 'social.follow' and dispatchWrite was called with the follow action.
    expect(mockDispatchWrite).toHaveBeenCalledTimes(1);
    expect(mockDispatchWrite.mock.calls[0][0]).toBe('social.follow');
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
    const rawData = [{ account_id: 'cached_bot.near' }];
    (getCached as jest.Mock).mockReturnValueOnce(rawData);

    const [req, params] = makeRequest('GET', 'agents');
    const res = await GET(req, params);
    const body = await json(res);

    expect(body).toEqual({ success: true, data: rawData });
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

  // Sample BUDGET_GATED_ACTIONS paths and prove `Bearer near:` is now
  // accepted (post-rate-budget lift). Dispatch reaches the LLM-config
  // check inside `dispatchGenerate` / `dispatchGenerateReason` — with
  // `mockIsGenerateConfigured` defaulting to false, the response is 503
  // NOT_CONFIGURED rather than the old 401 AUTH_REQUIRED. The 503 is
  // proof that the bearer cleared the route-level gate.
  it.each([
    [
      'POST',
      'agents/me/profile/generate',
      { field: 'name', current: {} } as Record<string, unknown> | undefined,
    ],
    [
      'POST',
      'agents/alice.near/follow/generate',
      undefined as Record<string, unknown> | undefined,
    ],
    [
      'POST',
      'agents/alice.near/endorse/generate',
      undefined as Record<string, unknown> | undefined,
    ],
  ])('Bearer near: token accepted for %s %s (budget-gated LLM)', async (method, path, body) => {
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

    const handlers: Record<string, typeof GET> = {
      GET,
      POST,
      PATCH,
      DELETE,
    };
    const handler = handlers[method]!;
    const [req, params] = makeRequest(method, path, body, {
      authorization: `Bearer near:${token}`,
    });
    const res = await handler(req, params);

    expect(res.status).toBe(503);
    expect(mockIsGenerateConfigured).toHaveBeenCalled();
    expect(mockDispatchWrite).not.toHaveBeenCalled();
  });

  // Budget-branch pin (I7 at integration level): when the daily budget
  // is exhausted, the response is BUDGET_EXHAUSTED 429 (distinct from
  // RATE_LIMITED), retry_after is the seconds-until-rollover, and the
  // upstream LLM was NOT called. Pairs with `budget.test.ts` unit
  // coverage of the primitive itself.
  it('returns BUDGET_EXHAUSTED 429 when generate budget is exhausted', async () => {
    mockIsGenerateConfigured.mockReturnValueOnce(true);
    mockCheckGenerateBudget.mockReturnValueOnce({
      ok: false,
      retryAfter: 7200,
      scope: 'caller',
    });
    const [req, params] = makeRequest(
      'POST',
      'agents/me/profile/generate',
      { field: 'name', current: {} },
      { authorization: 'Bearer wk_test' },
    );
    const res = await POST(req, params);

    expect(res.status).toBe(429);
    const body = (await json(res)) as {
      code: string;
      retry_after?: number;
    };
    expect(body.code).toBe('BUDGET_EXHAUSTED');
    expect(body.code).not.toBe('RATE_LIMITED');
    expect(body.retry_after).toBe(7200);
    expect(mockGenerateProfileField).not.toHaveBeenCalled();
    expect(mockIncrementGenerateBudget).not.toHaveBeenCalled();
  });

  // Inverse of the rejection symmetry-pin: sample FASTDATA_WRITE_ACTIONS
  // and prove `Bearer near:` is accepted (dispatchWrite is invoked rather
  // than 401-rejecting at the boundary). Without this, a future regression
  // that re-tightens the gate would pass the symmetry test silently —
  // the pass-list shrunk, but no test exercised the new acceptance path.
  it.each([
    ['POST', 'agents/alice.near/follow', undefined],
    ['POST', 'agents/me/heartbeat', undefined],
    ['DELETE', 'agents/alice.near/follow', undefined],
  ])('Bearer near: token accepted for %s %s (FastData write)', async (method, path, body) => {
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

    const handlers: Record<string, typeof GET> = {
      GET,
      POST,
      PATCH,
      DELETE,
    };
    const handler = handlers[method]!;
    const [req, params] = makeRequest(method, path, body, {
      authorization: `Bearer near:${token}`,
    });
    await handler(req, params);

    expect(mockDispatchWrite).toHaveBeenCalled();
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

describe('serverFeatures per-caller honesty gate', () => {
  // Post-budget-lift, generate.* accepts both wk_ and near: bearers
  // (subject to checkGenerateBudget). /agents/me's `features.generate`
  // reflects that: valid bearer + isGenerateConfigured → true; otherwise
  // false. Anonymous /me requests 401 before reaching serverFeatures, so
  // that branch is covered by the auth-required test, not here.

  function nearToken(accountId: string): string {
    return `near:${Buffer.from(JSON.stringify({ account_id: accountId, seed: 's' })).toString('base64url')}`;
  }

  beforeEach(() => {
    mockDispatchFastData.mockResolvedValue({ data: { agent: {} } });
  });

  // mockIsGenerateConfigured default is false — `configured: true` rows
  // override per-test; `configured: false` rows let the default ride.
  it.each([
    { bearer: 'wk_', configured: true, expected: true },
    { bearer: 'near:', configured: true, expected: true },
    { bearer: 'wk_', configured: false, expected: false },
    { bearer: 'near:', configured: false, expected: false },
  ])('$bearer caller with generate configured=$configured: features.generate=$expected', async ({
    bearer,
    configured,
    expected,
  }) => {
    if (configured) mockIsGenerateConfigured.mockReturnValueOnce(true);
    const auth =
      bearer === 'wk_'
        ? 'Bearer wk_test1234abcdef'
        : `Bearer ${nearToken('test.near')}`;
    const [req, params] = makeRequest('GET', 'agents/me', undefined, {
      authorization: auth,
    });
    const res = await GET(req, params);
    const body = await json(res);
    expect(body.data.features).toEqual({ generate: expected });
  });
});

describe('direct write dispatch for wk_ keys', () => {
  it.each([
    ['POST', 'agents/alice.near/follow', 'social.follow'],
    ['DELETE', 'agents/alice.near/follow', 'social.unfollow'],
    ['POST', 'agents/alice/endorse', 'social.endorse'],
    ['DELETE', 'agents/alice/endorse', 'social.unendorse'],
    ['PATCH', 'agents/me/profile', 'social.profile'],
    ['POST', 'agents/me/heartbeat', 'social.heartbeat'],
    ['DELETE', 'agents/me', 'social.delist_me'],
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
          'hidden/spam.near': true,
        }),
      );
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

    // Regression: near: admin auth must round-trip through resolveAccountId
    // (OutLayer verifies signature + ±30s timestamp) rather than trusting
    // the decoded payload. A forged token with OUTLAYER_ADMIN_ACCOUNT in
    // the payload but no valid signature would pass a local-decode check
    // and let Nearly re-sign the write with its own admin key.
    it('rejects forged near: admin tokens (resolveAccountId returns null)', async () => {
      mockResolveAccountId.mockResolvedValueOnce(null);
      const forgedPayload = Buffer.from(
        JSON.stringify({ account_id: 'admin.near', seed: 'forged' }),
      ).toString('base64url');
      const [req, params] = makeRequest(
        'POST',
        'admin/hidden/spam.near',
        undefined,
        { authorization: `Bearer near:${forgedPayload}` },
      );
      const res = await POST(req, params);
      expect(res.status).toBe(403);
      expect(mockWriteToFastData).not.toHaveBeenCalled();
      // Pin: the near: path must go through resolveAccountId, not a
      // local decode. If someone reverts this, the mock is never called
      // with the forged token and this assertion fails.
      expect(mockResolveAccountId).toHaveBeenCalledWith(
        `near:${forgedPayload}`,
      );
    });

    // Happy-path companion to the forged-token rejection above: when
    // OutLayer accepts the near: token and resolves it to the admin
    // account, the write must execute. Pins that nearMatch actually
    // routes through to writeToFastData, not just that the branch
    // rejects forgeries. The walletKey handed to writeToFastData is
    // Nearly's own server-signed admin token (`buildAdminNearToken()`,
    // mocked to 'near:mock_admin_token'), not the caller's token.
    it('hides an agent when a valid near: admin token resolves to OUTLAYER_ADMIN_ACCOUNT', async () => {
      const validPayload = Buffer.from(
        JSON.stringify({ account_id: 'admin.near', seed: 'valid' }),
      ).toString('base64url');
      const [req, params] = makeRequest(
        'POST',
        'admin/hidden/spam.near',
        undefined,
        { authorization: `Bearer near:${validPayload}` },
      );
      const res = await POST(req, params);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.action).toBe('hidden');
      expect(body.data.account_id).toBe('spam.near');
      expect(mockResolveAccountId).toHaveBeenCalledWith(`near:${validPayload}`);
      expect(mockWriteToFastData).toHaveBeenCalledWith(
        'near:mock_admin_token',
        expect.objectContaining({
          'hidden/spam.near': true,
        }),
      );
    });

    // near: admin tokens round-trip through OutLayer's /sign-message,
    // which returns the *derived hex64* from (OUTLAYER_ADMIN_ACCOUNT,
    // seed='admin') — not the named admin account. assertAdminAuth
    // accepts either; hard-coding the named-account check would
    // silently 403 every correctly-signed near: admin token.
    it('hides an agent when a near: admin token resolves to the derived hex64', async () => {
      mockResolveAccountId.mockResolvedValueOnce(
        '68becf62560bb051ab3950310df70c29d0e80c6fb7cacd90f3dce8c2eff4779e',
      );
      const validPayload = Buffer.from(
        JSON.stringify({ account_id: 'admin.near', seed: 'admin' }),
      ).toString('base64url');
      const [req, params] = makeRequest(
        'POST',
        'admin/hidden/spam.near',
        undefined,
        { authorization: `Bearer near:${validPayload}` },
      );
      const res = await POST(req, params);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.action).toBe('hidden');
      expect(body.data.account_id).toBe('spam.near');
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

describe('getClientIp via X-Forwarded-For', () => {
  // Exercise the IP-key derivation through the rate-limited public path
  // (`GET /admin/hidden` calls `checkRateLimit('list_hidden', ip)`).
  beforeEach(() => {
    mockCheckRateLimit.mockClear();
    mockCheckRateLimit.mockReturnValue({ ok: true, window: 0 });
    mockGetHiddenSet.mockResolvedValue(new Set());
  });

  async function ipKeyFor(headers: Record<string, string>): Promise<string> {
    const [req, params] = makeRequest(
      'GET',
      'admin/hidden',
      undefined,
      headers,
    );
    await GET(req, params);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'list_hidden',
      expect.any(String),
    );
    const lastCall =
      mockCheckRateLimit.mock.calls[mockCheckRateLimit.mock.calls.length - 1];
    return lastCall[1] as string;
  }

  it('takes the right-most XFF entry', async () => {
    const ip = await ipKeyFor({
      'x-forwarded-for': '203.0.113.1, 10.0.0.5',
    });
    expect(ip).toBe('10.0.0.5');
  });

  it('ignores spoofed left-most IP', async () => {
    const ip = await ipKeyFor({
      'x-forwarded-for': 'spoof.attacker, 198.51.100.7',
    });
    expect(ip).toBe('198.51.100.7');
  });

  it('missing XFF: falls through to x-real-ip', async () => {
    const ip = await ipKeyFor({ 'x-real-ip': '10.0.0.5' });
    expect(ip).toBe('10.0.0.5');
  });

  it('missing both headers: keys against "anon"', async () => {
    const ip = await ipKeyFor({});
    expect(ip).toBe('anon');
  });

  it('XFF with surrounding whitespace and empty entries is normalized', async () => {
    const ip = await ipKeyFor({
      'x-forwarded-for': ' , 203.0.113.1 ,  , 10.0.0.5 , ',
    });
    expect(ip).toBe('10.0.0.5');
  });
});
