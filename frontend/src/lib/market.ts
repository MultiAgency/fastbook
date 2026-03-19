// NEAR AI Agent Market API Client — MOCKED
// This endpoint does not exist yet. This prototype proposes its creation.

import type { VerifiableClaim } from '@/types';

export type { VerifiableClaim };

export interface MarketRegisterRequest {
  handle: string;
  capabilities: { skills: string[] };
  tags: string[];
  verifiable_claim: VerifiableClaim;
}

export interface MarketRegisterResponse {
  agent_id: string;
  api_key: string;
  near_account_id: string;
  handle: string;
}

/** Discriminated union — narrows type based on `mock` field */
export type MarketRegisterResult =
  | {
      data: MarketRegisterResponse;
      mock: true;
      request: { method: string; url: string; body: MarketRegisterRequest };
    }
  | {
      data: MarketRegisterResponse;
      mock: false;
      request: { method: string; url: string; body: LiveRegisterBody };
    };

// Live request body shape (Nearly Social API)
interface LiveRegisterBody {
  handle: string;
  description: string;
  verifiable_claim: VerifiableClaim;
}

export async function registerOnMarket(
  data: MarketRegisterRequest,
): Promise<Extract<MarketRegisterResult, { mock: true }>> {
  const url = 'https://market.near.ai/v1/agents/register';
  const request = { method: 'POST', url, body: data };

  // Simulate network delay
  await new Promise((resolve) => setTimeout(resolve, 200));

  const response: MarketRegisterResponse = {
    agent_id: crypto.randomUUID(),
    api_key: `sk_live_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    near_account_id: data.verifiable_claim.near_account_id,
    handle: data.handle,
  };

  return { data: response, mock: true, request };
}

export async function registerOnMarketLive(
  data: MarketRegisterRequest,
): Promise<Extract<MarketRegisterResult, { mock: false }>> {
  const url = '/api/social/agents/register';
  const body: LiveRegisterBody = {
    handle: data.handle,
    description: '',
    verifiable_claim: data.verifiable_claim,
  };
  const request = { method: 'POST', url, body };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      'Local API not reachable — is the Nearly Social API server running?',
    );
  }

  const json = await res.json();

  if (!res.ok) {
    throw new Error(json.error || `API error: ${res.status}`);
  }

  // Map Nearly Social API response shape to MarketRegisterResponse
  const agent = json.agent || json;
  const response: MarketRegisterResponse = {
    agent_id: agent.id || crypto.randomUUID(),
    api_key: agent.api_key,
    near_account_id:
      agent.near_account_id || data.verifiable_claim.near_account_id,
    handle: data.handle,
  };

  return { data: response, mock: false, request };
}
