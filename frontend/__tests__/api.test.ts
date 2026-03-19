import { api, ApiError } from '@/lib/api';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock sessionStorage (api.ts uses sessionStorage, not localStorage)
const mockStorage: Record<string, string> = {};
Object.defineProperty(window, 'sessionStorage', {
  value: {
    getItem: (key: string) => mockStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      mockStorage[key] = value;
    },
    removeItem: (key: string) => {
      delete mockStorage[key];
    },
  },
});

beforeEach(() => {
  mockFetch.mockReset();
  api.clearApiKey();
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
});

function mockJsonResponse(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
}

describe('ApiClient', () => {
  describe('API key management', () => {
    it('stores and retrieves API key', () => {
      api.setApiKey('nearly_testkey123');
      expect(api.getApiKey()).toBe('nearly_testkey123');
    });

    it('clears API key from memory', () => {
      api.setApiKey('nearly_testkey123');
      api.clearApiKey();
      expect(api.getApiKey()).toBeNull();
    });

    it('returns null when no key is set', () => {
      api.clearApiKey();
      expect(api.getApiKey()).toBeNull();
    });
  });

  describe('request construction', () => {
    it('includes Authorization header when API key is set', async () => {
      api.setApiKey('nearly_mykey');
      mockJsonResponse({ agent: { id: '1', name: 'test' } });
      await api.getMe();

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers.Authorization).toBe('Bearer nearly_mykey');
    });

    it('omits Authorization header when no API key', async () => {
      mockJsonResponse({ agent: { id: '1', name: 'test' } });
      await api.getMe();

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers.Authorization).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('throws ApiError on non-ok response', async () => {
      mockJsonResponse(
        { error: 'Not found', code: 'NOT_FOUND', hint: 'Check the ID' },
        404,
      );

      await expect(api.getMe()).rejects.toThrow(ApiError);
    });

    it('includes status code and message in ApiError', async () => {
      mockJsonResponse({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }, 401);

      await expect(api.getMe()).rejects.toMatchObject({
        statusCode: 401,
        message: 'Unauthorized',
        code: 'AUTH_REQUIRED',
      });
    });

    it('handles malformed error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('Invalid JSON');
        },
      });

      await expect(api.getMe()).rejects.toMatchObject({
        statusCode: 500,
        message: 'Unknown error',
      });
    });
  });

  describe('endpoint methods', () => {
    it('register sends correct payload', async () => {
      mockJsonResponse({
        agent: {
          id: 'uuid-123',
          api_key: 'nearly_abc',
          near_account_id: 'test.near',
        },
        important: 'Save your key',
      });

      const result = await api.register({
        handle: 'test_agent',
        description: 'A test',
        verifiable_claim: {
          near_account_id: 'test.near',
          public_key: 'ed25519:abc',
          signature: 'ed25519:sig',
          nonce: 'bm9uY2U=',
          message: `{"action":"register","domain":"nearly.social","account_id":"test.near","version":1,"timestamp":${Date.now()}}`,
        },
      });
      expect(result.agent.api_key).toBe('nearly_abc');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.handle).toBe('test_agent');
      expect(body.verifiable_claim.near_account_id).toBe('test.near');
    });

    it('followAgent sends POST and returns response', async () => {
      mockJsonResponse({ action: 'followed', followed: { handle: 'bob' } });
      const result = await api.followAgent('bob');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/agents/bob/follow');
      expect(options.method).toBe('POST');
      expect(result.action).toBe('followed');
    });

    it('unfollowAgent sends DELETE and returns response', async () => {
      mockJsonResponse({ action: 'unfollowed' });
      const result = await api.unfollowAgent('bob');

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toContain('/agents/bob/follow');
      expect(options.method).toBe('DELETE');
      expect(result.action).toBe('unfollowed');
    });

    it('followAgent throws on error response', async () => {
      mockJsonResponse({ error: 'Not found' }, 404);
      await expect(api.followAgent('nonexistent')).rejects.toBeInstanceOf(ApiError);
    });

    it('unfollowAgent throws on error response', async () => {
      mockJsonResponse({ error: 'Not found' }, 404);
      await expect(api.unfollowAgent('nonexistent')).rejects.toBeInstanceOf(ApiError);
    });
  });
});
