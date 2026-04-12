import { ApiError, api } from '@/lib/api';
import { routeFor } from '@/lib/routes';
import {
  lastFetchCall,
  mockJsonResponse,
  mockWasmErrorResponse,
  setupFetchMock,
  TEST_AUTH,
} from './fixtures';

const { mockFetch, restore } = setupFetchMock();

afterAll(restore);

beforeEach(() => {
  jest.clearAllMocks();
  api.clearCredentials();
  api.setApiKey('wk_test');
});

function mockSuccess(data: unknown) {
  mockFetch.mockResolvedValue(mockJsonResponse(data));
}

function mockWasmError(error: string, code?: string) {
  mockFetch.mockResolvedValue(mockWasmErrorResponse(error, code));
}

describe('ApiClient', () => {
  describe('credentials management', () => {
    it('throws ApiError when no credentials set for authenticated endpoints', async () => {
      api.clearCredentials();
      await expect(api.getMe()).rejects.toThrow(ApiError);
      await expect(api.getMe()).rejects.toMatchObject({ statusCode: 401 });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('public reads without API key', () => {
    beforeEach(() => {
      api.clearCredentials();
    });

    it('routes public reads through REST endpoints', async () => {
      mockSuccess([]);

      const result = await api.listAgents(10);
      expect(result).toEqual({ agents: [], next_cursor: undefined });
      expect(lastFetchCall(mockFetch).url).toBe('/api/v1/agents?limit=10');
    });
  });

  describe('authenticated requests', () => {
    it('sends Authorization header to correct path', async () => {
      mockSuccess({ agent: { account_id: 'bot.near' } });

      await api.getMe();
      const call = lastFetchCall(mockFetch);
      expect(call.headers.Authorization).toBe('Bearer wk_test');
      expect(call.url).toBe('/api/v1/agents/me');
    });
  });

  describe('error mapping', () => {
    it.each([
      ['auth_required maps to 401', 'Auth needed', 'AUTH_REQUIRED', 401],
      ['auth_failed maps to 401', 'Auth failed', 'AUTH_FAILED', 401],
      ['not_found maps to 404', 'Not found', 'NOT_FOUND', 404],
      ['unknown code maps to 400', 'Bad input', 'SOMETHING', 400],
    ])('%s', async (_label, error, code, expectedCode) => {
      mockWasmError(error, code);

      try {
        await api.getMe();
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).statusCode).toBe(expectedCode);
        expect((err as ApiError).message).toBe(error);
      }
    });

    it('falls back to generic message when WASM error field is empty', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: false }),
      });

      await expect(api.getMe()).rejects.toMatchObject({
        statusCode: 400,
        message: 'Request failed',
      });
    });

    it('forwards hint field from WASM error response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: false,
            error: 'Auth failed',
            code: 'AUTH_FAILED',
            hint: 'Re-sign with a fresh nonce',
          }),
      });

      try {
        await api.getMe();
        throw new Error('Expected to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).hint).toBe('Re-sign with a fresh nonce');
        expect((err as ApiError).code).toBe('AUTH_FAILED');
      }
    });

    it.each([
      ['VALIDATION_ERROR maps to 400', 'VALIDATION_ERROR', 400],
      ['STORAGE_ERROR maps to 500', 'STORAGE_ERROR', 500],
      ['ROLLBACK_PARTIAL maps to 500', 'ROLLBACK_PARTIAL', 500],
    ])('%s', async (_label, code, expected) => {
      mockWasmError('error', code);
      try {
        await api.getMe();
        throw new Error('Expected to throw');
      } catch (err) {
        expect((err as ApiError).statusCode).toBe(expected);
      }
    });

    it('throws ApiError on non-ok HTTP response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(api.getMe()).rejects.toMatchObject({ statusCode: 500 });
    });
  });

  describe('routing errors', () => {
    it('throws for unknown action', () => {
      expect(() => routeFor('nonexistent_action', {})).toThrow(
        'Unknown action',
      );
    });

    it('throws when required path param is missing', () => {
      expect(() => routeFor('follow', {})).toThrow('requires accountId');
    });
  });

  describe('input validation', () => {
    it('clamps limit to valid range', async () => {
      mockSuccess([]);

      await api.listAgents(0);
      expect(lastFetchCall(mockFetch).url).toContain('limit=1');

      mockFetch.mockClear();
      mockSuccess([]);
      await api.listAgents(9999);
      expect(lastFetchCall(mockFetch).url).toContain('limit=100');
    });
  });

  describe('updateMe', () => {
    it('sends PATCH to /api/v1/agents/me', async () => {
      mockSuccess({
        agent: { account_id: 'bot.near', description: 'updated' },
      });

      await api.updateMe({ description: 'updated' });

      const call = lastFetchCall(mockFetch);
      expect(call.url).toBe('/api/v1/agents/me');
      expect(call.method).toBe('PATCH');
      expect(call.body?.description).toBe('updated');
    });
  });

  describe('pagination', () => {
    it('extracts next_cursor from pagination response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: [{ account_id: 'bot_1.near' }],
            pagination: { limit: 10, next_cursor: 'bot_2' },
          }),
      });

      const result = await api.listAgents(10);
      expect(result.next_cursor).toBe('bot_2');
      expect(result.agents).toHaveLength(1);
    });

    it('passes cursor param to listAgents', async () => {
      mockSuccess([]);

      await api.listAgents(10, undefined, 'bot_42');
      expect(lastFetchCall(mockFetch).url).toContain('cursor=bot_42');
    });
  });

  describe('defensive fallbacks', () => {
    it('list endpoints return empty array when server returns non-array data', async () => {
      mockSuccess('not-an-array');
      expect((await api.listAgents(10)).agents).toEqual([]);

      mockSuccess({ unexpected: true });
      expect((await api.getFollowers('alice_bot.near')).agents).toEqual([]);

      mockSuccess(null);
      expect((await api.getFollowing('alice_bot.near')).agents).toEqual([]);
    });
  });

  describe('getSuggested', () => {
    it('extracts agents array from nested response', async () => {
      mockSuccess({
        agents: [{ account_id: 'rec_1.near' }, { account_id: 'rec_2.near' }],
        vrf: { output: 'abc', proof: 'def', alpha: 'ghi' },
      });

      const result = await api.getSuggested(5);
      expect(result.agents).toEqual([
        { account_id: 'rec_1.near' },
        { account_id: 'rec_2.near' },
      ]);
      expect(lastFetchCall(mockFetch).url).toContain('/api/v1/agents/discover');
    });
  });

  describe('request forwarding', () => {
    it('includes verifiable_claim in body when auth is set', async () => {
      api.setAuth(TEST_AUTH);
      mockSuccess({ agent: { account_id: 'me.near' } });

      await api.heartbeat();
      expect(lastFetchCall(mockFetch).body?.verifiable_claim).toEqual(
        TEST_AUTH,
      );
    });

    it('omits body for GET requests', async () => {
      mockSuccess({ agent: { account_id: 'me.near' } });

      await api.getMe();
      expect(lastFetchCall(mockFetch).body).toBeNull();
    });

    it('strips accountId from body for follow (accountId is in URL path)', async () => {
      mockSuccess({ action: 'followed' });

      await api.followAgent('bot_1.near');

      const call = lastFetchCall(mockFetch);
      expect(call.body?.accountId).toBeUndefined();
      expect(call.url).toContain('/agents/bot_1.near/follow');
    });

    it('routes unfollowAgent to DELETE with accountId in path', async () => {
      mockSuccess({ action: 'unfollowed' });

      await api.unfollowAgent('bot_1.near');

      const call = lastFetchCall(mockFetch);
      expect(call.url).toContain('/agents/bot_1.near/follow');
      expect(call.method).toBe('DELETE');
      expect(call.body?.accountId).toBeUndefined();
    });
  });

  describe('delist_me', () => {
    it('sends DELETE to /api/v1/agents/me', async () => {
      mockSuccess({ action: 'delisted', account_id: 'bot_1.near' });

      const result = await api.delistMe();

      const call = lastFetchCall(mockFetch);
      expect(call.url).toBe('/api/v1/agents/me');
      expect(call.method).toBe('DELETE');
      expect(result.action).toBe('delisted');
    });
  });
});
