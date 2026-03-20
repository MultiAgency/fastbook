import type { Nep413Auth } from '@/types';
import { API_TIMEOUT_MS } from './constants';
import { fetchWithTimeout, httpErrorText } from './fetch';

// Use the same-origin proxy to avoid sending API keys directly to external APIs
const OUTLAYER_PROXY_BASE = '/api/outlayer';
const PROJECT_OWNER = process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_OWNER || '';
const PROJECT_NAME = process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_NAME || 'nearly';

interface WasmResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  pagination?: {
    limit: number;
    nextCursor?: string;
  };
}

/** Type guard: checks that a value has the shape of a WasmResponse. */
function isWasmShape(v: unknown): v is WasmResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'success' in v &&
    typeof (v as Record<string, unknown>).success === 'boolean'
  );
}

/**
 * Decode an OutLayer API response, handling base64 and envelope formats.
 * Shared by executeWasm (client-side via proxy) and publicRequest (server-side direct).
 */
export function decodeOutlayerResponse<T = unknown>(
  result: unknown,
): WasmResponse<T> {
  if (typeof result === 'string') {
    const parsed: unknown = JSON.parse(atob(result));
    if (isWasmShape(parsed)) return parsed as WasmResponse<T>;
    throw new Error('Unexpected OutLayer response format');
  }

  if (typeof result !== 'object' || result === null) {
    throw new Error('Unexpected OutLayer response format');
  }

  const r = result as Record<string, unknown>;

  if (r.output) {
    const decoded =
      typeof r.output === 'string' ? JSON.parse(atob(r.output)) : r.output;
    if (isWasmShape(decoded)) return decoded as WasmResponse<T>;
    throw new Error('OutLayer output is not a valid WASM response');
  }

  if (isWasmShape(r)) return r as WasmResponse<T>;

  throw new Error('Unexpected OutLayer response format');
}

export class OutlayerExecError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'OutlayerExecError';
  }
}

/**
 * Execute a WASM action on the OutLayer project.
 *
 * @param apiKey - OutLayer wallet API key (format: wk_...)
 * @param action - The WASM action name (e.g., 'get_me', 'register', 'follow')
 * @param args - Additional arguments for the action
 * @param auth - NEP-413 auth for authenticated endpoints
 */
export async function executeWasm<T = unknown>(
  apiKey: string,
  action: string,
  args: Record<string, unknown> = {},
  auth?: Nep413Auth,
): Promise<WasmResponse<T>> {
  const url = `${OUTLAYER_PROXY_BASE}/call/${PROJECT_OWNER}/${PROJECT_NAME}`;

  const input = {
    action,
    ...args,
    ...(auth ? { auth } : {}),
  };

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(input),
    },
    API_TIMEOUT_MS,
  );

  if (!response.ok) {
    const text = await httpErrorText(response);
    throw new OutlayerExecError(
      `OutLayer execution failed: ${response.status} ${text}`,
    );
  }

  const result = await response.json();

  let wasmOutput: WasmResponse<T>;
  try {
    wasmOutput = decodeOutlayerResponse<T>(result);
  } catch {
    throw new OutlayerExecError('Failed to decode WASM output');
  }

  if (!wasmOutput.success) {
    throw new OutlayerExecError(wasmOutput.error || 'WASM action failed');
  }

  return wasmOutput;
}
