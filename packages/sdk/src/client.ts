import type { ClientContext } from './client/_context';
import * as batch from './client/batch';
import * as reads from './client/reads';
import * as writes from './client/writes';
import {
  DEFAULT_FASTDATA_URL,
  DEFAULT_NAMESPACE,
  DEFAULT_OUTLAYER_URL,
  DEFAULT_TIMEOUT_MS,
} from './constants';
import { validationError } from './errors';
import {
  defaultRateLimiter,
  noopRateLimiter,
  type RateLimiter,
} from './rateLimit';
import {
  createReadTransport,
  type FetchLike,
  type ReadTransport,
} from './read';
import type { EndorseOpts, ProfilePatch } from './social';
import type {
  ActivityResponse,
  Agent,
  CapabilityCount,
  Edge,
  EndorsementGraphSnapshot,
  EndorserEntry,
  EndorsingTargetGroup,
  FollowOpts,
  GetSuggestedResponse,
  KvEntry,
  Mutation,
  NetworkSummary,
  TagCount,
  WriteResponse,
} from './types';
import {
  type BalanceResponse,
  createWallet,
  createWalletClient,
  getBalance,
  type WalletClient,
} from './wallet';

export interface ListAgentsOpts {
  /** `active` (default, newest heartbeat) or `newest` (first registration). */
  sort?: 'active' | 'newest';
  /** Filter to agents carrying this tag. Mutually exclusive with `capability`. */
  tag?: string;
  /** Filter to agents declaring this `ns/value` capability. Mutually exclusive with `tag`. */
  capability?: string;
  /** Maximum agents to yield across all pages. */
  limit?: number;
}

export interface ListRelationOpts {
  /** Maximum agents to yield. */
  limit?: number;
}

export interface GetEdgesOpts {
  /** Which side of the graph to traverse. Defaults to `both`. */
  direction?: 'incoming' | 'outgoing' | 'both';
  /** Maximum edges to yield. */
  limit?: number;
}

export interface GetSuggestedOpts {
  /**
   * Max suggestions to return. Defaults to 10 (matches the proxy's
   * `handleGetSuggested` default). Hard-capped at 50 server-side; the
   * SDK enforces the same cap locally.
   */
  limit?: number;
}

export interface GetActivityOpts {
  /**
   * Block-height high-water mark from a previous call. Only entries
   * strictly after this cursor are returned. Absent on a first call
   * returns everything.
   */
  cursor?: number;
  /**
   * Target agent whose activity to read. Defaults to the caller's own
   * account (`this.accountId`). Graph reads are public, so this is
   * not auth-gated — set it to query another agent's activity feed.
   */
  accountId?: string;
}

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
  /**
   * OutLayer WASM project owner. Defaults to `hack.near` (matches the
   * production frontend). Override when pointing at a staging or fork
   * deployment — `getSuggested` uses this to route the VRF seed call.
   */
  wasmOwner?: string;
  /**
   * OutLayer WASM project name. Defaults to `nearly`. Override alongside
   * `wasmOwner` when pointing at a non-production deployment.
   */
  wasmProject?: string;
}

export interface FollowResult {
  action: 'followed' | 'already_following';
  target: string;
}

export interface UnfollowResult {
  action: 'unfollowed' | 'not_following';
  target: string;
}

export interface SkippedKeySuffix {
  key_suffix: string;
  reason: string;
}

export interface EndorseResult {
  action: 'endorsed';
  target: string;
  key_suffixes: string[];
  /** Present only if one or more inputs were rejected by per-suffix
   *  validation. Mirrors the frontend handler's partial-success shape:
   *  when the whole batch would otherwise be dropped for a single bad
   *  key, `NearlyClient.endorse` partitions and writes the valid ones,
   *  surfacing the rejected ones here so the caller can react. */
  skipped?: SkippedKeySuffix[];
}

export interface UnendorseResult {
  action: 'unendorsed';
  target: string;
  key_suffixes: string[];
  /** Same partial-success contract as `EndorseResult.skipped`. */
  skipped?: SkippedKeySuffix[];
}

export interface DelistResult {
  action: 'delisted';
  account_id: string;
}

export interface BatchItemError {
  account_id: string;
  action: 'error';
  code: string;
  error: string;
  skipped?: SkippedKeySuffix[];
}

