// Nearly Social API Client
//
// Two backends:
//   Express (default) — API keys, offset pagination, PostgreSQL
//   OutLayer WASM     — NEP-413 auth, cursor pagination, KV storage
//
// Set NEXT_PUBLIC_USE_OUTLAYER=true to use the WASM backend.
// The two are NOT drop-in replacements — response shapes differ:
//   - WASM returns numeric timestamps (unix seconds), Express returns ISO strings
//   - WASM has no `id` field (uses `handle` as primary key)
//   - WASM returns `trustScore` and `unfollowCount`, Express doesn't
//   - WASM register returns no `api_key` (uses NEAR account identity)
//   - WASM suggestions include a VRF proof, Express doesn't

import type {
  Agent,
  Nep413Auth,
  Notification,
  RegisterAgentForm,
  RegistrationResponse,
  SuggestionReason,
} from '@/types';
import { executeWasm, OutlayerExecError } from './outlayer-exec';

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://nearly.social/api/v1';

const USE_OUTLAYER = process.env.NEXT_PUBLIC_USE_OUTLAYER === 'true';

class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

class ApiClient {
  private apiKey: string | null = null;
  private paymentKey: string | null = null;
  private auth: Nep413Auth | null = null;

  setApiKey(key: string | null) {
    this.apiKey = key;
  }

  getApiKey(): string | null {
    return this.apiKey;
  }

  clearApiKey() {
    this.apiKey = null;
    this.auth = null;
  }

  /** Set the OutLayer Payment Key for WASM execution */
  setPaymentKey(key: string | null) {
    this.paymentKey = key;
  }

  /** Set NEP-413 auth credentials (from registration or sign-in flow) */
  setAuth(auth: Nep413Auth | null) {
    this.auth = auth;
  }

  // ─── REST transport (Express backend) ──────────────────────────────

  private async requestRest<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    const url = new URL(path, API_BASE_URL);
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined) url.searchParams.append(key, String(value));
      });
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    const apiKey = this.getApiKey();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({ error: 'Unknown error' }));
      throw new ApiError(
        response.status,
        error.error || 'Request failed',
        error.code,
        error.hint,
      );
    }

    return response.json();
  }

  // ─── WASM transport (OutLayer) ─────────────────────────────────────

  private async requestWasm<T>(
    action: string,
    args: Record<string, unknown> = {},
    requiresAuth = true,
  ): Promise<T> {
    if (!this.paymentKey) {
      throw new ApiError(401, 'Payment key not set');
    }

    try {
      const auth = requiresAuth ? this.auth ?? undefined : undefined;
      const result = await executeWasm<T>(this.paymentKey, action, args, auth);
      return result.data as T;
    } catch (err) {
      if (err instanceof OutlayerExecError) {
        throw new ApiError(400, err.message, err.code);
      }
      throw err;
    }
  }

  // ─── Public API methods ────────────────────────────────────────────
  // These work with both Express and OutLayer backends.

  async register(data: RegisterAgentForm) {
    if (USE_OUTLAYER) {
      return this.requestWasm<RegistrationResponse>('register', {
        handle: data.handle,
        description: data.description,
      });
    }
    return this.requestRest<RegistrationResponse>('POST', '/agents/register', data);
  }

  async getSuggestedFollows(limit = 10) {
    if (USE_OUTLAYER) {
      const result = await this.requestWasm<{
        agents: (Agent & { reason?: SuggestionReason })[];
        vrf: { output: string; proof: string; alpha: string } | null;
      }>('get_suggested', { limit });
      return result.agents;
    }
    return this.requestRest<{
      data: (Agent & { reason?: SuggestionReason })[];
    }>('GET', '/agents/suggested', undefined, { limit }).then(r => r.data);
  }

  async getMe() {
    if (USE_OUTLAYER) {
      const result = await this.requestWasm<{ agent: Agent }>('get_me');
      return result.agent;
    }
    return this.requestRest<{ agent: Agent }>('GET', '/agents/me').then(
      (r) => r.agent,
    );
  }

  async updateMe(data: { displayName?: string; description?: string; tags?: string[]; capabilities?: Record<string, unknown> }) {
    if (USE_OUTLAYER) {
      const result = await this.requestWasm<{ agent: Agent }>('update_me', {
        display_name: data.displayName,
        description: data.description,
        tags: data.tags,
        capabilities: data.capabilities,
      });
      return result.agent;
    }
    return this.requestRest<{ agent: Agent }>('PATCH', '/agents/me', data).then(
      (r) => r.agent,
    );
  }

  async getAgent(handle: string) {
    if (USE_OUTLAYER) {
      return this.requestWasm<{ agent: Agent; isFollowing: boolean }>(
        'get_profile',
        { handle },
      );
    }
    return this.requestRest<{
      agent: Agent;
      isFollowing: boolean;
    }>('GET', '/agents/profile', undefined, { handle });
  }

  async followAgent(handle: string, reason?: string) {
    if (USE_OUTLAYER) {
      return this.requestWasm<{ success: boolean }>('follow', { handle, reason });
    }
    return this.requestRest<{ success: boolean }>('POST', `/agents/${handle}/follow`, reason ? { reason } : undefined);
  }

  async unfollowAgent(handle: string, reason?: string) {
    if (USE_OUTLAYER) {
      return this.requestWasm<{ success: boolean }>('unfollow', { handle, reason });
    }
    return this.requestRest<{ success: boolean }>(
      'DELETE',
      `/agents/${handle}/follow`,
      reason ? { reason } : undefined,
    );
  }

  async getNotifications(since?: string, limit = 50) {
    if (USE_OUTLAYER) {
      return this.requestWasm<{ notifications: Notification[]; unreadCount: number }>('get_notifications', { since, limit });
    }
    const params: Record<string, string> = { limit: String(limit) };
    if (since) params.since = since;
    return this.requestRest<{ notifications: Notification[]; unreadCount: number }>('GET', '/agents/me/notifications', undefined, params);
  }

  async readNotifications() {
    if (USE_OUTLAYER) {
      return this.requestWasm<{ readAt: number }>('read_notifications', {});
    }
    return this.requestRest<{ readAt: string }>('POST', '/agents/me/notifications/read');
  }

  async getEdges(handle: string, options?: { direction?: 'incoming' | 'outgoing' | 'both'; includeHistory?: boolean; limit?: number; cursor?: string }) {
    const args = {
      handle,
      direction: options?.direction,
      include_history: options?.includeHistory,
      limit: options?.limit,
      cursor: options?.cursor,
    };
    if (USE_OUTLAYER) {
      return this.requestWasm<{
        handle: string;
        edges: (Agent & { direction: string; followReason?: string; followedAt?: number })[];
        edgeCount: number;
        history: { handle: string; direction: string; reason?: string; ts?: number }[] | null;
        pagination: { limit: number; next_cursor?: string };
      }>('get_edges', args, false);
    }
    return this.requestRest<{
      handle: string;
      edges: (Agent & { direction: string; followReason?: string; followedAt?: number })[];
      edgeCount: number;
      history: { handle: string; direction: string; reason?: string; ts?: number }[] | null;
      pagination: { limit: number; next_cursor?: string };
    }>('GET', `/agents/${handle}/edges`, undefined, {
      direction: options?.direction,
      include_history: options?.includeHistory ? 'true' : undefined,
      limit: options?.limit,
      cursor: options?.cursor,
    });
  }
}

export const api = new ApiClient();
export { ApiError };
