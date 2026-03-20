import { executeWasm, OutlayerExecError } from '@/lib/outlayer-exec';
import { TEST_AUTH } from './fixtures';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('executeWasm', () => {
  const apiKey = 'wk_test123';
  const action = 'get_me';

  describe('request formation', () => {
    it('sends correct URL, headers, and body', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, data: { agent: { handle: 'bot' } } }),
      });

      await executeWasm(apiKey, action, { extra: 'arg' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/outlayer/call/'),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ action: 'get_me', extra: 'arg' }),
        }),
      );
    });

    it('includes auth in body when provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, data: {} }),
      });

      await executeWasm(apiKey, action, {}, TEST_AUTH);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.auth).toEqual(TEST_AUTH);
    });

    it('omits auth field when not provided', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true, data: {} }),
      });

      await executeWasm(apiKey, action);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.auth).toBeUndefined();
    });
  });

  describe('response decoding', () => {
    it('decodes direct JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ success: true, data: { handle: 'bot' } }),
      });

      const result = await executeWasm(apiKey, action);
      expect(result.data).toEqual({ handle: 'bot' });
    });

    it('decodes base64-encoded string response', async () => {
      const payload = { success: true, data: { handle: 'bot' } };
      const encoded = btoa(JSON.stringify(payload));

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(encoded),
      });

      const result = await executeWasm(apiKey, action);
      expect(result.data).toEqual({ handle: 'bot' });
    });

    it('decodes output field with base64 string', async () => {
      const payload = { success: true, data: { handle: 'bot' } };
      const encoded = btoa(JSON.stringify(payload));

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ output: encoded }),
      });

      const result = await executeWasm(apiKey, action);
      expect(result.data).toEqual({ handle: 'bot' });
    });

    it('decodes output field with JSON object', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            output: { success: true, data: { handle: 'bot' } },
          }),
      });

      const result = await executeWasm(apiKey, action);
      expect(result.data).toEqual({ handle: 'bot' });
    });

    it('throws on unexpected response format', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ something: 'else' }),
      });

      await expect(executeWasm(apiKey, action)).rejects.toThrow(
        'Failed to decode WASM output',
      );
    });

    it('throws on malformed base64 string', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve('not-valid-base64!!!'),
      });

      await expect(executeWasm(apiKey, action)).rejects.toThrow(
        OutlayerExecError,
      );
    });
  });

  describe('error handling', () => {
    it('throws on non-ok HTTP response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await expect(executeWasm(apiKey, action)).rejects.toThrow(
        'OutLayer execution failed: 500 Internal Server Error',
      );
    });

    it('throws on success: false in WASM response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ success: false, error: 'Agent not found' }),
      });

      await expect(executeWasm(apiKey, action)).rejects.toThrow(
        'Agent not found',
      );
    });

    it('provides default error message when WASM error is empty', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: false }),
      });

      await expect(executeWasm(apiKey, action)).rejects.toThrow(
        'WASM action failed',
      );
    });

    it('handles text() failure on non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error('read failed')),
      });

      await expect(executeWasm(apiKey, action)).rejects.toThrow(
        'OutLayer execution failed: 502 HTTP 502',
      );
    });
  });

  describe('pagination', () => {
    it('passes through pagination from WASM response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { agents: [] },
            pagination: { limit: 25, nextCursor: 'agent_42' },
          }),
      });

      const result = await executeWasm(apiKey, 'list_agents');
      expect(result.pagination).toEqual({
        limit: 25,
        nextCursor: 'agent_42',
      });
    });
  });
});
