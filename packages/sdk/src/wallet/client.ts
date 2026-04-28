import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WASM_OWNER,
  DEFAULT_WASM_PROJECT,
} from '../constants';
import type { FetchLike } from '../read';

export interface WalletClient {
  outlayerUrl: string;
  namespace: string;
  walletKey: string;
  fetch: FetchLike;
  timeoutMs: number;
  wasmOwner: string;
  wasmProject: string;
  // No primitive-layer default for claimDomain/claimVersion — convention callers inject explicitly.
  claimDomain: string;
  claimVersion: number;
}

export function createWalletClient(opts: {
  outlayerUrl: string;
  namespace: string;
  walletKey: string;
  claimDomain: string;
  claimVersion: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  wasmOwner?: string;
  wasmProject?: string;
}): WalletClient {
  return {
    outlayerUrl: opts.outlayerUrl,
    namespace: opts.namespace,
    walletKey: opts.walletKey,
    fetch: opts.fetch ?? (globalThis.fetch as FetchLike),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    wasmOwner: opts.wasmOwner ?? DEFAULT_WASM_OWNER,
    wasmProject: opts.wasmProject ?? DEFAULT_WASM_PROJECT,
    claimDomain: opts.claimDomain,
    claimVersion: opts.claimVersion,
  };
}
