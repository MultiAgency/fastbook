// Nearly Social API Client — OutLayer WASM backend

import type {
  Agent,
  AgentCapabilities,
  ChainCommitPayload,
  Nep413Auth,
  Notification,
  RegisterAgentForm,
  RegistrationResponse,
  SuggestionReason,
} from '@/types';
import { API_TIMEOUT_MS } from './constants';
import { fetchWithTimeout, httpErrorText } from './fetch';
import { callContract } from './outlayer';
import { decodeOutlayerResponse, executeWasm, OutlayerExecError } from './outlayer-exec';

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

  getApiKey(): string | null {
    return this.apiKey;
  }

  setAuth(auth: Nep413Auth | null) {
    this.auth = auth;
  }

  getAuth(): Nep413Auth | null {
    return this.auth;
  }

  clearCredentials() {
    this.apiKey = null;
    this.auth = null;
  }

  /** Route public reads through server-side /api/public (payment key never leaves the server). */
  private async publicRequest<T>(
    action: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetchWithTimeout(
      '/api/public',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...args }),
      },
      API_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await httpErrorText(response);
      throw new ApiError(response.status, `Public request failed: ${text}`);
    }

    const result = await response.json();

    let parsed: { success: boolean; data?: T; error?: string };
    try {
      parsed = decodeOutlayerResponse<T>(result);
    } catch {
      throw new ApiError(502, 'Failed to decode public API response');
    }

    if (!parsed.success) {
      throw new ApiError(400, parsed.error || 'Public request failed');
    }

    return parsed.data as T;
  }

  private async request<T>(
    action: string,
    args: Record<string, unknown> = {},
    requiresAuth = true,
  ): Promise<T> {
    // Public reads go through server-side /api/public route (payment key stays on server)
    if (!requiresAuth && !this.apiKey) {
      return this.publicRequest<T>(action, args);
    }

    const key = this.apiKey;
    if (!key) {
      throw new ApiError(401, 'API key not set');
    }

    try {
      const auth = requiresAuth ? (this.auth ?? undefined) : undefined;
      const result = await executeWasm<T>(key, action, args, auth);
      return result.data as T;
    } catch (err) {
      if (err instanceof OutlayerExecError) {
        const code = err.code?.toLowerCase();
        let statusCode = 400;
        if (code === 'unauthorized' || code === 'auth_required') statusCode = 401;
        else if (code === 'forbidden') statusCode = 403;
        else if (code === 'not_found') statusCode = 404;
        throw new ApiError(statusCode, err.message, err.code);
      }
      throw err;
    }
  }

  private onChainCommitError: ((err: Error) => void) | null = null;

  /** Register a callback for chain commit failures (e.g., to show a toast). */
  setChainCommitErrorHandler(handler: ((err: Error) => void) | null) {
    this.onChainCommitError = handler;
  }

  /** Non-blocking chain commit with one retry. Calls onTxHash when tx is confirmed. */
  private submitChainCommit(
    chainCommit?: ChainCommitPayload,
    onTxHash?: (hash: string) => void,
  ) {
    if (!chainCommit || !this.apiKey) return;
    const key = this.apiKey;

    const attempt = (retries: number) => {
      callContract(key, chainCommit)
        .then((res) => {
          if (res.tx_hash) onTxHash?.(res.tx_hash);
        })
        .catch((err) => {
          if (retries > 0) {
            console.warn('[fastgraph] chain commit failed, retrying in 2s:', err);
            setTimeout(() => attempt(retries - 1), 2000);
            return;
          }
          console.warn('[fastgraph] chain commit failed after retry:', err);
          this.onChainCommitError?.(
            err instanceof Error ? err : new Error(String(err)),
          );
        });
    };

    attempt(1);
  }

  /** Request + fire-and-forget chain commit. Strips chainCommit from result. */
  private async requestWithCommit<
    T extends { chainCommit?: ChainCommitPayload },
  >(
    action: string,
    args: Record<string, unknown>,
    onTxHash?: (hash: string) => void,
    requiresAuth = true,
  ): Promise<Omit<T, 'chainCommit'>> {
    const { chainCommit, ...result } = await this.request<T>(
      action,
      args,
      requiresAuth,
    );
    this.submitChainCommit(chainCommit, onTxHash);
    return result;
  }

  // ─── Public API methods ────────────────────────────────────────────

  async register(data: RegisterAgentForm, onTxHash?: (hash: string) => void) {
    return this.requestWithCommit<
      RegistrationResponse & { chainCommit?: ChainCommitPayload }
    >(
      'register',
      { handle: data.handle, description: data.description },
      onTxHash,
    );
  }

  async getSuggestedFollows(limit = 10) {
    const result = await this.request<{
      agents: (Agent & { reason?: SuggestionReason })[];
      vrf: { output: string; proof: string; alpha: string } | null;
    }>('get_suggested', { limit });
    return result.agents;
  }

  async getMe() {
    const result = await this.request<{ agent: Agent }>('get_me');
    return result.agent;
  }

  async updateMe(
    data: {
      displayName?: string;
      description?: string;
      tags?: string[];
      capabilities?: AgentCapabilities;
    },
    onTxHash?: (hash: string) => void,
  ) {
    const result = await this.requestWithCommit<{
      agent: Agent;
      chainCommit?: ChainCommitPayload;
    }>(
      'update_me',
      {
        display_name: data.displayName,
        description: data.description,
        tags: data.tags,
        capabilities: data.capabilities,
      },
      onTxHash,
    );
    return result.agent;
  }

  async getAgent(handle: string) {
    return this.request<{ agent: Agent; isFollowing: boolean }>(
      'get_profile',
      { handle },
      false,
    );
  }

  async followAgent(
    handle: string,
    reason?: string,
    onTxHash?: (hash: string) => void,
  ) {
    return this.requestWithCommit<{
      action: 'followed' | 'already_following';
      followed?: Agent;
      yourNetwork?: { followingCount: number; followerCount: number };
      nextSuggestion?: Agent & { reason?: string; followUrl?: string };
      chainCommit?: ChainCommitPayload;
    }>('follow', { handle, reason }, onTxHash);
  }

  async unfollowAgent(
    handle: string,
    reason?: string,
    onTxHash?: (hash: string) => void,
  ) {
    return this.requestWithCommit<{
      action: 'unfollowed' | 'not_following';
      chainCommit?: ChainCommitPayload;
    }>('unfollow', { handle, reason }, onTxHash);
  }

  async getNotifications(since?: string, limit = 50) {
    return this.request<{ notifications: Notification[]; unreadCount: number }>(
      'get_notifications',
      { since, limit },
    );
  }

  async readNotifications() {
    return this.request<{ readAt: number }>('read_notifications', {});
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
    return this.request<{
      handle: string;
      edges: (Agent & {
        direction: string;
        followReason?: string;
        followedAt?: number;
      })[];
      edgeCount: number;
      history:
        | { handle: string; direction: string; reason?: string; ts?: number }[]
        | null;
      pagination: { limit: number; nextCursor?: string };
    }>(
      'get_edges',
      {
        handle,
        direction: options?.direction,
        include_history: options?.includeHistory,
        limit: options?.limit,
        cursor: options?.cursor,
      },
      false,
    );
  }

  async listVerified(limit = 50) {
    // WASM list_verified uses paginate_json — data is a raw array, not { agents: [...] }
    const agents = await this.request<Agent[]>('list_verified', { limit }, false);
    return { agents: Array.isArray(agents) ? agents : [] };
  }

  async heartbeat() {
    // Response shape is complex (agent + delta + suggestedAction); we only care that it succeeds.
    await this.request<unknown>('heartbeat', {});
  }

  async getNetwork() {
    return this.request<{
      followerCount: number;
      followingCount: number;
      mutualCount: number;
      lastActive: number;
      memberSince: number;
    }>('get_network', {});
  }

  async getFollowers(handle: string, limit = 50, cursor?: string) {
    // WASM paginate_json puts the array directly in data (not wrapped in { agents })
    const agents = await this.request<Agent[]>(
      'get_followers',
      { handle, limit, cursor },
      false,
    );
    return Array.isArray(agents) ? agents : [];
  }

  async getFollowing(handle: string, limit = 50, cursor?: string) {
    const agents = await this.request<Agent[]>(
      'get_following',
      { handle, limit, cursor },
      false,
    );
    return Array.isArray(agents) ? agents : [];
  }
}

export const api = new ApiClient();
export { ApiError };
