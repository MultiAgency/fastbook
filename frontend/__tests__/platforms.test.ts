/**
 * @jest-environment node
 */

const mockFetch = jest.fn();
global.fetch = mockFetch;

jest.mock('@/lib/outlayer-server', () => ({
  mintClaimForWalletKey: jest.fn(),
  resolveAccountId: jest.fn(),
}));

import { mintClaimForWalletKey, resolveAccountId } from '@/lib/outlayer-server';
import { handleRegisterPlatforms } from '@/lib/platforms';

const mockMint = mintClaimForWalletKey as jest.Mock;
const mockResolve = resolveAccountId as jest.Mock;

function marketOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function findMarketCall(): [string, RequestInit] | undefined {
  return mockFetch.mock.calls.find(([url]) =>
    String(url).includes('/agents/register'),
  ) as [string, RequestInit] | undefined;
}

describe('handleRegisterPlatforms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockResolvedValue('alice.near');
  });

  it('forwards minted verifiable_claim into the market POST body', async () => {
    const minted = {
      account_id: 'alice.near',
      public_key: 'ed25519:pk',
      signature: 'ed25519:sig',
      nonce: 'bm9uY2U=',
      message: '{"action":"register_platforms","domain":"nearly.social"}',
    };
    mockMint.mockResolvedValue(minted);
    mockFetch.mockResolvedValue(
      marketOk({
        api_key: 'sk_live_xxx',
        agent_id: 'uuid-1',
        account_id: 'alice.near',
      }),
    );

    const res = await handleRegisterPlatforms('wk_test_key', {
      platforms: ['market.near.ai'],
    });
    expect(res.status).toBe(200);

    expect(mockMint).toHaveBeenCalledWith('wk_test_key', 'register_platforms');
    const call = findMarketCall();
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body.verifiable_claim).toEqual(minted);
    expect(body.account_id).toBe('alice.near');
  });

  it('omits verifiable_claim when mint returns null (non-fatal)', async () => {
    mockMint.mockResolvedValue(null);
    mockFetch.mockResolvedValue(
      marketOk({ api_key: 'sk_live_xxx', agent_id: 'uuid-2' }),
    );

    const res = await handleRegisterPlatforms('wk_test_key', {
      platforms: ['market.near.ai'],
    });
    expect(res.status).toBe(200);

    const call = findMarketCall();
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body as string);
    expect(body).not.toHaveProperty('verifiable_claim');
  });

  it('returns 401 when the wallet key cannot resolve to an account', async () => {
    mockResolve.mockResolvedValue(null);

    const res = await handleRegisterPlatforms('wk_bad_key', {
      platforms: ['market.near.ai'],
    });
    expect(res.status).toBe(401);
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
