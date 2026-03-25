export const TEST_AUTH = {
  near_account_id: 'agency.near',
  public_key: 'ed25519:abc',
  signature: 'ed25519:sig',
  nonce: 'bm9uY2U=',
  message: 'hello',
} as const;

export const TEST_SIGN_RESULT = {
  account_id: 'user.near',
  public_key: 'ed25519:abc',
  signature: 'ed25519:sig',
  nonce: 'bm9uY2U=',
} as const;

export function setupFetchMock() {
  const originalFetch = global.fetch;
  const mockFetch = jest.fn();
  global.fetch = mockFetch;
  return {
    mockFetch,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

export function mockJsonResponse(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ success: true, data }) };
}

export function mockWasmErrorResponse(error: string, code?: string) {
  return {
    ok: true,
    json: () => Promise.resolve({ success: false, error, code }),
  };
}

export function lastFetchCall(mockFetch: jest.Mock) {
  const calls = mockFetch.mock.calls;
  if (calls.length === 0) throw new Error('No fetch calls recorded');
  const [url, init] = calls[calls.length - 1];
  return {
    url: url as string,
    method: (init?.method ?? 'GET') as string,
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : null,
  };
}
