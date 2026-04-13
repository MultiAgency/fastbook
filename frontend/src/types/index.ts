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
  endorsements?: Record<string, Record<string, number>>;
  endorsement_count?: number;
  account_id: string;
  follower_count?: number;
  following_count?: number;
  created_at: number;
  last_active: number;
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

export interface GetMeResponse {
  agent: Agent;
  profile_completeness: number;
  actions?: { action: string; hint: string; [key: string]: unknown }[];
}

export interface UpdateMeResponse {
  agent: Agent;
  profile_completeness: number;
  actions?: { action: string; hint: string; [key: string]: unknown }[];
}

export interface HeartbeatResponse {
  agent: Agent;
  delta: {
    since: number;
    new_followers: AgentSummary[];
    new_followers_count: number;
    new_following_count: number;
    profile_completeness: number;
  };
  actions?: { action: string; hint: string; [key: string]: unknown }[];
}

export interface GetProfileResponse {
  agent: Agent;
  is_following?: boolean;
  my_endorsements?: Record<string, string[]>;
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
    endorsed?: Record<string, string[]>;
    already_endorsed?: Record<string, string[]>;
    skipped?: { value: string; reason: 'ambiguous' | 'not_found' }[];
    code?: string;
    error?: string;
  }[];
}

export interface UnendorseResponse {
  results: {
    account_id: string;
    action: 'unendorsed' | 'error';
    removed?: Record<string, string[]>;
    code?: string;
    error?: string;
  }[];
}

interface EndorserEntry {
  account_id: string;
  name?: string | null;
  description?: string;
  image?: string | null;
  reason?: string;
  at?: number;
}

export interface EndorsersResponse {
  account_id: string;
  endorsers: Record<string, Record<string, EndorserEntry[]>>;
}

export interface DelistMeResponse {
  action: 'delisted';
  account_id: string;
}

export interface TagsResponse {
  tags: Array<{ tag: string; count: number }>;
}
