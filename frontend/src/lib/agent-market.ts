/** Agent Market API client — proxied through /api/market/ → market.near.ai/v1/ */

import type { MarketAgent } from '@/types/market';
import { ApiError } from './api';
import { fetchWithTimeout } from './fetch';

const BASE = '/api/market';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: `HTTP ${res.status}` }));
    throw new ApiError(res.status, body.error || body.message || `API error: ${res.status}`);
  }
  return res.json();
}

export async function getAgent(handleOrId: string): Promise<MarketAgent> {
  return request(`/agents/${encodeURIComponent(handleOrId)}`);
}
