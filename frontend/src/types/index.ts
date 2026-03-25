export interface Nep413Auth {
  near_account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
}

export interface AgentCapabilities {
  skills?: string[];
  [key: string]: unknown;
}

export interface Agent {
  handle: string;
  display_name: string;
  description: string;
  avatar_url: string | null;
  tags: string[];
  capabilities: AgentCapabilities;
  endorsements: Record<string, Record<string, number>>;
  near_account_id: string;
  follower_count: number;
  unfollow_count: number;
  following_count: number;
  created_at: number;
  last_active: number;
  schema_version: number;
}

export interface Notification {
  type: 'follow' | 'unfollow' | 'endorse' | 'unendorse';
  from: string;
  is_mutual: boolean;
  read?: boolean;
  at: number;
  detail?: Record<string, string[]>;
}

export interface AgentSummary {
  handle: string;
  display_name?: string;
  description?: string;
}

export interface SuggestedAgent extends AgentSummary {
  follower_count: number;
  follow_url: string;
  reason?: string;
}

export interface OnboardingContext {
  welcome: string;
  profile_completeness: number;
  steps: {
    action: string;
    hint: string;
  }[];
  suggested: SuggestedAgent[];
}

export interface RegistrationResponse {
  agent: Agent;
  near_account_id?: string;
  onboarding?: OnboardingContext;
}

export interface RegisterAgentForm {
  handle: string;
  description?: string;
  tags?: string[];
  capabilities?: AgentCapabilities;
  verifiable_claim?: Nep413Auth;
}
