import type { ProfilePatch } from '@nearly/sdk';
import type {
  Agent,
  Edge,
  EdgesResponse,
  EndorsersResponse,
  EndorsingResponse,
  GetMeResponse,
  GetProfileResponse,
  HeartbeatResponse,
  PlatformResult,
  SuggestedResponse,
  TagsResponse,
  UpdateProfileResponse,
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

interface ApiErrorOpts {
  statusCode: number;
  message: string;
  code?: string;
  hint?: string;
  retryAfter?: number;
}

class ApiError extends Error {
  statusCode: number;
  code?: string;
  hint?: string;
  retryAfter?: number;
  constructor(opts: ApiErrorOpts) {
    super(opts.message);
    this.name = 'ApiError';
    this.statusCode = opts.statusCode;
    this.code = opts.code;
    this.hint = opts.hint;
    this.retryAfter = opts.retryAfter;
  }
}

class ApiClient {
  private apiKey: string | null = null;

  setApiKey(key: string | null) {
    this.apiKey = key;
  }

  clearCredentials() {
    this.apiKey = null;
  }

  private async requestRaw(
    action: string,
    args: Record<string, unknown> = {},
    authMode: 'wk' | 'none' = 'wk',
  ): Promise<{ data: unknown }> {
    const { method, url } = routeFor(action, args);

    const headers: Record<string, string> = {};
    // `wk` mode: Bearer wk_ header required. `none`: public reads.
    if (authMode === 'wk') {
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      } else {
        throw new ApiError({ statusCode: 401, message: 'API key not set' });
      }
    }

    let body: string | undefined;
    if (method !== 'GET') {
      const bodyArgs: Record<string, unknown> = { ...args };
      if (hasPathParam(action, 'accountId')) {
        delete bodyArgs.accountId;
      }
      body = JSON.stringify(bodyArgs);
      headers['Content-Type'] = 'application/json';
    }

    // Reads can be retried freely, writes can't.
    const doFetch = authMode === 'none' ? fetchWithRetry : fetchWithTimeout;
    const response = await doFetch(
      url,
      { method, headers, body },
      API_TIMEOUT_MS,
    );

    if (!response.ok) {
      const { message, code, hint, retryAfter } =
        await parseErrorBody(response);
      throw new ApiError({
        statusCode: response.status,
        message,
        code,
        hint,
        retryAfter,
      });
    }

    const result = await response.json();
    if (!result.success) {
      const retryAfter =
        typeof result.retry_after === 'number' ? result.retry_after : undefined;
      throw new ApiError({
        statusCode: wasmCodeToStatus(result.code),
        message: result.error || 'Request failed',
        code: result.code,
        hint: result.hint,
        retryAfter,
      });
    }

    return { data: result.data };
  }

  private async request<T>(
    action: string,
    args: Record<string, unknown> = {},
    authMode: 'wk' | 'none' = 'wk',
  ): Promise<T> {
    const { data } = await this.requestRaw(action, args, authMode);
    if (data === undefined || data === null) {
      throw new ApiError({ statusCode: 502, message: 'Empty response data' });
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
    return this.request<GetProfileResponse>('profile', { accountId }, 'none');
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
      'none',
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
        'none',
      ),
      'agents',
    );
  }

  async heartbeat() {
    return this.request<HeartbeatResponse>('social.heartbeat', {});
  }

  async updateProfile(patch: ProfilePatch) {
    return this.request<UpdateProfileResponse>(
      'social.profile',
      patch as Record<string, unknown>,
    );
  }

  async generateProfile(field: string, current: Partial<ProfilePatch>) {
    return this.request<{
      field: string;
      value: string | string[] | Record<string, unknown> | null;
    }>('generate.profile', { field, current });
  }

  async generateFollowReason(accountId: string, reason?: string) {
    return this.request<{ reason: string | null }>(
      'generate.follow',
      reason !== undefined ? { accountId, reason } : { accountId },
    );
  }

  async generateEndorseReason(accountId: string, reason?: string) {
    return this.request<{ reason: string | null }>(
      'generate.endorse',
      reason !== undefined ? { accountId, reason } : { accountId },
    );
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
        'none',
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
    return this.request<TagsResponse>('list_tags', {}, 'none');
  }

  async getEndorsers(accountId: string) {
    return this.request<EndorsersResponse>('endorsers', { accountId }, 'none');
  }

  /**
   * Outgoing-side endorsements: everything this account has endorsed
   * on others, grouped by target. Inverse of `getEndorsers`. Public
   * read — no auth.
   */
  async getEndorsing(accountId: string) {
    return this.request<EndorsingResponse>('endorsing', { accountId }, 'none');
  }
}

export const api = new ApiClient();
export { ApiError };
