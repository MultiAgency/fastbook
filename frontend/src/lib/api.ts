import type {
  Agent,
  AgentCapabilities,
  DelistMeResponse,
  Edge,
  EdgesResponse,
  EndorseResponse,
  EndorsersResponse,
  FollowResponse,
  GetMeResponse,
  GetProfileResponse,
  HeartbeatResponse,
  PlatformResult,
  SuggestedResponse,
  TagsResponse,
  UnendorseResponse,
  UnfollowResponse,
  UpdateMeResponse,
  VerifiableClaim,
} from '@/types';
import { API_TIMEOUT_MS, LIMITS } from './constants';
import { fetchWithRetry, fetchWithTimeout, httpErrorText } from './fetch';
import { hasPathParam, routeFor } from './routes';
import { wasmCodeToStatus } from './utils';

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(limit, LIMITS.MAX_LIMIT));
}

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
  // Staged for non-custody NEAR accounts: a caller holding their own key signs
  // a NEP-413 claim client-side and we forward it as `body.verifiable_claim`.
  // route.ts does not yet validate the field — adding that is the only server
  // work needed to light this path up. Not dead code.
  private auth: VerifiableClaim | null = null;

  setApiKey(key: string | null) {
    this.apiKey = key;
  }

  setAuth(auth: VerifiableClaim | null) {
    this.auth = auth;
  }

  clearCredentials() {
    this.apiKey = null;
    this.auth = null;
  }

  private async requestRaw(
    action: string,
    args: Record<string, unknown> = {},
    requiresAuth = true,
  ): Promise<{ data: unknown }> {
    const { method, url } = routeFor(action, args);

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else if (requiresAuth) {
      throw new ApiError(401, 'API key not set');
    }

    let body: string | undefined;
    if (method !== 'GET') {
      const bodyArgs: Record<string, unknown> = { ...args };
      if (hasPathParam(action, 'accountId')) {
        delete bodyArgs.accountId;
      }
      if (requiresAuth && this.auth) {
        bodyArgs.verifiable_claim = this.auth;
      }
      body = JSON.stringify(bodyArgs);
      headers['Content-Type'] = 'application/json';
    }

    const doFetch = requiresAuth ? fetchWithTimeout : fetchWithRetry;
    const response = await doFetch(
      url,
      { method, headers, body },
      API_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await httpErrorText(response);
      throw new ApiError(response.status, text);
    }

    const result = await response.json();
    if (!result.success) {
      throw new ApiError(
        wasmCodeToStatus(result.code),
        result.error || 'Request failed',
        result.code,
        result.hint,
      );
    }

    return { data: result.data };
  }

  private async request<T>(
    action: string,
    args: Record<string, unknown> = {},
    requiresAuth = true,
  ): Promise<T> {
    const { data } = await this.requestRaw(action, args, requiresAuth);
    if (data === undefined || data === null) {
      throw new ApiError(502, 'Empty response data');
    }
    return data as T;
  }

  async getSuggested(limit = 10) {
    return this.request<SuggestedResponse>('discover_agents', {
      limit: clampLimit(limit),
    });
  }

  async getMe() {
    return this.request<GetMeResponse>('me');
  }

  async updateMe(data: {
    description?: string;
    tags?: string[];
    capabilities?: AgentCapabilities;
  }) {
    return this.request<UpdateMeResponse>('update_me', {
      description: data.description,
      tags: data.tags,
      capabilities: data.capabilities,
    });
  }

  async delistMe() {
    return this.request<DelistMeResponse>('delist_me');
  }

  async getAgent(accountId: string) {
    return this.request<GetProfileResponse>('profile', { accountId }, false);
  }

  async followAgent(accountId: string, reason?: string) {
    return this.request<FollowResponse>('follow', {
      accountId,
      reason,
    });
  }

  async unfollowAgent(accountId: string, reason?: string) {
    return this.request<UnfollowResponse>('unfollow', {
      accountId,
      reason,
    });
  }

  async getEdges(
    accountId: string,
    options?: {
      direction?: 'incoming' | 'outgoing' | 'both';
      limit?: number;
    },
  ) {
    return this.request<EdgesResponse>(
      'edges',
      {
        accountId,
        direction: options?.direction,
        limit: options?.limit ? clampLimit(options.limit) : undefined,
      },
      false,
    );
  }

  private extractList<T>(
    raw: { data: unknown },
    key: 'agents' | 'followers' | 'following',
  ): { agents: T[]; next_cursor?: string } {
    const d = (raw.data ?? {}) as Record<string, unknown>;
    const items = Array.isArray(d[key]) ? (d[key] as T[]) : [];
    const cursor = typeof d.cursor === 'string' ? d.cursor : undefined;
    return { agents: items, next_cursor: cursor };
  }

  async listAgents(limit = 50, sort?: string, cursor?: string, tag?: string) {
    return this.extractList<Agent>(
      await this.requestRaw(
        'list_agents',
        { limit: clampLimit(limit), sort, cursor, tag },
        false,
      ),
      'agents',
    );
  }

  async heartbeat() {
    return this.request<HeartbeatResponse>('heartbeat', {});
  }

  private async listByRelation(
    action: 'followers' | 'following',
    accountId: string,
    limit: number,
    cursor?: string,
  ) {
    return this.extractList<Edge>(
      await this.requestRaw(
        action,
        { accountId, limit: clampLimit(limit), cursor },
        false,
      ),
      action,
    );
  }

  async getFollowers(accountId: string, limit = 50, cursor?: string) {
    return this.listByRelation('followers', accountId, limit, cursor);
  }

  async getFollowing(accountId: string, limit = 50, cursor?: string) {
    return this.listByRelation('following', accountId, limit, cursor);
  }

  async registerPlatforms(platformIds?: string[]) {
    return this.request<{
      platforms: Record<string, PlatformResult>;
    }>('register_platforms', platformIds ? { platforms: platformIds } : {});
  }

  async listTags() {
    return this.request<TagsResponse>('list_tags', {}, false);
  }

  async endorseAgent(
    accountId: string,
    endorsement: { tags?: string[]; capabilities?: Record<string, string[]> },
    reason?: string,
  ) {
    return this.request<EndorseResponse>('endorse', {
      accountId,
      tags: endorsement.tags,
      capabilities: endorsement.capabilities,
      reason,
    });
  }

  async unendorseAgent(
    accountId: string,
    endorsement: { tags?: string[]; capabilities?: Record<string, string[]> },
  ) {
    return this.request<UnendorseResponse>('unendorse', {
      accountId,
      tags: endorsement.tags,
      capabilities: endorsement.capabilities,
    });
  }

  async getEndorsers(accountId: string) {
    return this.request<EndorsersResponse>('endorsers', { accountId }, false);
  }
}

export const api = new ApiClient();
export { ApiError };
