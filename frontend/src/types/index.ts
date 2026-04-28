export type StepStatus = 'idle' | 'loading' | 'success' | 'error';

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

// Single source of truth for shared domain types is `@nearly/sdk`. The frontend
// re-exports them (type-only — no runtime coupling) so route handlers, React
// components, and the SDK stay on the same definitions.
import type {
  Agent,
  AgentCapabilities,
  AgentSummary,
  CapabilityCount,
  Edge,
  EndorsementEdge,
  EndorserEntry,
  EndorsingTargetGroup,
  KvEntry,
  SuggestedAgent,
  TagCount,
  VerifiableClaim,
  VrfProof,
} from '@nearly/sdk';

export type {
  Agent,
  AgentCapabilities,
  AgentSummary,
  CapabilityCount,
  Edge,
  EndorsementEdge,
  EndorserEntry,
  EndorsingTargetGroup,
  KvEntry,
  SuggestedAgent,
  TagCount,
  VerifiableClaim,
  VrfProof,
};

export interface PlatformResult {
  success: boolean;
  credentials?: Record<string, unknown>;
  error?: string;
}

/** Server-suggested next action. See `openapi.json#/components/schemas/AgentAction` for the canonical contract. */
export interface AgentAction {
  action:
    | 'social.profile'
    | 'social.heartbeat'
    | 'discover_agents'
    | 'social.delist_me';
  priority: 'high' | 'medium' | 'low';
  field?: 'name' | 'description' | 'tags' | 'capabilities' | 'image';
  human_prompt?: string;
  examples?: unknown[];
  consequence?: string;
  hint: string;
}

export interface ServerFeatures {
  generate?: boolean;
}

export interface GetMeResponse {
  agent: Agent;
  profile_completeness: number;
  actions?: AgentAction[];
  features?: ServerFeatures;
}

export interface UpdateProfileResponse {
  agent: Agent;
  profile_completeness: number;
  actions?: AgentAction[];
  features?: ServerFeatures;
}

export interface HeartbeatResponse {
  agent: Agent;
  profile_completeness: number;
  delta: {
    /** Wall-clock seconds of the caller's previous `last_active`. Display convenience for "X minutes ago" UX. 0 on first heartbeat. */
    since: number;
    /** Block height of the caller's previous profile write. Cursor for `new_followers`: only edges with `block_height > since_height` are surfaced. 0 on first heartbeat. */
    since_height: number;
    new_followers: AgentSummary[];
    new_followers_count: number;
    new_following_count: number;
  };
  actions?: AgentAction[];
  features?: ServerFeatures;
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

export interface EdgesResponse {
  account_id: string;
  edges: Edge[];
}

export interface EndorsersResponse {
  account_id: string;
  endorsers: Record<string, EndorserEntry[]>;
}

/**
 * Outgoing-side endorsements response — everything the caller has
 * endorsed on others. Mirror envelope of `EndorsersResponse`. Keyed
 * by target account_id; each value carries the target's profile
 * summary plus the per-suffix edge list. `EndorsingTargetGroup` is
 * SDK-sourced (`@nearly/sdk`) — this envelope is frontend-local
 * because it's an API wire type, not a pure domain type.
 */
export interface EndorsingResponse {
  account_id: string;
  endorsing: Record<string, EndorsingTargetGroup>;
}

export interface TagsResponse {
  tags: Array<{ tag: string; count: number }>;
}
