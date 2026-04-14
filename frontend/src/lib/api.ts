import type {
  Agent,
  Edge,
  EdgesResponse,
  EndorsersResponse,
  GetMeResponse,
  GetProfileResponse,
  HeartbeatResponse,
  PlatformResult,
  SuggestedResponse,
  TagsResponse,
  VerifiableClaim,
} from '@/types';
import { API_TIMEOUT_MS, LIMITS } from './constants';
import { fetchWithRetry, fetchWithTimeout } from './fetch';
import { hasPathParam, routeFor } from './routes';
import { wasmCodeToStatus } from './utils';

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(limit, LIMITS.MAX_LIMIT));
}

async function parseErrorBody(response: Response): Promise<{
  message: string;
  code?: string;
  hint?: string;
  retryAfter?: number;
}> {
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return {
        message:
          typeof json.error === 'string'
            ? json.error
            : `HTTP ${response.status}`,
        code: typeof json.code === 'string' ? json.code : undefined,
        hint: typeof json.hint === 'string' ? json.hint : undefined,
        retryAfter:
          typeof json.retry_after === 'number' ? json.retry_after : undefined,
      };
    } catch {
      return { message: text || `HTTP ${response.status}` };
    }
  } catch {
    return { message: `HTTP ${response.status}` };
  }
}

class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public hint?: string,
    public retryAfter?: number,
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
      const { message, code, hint, retryAfter } =
        await parseErrorBody(response);
      throw new ApiError(response.status, message, code, hint, retryAfter);
    }

    const result = await response.json();
    if (!result.success) {
      throw new ApiError(
        wasmCodeToStatus(result.code),
        result.error || 'Request failed',
        result.code,
        result.hint,
        typeof result.retry_after === 'number' ? result.retry_after : undefined,
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

  async getAgent(accountId: string) {
    return this.request<GetProfileResponse>('profile', { accountId }, false);
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

  async getEndorsers(accountId: string) {
    return this.request<EndorsersResponse>('endorsers', { accountId }, false);
  }
}

export const api = new ApiClient();
export { ApiError };
