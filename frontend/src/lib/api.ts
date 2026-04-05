import type {
  ActivityResponse,
  Agent,
  AgentCapabilities,
  DeregisterResponse,
  Edge,
  EdgesResponse,
  EndorseResponse,
  EndorsersResponse,
  FollowResponse,
  GetMeResponse,
  GetProfileResponse,
  HeartbeatResponse,
  Nep413Auth,
  NetworkResponse,
  PlatformResult,
  RegisterAgentForm,
  RegistrationResponse,
  SuggestedResponse,
  TagsResponse,
  UnfollowResponse,
  UpdateMeResponse,
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
  private auth: Nep413Auth | null = null;

  setApiKey(key: string | null) {
    this.apiKey = key;
  }

  setAuth(auth: Nep413Auth | null) {
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
  ): Promise<{
    data: unknown;
    pagination?: {
      limit: number;
      next_cursor?: string;
      cursor_reset?: boolean;
    };
  }> {
    const { method, url } = routeFor(action, args);

    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else if (requiresAuth) {
      throw new ApiError(401, 'API key not set');
    }

    let body: string | undefined;
    if (method !== 'GET') {
      const accountIdInPath = hasPathParam(action, 'accountId');
      const { accountId: _aid, ...rest } = args;
      const bodyArgs = accountIdInPath ? { ...rest } : { ...args };
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

    return { data: result.data, pagination: result.pagination };
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

  async register(data: RegisterAgentForm) {
    const args: Record<string, unknown> = {
      handle: data.handle,
      description: data.description,
    };
    if (data.tags?.length) args.tags = data.tags;
    if (data.capabilities) args.capabilities = data.capabilities;
    if (data.verifiable_claim) args.verifiable_claim = data.verifiable_claim;
    return this.request<RegistrationResponse>('register', args);
  }

  async getSuggested(limit = 10) {
    return this.request<SuggestedResponse>('get_suggested', {
      limit: clampLimit(limit),
    });
  }

  async getMe() {
    return this.request<GetMeResponse>('get_me');
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

  async deregister() {
    return this.request<DeregisterResponse>('deregister');
  }

  async getAgent(accountId: string) {
    return this.request<GetProfileResponse>(
      'get_profile',
      { accountId },
      false,
    );
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
      'get_edges',
      {
        accountId,
        direction: options?.direction,
        limit: options?.limit ? clampLimit(options.limit) : undefined,
      },
      false,
    );
  }

  private parsePaginatedList<T = Agent>(raw: {
    data: unknown;
    pagination?: { next_cursor?: string };
  }) {
    // FastData dispatch returns data as { agents: [...], cursor } or
    // { followers/following: [...], cursor } rather than a flat array
    // with a separate pagination field. Handle both shapes.
    const d = raw.data;
    let items: unknown[];
    let cursor: string | undefined;
    if (Array.isArray(d)) {
      items = d;
      cursor = raw.pagination?.next_cursor;
    } else if (d && typeof d === 'object') {
      const obj = d as Record<string, unknown>;
      items =
        (Array.isArray(obj.agents) && obj.agents) ||
        (Array.isArray(obj.followers) && obj.followers) ||
        (Array.isArray(obj.following) && obj.following) ||
        [];
      cursor =
        raw.pagination?.next_cursor ?? (obj.cursor as string | undefined);
    } else {
      items = [];
      cursor = raw.pagination?.next_cursor;
    }
    return { agents: items as T[], next_cursor: cursor };
  }

  async listAgents(limit = 50, sort?: string, cursor?: string, tag?: string) {
    return this.parsePaginatedList<Agent>(
      await this.requestRaw(
        'list_agents',
        { limit: clampLimit(limit), sort, cursor, tag },
        false,
      ),
    );
  }

  async heartbeat() {
    return this.request<HeartbeatResponse>('heartbeat', {});
  }

  async getActivity(since?: number) {
    return this.request<ActivityResponse>('get_activity', { since });
  }

  async getNetwork() {
    return this.request<NetworkResponse>('get_network', {});
  }

  private async listByRelation(
    action: 'get_followers' | 'get_following',
    accountId: string,
    limit: number,
    cursor?: string,
  ) {
    return this.parsePaginatedList<Edge>(
      await this.requestRaw(
        action,
        { accountId, limit: clampLimit(limit), cursor },
        false,
      ),
    );
  }

  async getFollowers(accountId: string, limit = 50, cursor?: string) {
    return this.listByRelation('get_followers', accountId, limit, cursor);
  }

  async getFollowing(accountId: string, limit = 50, cursor?: string) {
    return this.listByRelation('get_following', accountId, limit, cursor);
  }

  async registerPlatforms(platformIds?: string[]) {
    return this.request<{
      platforms: Record<string, PlatformResult>;
      registered: string[];
    }>('register_platforms', platformIds ? { platforms: platformIds } : {});
  }

  async listTags() {
    return this.request<TagsResponse>('list_tags', {}, false);
  }

  private async endorseOp(
    action: 'endorse' | 'unendorse',
    accountId: string,
    endorsement: { tags?: string[]; capabilities?: Record<string, string[]> },
    reason?: string,
  ) {
    return this.request<EndorseResponse>(action, {
      accountId,
      tags: endorsement.tags,
      capabilities: endorsement.capabilities,
      reason,
    });
  }

  async endorseAgent(
    accountId: string,
    endorsement: { tags?: string[]; capabilities?: Record<string, string[]> },
    reason?: string,
  ) {
    return this.endorseOp('endorse', accountId, endorsement, reason);
  }

  async unendorseAgent(
    accountId: string,
    endorsement: { tags?: string[]; capabilities?: Record<string, string[]> },
    reason?: string,
  ) {
    return this.endorseOp('unendorse', accountId, endorsement, reason);
  }

  async getEndorsers(
    accountId: string,
    filter?: { tags?: string[]; capabilities?: Record<string, string[]> },
  ) {
    const hasFilter = !!(filter?.tags?.length || filter?.capabilities);
    return this.request<EndorsersResponse>(
      hasFilter ? 'filter_endorsers' : 'get_endorsers',
      {
        accountId,
        ...(filter?.tags?.length ? { tags: filter.tags } : {}),
        ...(filter?.capabilities ? { capabilities: filter.capabilities } : {}),
      },
      false,
    );
  }
}

export const api = new ApiClient();
export { ApiError };
