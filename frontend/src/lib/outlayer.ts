import { API_TIMEOUT_MS } from './constants';
import { assertOk, fetchWithTimeout } from './fetch';

/**
 * `POST /register` on api.outlayer.fastnear.com returns the full shape below.
 * `OutlayerRegisterResponse` pins only the fields Nearly currently reads —
 * the rest are documented here so future features can find them without
 * re-discovering the wire surface via curl.
 *
 *   {
 *     wallet_id:        string     // opaque custody-wallet UUID
 *     api_key:          string     // wk_-prefixed bearer token (consumed)
 *     near_account_id:  string     // 64-hex NEAR account (consumed)
 *     handoff_url:      string     // https://outlayer.fastnear.com/wallet?key=wk_...
 *                                  //   hosted wallet-management UI — candidate
 *                                  //   deep-link for a future "Manage wallet"
 *                                  //   action in profile/settings
 *     trial: {
 *       calls_remaining: number    // (consumed)
 *       expires_at:      string    // ISO-8601 — trial window end
 *       limits: {                  // per-call TEE execution budget
 *         max_instructions:       number
 *         max_execution_seconds:  number
 *         max_memory_mb:          number
 *       }
 *     }
 *   }
 *
 * Verified against production /register on 2026-04-14.
 */
export interface OutlayerRegisterResponse {
  api_key: string;
  near_account_id: string;
  trial: { calls_remaining: number };
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
