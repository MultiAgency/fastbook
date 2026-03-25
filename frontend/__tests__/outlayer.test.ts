import { getBalance, registerOutlayer, signMessage } from '@/lib/outlayer';

jest.mock('@/lib/fetch', () => {
  const errorText = async (res: Response) => {
    try {
      return await res.text();
    } catch {
      return `HTTP ${res.status}`;
    }
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

    const result = await registerOutlayer();

    expect(result).toEqual(responseData);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/register',
      expect.objectContaining({ method: 'POST' }),
      10_000,
    );
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

    const result = await signMessage(
      'wk_key',
      '{"action":"register"}',
      'nearly.social',
    );

    expect(result).toEqual(responseData);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/outlayer/wallet/v1/sign-message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer wk_key',
        }),
        body: JSON.stringify({
          message: '{"action":"register"}',
          recipient: 'nearly.social',
        }),
      }),
      10_000,
    );
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Invalid key'),
    } as Response);

    await expect(signMessage('wk_bad', 'msg', 'nearly.social')).rejects.toThrow(
      'Invalid key',
    );
  });
});

describe('timeout configuration', () => {
  it('passes API_TIMEOUT_MS to all fetchWithTimeout calls', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          api_key: 'wk_x',
          near_account_id: 'x.near',
          handoff_url: '',
          trial: true,
        }),
    } as Response);

    await registerOutlayer();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      10_000,
    );

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          account_id: 'x.near',
          public_key: 'ed25519:a',
          signature: 'ed25519:s',
          nonce: 'bm9uY2U=',
        }),
    } as Response);

    await signMessage('wk_key', 'msg', 'nearly.social');
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      10_000,
    );

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ balance: '1' }),
    } as Response);

    await getBalance('wk_key');
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Object),
      10_000,
    );
  });
});

describe('getBalance', () => {
  it('returns balance on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ balance: '12.5' }),
    } as Response);

    const balance = await getBalance('wk_key');
    expect(balance).toBe('12.5');
  });

  it('returns 0 when balance field is missing', async () => {
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
      text: () => Promise.resolve('Unauthorized'),
    } as unknown as Response);

    await expect(getBalance('wk_bad')).rejects.toThrow('Unauthorized');
  });

  it('throws on non-JSON response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('not JSON')),
    } as Response);

    await expect(getBalance('wk_key')).rejects.toThrow('unexpected response');
  });
});
