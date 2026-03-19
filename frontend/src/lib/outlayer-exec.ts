import type { Nep413Auth } from '@/types';

const OUTLAYER_API_URL =
  process.env.NEXT_PUBLIC_OUTLAYER_API_URL || 'https://api.outlayer.fastnear.com';
const PROJECT_OWNER =
  process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_OWNER || '';
const PROJECT_NAME =
  process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_NAME || 'nearly';

interface WasmResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  pagination?: {
    limit: number;
    next_cursor?: string;
  };
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
 * @param paymentKey - OutLayer Payment Key (format: owner:nonce:secret)
 * @param action - The WASM action name (e.g., 'get_me', 'register', 'follow')
 * @param args - Additional arguments for the action
 * @param auth - NEP-413 auth for authenticated endpoints
 */
export async function executeWasm<T = unknown>(
  paymentKey: string,
  action: string,
  args: Record<string, unknown> = {},
  auth?: Nep413Auth,
): Promise<WasmResponse<T>> {
  const url = `${OUTLAYER_API_URL}/call/${PROJECT_OWNER}/${PROJECT_NAME}`;

  const input = {
    action,
    ...args,
    ...(auth ? { auth } : {}),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment-Key': paymentKey,
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    throw new OutlayerExecError(`OutLayer execution failed: ${response.status} ${text}`);
  }

  const result = await response.json();

  // OutLayer wraps the WASM stdout in a result envelope
  // The actual WASM output is the JSON our module writes to stdout
  let wasmOutput: WasmResponse<T>;

  if (typeof result === 'string') {
    // Base64-encoded output
    try {
      const decoded = atob(result);
      wasmOutput = JSON.parse(decoded);
    } catch {
      throw new OutlayerExecError('Failed to decode WASM output');
    }
  } else if (result?.output) {
    // Output field in the response
    try {
      const decoded = typeof result.output === 'string'
        ? JSON.parse(atob(result.output))
        : result.output;
      wasmOutput = decoded;
    } catch {
      throw new OutlayerExecError('Failed to parse WASM output');
    }
  } else if (result?.success !== undefined) {
    // Direct JSON response
    wasmOutput = result;
  } else {
    throw new OutlayerExecError('Unexpected OutLayer response format');
  }

  if (!wasmOutput.success) {
    throw new OutlayerExecError(wasmOutput.error || 'WASM action failed');
  }

  return wasmOutput;
}
