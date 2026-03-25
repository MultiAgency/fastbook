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

    it('throws after clearing credentials', async () => {
      api.clearCredentials();

      await expect(api.getMe()).rejects.toThrow(ApiError);
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

    it('does not send Authorization header for public reads', async () => {
      mockSuccess([]);

      await api.listAgents(10);
      expect(lastFetchCall(mockFetch).headers.Authorization).toBeUndefined();
    });
  });

  describe('authenticated requests', () => {
    it('sends Authorization header', async () => {
      mockSuccess({ agent: { handle: 'bot' } });

      await api.getMe();
      expect(lastFetchCall(mockFetch).headers.Authorization).toBe(
        'Bearer wk_test',
      );
    });

    it('routes to correct REST paths', async () => {
      mockSuccess({ agent: { handle: 'bot' } });
      await api.getMe();
      expect(lastFetchCall(mockFetch).url).toBe('/api/v1/agents/me');
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
      expect(() => routeFor('follow', {})).toThrow('requires handle');
    });
  });

  describe('input validation', () => {
    it('rejects invalid handles', async () => {
      await expect(api.getAgent('UPPER')).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(api.getAgent('ab')).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(api.getAgent('has-dash')).rejects.toMatchObject({
        statusCode: 400,
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

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

  describe('register', () => {
    beforeEach(() => {
      mockSuccess({ agent: { handle: 'my_bot' }, near_account_id: 'abc' });
    });

    it('forwards handle and description', async () => {
      await api.register({ handle: 'my_bot', description: 'test agent' });

      const { body } = lastFetchCall(mockFetch);
      expect(body?.handle).toBe('my_bot');
      expect(body?.description).toBe('test agent');
    });

    it('forwards tags when provided', async () => {
      await api.register({ handle: 'my_bot', tags: ['defi', 'research'] });
      expect(lastFetchCall(mockFetch).body?.tags).toEqual(['defi', 'research']);
    });

    it('omits tags when empty', async () => {
      await api.register({ handle: 'my_bot', tags: [] });
      expect(lastFetchCall(mockFetch).body?.tags).toBeUndefined();
    });

    it('forwards capabilities when provided', async () => {
      await api.register({
        handle: 'my_bot',
        capabilities: { skills: ['chat'] },
      });
      expect(lastFetchCall(mockFetch).body?.capabilities).toEqual({
        skills: ['chat'],
      });
    });

    it('forwards verifiable_claim when provided', async () => {
      await api.register({ handle: 'my_bot', verifiable_claim: TEST_AUTH });
      expect(lastFetchCall(mockFetch).body?.verifiable_claim).toEqual(
        TEST_AUTH,
      );
    });

    it('posts to /api/v1/agents/register', async () => {
      await api.register({ handle: 'my_bot' });

      const call = lastFetchCall(mockFetch);
      expect(call.url).toBe('/api/v1/agents/register');
      expect(call.method).toBe('POST');
    });
  });

  describe('updateMe', () => {
    it('sends PATCH to /api/v1/agents/me', async () => {
      mockSuccess({ agent: { handle: 'bot', description: 'updated' } });

      await api.updateMe({ description: 'updated' });

      const call = lastFetchCall(mockFetch);
      expect(call.url).toBe('/api/v1/agents/me');
      expect(call.method).toBe('PATCH');
      expect(call.body?.description).toBe('updated');
    });

    it('returns updated agent', async () => {
      mockSuccess({ agent: { handle: 'bot', display_name: 'Bot v2' } });

      const agent = await api.updateMe({ display_name: 'Bot v2' });
      expect(agent.display_name).toBe('Bot v2');
    });
  });

  describe('getActivity', () => {
    it('sends GET to /api/v1/agents/me/activity', async () => {
      mockSuccess({ since: 1700000000, new_followers: [], new_following: [] });

      await api.getActivity(1700000000);

      const call = lastFetchCall(mockFetch);
      expect(call.url).toContain('/api/v1/agents/me/activity');
      expect(call.method).toBe('GET');
    });

    it('returns activity data', async () => {
      mockSuccess({
        since: 1700000000,
        new_followers: [{ handle: 'alice' }],
        new_following: [],
      });

      const result = await api.getActivity(1700000000);
      expect(result.new_followers).toEqual([{ handle: 'alice' }]);
      expect(result.since).toBe(1700000000);
    });
  });

  describe('getNetwork', () => {
    it('sends GET to /api/v1/agents/me/network', async () => {
      mockSuccess({
        follower_count: 5,
        following_count: 3,
        mutual_count: 2,
        last_active: 1700000000,
        member_since: 1690000000,
      });

      await api.getNetwork();

      const call = lastFetchCall(mockFetch);
      expect(call.url).toBe('/api/v1/agents/me/network');
      expect(call.method).toBe('GET');
    });

    it('returns network stats', async () => {
      mockSuccess({
        follower_count: 5,
        following_count: 3,
        mutual_count: 2,
        last_active: 1700000000,
        member_since: 1690000000,
      });

      const result = await api.getNetwork();
      expect(result.follower_count).toBe(5);
      expect(result.mutual_count).toBe(2);
    });
  });

  describe('pagination', () => {
    it('extracts next_cursor from pagination response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: [{ handle: 'bot_1' }],
            pagination: { limit: 10, next_cursor: 'bot_2' },
          }),
      });

      const result = await api.listAgents(10);
      expect(result.next_cursor).toBe('bot_2');
      expect(result.agents).toHaveLength(1);
    });

    it('returns undefined next_cursor when no more pages', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: [{ handle: 'bot_1' }],
            pagination: { limit: 10 },
          }),
      });

      const result = await api.listAgents(10);
      expect(result.next_cursor).toBeUndefined();
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
      expect((await api.getFollowers('alice_bot')).agents).toEqual([]);

      mockSuccess(null);
      expect((await api.getFollowing('alice_bot')).agents).toEqual([]);
    });
  });

  describe('getSuggestedFollows', () => {
    it('extracts agents array from nested response', async () => {
      mockSuccess({
        agents: [{ handle: 'rec_1' }, { handle: 'rec_2' }],
        vrf: { output: 'abc', proof: 'def', alpha: 'ghi' },
      });

      const agents = await api.getSuggestedFollows(5);
      expect(agents).toEqual([{ handle: 'rec_1' }, { handle: 'rec_2' }]);
      expect(lastFetchCall(mockFetch).url).toContain(
        '/api/v1/agents/suggested',
      );
    });
  });

  describe('getNotifications', () => {
    it('sends GET with since and limit in query string', async () => {
      mockSuccess({ notifications: [{ type: 'follow' }], unread_count: 1 });

      const result = await api.getNotifications('1700000000', 20);
      expect(result.notifications).toHaveLength(1);
      expect(result.unread_count).toBe(1);

      const call = lastFetchCall(mockFetch);
      expect(call.url).toContain('/api/v1/agents/me/notifications');
      expect(call.url).toContain('since=1700000000');
      expect(call.url).toContain('limit=20');
    });

    it('omits since from query when not provided', async () => {
      mockSuccess({ notifications: [], unread_count: 0 });

      await api.getNotifications();

      const call = lastFetchCall(mockFetch);
      expect(call.url).not.toContain('since=');
      expect(call.url).toContain('limit=50');
    });
  });

  describe('readNotifications', () => {
    it('sends POST and returns read_at', async () => {
      mockSuccess({ read_at: 1700000000 });

      const result = await api.readNotifications();
      expect(result.read_at).toBe(1700000000);
      expect(lastFetchCall(mockFetch).method).toBe('POST');
    });
  });

  describe('getEdges', () => {
    it('converts camelCase options to snake_case query params', async () => {
      api.clearCredentials();
      mockSuccess({
        handle: 'bot_1',
        edges: [],
        edge_count: 0,
        history: null,
        pagination: { limit: 25 },
      });

      await api.getEdges('bot_1', {
        direction: 'both',
        includeHistory: true,
        limit: 10,
      });

      const call = lastFetchCall(mockFetch);
      expect(call.url).toContain('/api/v1/agents/bot_1/edges');
      expect(call.url).toContain('direction=both');
      expect(call.url).toContain('include_history=true');
      expect(call.url).toContain('limit=10');
      expect(call.method).toBe('GET');
    });

    it('is a public endpoint (no auth required)', async () => {
      api.clearCredentials();
      mockSuccess({
        handle: 'bot_1',
        edges: [],
        edge_count: 0,
        history: null,
        pagination: { limit: 25 },
      });

      await expect(api.getEdges('bot_1')).resolves.toBeDefined();
    });
  });

  describe('listTags', () => {
    it('extracts tags array from response', async () => {
      api.clearCredentials();
      mockSuccess({
        tags: [
          { tag: 'ai', count: 5 },
          { tag: 'defi', count: 3 },
        ],
      });

      const tags = await api.listTags();
      expect(tags).toEqual([
        { tag: 'ai', count: 5 },
        { tag: 'defi', count: 3 },
      ]);
      expect(lastFetchCall(mockFetch).url).toContain('/api/v1/tags');
    });
  });

  describe('getFollowers / getFollowing', () => {
    beforeEach(() => {
      api.clearCredentials();
    });

    it('routes getFollowers to correct path', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: [{ handle: 'follower_1' }],
            pagination: { limit: 50, next_cursor: 'abc' },
          }),
      });

      const result = await api.getFollowers('bot_1', 50);
      expect(result.agents).toEqual([{ handle: 'follower_1' }]);
      expect(result.next_cursor).toBe('abc');
      expect(lastFetchCall(mockFetch).url).toContain('/agents/bot_1/followers');
    });

    it('routes getFollowing to correct path', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: [{ handle: 'followed_1' }],
            pagination: { limit: 50 },
          }),
      });

      const result = await api.getFollowing('bot_1', 50);
      expect(result.agents).toEqual([{ handle: 'followed_1' }]);
      expect(lastFetchCall(mockFetch).url).toContain('/agents/bot_1/following');
    });
  });

  describe('request forwarding', () => {
    it('includes verifiable_claim in body when auth is set', async () => {
      api.setAuth(TEST_AUTH);
      mockSuccess({ agent: { handle: 'me' } });

      await api.heartbeat();
      expect(lastFetchCall(mockFetch).body?.verifiable_claim).toEqual(
        TEST_AUTH,
      );
    });

    it('omits body for GET requests', async () => {
      mockSuccess({ agent: { handle: 'me' } });

      await api.getMe();
      expect(lastFetchCall(mockFetch).body).toBeNull();
    });

    it('strips handle from body for follow (handle is in URL path)', async () => {
      mockSuccess({ action: 'followed' });

      await api.followAgent('bot_1');

      const call = lastFetchCall(mockFetch);
      expect(call.body?.handle).toBeUndefined();
      expect(call.url).toContain('/agents/bot_1/follow');
    });

    it('routes unfollowAgent to DELETE with handle in path', async () => {
      mockSuccess({ action: 'unfollowed' });

      await api.unfollowAgent('bot_1');

      const call = lastFetchCall(mockFetch);
      expect(call.url).toContain('/agents/bot_1/follow');
      expect(call.method).toBe('DELETE');
      expect(call.body?.handle).toBeUndefined();
    });

    it('keeps handle in body for register (handle is NOT in URL path)', async () => {
      mockSuccess({ agent: { handle: 'my_bot' }, near_account_id: 'abc' });

      await api.register({ handle: 'my_bot' });
      expect(lastFetchCall(mockFetch).body?.handle).toBe('my_bot');
    });

    it('strips handle from body for endorse (handle is in URL path)', async () => {
      mockSuccess({ action: 'endorsed', endorsed: { tags: ['rust'] } });

      await api.endorseAgent('bot_1', { tags: ['rust'] });

      const call = lastFetchCall(mockFetch);
      expect(call.body?.handle).toBeUndefined();
      expect(call.body?.tags).toEqual(['rust']);
      expect(call.url).toContain('/agents/bot_1/endorse');
      expect(call.method).toBe('POST');
    });

    it('routes unendorse to DELETE with handle in path', async () => {
      mockSuccess({ action: 'unendorsed', removed: { tags: ['rust'] } });

      await api.unendorseAgent('bot_1', { tags: ['rust'] });

      const call = lastFetchCall(mockFetch);
      expect(call.url).toContain('/agents/bot_1/endorse');
      expect(call.method).toBe('DELETE');
    });

    it('routes getEndorsers to GET without auth', async () => {
      api.clearCredentials();
      mockSuccess({ handle: 'bot_1', endorsers: {} });

      await api.getEndorsers('bot_1');

      const call = lastFetchCall(mockFetch);
      expect(call.url).toContain('/agents/bot_1/endorsers');
      expect(call.method).toBe('GET');
    });
  });
});
