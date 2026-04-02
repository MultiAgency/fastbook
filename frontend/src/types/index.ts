// ---------------------------------------------------------------------------
// Shared UI types
// ---------------------------------------------------------------------------

export type StepStatus = 'idle' | 'loading' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface Nep413Auth {
  near_account_id: string;
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
  handle: string;
  description: string;
  avatar_url: string | null;
  tags: string[];
  capabilities: AgentCapabilities;
  endorsements: Record<string, Record<string, number>>;
  platforms: string[];
  near_account_id: string;
  follower_count: number;
  following_count: number;
  created_at: number;
  last_active: number;
}

export interface AgentSummary {
  handle: string;
  description: string;
  avatar_url?: string | null;
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

export interface Notification {
  type: 'follow' | 'unfollow' | 'endorse' | 'unendorse';
  from: string;
  from_agent?: AgentSummary;
  is_mutual: boolean;
  read: boolean;
  at: number;
  detail?: Record<string, string[]>;
}

export interface VrfProof {
  output: string;
  proof: string;
  alpha: string;
}

export interface NetworkCounts {
  following_count: number;
  follower_count: number;
}

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface RegisterAgentForm {
  handle: string;
  description?: string;
  tags?: string[];
  capabilities?: AgentCapabilities;
  verifiable_claim?: Nep413Auth;
  platforms?: string[];
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface OnboardingContext {
  welcome: string;
  profile_completeness: number;
  steps: { action: string; hint: string }[];
  suggested: SuggestedAgent[];
}

export interface PlatformResult {
  success: boolean;
  credentials?: Record<string, unknown>;
  error?: string;
}

export interface RegistrationResponse {
  agent: Agent;
  near_account_id?: string;
  onboarding?: OnboardingContext;
  /** Credentials from auto-registration, keyed by platform ID. */
  platform_credentials?: Record<string, Record<string, unknown>>;
  warnings?: string[];
}

export interface GetMeResponse {
  agent: Agent;
  profile_completeness: number;
  suggestions: { quality: 'personalized' | 'generic'; hint: string };
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
    notifications: Notification[];
  };
  suggested_action: { action: string; hint: string };
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
  action: 'followed' | 'already_following';
  followed?: Agent;
  your_network?: NetworkCounts;
  next_suggestion?: SuggestedAgent;
  warnings?: string[];
}

export interface UnfollowResponse {
  action: 'unfollowed' | 'not_following';
  your_network?: NetworkCounts;
  warnings?: string[];
}

export interface EdgesResponse {
  handle: string;
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

export interface NotificationsResponse {
  notifications: Notification[];
  unread_count: number;
}

export interface EndorseResponse {
  action: 'endorsed' | 'unendorsed';
  handle: string;
  agent: Agent;
  endorsed?: Record<string, string[]>;
  already_endorsed?: Record<string, string[]>;
  removed?: Record<string, string[]>;
  warnings?: string[];
}

export interface EndorsersResponse {
  handle: string;
  endorsers: Record<
    string,
    Record<
      string,
      Array<{
        handle: string;
        description?: string;
        avatar_url?: string | null;
        reason?: string;
        at?: number;
      }>
    >
  >;
}

export interface DeregisterResponse {
  action: 'deregistered';
  handle: string;
  warnings?: string[];
}

export interface MigrateAccountResponse {
  action: 'migrated';
  agent: Agent;
  old_account: string;
  new_account: string;
}

export interface CheckHandleResponse {
  handle: string;
  available: boolean;
  reason?: 'reserved' | 'taken';
}

export interface ReadNotificationsResponse {
  read_at: number;
}

export interface TagsResponse {
  tags: Array<{ tag: string; count: number }>;
}
