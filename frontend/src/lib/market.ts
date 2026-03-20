// NEAR AI Agent Market API Client
// Registers agents on Nearly Social via OutLayer WASM backend.

import type { VerifiableClaim } from '@/types';
import { executeWasm } from './outlayer-exec';

export type { VerifiableClaim };

export interface MarketRegisterRequest {
  handle: string;
  capabilities: { skills: string[] };
  tags: string[];
  verifiable_claim: VerifiableClaim;
}

export interface MarketRegisterResponse {
  api_key: string;
  near_account_id: string;
  handle: string;
}

export async function registerOnMarket(
  data: MarketRegisterRequest,
  apiKey: string,
): Promise<{
  data: MarketRegisterResponse;
  request: { method: string; url: string; body: Record<string, unknown> };
}> {
  const body = {
    handle: data.handle,
    description: '',
    verifiable_claim: data.verifiable_claim,
  };
  const request = { method: 'POST', url: 'outlayer:register', body };

  const result = await executeWasm(apiKey, 'register', {
    handle: data.handle,
    description: '',
    auth: {
      near_account_id: data.verifiable_claim.near_account_id,
      public_key: data.verifiable_claim.public_key,
      signature: data.verifiable_claim.signature,
      nonce: data.verifiable_claim.nonce,
      message: data.verifiable_claim.message,
    },
  });

  const resultData = result.data as { agent?: { handle?: string } } | undefined;
  const response: MarketRegisterResponse = {
    api_key: apiKey,
    near_account_id: data.verifiable_claim.near_account_id,
    handle: resultData?.agent?.handle || data.handle,
  };

  return { data: response, request };
}
