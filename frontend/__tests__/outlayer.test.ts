import {
  registerOutlayer,
  signMessage,
  callContract,
  getBalance,
} from '@/lib/outlayer';

// Mock fetch utilities
jest.mock('@/lib/fetch', () => {
  const errorText = async (res: Response) => {
    try { return await res.text(); } catch { return `HTTP ${res.status}`; }
  };
  return {
    fetchWithTimeout: jest.fn(),
    httpErrorText: jest.fn(errorText),
    assertOk: jest.fn(async (res: Response) => {
      if (!res.ok) throw new Error(await errorText(res));
    }),
  };
});

import { fetchWithTimeout } from '@/lib/fetch';

const mockFetch = fetchWithTimeout as jest.MockedFunction<
  typeof fetchWithTimeout
>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('registerOutlayer', () => {
  it('registers and returns api_key and near_account_id', async () => {
    const responseData = {
      api_key: 'wk_new',
      near_account_id: 'user.near',
      handoff_url: 'https://outlayer.com/handoff',
      trial: true,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(responseData),
    } as Response);

    const { data, request } = await registerOutlayer();

    expect(data).toEqual(responseData);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/api/outlayer/register');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Service unavailable'),
    } as Response);

    await expect(registerOutlayer()).rejects.toThrow('Service unavailable');
  });

  it('handles unreadable error response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error('read failed')),
    } as Response);

    await expect(registerOutlayer()).rejects.toThrow('HTTP 502');
  });
});

describe('signMessage', () => {
  it('signs a message and returns NEP-413 components', async () => {
    const responseData = {
      account_id: 'user.near',
      public_key: 'ed25519:abc',
      signature: 'ed25519:sig',
      nonce: 'bm9uY2U=',
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(responseData),
    } as Response);

    const { data, request } = await signMessage(
      'wk_key',
      '{"action":"register"}',
      'nearly.social',
    );

    expect(data).toEqual(responseData);
    expect(request.body).toEqual({
      message: '{"action":"register"}',
      recipient: 'nearly.social',
    });
    expect(request.headers.Authorization).toBe('Bearer wk_key');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Invalid key'),
    } as Response);

    await expect(
      signMessage('wk_bad', 'msg', 'nearly.social'),
    ).rejects.toThrow('Invalid key');
  });
});

describe('callContract', () => {
  const params = {
    receiver_id: 'fastgraph.near',
    method_name: 'commit',
    args: { mutations: [], reasoning: 'test', phase: 'test' },
  };

  it('calls contract and returns tx_hash', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          request_id: 'r1',
          status: 'ok',
          tx_hash: '0xabc',
        }),
    } as Response);

    const result = await callContract('wk_key', params);

    expect(result.tx_hash).toBe('0xabc');
    expect(result.status).toBe('ok');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad request'),
    } as Response);

    await expect(callContract('wk_key', params)).rejects.toThrow(
      'Bad request',
    );
  });

  it('handles unreadable error response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('read failed')),
    } as Response);

    await expect(callContract('wk_key', params)).rejects.toThrow(
      'HTTP 500',
    );
  });
});

describe('getBalance', () => {
  it('returns balance string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ balance: '1000000000000000000000000' }),
    } as Response);

    const balance = await getBalance('wk_key');
    expect(balance).toBe('1000000000000000000000000');
  });

  it('returns "0" when balance is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    const balance = await getBalance('wk_key');
    expect(balance).toBe('0');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
    } as Response);

    await expect(getBalance('wk_bad')).rejects.toThrow(
      'Balance check failed: HTTP 401',
    );
  });

  it('throws on non-json response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error('not json')),
    } as Response);

    await expect(getBalance('wk_key')).rejects.toThrow(
      'Balance check failed: unexpected response',
    );
  });
});
