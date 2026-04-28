/**
 * @jest-environment node
 */

const mockFetch = jest.fn();
global.fetch = mockFetch;

import {
  BoundedAccountCache,
  callOutlayer,
  decodeOutlayerResponse,
  resolveAccountId,
} from '@/lib/outlayer-server';

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

describe('resolveAccountId', () => {
  beforeEach(() => jest.clearAllMocks());

  it('resolves wk_ key via GET /wallet/v1/balance without sign-message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ account_id: 'alice.near', balance: '0' }),
    } as unknown as Response);

    // Use a fresh key per test to bypass the module-level accountCache.
    const result = await resolveAccountId('wk_fresh_balance_first');
    expect(result).toBe('alice.near');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/wallet/v1/balance?chain=near');
    expect(
      (init as RequestInit).headers as Record<string, string>,
    ).toMatchObject({ Authorization: 'Bearer wk_fresh_balance_first' });
  });

  it('falls back to sign-message when balance response lacks account_id', async () => {
    // balance returns 2xx but omits account_id → fall through to sign-message.
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ balance: '0' }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            account_id: 'bob.near',
            public_key: 'ed25519:pk',
            signature: 'ed25519:sig',
            nonce: 'bm9uY2U=',
          }),
      } as unknown as Response);

    const result = await resolveAccountId('wk_fresh_fallback_path');
    expect(result).toBe('bob.near');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1][0])).toContain(
      '/wallet/v1/sign-message',
    );
  });

  it('skips balance path entirely for near: tokens and uses sign-message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          account_id: 'carol.near',
          public_key: 'ed25519:pk',
          signature: 'ed25519:sig',
          nonce: 'bm9uY2U=',
        }),
    } as unknown as Response);

    const result = await resolveAccountId('near:fresh_token_payload');
    expect(result).toBe('carol.near');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      '/wallet/v1/sign-message',
    );
  });

  it('caches wk_ resolution: second call with same key hits cache, no network', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ account_id: 'dave.near', balance: '0' }),
    } as unknown as Response);

    const first = await resolveAccountId('wk_cache_hit_test');
    const second = await resolveAccountId('wk_cache_hit_test');
    expect(first).toBe('dave.near');
    expect(second).toBe('dave.near');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache near: tokens — distinct tokens both hit sign-message', async () => {
    const signResponse = (accountId: string) =>
      ({
        ok: true,
        json: () =>
          Promise.resolve({
            account_id: accountId,
            public_key: 'ed25519:pk',
            signature: 'ed25519:sig',
            nonce: 'bm9uY2U=',
          }),
      }) as unknown as Response;
    mockFetch
      .mockResolvedValueOnce(signResponse('eve.near'))
      .mockResolvedValueOnce(signResponse('eve.near'));

    const first = await resolveAccountId('near:token_one');
    const second = await resolveAccountId('near:token_two');
    expect(first).toBe('eve.near');
    expect(second).toBe('eve.near');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0][0])).toContain(
      '/wallet/v1/sign-message',
    );
    expect(String(mockFetch.mock.calls[1][0])).toContain(
      '/wallet/v1/sign-message',
    );
  });
});

describe('BoundedAccountCache', () => {
  it('returns undefined for missing keys', () => {
    const cache = new BoundedAccountCache(3);
    expect(cache.get('wk_missing')).toBeUndefined();
  });

  it('stores and retrieves values', () => {
    const cache = new BoundedAccountCache(3);
    cache.set('wk_a', 'alice.near');
    expect(cache.get('wk_a')).toBe('alice.near');
  });

  it('evicts the oldest entry when size exceeds the cap', () => {
    const cache = new BoundedAccountCache(3);
    cache.set('wk_a', 'alice.near');
    cache.set('wk_b', 'bob.near');
    cache.set('wk_c', 'carol.near');
    cache.set('wk_d', 'dave.near');
    expect(cache.size).toBe(3);
    expect(cache.get('wk_a')).toBeUndefined();
    expect(cache.get('wk_d')).toBe('dave.near');
  });

  it('refreshes insertion order on get — read keeps a key resident', () => {
    const cache = new BoundedAccountCache(3);
    cache.set('wk_a', 'alice.near');
    cache.set('wk_b', 'bob.near');
    cache.set('wk_c', 'carol.near');
    // Touch wk_a so it becomes the freshest entry.
    expect(cache.get('wk_a')).toBe('alice.near');
    cache.set('wk_d', 'dave.near');
    // wk_b is now the oldest and evicted; wk_a survives.
    expect(cache.get('wk_a')).toBe('alice.near');
    expect(cache.get('wk_b')).toBeUndefined();
    expect(cache.get('wk_c')).toBe('carol.near');
    expect(cache.get('wk_d')).toBe('dave.near');
  });

  it('refreshes insertion order on re-set with the same key', () => {
    const cache = new BoundedAccountCache(2);
    cache.set('wk_a', 'alice.near');
    cache.set('wk_b', 'bob.near');
    // Re-set wk_a; it becomes the freshest.
    cache.set('wk_a', 'alice.near');
    cache.set('wk_c', 'carol.near');
    // wk_b was the oldest after the re-set, so it gets evicted.
    expect(cache.get('wk_a')).toBe('alice.near');
    expect(cache.get('wk_b')).toBeUndefined();
    expect(cache.get('wk_c')).toBe('carol.near');
  });

  it('handles cap=1 (degenerate but valid)', () => {
    const cache = new BoundedAccountCache(1);
    cache.set('wk_a', 'alice.near');
    cache.set('wk_b', 'bob.near');
    expect(cache.size).toBe(1);
    expect(cache.get('wk_a')).toBeUndefined();
    expect(cache.get('wk_b')).toBe('bob.near');
  });
});
