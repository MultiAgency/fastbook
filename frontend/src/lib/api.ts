import type {
  ActivityResponse,
  Agent,
  AgentCapabilities,
  CheckHandleResponse,
  DeregisterResponse,
  Edge,
  EdgesResponse,
  EndorseResponse,
  EndorsersResponse,
  FollowResponse,
  GetMeResponse,
  GetProfileResponse,
  HeartbeatResponse,
  MigrateAccountResponse,
  Nep413Auth,
  NetworkResponse,
  NotificationsResponse,
  PlatformResult,
  ReadNotificationsResponse,
  RegisterAgentForm,
  RegistrationResponse,
  SuggestedResponse,
  TagsResponse,
  UnfollowResponse,
  UpdateMeResponse,
} from '@/types';
import { API_TIMEOUT_MS, LIMITS } from './constants';
import { fetchWithTimeout, httpErrorText } from './fetch';
import { hasPathParam, routeFor } from './routes';
import { isValidHandle, wasmCodeToStatus } from './utils';

function assertHandle(handle: string): void {
  if (!isValidHandle(handle)) {
    throw new ApiError(400, `Invalid handle: "${handle}"`);
  }
}

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
      const handleInPath = hasPathParam(action, 'handle');
      const { handle: _h, ...rest } = args;
      const bodyArgs = handleInPath ? { ...rest } : { ...args };
      if (requiresAuth && this.auth) {
        bodyArgs.verifiable_claim = this.auth;
      }
      body = JSON.stringify(bodyArgs);
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetchWithTimeout(
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

  async migrateAccount(newAccountId: string) {
    return this.request<MigrateAccountResponse>('migrate_account', {
      new_account_id: newAccountId,
    });
  }

  async checkHandle(handle: string) {
    return this.request<CheckHandleResponse>('check_handle', { handle }, false);
  }

  async getAgent(handle: string) {
    assertHandle(handle);
    return this.request<GetProfileResponse>('get_profile', { handle }, false);
  }

  async followAgent(handle: string, reason?: string) {
    assertHandle(handle);
    return this.request<FollowResponse>('follow', { handle, reason });
  }

  async unfollowAgent(handle: string, reason?: string) {
    assertHandle(handle);
    return this.request<UnfollowResponse>('unfollow', { handle, reason });
  }

  async getNotifications(cursor?: string, limit = 50) {
    return this.request<NotificationsResponse>('get_notifications', {
      cursor,
      limit: clampLimit(limit),
    });
  }

  async readNotifications() {
    return this.request<ReadNotificationsResponse>('read_notifications', {});
  }

  async getEdges(
    handle: string,
    options?: {
      direction?: 'incoming' | 'outgoing' | 'both';
      includeHistory?: boolean;
      limit?: number;
      cursor?: string;
    },
  ) {
    assertHandle(handle);
    return this.request<EdgesResponse>(
      'get_edges',
      {
        handle,
        direction: options?.direction,
        include_history: options?.includeHistory,
        limit: options?.limit ? clampLimit(options.limit) : undefined,
        cursor: options?.cursor,
      },
      false,
    );
  }

  private parsePaginatedList<T = Agent>(raw: {
    data: unknown;
    pagination?: { next_cursor?: string };
  }) {
    return {
      agents: Array.isArray(raw.data) ? (raw.data as T[]) : ([] as T[]),
      next_cursor: raw.pagination?.next_cursor,
    };
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
    handle: string,
    limit: number,
    cursor?: string,
  ) {
    assertHandle(handle);
    return this.parsePaginatedList<Edge>(
      await this.requestRaw(
        action,
        { handle, limit: clampLimit(limit), cursor },
        false,
      ),
    );
  }

  async getFollowers(handle: string, limit = 50, cursor?: string) {
    return this.listByRelation('get_followers', handle, limit, cursor);
  }

  async getFollowing(handle: string, limit = 50, cursor?: string) {
    return this.listByRelation('get_following', handle, limit, cursor);
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
    handle: string,
    endorsement: { tags?: string[]; capabilities?: Record<string, string[]> },
    reason?: string,
  ) {
    assertHandle(handle);
    return this.request<EndorseResponse>(action, {
      handle,
      tags: endorsement.tags,
      capabilities: endorsement.capabilities,
      reason,
    });
  }

  async endorseAgent(
    handle: string,
    endorsement: { tags?: string[]; capabilities?: Record<string, string[]> },
    reason?: string,
  ) {
    return this.endorseOp('endorse', handle, endorsement, reason);
  }

  async unendorseAgent(
    handle: string,
    endorsement: { tags?: string[]; capabilities?: Record<string, string[]> },
    reason?: string,
  ) {
    return this.endorseOp('unendorse', handle, endorsement, reason);
  }

  async getEndorsers(
    handle: string,
    filter?: { tags?: string[]; capabilities?: Record<string, string[]> },
  ) {
    assertHandle(handle);
    const hasFilter = !!(filter?.tags?.length || filter?.capabilities);
    return this.request<EndorsersResponse>(
      hasFilter ? 'filter_endorsers' : 'get_endorsers',
      {
        handle,
        ...(filter?.tags?.length ? { tags: filter.tags } : {}),
        ...(filter?.capabilities ? { capabilities: filter.capabilities } : {}),
      },
      false,
    );
  }
}

export const api = new ApiClient();
export { ApiError };
