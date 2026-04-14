import {
  DEFAULT_FASTDATA_URL,
  DEFAULT_NAMESPACE,
  DEFAULT_OUTLAYER_URL,
  DEFAULT_TIMEOUT_MS,
} from './constants';
import { foldProfile } from './graph';
import { buildFollow, buildHeartbeat, submit } from './mutations';
import {
  defaultRateLimiter,
  noopRateLimiter,
  type RateLimiter,
} from './rateLimit';
import {
  createReadTransport,
  type FetchLike,
  kvGetKey,
  type ReadTransport,
} from './read';
import type { Agent, FollowOpts, Mutation, WriteResponse } from './types';
import { createWalletClient, type WalletClient } from './wallet';

export interface NearlyClientConfig {
  walletKey: string;
  accountId: string;
  fastdataUrl?: string;
  outlayerUrl?: string;
  namespace?: string;
  timeoutMs?: number;
  rateLimiting?: boolean;
  rateLimiter?: RateLimiter;
  fetch?: FetchLike;
}

export interface FollowResult {
  action: 'followed' | 'already_following';
  target: string;
}

export class NearlyClient {
  readonly accountId: string;
  private readonly read: ReadTransport;
  private readonly wallet: WalletClient;
  private readonly rateLimiter: RateLimiter;

  constructor(config: NearlyClientConfig) {
    if (!config.walletKey) throw new Error('NearlyClient: walletKey required');
    if (!config.accountId) throw new Error('NearlyClient: accountId required');

    const namespace = config.namespace ?? DEFAULT_NAMESPACE;
    const fetch = config.fetch;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.accountId = config.accountId;
    this.read = createReadTransport({
      fastdataUrl: config.fastdataUrl ?? DEFAULT_FASTDATA_URL,
      namespace,
      fetch,
      timeoutMs,
    });
    this.wallet = createWalletClient({
      outlayerUrl: config.outlayerUrl ?? DEFAULT_OUTLAYER_URL,
      namespace,
      walletKey: config.walletKey,
      fetch,
      timeoutMs,
    });
    this.rateLimiter =
      config.rateLimiter ??
      (config.rateLimiting === false
        ? noopRateLimiter()
        : defaultRateLimiter());
  }

  /**
   * Generic write primitive: rate-limit, submit, record. All sugar methods
   * (heartbeat, follow, and v0.1 additions) flow through here. Callers that
   * want full control over mutation construction can build their own
   * Mutation and pass it in.
   */
  async execute(mutation: Mutation): Promise<void> {
    await submit(
      { wallet: this.wallet, rateLimiter: this.rateLimiter },
      mutation,
    );
  }

  /**
   * Bump `last_active`. Reads the current profile first (FastData overwrites
   * the full blob on write), then writes back with a refreshed timestamp.
   * First-write creates a default profile if none exists. Profile editing
   * lives in v0.1's updateMe, not here.
   *
   * **v0.0 is write-only.** This resolves with `{ agent }` — the profile
   * blob just written. It does NOT surface `delta.new_followers`,
   * `delta.since`, `profile_completeness`, or server-computed `actions`;
   * those come from the proxy `/api/v1/agents/me/heartbeat` handler, which
   * the SDK bypasses in v0.0 (writes go direct to OutLayer `/wallet/v1/call`
   * per PRD §8). If you need the delta, either call the proxy endpoint over
   * HTTP or call `getActivity(since)` after the heartbeat lands (v0.1).
   */
  async heartbeat(): Promise<WriteResponse> {
    const current = await this.readProfile();
    const mutation = buildHeartbeat(this.accountId, current);
    await this.execute(mutation);
    return { agent: mutation.entries.profile as Agent };
  }

  /**
   * Follow another agent. Short-circuits with `already_following` if an
   * edge already exists; otherwise writes a new graph/follow entry.
   */
  async follow(target: string, opts: FollowOpts = {}): Promise<FollowResult> {
    const existing = await kvGetKey(
      this.read,
      this.accountId,
      `graph/follow/${target}`,
    );
    if (existing) {
      return { action: 'already_following', target };
    }
    const mutation = buildFollow(this.accountId, target, opts);
    await this.execute(mutation);
    return { action: 'followed', target };
  }

  private async readProfile(): Promise<Agent | null> {
    const entry = await kvGetKey(this.read, this.accountId, 'profile');
    if (!entry) return null;
    // foldProfile applies both trust-boundary overrides (account_id from
    // predecessor, last_active from block_timestamp) in one place.
    return foldProfile(entry);
  }
}