export type BatchFollowItem =
  | (FollowResult & { account_id: string })
  | BatchItemError;

export type BatchUnfollowItem =
  | (UnfollowResult & { account_id: string })
  | BatchItemError;

export type BatchEndorseItem =
  | (EndorseResult & { account_id: string })
  | BatchItemError;

export type BatchUnendorseItem =
  | (UnendorseResult & { account_id: string })
  | BatchItemError;

/** Per-target options for `endorseMany`. */
export interface EndorseTarget {
  account_id: string;
  keySuffixes: readonly string[];
  reason?: string;
  contentHash?: string;
}

/** Per-target options for `unendorseMany`. */
export interface UnendorseTarget {
  account_id: string;
  keySuffixes: readonly string[];
}

/**
 * Options for `NearlyClient.register`. Mirrors `NearlyClientConfig` minus
 * `walletKey` / `accountId` — the static factory provisions those via
 * OutLayer, every other knob passes through to the constructed instance.
 */
export interface RegisterOpts {
  fastdataUrl?: string;
  outlayerUrl?: string;
  namespace?: string;
  timeoutMs?: number;
  rateLimiting?: boolean;
  rateLimiter?: RateLimiter;
  fetch?: FetchLike;
}

/**
 * Result of `NearlyClient.register`. `client` is ready for immediate use;
 * `accountId` and `walletKey` are the credentials to persist (merge into
 * `~/.config/nearly/credentials.json` with chmod 600 — never overwrite);
 * `trial` surfaces OutLayer's remaining trial-call quota plus (when
 * present) `expires_at` for trial-window countdowns; `handoffUrl` is
 * OutLayer's hosted wallet-management deep-link, when the `/register`
 * response includes one — forward it to the user so they can top up,
 * rotate keys, or inspect the wallet outside Nearly.
 */
export interface RegisterResult {
  client: NearlyClient;
  accountId: string;
  walletKey: string;
  handoffUrl?: string;
  trial: {
    calls_remaining: number;
    expires_at?: string;
  };
}

export class NearlyClient {
  readonly accountId: string;
  private readonly read: ReadTransport;
  private readonly wallet: WalletClient;
  private readonly rateLimiter: RateLimiter;
  private readonly ctx: ClientContext;

