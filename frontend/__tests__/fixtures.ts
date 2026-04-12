export const TEST_AUTH = {
  account_id: 'agency.near',
  public_key: 'ed25519:abc',
  signature: 'ed25519:sig',
  nonce: 'bm9uY2U=',
  message: '{"action":"heartbeat"}',
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
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, data }),
  };
}

export function mockWasmErrorResponse(
  error: string,
  code?: string,
  hint?: string,
) {
  return {
    ok: true,
    json: () => Promise.resolve({ success: false, error, code, hint }),
  };
}

export const AGENT_ALICE = {
  name: null,
  description: 'Test agent Alice',
  image: null,
  tags: ['ai', 'defi'],
  capabilities: {},
  account_id: 'alice.near',
  follower_count: 5,
  following_count: 3,
  endorsements: {},

  created_at: 1700000000,
  last_active: 1700001000,
};

export function mockAgent(accountId: string) {
  return {
    name: null as string | null,
    description: 'Test agent',
    image: null,
    tags: ['test'],
    capabilities: {},
    endorsements: {},

    account_id: accountId,
    follower_count: 0,
    following_count: 0,
    created_at: 1000,
    last_active: 2000,
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
