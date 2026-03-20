import { api, ApiError } from '@/lib/api';
import { executeWasm, OutlayerExecError } from '@/lib/outlayer-exec';
import { callContract } from '@/lib/outlayer';
import { TEST_AUTH } from './fixtures';

jest.mock('@/lib/outlayer-exec', () => {
  const actual = jest.requireActual('@/lib/outlayer-exec');
  class OutlayerExecError extends Error {
    code?: string;
    constructor(message: string, code?: string) {
      super(message);
      this.name = 'OutlayerExecError';
      this.code = code;
    }
  }
  return {
    ...actual,
    executeWasm: jest.fn(),
    OutlayerExecError,
  };
});

jest.mock('@/lib/outlayer', () => ({
  callContract: jest.fn(),
}));

const mockExecuteWasm = executeWasm as jest.MockedFunction<typeof executeWasm>;
const mockCallContract = callContract as jest.MockedFunction<typeof callContract>;

beforeEach(() => {
  jest.clearAllMocks();
  api.clearCredentials();
});

describe('ApiClient', () => {
  describe('credentials management', () => {
    it('starts with null apiKey and auth', () => {
      expect(api.getApiKey()).toBeNull();
      expect(api.getAuth()).toBeNull();
    });

    it('sets and gets API key', () => {
      api.setApiKey('wk_test123');
      expect(api.getApiKey()).toBe('wk_test123');
    });

    it('sets and gets auth', () => {
      api.setAuth(TEST_AUTH);
      expect(api.getAuth()).toEqual(TEST_AUTH);
    });

    it('clears credentials', () => {
      api.setApiKey('wk_test');
      api.setAuth(TEST_AUTH);
      api.clearCredentials();
      expect(api.getApiKey()).toBeNull();
      expect(api.getAuth()).toBeNull();
    });
  });

  describe('request without API key', () => {
    it('throws 401 for authenticated actions when no API key is set', async () => {
      await expect(api.getMe()).rejects.toThrow(ApiError);
      await expect(api.getMe()).rejects.toMatchObject({ statusCode: 401 });
    });

    it('routes public reads through /api/public when no API key is set', async () => {
      // publicRequest uses fetchWithTimeout, which wraps global fetch
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ output: { success: true, data: { agents: [] } } }),
      });

      const result = await api.listVerified(10);
      expect(result).toEqual({ agents: [] });

      // Verify it hit /api/public, not the OutLayer proxy
      const callUrl = (global.fetch as jest.Mock).mock.calls[0][0];
      expect(callUrl).toBe('/api/public');

      global.fetch = originalFetch;
    });
  });

  describe('successful requests', () => {
    beforeEach(() => {
      api.setApiKey('wk_test');
    });

    it('returns data from executeWasm', async () => {
      const agent = { handle: 'bot_1', followerCount: 0, followingCount: 0, createdAt: 1 };
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { agent },
      });

      const result = await api.getMe();
      expect(result).toEqual(agent);
    });
  });

  describe('error mapping', () => {
    beforeEach(() => {
      api.setApiKey('wk_test');
    });

    it.each([
      ['unauthorized code maps to 401', 'Invalid auth token', 'unauthorized', 401],
      ['auth_required code maps to 401', 'Auth required', 'auth_required', 401],
      ['forbidden code maps to 403', 'Action forbidden', 'forbidden', 403],
      ['not_found code maps to 404', 'Agent not found', 'not_found', 404],
      ['unknown code maps to 400', 'Invalid input data', undefined, 400],
      ['no code maps to 400', 'Some error', undefined, 400],
    ])('%s', async (_label, message, code, expectedCode) => {
      const { OutlayerExecError: MockExecError } = jest.requireMock('@/lib/outlayer-exec');
      mockExecuteWasm.mockRejectedValue(new MockExecError(message, code));

      try {
        await api.getMe();
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).statusCode).toBe(expectedCode);
      }
    });

    it('passes through non-OutlayerExecError', async () => {
      const genericError = new TypeError('Network failure');
      mockExecuteWasm.mockRejectedValue(genericError);

      await expect(api.getMe()).rejects.toThrow(genericError);
      await expect(api.getMe()).rejects.not.toBeInstanceOf(ApiError);
    });
  });

  describe('request forwarding', () => {
    beforeEach(() => {
      api.setApiKey('wk_test');
      mockExecuteWasm.mockResolvedValue({ success: true, data: {} });
      mockCallContract.mockResolvedValue({ request_id: 'r1', status: 'ok' });
    });

    it('passes auth when set on client', async () => {
      api.setAuth(TEST_AUTH);
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { agent: { handle: 'me' } },
      });
      await api.getMe();
      expect(mockExecuteWasm).toHaveBeenCalledWith(
        'wk_test',
        'get_me',
        {},
        TEST_AUTH,
      );
    });

    it('omits auth for non-authenticated endpoints', async () => {
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { agents: [] },
      });
      await api.listVerified(10);
      expect(mockExecuteWasm).toHaveBeenCalledWith(
        'wk_test',
        'list_verified',
        { limit: 10 },
        undefined,
      );
    });

  });

  describe('chain commit', () => {
    beforeEach(() => {
      api.setApiKey('wk_test');
      mockCallContract.mockResolvedValue({
        request_id: 'r1',
        status: 'ok',
        tx_hash: '0xabc',
      });
    });

    it('fires chain commit on register', async () => {
      const chainCommit = {
        receiver_id: 'fastgraph.near',
        method_name: 'commit',
        args: { mutations: [], reasoning: 'register', phase: 'register' },
      };
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { agent: { handle: 'new_bot' }, chainCommit },
      });

      await api.register({ handle: 'new_bot' });

      // callContract is fire-and-forget, wait for microtask
      await new Promise((r) => setTimeout(r, 0));
      expect(mockCallContract).toHaveBeenCalledWith('wk_test', chainCommit);
    });

    it('fires chain commit on followAgent', async () => {
      const chainCommit = {
        receiver_id: 'fastgraph.near',
        method_name: 'commit',
        args: { mutations: [], reasoning: 'follow', phase: 'follow' },
      };
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { action: 'followed', chainCommit },
      });

      await api.followAgent('friend');
      await new Promise((r) => setTimeout(r, 0));
      expect(mockCallContract).toHaveBeenCalledWith('wk_test', chainCommit);
    });

    it('fires chain commit on unfollowAgent', async () => {
      const chainCommit = {
        receiver_id: 'fastgraph.near',
        method_name: 'commit',
        args: { mutations: [], reasoning: 'unfollow', phase: 'unfollow' },
      };
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { action: 'unfollowed', chainCommit },
      });

      await api.unfollowAgent('ex_friend');
      await new Promise((r) => setTimeout(r, 0));
      expect(mockCallContract).toHaveBeenCalledWith('wk_test', chainCommit);
    });

    it('fires chain commit on updateMe', async () => {
      const chainCommit = {
        receiver_id: 'fastgraph.near',
        method_name: 'commit',
        args: { mutations: [], reasoning: 'update', phase: 'update' },
      };
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { agent: { handle: 'me' }, chainCommit },
      });

      await api.updateMe({ displayName: 'Updated' });
      await new Promise((r) => setTimeout(r, 0));
      expect(mockCallContract).toHaveBeenCalledWith('wk_test', chainCommit);
    });

    it('does not fire chain commit when none is returned', async () => {
      mockExecuteWasm.mockResolvedValue({
        success: true,
        data: { agent: { handle: 'me' } },
      });

      await api.updateMe({ displayName: 'Updated' });
      await new Promise((r) => setTimeout(r, 0));
      expect(mockCallContract).not.toHaveBeenCalled();
    });
  });
});
