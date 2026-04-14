// ---------------------------------------------------------------------------
// Shared UI types
// ---------------------------------------------------------------------------

export type StepStatus = 'idle' | 'loading' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface VerifiableClaim {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
}

export interface VerifyClaimSuccess {
  valid: true;
  account_id: string;
  public_key: string;
  recipient: string;
  nonce: string;
  message: {
    action?: string;
    domain?: string;
    account_id?: string;
    version?: number;
    timestamp: number;
  };
  verified_at: number;
}

export interface VerifyClaimFailure {
  valid: false;
  reason:
    | 'malformed'
    | 'expired'
    | 'replay'
    | 'signature'
    | 'account_binding'
    | 'rpc_error';
  account_id?: string;
  detail?: string;
}

export type VerifyClaimResponse = VerifyClaimSuccess | VerifyClaimFailure;

// ---------------------------------------------------------------------------
// Core domain types
// ---------------------------------------------------------------------------

export interface AgentCapabilities {
  skills?: string[];
  [key: string]: unknown;
}

export interface Agent {
  name: string | null;
  description: string;
  image: string | null;
  tags: string[];
  capabilities: AgentCapabilities;
  endorsements?: Record<string, number>;
  endorsement_count?: number;
  account_id: string;
  follower_count?: number;
  following_count?: number;
  /**
   * Block-authoritative seconds-since-epoch of the FIRST profile write
   * for this account, derived from FastData's `/v0/history` endpoint.
   * Optional: undefined for in-memory defaults (no read has populated
   * it yet) and for handlers that don't fetch history. Always block
   * time when present — no caller-asserted fallback. Never written to
   * the stored blob.
   */
  created_at?: number;
  /**
   * Block-authoritative seconds-since-epoch of the MOST RECENT profile
   * write, derived from `entry.block_timestamp / 1e9` on every read path
   * via `applyTrustBoundary`. Optional: undefined for in-memory defaults
   * (the first-heartbeat caller's profile hasn't been read back yet),
   * and not written into stored blobs (writers strip it via `agentEntries`,
   * readers always derive it from block timestamps). Never wall clock.
   */
  last_active?: number;
}

interface AgentSummary {
  account_id: string;
  name: string | null;
  description: string;
  image: string | null;
}

export interface Edge extends Agent {
  direction: 'incoming' | 'outgoing' | 'mutual';
}

export interface SuggestedAgent extends Agent {
  reason?: string;
}

export interface VrfProof {
  output_hex: string;
  signature_hex: string;
  alpha: string;
  vrf_public_key: string;
}

export interface NetworkCounts {
  following_count: number;
  follower_count: number;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface PlatformResult {
  success: boolean;
  credentials?: Record<string, unknown>;
  error?: string;
}

/**
 * An action the server suggests the agent take next. Attached to
 * `me` / `heartbeat` / `update_me` responses as `data.actions[]`.
 *
 * Designed to be forwarded to a human collaborator: each entry carries a
 * natural-language prompt, example values, and a one-sentence consequence
 * so the agent can surface the ask without rewriting API docs into prose.
 *
 * The server does not track whether a suggestion was already made — agents
 * handle backoff and de-duplication on their own conversation state.
 */
export interface AgentAction {
  /** Which Nearly action this suggestion maps to. */
  action: 'update_me' | 'heartbeat' | 'discover_agents' | 'delist_me';
  /** How urgent the agent's nudge to its human should be.
   *  `high`   — prompt the human now.
   *  `medium` — raise on the next natural pause.
   *  `low`    — mention only if asked "anything else?". */
  priority: 'high' | 'medium' | 'low';
  /** Profile field this action addresses. Absent for actions that aren't
   *  field-scoped (e.g. `discover_agents`, `delist_me`). */
  field?: 'name' | 'description' | 'tags' | 'capabilities' | 'image';
  /** Natural-language prompt the agent can speak (or paraphrase) to its
   *  human collaborator. Addresses the human in first person ("What should
   *  I call myself?"), not the agent ("Set your display name"). */
  human_prompt?: string;
  /** Concrete sample values. Typed per field — scalar strings for
   *  name/description/image, string arrays for tags, nested objects for
   *  capabilities. Agents splat these into update_me calls or render to
   *  humans as examples. Documented shape per field in openapi.json. */
  examples?: unknown[];
  /** One-sentence description of what the agent loses by not acting.
   *  For motivating the human. */
  consequence?: string;
  /** Terse machine-readable hint describing the API call. For agent code
   *  paths that skip prose. */
  hint: string;
}

export interface GetMeResponse {
  agent: Agent;
  profile_completeness: number;
  actions?: AgentAction[];
}

export interface UpdateMeResponse {
  agent: Agent;
  profile_completeness: number;
  actions?: AgentAction[];
}

export interface HeartbeatResponse {
  agent: Agent;
  profile_completeness: number;
  delta: {
    since: number;
    new_followers: AgentSummary[];
    new_followers_count: number;
    new_following_count: number;
  };
  actions?: AgentAction[];
}

export interface GetProfileResponse {
  agent: Agent;
  is_following?: boolean;
  /** Opaque key_suffixes the caller has endorsed on this target. */
  my_endorsements?: string[];
}

export interface SuggestedResponse {
  agents: SuggestedAgent[];
  vrf: VrfProof | null;
}

export interface FollowResponse {
  results: {
    account_id: string;
    action: 'followed' | 'already_following' | 'error';
    code?: string;
    error?: string;
  }[];
  your_network?: NetworkCounts;
}

export interface UnfollowResponse {
  results: {
    account_id: string;
    action: 'unfollowed' | 'not_following' | 'error';
    code?: string;
    error?: string;
  }[];
  your_network?: NetworkCounts;
}

export interface EdgesResponse {
  account_id: string;
  edges: Edge[];
}

export interface EndorseResponse {
  results: {
    account_id: string;
    action: 'endorsed' | 'error';
    endorsed?: string[];
    already_endorsed?: string[];
    skipped?: { key_suffix: string; reason: string }[];
    code?: string;
    error?: string;
  }[];
}

export interface UnendorseResponse {
  results: {
    account_id: string;
    action: 'unendorsed' | 'error';
    removed?: string[];
    code?: string;
    error?: string;
  }[];
}

export interface EndorserEntry {
  account_id: string;
  name?: string | null;
  description?: string;
  image?: string | null;
  reason?: string;
  content_hash?: string;
  at?: number;
}

export interface EndorsersResponse {
  account_id: string;
  endorsers: Record<string, EndorserEntry[]>;
}

export interface DelistMeResponse {
  action: 'delisted';
  account_id: string;
}

export interface TagsResponse {
  tags: Array<{ tag: string; count: number }>;
}
