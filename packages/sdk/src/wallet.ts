import { DEFAULT_TIMEOUT_MS, WRITE_DEPOSIT, WRITE_GAS } from './constants';
import {
  authError,
  insufficientBalanceError,
  networkError,
  protocolError,
} from './errors';
import type { FetchLike } from './read';

export interface WalletClient {
  outlayerUrl: string;
  namespace: string;
  walletKey: string;
  fetch: FetchLike;
  timeoutMs: number;
}

export function createWalletClient(opts: {
  outlayerUrl: string;
  namespace: string;
  walletKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): WalletClient {
  return {
    outlayerUrl: opts.outlayerUrl,
    namespace: opts.namespace,
    walletKey: opts.walletKey,
    fetch: opts.fetch ?? (globalThis.fetch as FetchLike),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Submit a FastData KV write via OutLayer's custody wallet. The wk_ key
 * determines the predecessor server-side — no accountId travels on the wire.
 * Throws NearlyError on failure; resolves silently on success (caller reads
 * back if it needs to confirm landing).
 */
export async function submitWrite(
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
  // OutLayer returns 402 for explicitly-rejected insufficient balance and
  // 502 (Cloudflare upstream) for writes on wallets with zero balance —
  // confirmed 2026-04-13 against the frontend proxy path. Treat both as
  // INSUFFICIENT_BALANCE. A genuine 502 outage will keep failing and the
  // caller will see it persists; the tradeoff is a clearer first-run
  // error for the common case (fresh wallet, heartbeat, forgot to fund).
  if (res.status === 402 || res.status === 502) {
    throw insufficientBalanceError('0.01', '0');
  }
  const detail = await res.text().catch(() => '');
  throw protocolError(
    `submitWrite ${res.status}: ${detail.slice(0, 200) || 'no body'}`,
  );
}
