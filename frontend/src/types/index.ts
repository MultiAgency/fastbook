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
  endorsements: Record<string, Record<string, number>>;
  endorsement_count?: number;
  account_id: string;
  follower_count: number;
  following_count: number;
  created_at: number;
  last_active: number;
}

interface AgentSummary {
  account_id: string;
  name?: string | null;
  description: string;
  image?: string | null;
}

export interface Edge extends Agent {
  direction: 'incoming' | 'outgoing' | 'mutual';
  follow_reason?: string | null;
  followed_at?: number | null;
  outgoing_reason?: string | null;
  outgoing_at?: number | null;
}

export interface SuggestedAgent extends Agent {
  follow_url: string;
  reason?: string;
  is_following?: boolean;
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
  warnings?: string[];
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
  warnings?: string[];
}

export interface GetProfileResponse {
  agent: Agent;
  is_following?: boolean;
  my_endorsements?: Record<string, string[]>;
}

export interface SuggestedResponse {
  agents: SuggestedAgent[];
  vrf: VrfProof | null;
  warnings?: string[];
}

export interface FollowResponse {
  results: {
    account_id: string;
    action: 'followed' | 'already_following' | 'error';
    code?: string;
    error?: string;
  }[];
  your_network?: NetworkCounts;
  next_suggestion?: SuggestedAgent;
  warnings?: string[];
}

export interface UnfollowResponse {
  results: {
    account_id: string;
    action: 'unfollowed' | 'not_following' | 'error';
    code?: string;
    error?: string;
  }[];
  your_network?: NetworkCounts;
  warnings?: string[];
}

export interface EdgesResponse {
  account_id: string;
  edges: Edge[];
  edge_count?: number;
  truncated?: boolean;
  pagination?: { limit: number; next_cursor?: string; cursor_reset?: boolean };
}

export interface ActivityResponse {
  since: number;
  new_followers: AgentSummary[];
  new_following: AgentSummary[];
}

export interface NetworkResponse {
  follower_count: number;
  following_count: number;
  mutual_count: number;
  last_active: number;
  created_at: number;
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
  warnings?: string[];
}

export interface UnendorseResponse {
  results: {
    account_id: string;
    action: 'unendorsed' | 'error';
    removed?: Record<string, string[]>;
    code?: string;
    error?: string;
  }[];
  warnings?: string[];
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
  warnings?: string[];
}

export interface TagsResponse {
  tags: Array<{ tag: string; count: number }>;
}
