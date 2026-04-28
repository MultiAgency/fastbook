import { WRITE_DEPOSIT, WRITE_GAS } from '../constants';
import {
  authError,
  insufficientBalanceError,
  networkError,
  protocolError,
} from '../errors';
import type { VerifiableClaim } from '../types';
import type { WalletClient } from './client';

export async function responseDetail(res: Response): Promise<string> {
  const detail = await res.text().catch(() => '');
  return detail || 'no body';
}

export async function writeEntries(
  client: WalletClient,
  entries: Record<string, unknown>,
): Promise<void> {
  const url = `${client.outlayerUrl}/wallet/v1/call`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), client.timeoutMs);
  let res: Response;
  try {
    res = await client.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${client.walletKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receiver_id: client.namespace,
        method_name: '__fastdata_kv',
        args: entries,
        gas: WRITE_GAS,
        deposit: WRITE_DEPOSIT,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (res.ok) return;

  if (res.status === 401 || res.status === 403) {
    throw authError(`OutLayer rejected credentials (${res.status})`);
  }
  // Zero-balance writes return 502 + text/plain (Cloudflare upstream).
  if (res.status === 502) {
    throw insufficientBalanceError('0.01', '0');
  }
  throw protocolError(
    `writeEntries ${res.status}: ${await responseDetail(res)}`,
  );
}

export interface BalanceResponse {
  accountId: string;
  chain: string;
  balance: string;
  balanceNear?: number;
}

// Missing fields surface as protocolError, not silent zeros (would mislead funded callers).
export async function getBalance(
  client: WalletClient,
  chain: string = 'near',
): Promise<BalanceResponse> {
  const url = `${client.outlayerUrl}/wallet/v1/balance?chain=${encodeURIComponent(chain)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), client.timeoutMs);
  let res: Response;
  try {
    res = await client.fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${client.walletKey}` },
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`OutLayer rejected credentials (${res.status})`);
    }
    throw protocolError(
      `getBalance ${res.status}: ${await responseDetail(res)}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('getBalance: malformed JSON in 2xx response');
  }
  if (!body || typeof body !== 'object') {
    throw protocolError('getBalance: response body is not an object');
  }
  const b = body as Record<string, unknown>;
  const balance = b.balance;
  const accountId = b.account_id;
  if (typeof balance !== 'string' || !balance) {
    throw protocolError('getBalance: response missing balance');
  }
  if (typeof accountId !== 'string' || !accountId) {
    throw protocolError('getBalance: response missing account_id');
  }

  // Yocto → pico → float keeps 12 decimals under MAX_SAFE_INTEGER for balances ≲9M NEAR.
  let balanceNear: number | undefined;
  if (chain === 'near') {
    try {
      const pico = Number(BigInt(balance) / BigInt('1000000000000'));
      const asNum = pico / 1e12;
      if (Number.isFinite(asNum)) balanceNear = asNum;
    } catch {
      // BigInt() throws on non-numeric strings; leave balanceNear undefined.
    }
  }

  return { accountId, chain, balance, balanceNear };
}

export interface SignMessageInput {
  message: string;
  recipient: string;
  format?: 'nep413' | 'raw';
}

export async function signMessage(
  client: WalletClient,
  input: SignMessageInput,
): Promise<VerifiableClaim> {
  const wireBody: Record<string, unknown> = {
    message: input.message,
    recipient: input.recipient,
  };
  if (input.format === 'raw') wireBody.format = 'raw';

  const url = `${client.outlayerUrl}/wallet/v1/sign-message`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), client.timeoutMs);
  let res: Response;
  try {
    res = await client.fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${client.walletKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(wireBody),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`OutLayer rejected sign-message (${res.status})`);
    }
    throw protocolError(
      `signMessage ${res.status}: ${await responseDetail(res)}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('signMessage: malformed JSON in 2xx response');
  }
  if (!body || typeof body !== 'object') {
    throw protocolError('signMessage: response body is not an object');
  }
  const b = body as Record<string, unknown>;
  if (
    typeof b.account_id !== 'string' ||
    typeof b.public_key !== 'string' ||
    typeof b.signature !== 'string' ||
    typeof b.nonce !== 'string'
  ) {
    throw protocolError('signMessage: response missing claim fields');
  }
  return {
    account_id: b.account_id,
    public_key: b.public_key,
    signature: b.signature as string,
    nonce: b.nonce as string,
    message: input.message,
  };
}

// Mirror of frontend/src/lib/outlayer-server.ts; divergence breaks SDK/proxy gas parity.
const OUTLAYER_RESOURCE_LIMITS = {
  max_instructions: 2_000_000_000,
  max_memory_mb: 512,
  max_execution_seconds: 30,
} as const;

export interface WasmResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  hint?: string;
  retry_after?: number;
}

function isWasmResponse(v: unknown): v is WasmResponse {
  if (typeof v !== 'object' || v === null || !('success' in v)) return false;
  return typeof (v as { success: unknown }).success === 'boolean';
}

// Three shapes: top-level WasmResponse, {output: base64-json}, or raw base64 string.
function decodeWasmResponse(result: unknown): WasmResponse {
  if (typeof result === 'string') {
    let decoded: string;
    try {
      decoded = atob(result);
    } catch {
      throw protocolError('callOutlayer: invalid base64 in response');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw protocolError('callOutlayer: invalid JSON in base64 payload');
    }
    if (isWasmResponse(parsed)) return parsed;
    throw protocolError('callOutlayer: decoded body is not a WASM response');
  }

  if (typeof result !== 'object' || result === null) {
    throw protocolError('callOutlayer: unexpected response type');
  }

  const r = result as Record<string, unknown>;
  if (r.output !== undefined) {
    let decoded: unknown;
    try {
      decoded =
        typeof r.output === 'string' ? JSON.parse(atob(r.output)) : r.output;
    } catch {
      throw protocolError('callOutlayer: invalid base64 in output field');
    }
    if (isWasmResponse(decoded)) return decoded;
    throw protocolError('callOutlayer: output field is not a WASM response');
  }

  if (isWasmResponse(r)) return r;
  throw protocolError('callOutlayer: response missing success flag');
}

// wk_ → Authorization: Bearer, anything else → X-Payment-Key (matches proxy branching).
export async function callOutlayer(
  client: WalletClient,
  wasmBody: Record<string, unknown>,
): Promise<WasmResponse> {
  const url = `${client.outlayerUrl}/call/${client.wasmOwner}/${client.wasmProject}`;
  const isWalletKey = client.walletKey.startsWith('wk_');
  const authHeaders: Record<string, string> = isWalletKey
    ? { Authorization: `Bearer ${client.walletKey}` }
    : { 'X-Payment-Key': client.walletKey };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), client.timeoutMs);
  let res: Response;
  try {
    res = await client.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        input: wasmBody,
        resource_limits: OUTLAYER_RESOURCE_LIMITS,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`OutLayer rejected credentials (${res.status})`);
    }
    if (res.status === 402 || res.status === 502) {
      throw insufficientBalanceError('0.01', '0');
    }
    throw protocolError(
      `callOutlayer ${res.status}: ${await responseDetail(res)}`,
    );
  }

  let result: unknown;
  try {
    result = await res.json();
  } catch {
    throw protocolError('callOutlayer: malformed JSON in 2xx response');
  }

  // OutLayer signals WASM execution failures with top-level status: "failed".
  if (
    typeof result === 'object' &&
    result !== null &&
    (result as { status?: unknown }).status === 'failed'
  ) {
    throw protocolError('callOutlayer: WASM execution failed');
  }

  return decodeWasmResponse(result);
}
