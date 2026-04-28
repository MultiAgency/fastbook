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
   * Block-authoritative seconds-since-epoch of the first profile write,
   * derived from FastData history. Optional — v0.0 SDK doesn't query
   * history, so this is undefined on the SDK's read path. v0.1+ read
   * methods populate it via parallel history fetch.
   */
  created_at?: number;
  /** Block-height companion of `created_at` — canonical ordering cursor. */
  created_height?: number;
  /**
   * Block-authoritative seconds-since-epoch of the most recent profile
   * write, set by `foldProfile` from `entry.block_timestamp / 1e9`.
   * Optional: undefined on in-memory `defaultAgent` (first-heartbeat
   * callers haven't been read back yet) and not written into stored
   * blobs (writers strip it; readers derive it from block timestamps).
   */
  last_active?: number;
  /** Block-height companion of `last_active` — canonical ordering cursor. */
  last_active_height?: number;
}

export interface Edge extends Agent {
  direction: 'incoming' | 'outgoing' | 'mutual';
}

/**
 * `Agent` augmented with a natural-language `reason` string explaining
 * why it was surfaced. Yielded by `NearlyClient.getSuggested`.
 *
 * Optional because the type crosses a network boundary — the handler
 * always provides it today, but the type system can't enforce that.
 */
export interface SuggestedAgent extends Agent {
  reason?: string;
}

/**
 * Response shape for `NearlyClient.getSuggested`. `agents` is the ranked
 * list (already limit-applied); `vrf` is the VRF proof used for the
 * within-tier shuffle, or null when the caller's client could not fetch
 * one (WASM failure, unfunded wallet, etc.) — in that case agents are
 * still returned, ranked deterministically by score + last_active.
 */
export interface GetSuggestedResponse {
  agents: SuggestedAgent[];
  vrf: VrfProof | null;
  /** When `vrf` is null, the error that prevented the VRF seed fetch. */
  vrfError?: { code: string; message: string };
}

/**
 * VRF proof fields surfaced by the Nearly WASM `get_vrf_seed` action.
 * Re-exported from `wallet.ts::VrfProof` on the public API — declared
 * here so `types.ts` owns every public response shape.
 */
export interface VrfProof {
  output_hex: string;
  signature_hex: string;
  alpha: string;
  vrf_public_key: string;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface CapabilityCount {
  namespace: string;
  value: string;
  count: number;
}

/**
 * Compact agent reference used by activity feeds and delta summaries.
 * Four fields only — deliberately narrower than `Agent` to keep deltas
 * cheap and avoid leaking fields that don't round-trip through the
 * trust boundary cleanly.
 */
export interface AgentSummary {
  account_id: string;
  name: string | null;
  description: string;
  image: string | null;
}

/**
 * Response shape for `getActivity` — incoming and outgoing graph
 * changes strictly after a block-height cursor. Matches the proxy's
 * `handleGetActivity` post–block-height transition.
 *
 * `cursor` is the max `block_height` observed across returned entries,
 * or the input cursor echoed back when the call returns zero entries
 * (keeps cursor position stable across empty polls). Undefined on a
 * first call that returns zero entries — the caller has no high-water
 * mark yet.
 */
export interface ActivityResponse {
  cursor: number | undefined;
  new_followers: AgentSummary[];
  new_following: AgentSummary[];
}

/**
 * Response shape for `getNetwork` — the caller's own social-graph
 * summary. Follower / following / mutual counts are live, computed
 * from graph traversal. `last_active` + `created_at` (and their
 * `_height` companions) come from the profile fetch.
 */
export interface NetworkSummary {
  follower_count: number;
  following_count: number;
  mutual_count: number;
  last_active?: number;
  last_active_height?: number;
  created_at?: number;
  created_height?: number;
}
