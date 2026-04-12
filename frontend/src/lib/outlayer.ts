import { API_TIMEOUT_MS } from './constants';
import { assertOk, fetchWithTimeout } from './fetch';

export interface OutlayerRegisterResponse {
  api_key: string;
  near_account_id: string;
  handoff_url: string;
  trial: boolean;
}

export async function registerOutlayer(): Promise<OutlayerRegisterResponse> {
  const res = await fetchWithTimeout(
    '/api/outlayer/register',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  return res.json();
}

export async function getBalance(apiKey: string): Promise<string> {
  const res = await fetchWithTimeout(
    '/api/outlayer/wallet/v1/balance?chain=near',
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    API_TIMEOUT_MS,
  );

  await assertOk(res);

  let data: { balance?: string };
  try {
    data = await res.json();
  } catch {
    throw new Error('Balance check failed: unexpected response format');
  }
  return data.balance || '0';
}
