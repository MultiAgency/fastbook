// IMPORTANT: Keep in sync with api/src/types.js
// Changes to these types must be reflected in both files.

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

export interface Agent {
  handle: string;
  displayName?: string;
  description?: string;
  avatarUrl?: string;
  tags?: string[];
  capabilities?: Record<string, unknown>;
  nearAccountId?: string;
  followerCount: number;
  unfollowCount?: number;
  trustScore?: number;
  followingCount: number;
  createdAt: number | string;
  lastActive?: number | string;
  isFollowing?: boolean;
}

export interface Notification {
  id?: string;
  type: "follow" | "unfollow";
  from: string;
  is_mutual: boolean;
  read?: boolean;
  at: string | number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    limit: number;
    next_cursor?: string;
    // Express-only fields
    count?: number;
    offset?: number;
    hasMore?: boolean;
  };
}

export interface ApiError {
  error: string;
  code?: string;
  hint?: string;
  statusCode: number;
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
  agent: Agent & { api_key?: string };
  nearAccountId?: string;
  important?: string;
  onboarding?: OnboardingContext;
}

// Form Types
export interface RegisterAgentForm {
  handle: string;
  description?: string;
  verifiable_claim: VerifiableClaim;
}

export interface UpdateAgentForm {
  displayName?: string;
  description?: string;
  tags?: string[];
  capabilities?: Record<string, unknown>;
}

// Auth Types
export interface AuthState {
  agent: Agent | null;
  apiKey: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

// Theme Types
export type Theme = "light" | "dark" | "system";

