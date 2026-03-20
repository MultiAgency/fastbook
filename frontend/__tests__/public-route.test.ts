/**
 * Tests for /api/public route handler.
 * Verifies action allowlist, request forwarding, and error responses.
 */

// Mock next/server — the route uses NextRequest and NextResponse
jest.mock('next/server', () => {
  class MockNextResponse {
    body: string;
    status: number;
    headers: Map<string, string>;

    constructor(
      body: string,
      init?: { status?: number; headers?: Record<string, string> },
    ) {
      this.body = body;
      this.status = init?.status || 200;
      this.headers = new Map(Object.entries(init?.headers || {}));
    }

    static json(
      data: unknown,
      init?: { status?: number; headers?: Record<string, string> },
    ) {
      return new MockNextResponse(JSON.stringify(data), init);
    }
  }

  return {
    NextRequest: jest.fn(),
    NextResponse: MockNextResponse,
  };
});

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

let POST: typeof import('@/app/api/public/route').POST;

beforeAll(async () => {
  // Set env vars before loading the route module
  process.env.OUTLAYER_API_KEY = 'wk_server_payment_key';
  process.env.NEXT_PUBLIC_OUTLAYER_API_URL = 'https://api.outlayer.fastnear.com';
  process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_OWNER = 'agency.near';
  process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_NAME = 'nearly';

  // Force fresh module load
  jest.resetModules();
  const mod = await import('@/app/api/public/route');
  POST = mod.POST;
});

function makeRequest(body: Record<string, unknown>): any {
  return {
    json: () => Promise.resolve(body),
    headers: {
      get: () => null,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({ success: true, data: { agents: [] } }),
      ),
  });
});

describe('/api/public route', () => {
  describe('action allowlist', () => {
    it.each([
      'list_verified',
      'list_agents',
      'get_profile',
      'get_edges',
      'get_followers',
      'get_following',
      'health',
    ])('allows %s action', async (action) => {
      const res = await POST(makeRequest({ action }));
      expect(res.status).toBe(200);
    });

    it.each([
      'register',
      'follow',
      'unfollow',
      'update_me',
      'get_me',
      'read_notifications',
    ])('rejects %s action with 403', async (action) => {
      const res = await POST(makeRequest({ action }));
      expect(res.status).toBe(403);
    });

    it('rejects missing action with 403', async () => {
      const res = await POST(makeRequest({}));
      expect(res.status).toBe(403);
    });
  });

  describe('request forwarding', () => {
    it('forwards to OutLayer with server-side payment key', async () => {
      await POST(makeRequest({ action: 'list_verified', limit: 10 }));

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.outlayer.fastnear.com/call/agency.near/nearly',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer wk_server_payment_key',
          }),
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.action).toBe('list_verified');
      expect(body.limit).toBe(10);
    });

    it('strips auth field to prevent nonce-burning attacks', async () => {
      const fakeAuth = {
        near_account_id: 'attacker.near',
        public_key: 'ed25519:abc',
        signature: 'ed25519:sig',
        nonce: 'stolen_nonce',
        message: '{}',
      };

      await POST(
        makeRequest({ action: 'get_profile', handle: 'victim', auth: fakeAuth }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.auth).toBeUndefined();
      expect(body.action).toBe('get_profile');
      expect(body.handle).toBe('victim');
    });
  });

  describe('error handling', () => {
    it('returns 400 for invalid JSON body', async () => {
      const req = {
        json: () => Promise.reject(new Error('parse error')),
        headers: { get: () => '127.0.0.1' },
      };

      const res = await POST(req as any);
      expect(res.status).toBe(400);
    });
  });

});
