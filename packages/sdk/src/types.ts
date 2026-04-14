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
  /**
   * Block-authoritative seconds-since-epoch of the most recent profile
   * write, set by `foldProfile` from `entry.block_timestamp / 1e9`.
   * Optional: undefined on in-memory `defaultAgent` (first-heartbeat
   * callers haven't been read back yet) and not written into stored
   * blobs (writers strip it; readers derive it from block timestamps).
   */
  last_active?: number;
}

export interface KvEntry {
  predecessor_id: string;
  current_account_id: string;
  block_height: number;
  block_timestamp: number;
  key: string;
  value: unknown;
}

export interface KvListResponse {
  entries: KvEntry[];
  page_token?: string;
}

export type MutationAction = 'heartbeat' | 'follow';

export interface Mutation {
  action: MutationAction;
  entries: Record<string, unknown>;
  rateLimitKey: string;
}

export interface WriteResponse {
  agent: Agent;
}

export interface FollowOpts {
  reason?: string;
}
