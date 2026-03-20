// OutLayer API Client
// Proxied through Next.js rewrites: /api/outlayer/* → https://api.outlayer.fastnear.com/*

import { API_TIMEOUT_MS } from './constants';
import { assertOk, fetchWithTimeout } from './fetch';

export interface OutlayerRegisterResponse {
  api_key: string;
  near_account_id: string;
  handoff_url: string;
  trial: boolean;
}

export interface SignMessageRequest {
  message: string;
  recipient: string;
}

/** Response from signing a message via OutLayer custodial wallet (NEP-413). */
export interface SignMessageResponse {
  /** The NEAR account ID that signed the message */
  account_id: string;
  /** Ed25519 public key in "ed25519:<base58>" format */
  public_key: string;
  /** Ed25519 signature in "ed25519:<base58>" format */
  signature: string;
  /** Base64-encoded 32-byte nonce, unique per message */
  nonce: string;
}

export async function registerOutlayer(): Promise<{
  data: OutlayerRegisterResponse;
  request: { method: string; url: string; body: null };
}> {
  const url = '/api/outlayer/register';
  const request = { method: 'POST', url, body: null };

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  const data: OutlayerRegisterResponse = await res.json();
  return { data, request };
}

export async function signMessage(
  apiKey: string,
  message: string,
  recipient: string,
): Promise<{
  data: SignMessageResponse;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: SignMessageRequest;
  };
}> {
  const url = '/api/outlayer/wallet/v1/sign-message';
  const body: SignMessageRequest = { message, recipient };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  const request = { method: 'POST', url, headers, body };

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    API_TIMEOUT_MS,
  );
  await assertOk(res);
  const data: SignMessageResponse = await res.json();
  return { data, request };
}

export interface CallContractParams {
  receiver_id: string;
  method_name: string;
  args: Record<string, unknown>;
  deposit?: string;
  gas?: string;
}

export interface CallContractResponse {
  request_id: string;
  status: string;
  tx_hash?: string;
  result?: unknown;
}

/**
 * Call a NEAR contract via OutLayer custody wallet.
 * Requires NEAR balance for gas.
 */
export async function callContract(
  apiKey: string,
  params: CallContractParams,
): Promise<CallContractResponse> {
  const url = '/api/outlayer/wallet/v1/call';

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(params),
    },
    API_TIMEOUT_MS,
  );

  await assertOk(res);

  const data: CallContractResponse = await res.json();
  return data;
}

/**
 * Check wallet NEAR balance via OutLayer.
 */
export async function getBalance(apiKey: string): Promise<string> {
  const url = '/api/outlayer/wallet/v1/balance?chain=near';

  const res = await fetchWithTimeout(
    url,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    API_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new Error(`Balance check failed: HTTP ${res.status}`);
  }

  let data: { balance?: string };
  try {
    data = await res.json();
  } catch {
    throw new Error(
      `Balance check failed: unexpected response (${res.status})`,
    );
  }
  return data.balance || '0';
}
