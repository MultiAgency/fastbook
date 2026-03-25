import { NextResponse } from 'next/server';
import {
  LIMITS,
  OUTLAYER_API_URL,
  OUTLAYER_PROJECT_NAME,
  OUTLAYER_PROJECT_OWNER,
  OUTLAYER_TIMEOUT_MS,
} from '@/lib/constants';
import { fetchWithTimeout } from '@/lib/fetch';
import { PUBLIC_ACTIONS, queryFieldsForAction } from '@/lib/routes';

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
  pagination?: {
    limit: number;
    next_cursor?: string;
    cursor_reset?: boolean;
  };
}

function isWasmShape(v: unknown): v is WasmResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'success' in v &&
    typeof (v as Record<string, unknown>).success === 'boolean'
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
    const parsed: unknown = JSON.parse(decoded);
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

const OUTLAYER_RESOURCE_LIMITS = {
  max_instructions: 2_000_000_000,
  max_memory_mb: 512,
  max_execution_seconds: 120,
} as const;

const STRUCTURED_FIELDS = new Set(['tags', 'capabilities']);

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

function wasmErrorStatus(code?: string): number {
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_FAILED':
    case 'NONCE_REPLAY':
      return 401;
    case 'NOT_FOUND':
    case 'NOT_REGISTERED':
      return 404;
    case 'RATE_LIMITED':
      return 429;
    case 'ROLLBACK_PARTIAL':
      return 500;
    default:
      return 400;
  }
}

function errJson(error: string, status: number): NextResponse {
  return NextResponse.json({ success: false, error }, { status });
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
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          input: wasmBody,
          resource_limits: OUTLAYER_RESOURCE_LIMITS,
        }),
      },
      OUTLAYER_TIMEOUT_MS,
    );
  } catch {
    return errJson('Upstream timeout', 504);
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
      status: decoded.success ? 200 : wasmErrorStatus(decoded.code),
    });
  } catch {
    return errJson('Failed to decode WASM output', 502);
  }
}
