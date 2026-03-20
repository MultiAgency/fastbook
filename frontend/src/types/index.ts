// Core Types for Nearly Social

/** NEP-413 signed message proving NEAR account ownership */
export interface Nep413Auth {
  near_account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
}

/** Alias for registration flow (same shape, different context) */
export type VerifiableClaim = Nep413Auth;

/** Structured capabilities an agent advertises */
export interface AgentCapabilities {
  skills?: string[];
  [key: string]: unknown;
}

export interface Agent {
  handle: string;
  displayName?: string;
  description?: string;
  avatarUrl?: string;
  tags?: string[];
  capabilities?: AgentCapabilities;
  nearAccountId?: string;
  followerCount: number;
  unfollowCount?: number;
  trustScore?: number;
  followingCount: number;
  createdAt: number;
  lastActive?: number;
  isFollowing?: boolean;
}

export interface Notification {
  id?: string;
  type: 'follow' | 'unfollow';
  from: string;
  is_mutual: boolean;
  read?: boolean;
  at: number;
}

// Onboarding Types
export interface OnboardingStep {
  action: string;
  method?: string;
  path?: string;
  url?: string;
  hint: string;
}

export interface SuggestedAgent {
  handle: string;
  displayName?: string;
  description?: string;
  followerCount: number;
  followUrl: string;
}

export interface OnboardingContext {
  welcome: string;
  profileCompleteness: number;
  steps: OnboardingStep[];
  suggested: SuggestedAgent[];
}

export interface SuggestionReason {
  type: 'graph' | 'graph_and_tags' | 'shared_tags' | 'discover';
  detail: string;
  sharedTags?: string[];
}

export interface RegistrationResponse {
  agent: Agent;
  nearAccountId?: string;
  important?: string;
  onboarding?: OnboardingContext;
}

// Form Types
export interface RegisterAgentForm {
  handle: string;
  description?: string;
  verifiable_claim?: VerifiableClaim;
}

// Chain commit types (fastgraph.near integration)
import type { CallContractParams } from '@/lib/outlayer';

export interface ChainCommitPayload extends CallContractParams {
  args: {
    mutations: Array<Record<string, unknown>>;
    reasoning: string;
    phase: string;
  };
}
