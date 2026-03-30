import { NextResponse } from 'next/server';
import {
  LIMITS,
  OUTLAYER_API_URL,
  OUTLAYER_PROJECT_NAME,
  OUTLAYER_PROJECT_OWNER,
} from '@/lib/constants';
import { fetchWithTimeout } from '@/lib/fetch';
import { PUBLIC_ACTIONS, queryFieldsForAction } from '@/lib/routes';
import { wasmCodeToStatus } from '@/lib/utils';

const COMMON_FIELDS = ['action', 'handle'];

const PUBLIC_ACTION_FIELDS: Record<string, readonly string[]> = {};
for (const action of PUBLIC_ACTIONS) {
  PUBLIC_ACTION_FIELDS[action] = queryFieldsForAction(action);
}

interface WasmResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  hint?: string;
  retry_after?: number;
  pagination?: {
    limit: number;
    next_cursor?: string;
    cursor_reset?: boolean;
  };
}

function isWasmShape(v: unknown): v is WasmResponse {
  if (typeof v !== 'object' || v === null || !('success' in v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.success === 'boolean' &&
    (r.error === undefined || typeof r.error === 'string') &&
    (r.code === undefined || typeof r.code === 'string')
  );
}

const MAX_RESPONSE_BYTES = LIMITS.MAX_RESPONSE_BYTES;

export function decodeOutlayerResponse<T = unknown>(
  result: unknown,
): WasmResponse<T> {
  if (typeof result === 'string') {
    if (result.length > MAX_RESPONSE_BYTES) {
      throw new Error('OutLayer response too large');
    }
    let decoded: string;
    try {
      decoded = atob(result);
    } catch {
      throw new Error('Invalid base64 in OutLayer response');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      throw new Error('Invalid JSON in OutLayer base64 payload');
    }
    if (isWasmShape(parsed)) return parsed as WasmResponse<T>;
    throw new Error('Unexpected OutLayer response format');
  }

  if (typeof result !== 'object' || result === null) {
    throw new Error('Unexpected OutLayer response format');
  }

  const r = result as Record<string, unknown>;

  if (r.output) {
    if (typeof r.output === 'string' && r.output.length > MAX_RESPONSE_BYTES) {
      throw new Error('OutLayer output field too large');
    }
    let decoded: unknown;
    try {
      decoded =
        typeof r.output === 'string' ? JSON.parse(atob(r.output)) : r.output;
    } catch {
      throw new Error('Invalid base64 in OutLayer output field');
    }
    if (isWasmShape(decoded)) return decoded as WasmResponse<T>;
    throw new Error('OutLayer output is not a valid WASM response');
  }

  if (isWasmShape(r)) return r as WasmResponse<T>;

  throw new Error('Unexpected OutLayer response format');
}

export function getOutlayerPaymentKey(): string {
  const key = process.env.OUTLAYER_PAYMENT_KEY || '';
  if (process.env.NODE_ENV === 'production' && !key) {
    throw new Error(
      'OUTLAYER_PAYMENT_KEY is not set — the API cannot function without it. Set this env var and redeploy.',
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Auto-sign: mint a verifiable_claim for trial wallet keys (wk_).
//
// Trial wk_ keys don't carry NEAR identity into WASM execution.  To resolve
// the wallet's account, we call the free /wallet/v1/sign-message endpoint
// and inject the result as a verifiable_claim before forwarding to WASM.
//
// Two caches avoid redundant calls:
//   accountCache  — wk_ → account_id  (deterministic, never expires)
//   claimCache    — wk_:action → signed claim  (4 min TTL)
//
// First request for a new wk_ key costs 2 sign calls (resolve + sign).
// Subsequent requests with a warm account cache cost 1 sign call.
// Cache-hit requests cost 0.
// ---------------------------------------------------------------------------

interface CachedClaim {
  near_account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
  expiresAt: number;
}

const accountCache = new Map<string, string>();
const claimCache = new Map<string, CachedClaim>();
const CLAIM_TTL_MS = 4 * 60 * 1000; // 4 minutes (within 5-minute NEP-413 window)
const SIGN_TIMEOUT_MS = 5_000;

async function signMessage(
  walletKey: string,
  message: string,
): Promise<Record<string, string> | null> {
  let resp: Response;
  try {
    resp = await fetchWithTimeout(
      `${OUTLAYER_API_URL}/wallet/v1/sign-message`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${walletKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message, recipient: 'nearly.social' }),
      },
      SIGN_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  try {
    const r = (await resp.json()) as Record<string, unknown>;
    if (
      typeof r.account_id === 'string' &&
      typeof r.public_key === 'string' &&
      typeof r.signature === 'string' &&
      typeof r.nonce === 'string'
    ) {
      return r as unknown as Record<string, string>;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveAccountId(walletKey: string): Promise<string | null> {
  const cached = accountCache.get(walletKey);
  if (cached) return cached;

  // Sign a throwaway message just to learn the account_id.
  const msg = JSON.stringify({ action: 'resolve', domain: 'nearly.social' });
  const result = await signMessage(walletKey, msg);
  if (!result) return null;

  accountCache.set(walletKey, result.account_id);
  return result.account_id;
}

export async function mintClaimForWalletKey(
  walletKey: string,
  action: string,
): Promise<CachedClaim | null> {
  const now = Date.now();

  const cacheKey = `${walletKey}:${action}`;
  const cached = claimCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached;

  const accountId = await resolveAccountId(walletKey);
  if (!accountId) return null;

  const message = JSON.stringify({
    action,
    domain: 'nearly.social',
    account_id: accountId,
    version: 1,
    timestamp: now,
  });

  const result = await signMessage(walletKey, message);
  if (!result) return null;

  const claim: CachedClaim = {
    near_account_id: accountId,
    public_key: result.public_key,
    signature: result.signature,
    nonce: result.nonce,
    message,
    expiresAt: now + CLAIM_TTL_MS,
  };

  claimCache.set(cacheKey, claim);
  return claim;
}

const OUTLAYER_RESOURCE_LIMITS = {
  max_instructions: 2_000_000_000,
  max_memory_mb: 512,
  max_execution_seconds: 120,
} as const;

const STRUCTURED_FIELDS = new Set(['tags', 'capabilities', 'handles']);

export function sanitizePublic(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const action = body.action as string | undefined;
  const allowed = new Set([
    ...COMMON_FIELDS,
    ...((action && PUBLIC_ACTION_FIELDS[action]) || []),
  ]);
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key) || value == null) continue;
    if (STRUCTURED_FIELDS.has(key)) {
      clean[key] = value;
    } else {
      const t = typeof value;
      if (t === 'string' || t === 'number' || t === 'boolean') {
        clean[key] = value;
      }
    }
  }
  return clean;
}

function errJson(
  error: string,
  status: number,
  code = 'INTERNAL_ERROR',
): NextResponse {
  return NextResponse.json({ success: false, error, code }, { status });
}

export async function callOutlayer(
  wasmBody: Record<string, unknown>,
  authKey: string,
): Promise<NextResponse> {
  const url = `${OUTLAYER_API_URL}/call/${OUTLAYER_PROJECT_OWNER}/${OUTLAYER_PROJECT_NAME}`;

  const isWalletKey = authKey.startsWith('wk_');
  const authHeaders: Record<string, string> = isWalletKey
    ? { Authorization: `Bearer ${authKey}` }
    : { 'X-Payment-Key': authKey };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        input: wasmBody,
        resource_limits: OUTLAYER_RESOURCE_LIMITS,
      }),
    });
  } catch {
    return errJson('Upstream unreachable', 502);
  }

  if (!response.ok) {
    if (response.status === 402) {
      return errJson(
        'OutLayer quota exhausted — top up the payment key balance',
        503,
      );
    }
    return errJson(
      `Upstream error: ${response.status}`,
      response.status >= 400 && response.status < 500 ? response.status : 502,
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    return errJson('Invalid JSON from OutLayer', 502);
  }

  if (
    typeof result === 'object' &&
    result !== null &&
    (result as Record<string, unknown>).status === 'failed'
  ) {
    return errJson('WASM execution failed', 502);
  }

  try {
    const decoded = decodeOutlayerResponse(result);
    return NextResponse.json(decoded, {
      status: decoded.success ? 200 : wasmCodeToStatus(decoded.code),
    });
  } catch {
    return errJson('Failed to decode WASM output', 502);
  }
}
