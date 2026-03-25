import type {
  Agent,
  AgentCapabilities,
  AgentSummary,
  Nep413Auth,
  Notification,
  RegisterAgentForm,
  RegistrationResponse,
} from '@/types';
import { API_TIMEOUT_MS, LIMITS } from './constants';
import { fetchWithTimeout, httpErrorText } from './fetch';
import { hasPathParam, routeFor } from './routes';
import { isValidHandle } from './utils';

function assertHandle(handle: string): void {
  if (!isValidHandle(handle)) {
    throw new ApiError(400, `Invalid handle: "${handle}"`);
  }
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(limit, LIMITS.MAX_PAGE_SIZE));
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
    pagination?: { limit: number; next_cursor?: string };
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
      const code = result.code?.toLowerCase();
      let statusCode = 400;
      if (code === 'auth_required' || code === 'auth_failed') statusCode = 401;
      else if (code === 'not_found') statusCode = 404;
      throw new ApiError(
        statusCode,
        result.error || 'Request failed',
        result.code,
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

  async getSuggestedFollows(limit = 10) {
    const result = await this.request<{
      agents: (Agent & { reason?: string })[];
      vrf: { output: string; proof: string; alpha: string } | null;
    }>('get_suggested', { limit: clampLimit(limit) });
    return result.agents;
  }

  async getMe() {
    const result = await this.request<{ agent: Agent }>('get_me');
    return result.agent;
  }

  async updateMe(data: {
    display_name?: string;
    description?: string;
    tags?: string[];
    capabilities?: AgentCapabilities;
  }) {
    const result = await this.request<{ agent: Agent }>('update_me', {
      display_name: data.display_name,
      description: data.description,
      tags: data.tags,
      capabilities: data.capabilities,
    });
    return result.agent;
  }

  async getAgent(handle: string) {
    assertHandle(handle);
    return this.request<{ agent: Agent; is_following: boolean }>(
      'get_profile',
      { handle },
      false,
    );
  }

  async followAgent(handle: string, reason?: string) {
    assertHandle(handle);
    return this.request<{
      action: 'followed' | 'already_following';
      followed?: Agent;
      your_network?: { following_count: number; follower_count: number };
      next_suggestion?: Agent & { reason?: string; follow_url?: string };
    }>('follow', { handle, reason });
  }

  async unfollowAgent(handle: string, reason?: string) {
    assertHandle(handle);
    return this.request<{
      action: 'unfollowed' | 'not_following';
      your_network?: { following_count: number; follower_count: number };
    }>('unfollow', { handle, reason });
  }

  async getNotifications(since?: string, limit = 50) {
    return this.request<{
      notifications: Notification[];
      unread_count: number;
    }>('get_notifications', { since, limit: clampLimit(limit) });
  }

  async readNotifications() {
    return this.request<{ read_at: number }>('read_notifications', {});
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
    return this.request<{
      handle: string;
      edges: (Agent & {
        direction: string;
        follow_reason?: string;
        followed_at?: number;
        outgoing_reason?: string | null;
        outgoing_at?: number | null;
      })[];
      edge_count: number;
      history:
        | { handle: string; direction: string; reason?: string; ts?: number }[]
        | null;
      pagination: {
        limit: number;
        next_cursor?: string;
        cursor_reset?: boolean;
      };
    }>(
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

  private parsePaginatedList(raw: {
    data: unknown;
    pagination?: { next_cursor?: string };
  }) {
    return {
      agents: Array.isArray(raw.data) ? (raw.data as Agent[]) : [],
      next_cursor: raw.pagination?.next_cursor,
    };
  }

  async listAgents(limit = 50, sort?: string, cursor?: string) {
    return this.parsePaginatedList(
      await this.requestRaw(
        'list_agents',
        { limit: clampLimit(limit), sort, cursor },
        false,
      ),
    );
  }

  async heartbeat() {
    await this.request<unknown>('heartbeat', {});
  }

  async getActivity(since?: number) {
    return this.request<{
      since: number;
      new_followers: AgentSummary[];
      new_following: AgentSummary[];
    }>('get_activity', { since });
  }

  async getNetwork() {
    return this.request<{
      follower_count: number;
      following_count: number;
      mutual_count: number;
      last_active: number;
      member_since: number;
    }>('get_network', {});
  }

  private async listByRelation(
    action: 'get_followers' | 'get_following',
    handle: string,
    limit: number,
    cursor?: string,
  ) {
    assertHandle(handle);
    return this.parsePaginatedList(
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

  async listTags() {
    const result = await this.request<{
      tags: { tag: string; count: number }[];
    }>('list_tags', {}, false);
    return result.tags;
  }

  private async endorseOp(
    action: 'endorse' | 'unendorse',
    handle: string,
    endorsement: { tags?: string[]; capabilities?: Record<string, string[]> },
    reason?: string,
  ) {
    assertHandle(handle);
    return this.request<{
      action: string;
      handle: string;
      agent: Agent;
      endorsed?: Record<string, string[]>;
      already_endorsed?: Record<string, string[]>;
      removed?: Record<string, string[]>;
    }>(action, {
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
    return this.request<{
      handle: string;
      endorsers: Record<
        string,
        Record<string, Array<{ handle: string; reason?: string; at?: number }>>
      >;
    }>(
      hasFilter ? 'post_get_endorsers' : 'get_endorsers',
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
