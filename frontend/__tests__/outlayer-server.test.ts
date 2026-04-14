/**
 * @jest-environment node
 */

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { callOutlayer, decodeOutlayerResponse } from '@/lib/outlayer-server';

describe('decodeOutlayerResponse', () => {
  it('decodes base64-encoded string response', () => {
    const inner = { success: true, data: { handle: 'bot' } };
    const encoded = btoa(JSON.stringify(inner));

    const result = decodeOutlayerResponse(encoded);
    expect(result).toEqual(inner);
  });

  it('decodes output field with JSON object', () => {
    const inner = { success: true, data: { handle: 'bot' } };
    const result = decodeOutlayerResponse({ output: inner });
    expect(result).toEqual(inner);
  });

  it('passes through direct WasmResponse shape', () => {
    const direct = { success: true, data: { agents: [] } };
    const result = decodeOutlayerResponse(direct);
    expect(result).toEqual(direct);
  });

  it('throws on non-object, non-string input', () => {
    expect(() => decodeOutlayerResponse(42)).toThrow(
      'Unexpected OutLayer response format',
    );
    expect(() => decodeOutlayerResponse(null)).toThrow(
      'Unexpected OutLayer response format',
    );
  });

  it('throws on object without success field', () => {
    expect(() => decodeOutlayerResponse({ something: 'else' })).toThrow(
      'Unexpected OutLayer response format',
    );
  });

  it('throws on invalid base64 string', () => {
    expect(() => decodeOutlayerResponse('not-valid-base64!!!')).toThrow(
      'Invalid base64',
    );
  });
});

describe('callOutlayer', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['NOT_FOUND', 404],
    ['AUTH_REQUIRED', 401],
    ['AUTH_FAILED', 401],
    ['NONCE_REPLAY', 401],
    ['RATE_LIMITED', 429],
    ['HANDLE_TAKEN', 400],
    ['HANDLE_INVALID', 400],
    ['SELF_FOLLOW', 400],
    [undefined, 400],
  ])('maps WASM error code %s to HTTP %d', async (code, expectedStatus) => {
    const wasmResp = { success: false, error: 'fail', code };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', output: wasmResp }),
    } as unknown as Response);

    const { response: res } = await callOutlayer(
      { action: 'get_me' },
      'wk_test',
    );
    expect(res.status).toBe(expectedStatus);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it('returns decoded WASM response on success', async () => {
    const wasmResp = { success: true, data: { handle: 'bot' } };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', output: wasmResp }),
    } as unknown as Response);

    const { response: res } = await callOutlayer(
      { action: 'get_me' },
      'wk_test',
    );
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.handle).toBe('bot');
    expect(res.status).toBe(200);
  });

  it('returns 502 on upstream unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'));

    const { response: res } = await callOutlayer(
      { action: 'get_me' },
      'wk_test',
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('unreachable');
  });

  it('returns 502 for upstream 5xx errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    const { response: res } = await callOutlayer(
      { action: 'get_me' },
      'wk_test',
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('503');
  });

  it('passes through upstream 4xx status', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
    } as Response);

    const { response: res } = await callOutlayer(
      { action: 'get_me' },
      'wk_test',
    );
    expect(res.status).toBe(429);
  });

  it('returns 502 with generic message when WASM execution fails', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'failed', error: 'panic in wasm' }),
    } as unknown as Response);

    const { response: res } = await callOutlayer(
      { action: 'get_me' },
      'wk_test',
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('WASM execution failed');
    expect(body.error).not.toContain('panic');
  });

  it('returns 502 when upstream response is not valid JSON', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    } as unknown as Response);

    const { response: res } = await callOutlayer(
      { action: 'get_me' },
      'wk_test',
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON from OutLayer');
  });

  it('sends wallet key as Bearer and payment key as X-Payment-Key', async () => {
    const wasmResp = { success: true, data: {} };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', output: wasmResp }),
    } as unknown as Response);

    await callOutlayer({ action: 'list_agents' }, 'wk_wallet123');
    let headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe('Bearer wk_wallet123');
    expect(headers['X-Payment-Key']).toBeUndefined();

    mockFetch.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', output: wasmResp }),
    } as unknown as Response);

    await callOutlayer({ action: 'list_agents' }, 'owner:1:secret');
    headers = (mockFetch.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers['X-Payment-Key']).toBe('owner:1:secret');
    expect(headers.Authorization).toBeUndefined();
  });
});