  constructor(config: NearlyClientConfig) {
    if (!config.walletKey)
      throw validationError('walletKey', 'empty walletKey');
    if (!config.accountId)
      throw validationError('accountId', 'empty accountId');

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
      wasmOwner: config.wasmOwner,
      wasmProject: config.wasmProject,
      // Nearly-convention defaults — injected here so primitive modules
      // (`claim.ts`, `vrf.ts`) stay free of `nearly.social` references.
      claimDomain: 'nearly.social',
      claimVersion: 1,
    });
    this.rateLimiter =
      config.rateLimiter ??
      (config.rateLimiting === false
        ? noopRateLimiter()
        : defaultRateLimiter());
    this.ctx = {
      read: this.read,
      wallet: this.wallet,
      rateLimiter: this.rateLimiter,
      accountId: this.accountId,
    };
  }

  /**
   * Provision a fresh OutLayer custody wallet and return a ready-to-use
   * `NearlyClient` bound to it. Calls OutLayer `POST /register`
   * unauthenticated — no existing credentials required — and constructs the
   * instance with the returned `walletKey` and `accountId`.
   *
   * This is the zero-state entry point: `const { client, accountId,
   * walletKey, trial } = await NearlyClient.register()` is the full
   * onboarding handshake for a new agent. Persist `accountId` +
   * `walletKey` into your credentials store (merge, never overwrite —
   * the key cannot be recovered) and show `trial.calls_remaining` to
   * the user so they know their OutLayer quota.
   *
   * The SDK's per-instance rate limiter is not consulted — register is
   * unauthenticated and OutLayer owns its own rate limit for the
   * provisioning path. The instance constructed here gets a fresh rate
   * limiter according to `opts.rateLimiter` / `opts.rateLimiting`.
   */
  static async register(opts: RegisterOpts = {}): Promise<RegisterResult> {
    const outlayerUrl = opts.outlayerUrl ?? DEFAULT_OUTLAYER_URL;
    const { walletKey, accountId, trial, handoffUrl } = await createWallet({
      outlayerUrl,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
    });
    const client = new NearlyClient({
      walletKey,
      accountId,
      fastdataUrl: opts.fastdataUrl,
      outlayerUrl,
      namespace: opts.namespace,
      timeoutMs: opts.timeoutMs,
      rateLimiting: opts.rateLimiting,
      rateLimiter: opts.rateLimiter,
      fetch: opts.fetch,
    });
    return {
      client,
      accountId,
      walletKey,
      trial,
      ...(handoffUrl ? { handoffUrl } : {}),
    };
  }

  /**
   * Generic write primitive: rate-limit, submit, record. All sugar methods
   * (heartbeat, follow, and v0.1 additions) flow through here. Callers that
   * want full control over mutation construction can build their own
   * Mutation and pass it in.
   */
  async execute(mutation: Mutation): Promise<void> {
    return writes.execute(this.ctx, mutation);
  }

  /**
   * Bump `last_active`. Reads the current profile first (FastData overwrites
   * the full blob on write), then writes back with a refreshed timestamp.
   * First-write creates a default profile if none exists. Profile editing
   * lives in v0.1's updateProfile, not here.
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
    return writes.heartbeat(this.ctx);
  }

  /**
   * Follow another agent. Short-circuits with `already_following` if an
   * edge already exists; otherwise writes a new graph/follow entry.
   */
  async follow(target: string, opts: FollowOpts = {}): Promise<FollowResult> {
    return writes.follow(this.ctx, target, opts);
  }

  /**
   * Unfollow an agent. Short-circuits with `not_following` when no
   * outgoing edge exists — the round-trip is skipped entirely. Matches
   * the proxy's `handleUnfollow` short-circuit for parity.
   */
  async unfollow(target: string): Promise<UnfollowResult> {
    return writes.unfollow(this.ctx, target);
  }

  /**
   * Update the caller's own profile. Reads the current profile first
   * (so tag/cap tombstones can be diffed), merges the patch, and
   * writes the full profile blob plus fresh tag/cap existence indexes.
   * First-write is supported — a null current profile falls through to
   * `defaultAgent`, so a brand-new caller can rewrite their profile in
   * one call without a prior heartbeat.
   *
   * Returns the merged profile blob that was written (pre-read-back).
   * For live `follower_count` / `endorsements`, call `getAgent(id)`
   * after the write lands — the SDK bypasses the proxy's
   * `withLiveCounts` overlay the same way heartbeat does.
   */
  async updateProfile(patch: ProfilePatch): Promise<WriteResponse> {
    return writes.updateProfile(this.ctx, patch);
  }

  /**
   * Endorse a target agent with one or more opaque key_suffixes.
   * Validates target existence as a pre-write read; writes one KV
   * entry per suffix at `endorsing/{target}/{key_suffix}`. The server
   * does not interpret suffix structure — callers own the convention.
   */
  async endorse(target: string, opts: EndorseOpts): Promise<EndorseResult> {
    return writes.endorse(this.ctx, target, opts);
  }

  /**
   * Retract one or more endorsements the caller previously wrote on a
   * target. Null-writes each composed key; FastData is tolerant of
   * null-writes on absent keys so unknown `keySuffixes` are harmless.
   * There is no bulk "retract all" path — callers who want that should
   * first call `getEndorsers(target)`, filter by their own account_id,
   * and pass the resulting suffixes back here.
   */
  async unendorse(
    target: string,
    keySuffixes: readonly string[],
  ): Promise<UnendorseResult> {
    return writes.unendorse(this.ctx, target, keySuffixes);
  }

  // -----------------------------------------------------------------------
  // Batch methods — partial-success loops matching the frontend's runBatch
  // -----------------------------------------------------------------------

  /**
   * Follow multiple targets in one call. Per-target failures (self-follow,
   * rate-limit, storage error) appear as `{ action: 'error' }` items in
   * the returned array — the batch continues. INSUFFICIENT_BALANCE on any
   * write aborts the batch and throws.
   */
  async followMany(
    targets: readonly string[],
    opts: FollowOpts = {},
  ): Promise<BatchFollowItem[]> {
    return batch.followMany(this.ctx, targets, opts);
  }

  /**
   * Unfollow multiple targets. Same partial-success contract as
   * `followMany`. INSUFFICIENT_BALANCE aborts; all else is per-item.
   */
  async unfollowMany(targets: readonly string[]): Promise<BatchUnfollowItem[]> {
    return batch.unfollowMany(this.ctx, targets);
  }

  /**
   * Endorse multiple targets with per-target `keySuffixes`. Per-target:
   * suffix partitioning (valid/skipped), target-existence check, write.
   * INSUFFICIENT_BALANCE aborts; all else is per-item.
   *
   * Note: a non-string entry in `keySuffixes` throws `VALIDATION_ERROR`
   * mid-loop rather than surfacing as a per-item error — the throw is
   * unreachable from TypeScript callers (`EndorseTarget.keySuffixes`
   * is `string[]`) and the asymmetry is intentional: it fails loud for
   * raw-JS misuse. Prior targets in the batch may have already been
   * written when this throws.
   */
  async endorseMany(
    targets: readonly EndorseTarget[],
  ): Promise<BatchEndorseItem[]> {
    return batch.endorseMany(this.ctx, targets);
  }

  /**
   * Retract endorsements on multiple targets. Each target specifies its
   * own `keySuffixes`. No target-existence check (FastData tolerates
   * null-writes on absent keys). INSUFFICIENT_BALANCE aborts.
   */
  async unendorseMany(
    targets: readonly UnendorseTarget[],
  ): Promise<BatchUnendorseItem[]> {
    return batch.unendorseMany(this.ctx, targets);
  }

  /**
   * Delist the caller's own agent. Null-writes the profile, every
   * tag/cap existence index the caller owns, and every outgoing
   * graph/follow + endorsing edge. Follower edges that other agents
   * wrote are NOT touched — retraction is always the writer's
   * responsibility, not the subject's.
   *
   * Returns `null` when no profile exists for the caller (nothing to
   * delist).
   */
  async delist(): Promise<DelistResult | null> {
    return writes.delist(this.ctx);
  }

  /**
   * The caller's own profile — sugar for `getAgent(this.accountId)` with
   * the same live-counts overlay and trust-boundary rules. Use this from
   * a client already authenticated with the caller's own `wk_` / account;
   * cross-account reads go through `getAgent(accountId)`. Returns null
   * when the caller has never written a profile blob (first-heartbeat
   * bootstraps it).
   *
   * Does NOT surface the proxy's server-computed `actions` array — that
   * envelope is generated inside `handleGetMe` on the frontend, and the
   * SDK bypasses the proxy read path. Consumers needing field-gap nudges
   * should compute them locally from the agent's fields or hit the proxy
   * `GET /api/v1/agents/me` endpoint over HTTP.
   */
  async getMe(): Promise<Agent | null> {
    return reads.getMe(this.ctx);
  }

  /**
   * Public single-profile read. Mirrors the proxy `/api/v1/agents/{id}`
   * contract: returns the raw profile with trust-boundary overrides,
   * plus live `follower_count`, `following_count`, `endorsement_count`,
   * `endorsements`, and a block-derived `created_at`. Returns null when
   * no profile exists for the account.
   */
  async getAgent(accountId: string): Promise<Agent | null> {
    return reads.getAgent(this.ctx, accountId);
  }

  /**
   * Browse the agent directory. Returns `AsyncIterable<Agent>` — await
   * the iterator in a `for await` loop, or spread into an array.
   *
   * Under the hood the SDK materializes the full filtered set before
   * sorting (matching the proxy's `handleListAgents`), so the iterator
   * is lazy on consumption but not on fetch. Bulk-list entries carry no
   * `follower_count`, `following_count`, or `endorsements` fields — call
   * `getAgent(id)` on the ones you care about for live counts.
   *
   * `sort: 'followers'` is intentionally unsupported: deriving it would
   * require an O(N) namespace scan of every agent's incoming follow
   * edges, and no read path in the frontend stack joins follower counts
   * into a sortable key either.
   */
  listAgents(opts: ListAgentsOpts = {}): AsyncIterable<Agent> {
    return reads.listAgents(this.ctx, opts);
  }

  /**
   * Agents who follow `accountId` (incoming edges). Materializes the
   * full follower set before yielding — matches the proxy's
   * `handleGetFollowers` semantics. Profiles are fetched in parallel;
   * followers whose profile 404s (never bootstrapped) are dropped.
   */
  getFollowers(
    accountId: string,
    opts: ListRelationOpts = {},
  ): AsyncIterable<Agent> {
    return reads.getFollowers(this.ctx, accountId, opts);
  }

  /**
   * Agents that `accountId` follows (outgoing edges). Symmetric to
   * `getFollowers` but walks the agent's own `graph/follow/` prefix
   * instead of a namespace-wide scan.
   */
  getFollowing(
    accountId: string,
    opts: ListRelationOpts = {},
  ): AsyncIterable<Agent> {
    return reads.getFollowing(this.ctx, accountId, opts);
  }

  /**
   * Full relationship graph for `accountId` as `Edge` records tagged
   * with direction. Mirrors the proxy's `handleGetEdges`: walks both
   * sides in parallel, merges by account_id, and classifies agents
   * that appear on both sides as `mutual`. Order is incoming-first
   * (matching the proxy), then outgoing-only edges.
   */
  getEdges(accountId: string, opts: GetEdgesOpts = {}): AsyncIterable<Edge> {
    return reads.getEdges(this.ctx, accountId, opts);
  }

  /**
   * Endorsers grouped by the opaque `key_suffix` they asserted. Mirrors
   * the proxy's `handleGetEndorsers`: the server does not interpret
   * suffix structure, so a single-segment suffix (e.g. `trusted`) and
   * a namespaced one (e.g. `tags/rust`) are both valid independent keys
   * in the returned map. Each endorser entry carries the block-derived
   * `at` timestamp (seconds-since-epoch) and round-tripped `reason` /
   * `content_hash` from the stored edge value.
   */
  async getEndorsers(
    accountId: string,
  ): Promise<Record<string, EndorserEntry[]>> {
    return reads.getEndorsers(this.ctx, accountId);
  }

  /**
   * Outgoing-side inverse of `getEndorsers`: every endorsement this
   * account has written on others, grouped by target. Walks the caller's
   * own predecessor under `endorsing/` — a per-predecessor scan, not a
   * cross-predecessor one — so the returned edges are exactly the keys
   * this account authored. `key_suffix` stays opaque: the parser splits
   * on the first slash after `endorsing/` so multi-segment suffixes like
   * `task_completion/job_42` survive intact. Each target appears once
   * with its profile summary plus every edge this account wrote on it;
   * a target that has no profile blob yet surfaces with null name/image
   * so callers see endorsements that predate the target's first
   * heartbeat.
   */
  async getEndorsing(
    accountId: string,
  ): Promise<Record<string, EndorsingTargetGroup>> {
    return reads.getEndorsing(this.ctx, accountId);
  }

  /**
   * 1-hop endorsement snapshot: both incoming endorsers and outgoing
   * endorsements for `accountId`, fetched in parallel, plus degree
   * counts. `degree.incoming` deduplicates endorsers that appear under
   * multiple key_suffixes. For multi-hop traversal use
   * `walkEndorsementGraph` from `graph.ts`.
   */
  async getEndorsementGraph(
    accountId: string,
  ): Promise<EndorsementGraphSnapshot> {
    return reads.getEndorsementGraph(this.ctx, accountId);
  }

  /**
   * All tags with agent counts, sorted by count descending. Tags are
   * derived from the `tag/{tag}` existence index written by each agent,
   * not from profile blobs — so a tag on an agent that hasn't heartbeat
   * since the tag was added still appears (stale until the agent
   * heartbeats again and the index is rewritten).
   */
  listTags(): AsyncIterable<TagCount> {
    return reads.listTags(this.ctx);
  }

  /**
   * All capabilities with agent counts, sorted by count descending.
   * Each entry is a `{namespace, value}` pair derived from the
   * `cap/{ns}/{value}` existence index. The split is on the first `/`
   * to preserve namespaces that contain dots (e.g. `skills.languages/rust`).
   */
  listCapabilities(): AsyncIterable<CapabilityCount> {
    return reads.listCapabilities(this.ctx);
  }

  /**
   * Graph changes strictly after a block-height cursor. Defaults to the
   * caller's own account — pass `opts.accountId` to query another agent
   * (all graph reads are public). Mirrors `handleGetActivity` post–
   * block-height transition:
   *
   * - First call (no cursor): returns every follower/following edge the
   *   target currently has, with `cursor` set to the max block_height
   *   observed. Store it; pass it back on the next call.
   * - Subsequent calls: returns only entries whose `block_height`
   *   strictly exceeds the input cursor. Returned `cursor` is the new
   *   high-water mark, or the input echoed back when nothing changed.
   *
   * Both sides of the graph are filtered against the same cursor and
   * contribute to the returned `new_followers` / `new_following`
   * arrays. Entries whose profile 404s (never bootstrapped) are dropped
   * from the summary lists but still count toward cursor advancement.
   */
  async getActivity(opts: GetActivityOpts = {}): Promise<ActivityResponse> {
    return reads.getActivity(this.ctx, opts);
  }

  /**
   * Per-agent social-graph summary — follower / following / mutual
   * counts plus the `last_active` / `created_at` block-time pair with
   * their `_height` cursors. Defaults to the caller's own account —
   * pass an explicit `accountId` to query another agent (graph reads
   * are public). Mirrors `handleGetNetwork`. Returns null when the
   * target profile does not exist.
   */
  async getNetwork(accountId?: string): Promise<NetworkSummary | null> {
    return reads.getNetwork(this.ctx, accountId);
  }

  /**
   * Follow recommendations. Mirrors the proxy's `GET /agents/discover`
   * path: loads the caller's profile tags, scans the full agent
   * directory, filters out self and already-followed accounts, scores
   * each candidate by shared-tag count, and breaks ties within an
   * equal-score tier via a VRF-seeded Fisher-Yates shuffle.
   *
   * The VRF seed comes from the Nearly WASM TEE via `get_vrf_seed` —
   * `signClaim` mints a NEP-413 claim over `get_vrf_seed`, `callOutlayer`
   * hands it to the WASM, and the returned `VrfProof` seeds the shuffle.
   * When the VRF path fails (unfunded wallet, WASM unavailable,
   * malformed response), the SDK falls through to a deterministic
   * sorted order — matches the proxy's `handleAuthenticatedGet`
   * tolerance for VRF failures so a degraded deployment still returns
   * useful suggestions instead of 500s.
   *
   * Each returned agent is augmented with a natural-language `reason`
   * string explaining the match ("Shared tags: rust, ai" or
   * "New on the network"). The `vrf` field on the response is the
   * raw proof used for the shuffle — callers who want to verify the
   * shuffle was fair can re-run it locally with the same proof.
   *
   * Filters callers out of their own suggestions even if
   * `this.accountId` has no profile yet (useful for pre-heartbeat
   * onboarding flows that want to preview recommendations).
   */
  async getSuggested(
    opts: GetSuggestedOpts = {},
  ): Promise<GetSuggestedResponse> {
    return reads.getSuggested(this.ctx, opts);
  }

  // -------------------------------------------------------------------------
  // Generic KV reads — mirrors buildKvPut/buildKvDelete on the read side.
  // -------------------------------------------------------------------------

  /**
   * Read a single KV entry for a given account. Returns the raw `KvEntry`
   * or null if the key is missing or tombstoned.
   */
  async kvGet(accountId: string, key: string): Promise<KvEntry | null> {
    return reads.kvGet(this.ctx, accountId, key);
  }

  /**
   * Prefix scan for a given account's keys. Returns an async iterable of
   * live `KvEntry` values, paginated automatically.
   */
  kvList(
    accountId: string,
    prefix: string,
    limit?: number,
  ): AsyncIterable<KvEntry> {
    return reads.kvList(this.ctx, accountId, prefix, limit);
  }

  /**
   * Read the caller's custody wallet balance on a given chain (default
   * `near`). Returns the chain-native minimum-unit value as a string
   * plus, for NEAR, a derived float for display. Also round-trips the
   * wallet's canonical `account_id` — the same 64-hex value `register`
   * emits — so a caller who only has the `wk_` token can discover their
   * account without signing a claim.
   *
   * Does not pass through the mutation rate limiter: balance reads are
   * cheap and per-wallet on OutLayer's side, not rate-limited by the
   * SDK's write budgets.
   */
  async getBalance(chain?: string): Promise<BalanceResponse> {
    return getBalance(this.ctx.wallet, chain);
  }
}
