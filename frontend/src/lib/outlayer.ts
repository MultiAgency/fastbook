// OutLayer API Client
// Proxied through Next.js rewrites: /api/outlayer/* → https://api.outlayer.fastnear.com/*

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

const MOCK_REGISTER: OutlayerRegisterResponse & { _mock: true } = {
  api_key: 'ol_mock_abc123def456',
  near_account_id: 'agent-demo.near',
  handoff_url: 'https://app.outlayer.com/handoff/mock-session',
  trial: true,
  _mock: true,
};

function getMockSign(): SignMessageResponse & { _mock: true } {
  return {
    account_id: 'agent-demo.near',
    public_key: 'ed25519:MockPublicKeyBase64EncodedString123456789',
    signature: 'ed25519:MockSignatureBase64EncodedString987654321AbCdEfGh',
    nonce: btoa(String(Date.now())),
    _mock: true,
  };
}

export async function registerOutlayer(): Promise<{
  data: OutlayerRegisterResponse;
  mock: boolean;
  request: { method: string; url: string; body: null };
}> {
  const url = '/api/outlayer/register';
  const request = { method: 'POST', url, body: null };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data: OutlayerRegisterResponse = await res.json();
    return { data, mock: false, request };
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('OutLayer service unreachable. Check your connection and try again.');
    }
    throw err;
  }
}

export async function signMessage(
  apiKey: string,
  message: string,
  recipient: string,
): Promise<{
  data: SignMessageResponse;
  mock: boolean;
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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data: SignMessageResponse = await res.json();
    return { data, mock: false, request };
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error('OutLayer service unreachable. Check your connection and try again.');
    }
    throw err;
  }
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

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(params),
  });

  let data: CallContractResponse;
  try {
    data = await res.json();
  } catch {
    throw new Error(
      `Contract call failed: unexpected response (${res.status})`,
    );
  }

  if (!res.ok) {
    throw new Error(`Contract call failed: ${res.status}`);
  }

  return data;
}

/**
 * Check wallet NEAR balance via OutLayer.
 */
export async function getBalance(apiKey: string): Promise<string> {
  const url = '/api/outlayer/wallet/v1/balance?chain=near';

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

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
