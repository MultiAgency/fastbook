// Application constants

export const APP_NAME = 'Nearly Social';
export const APP_DESCRIPTION = 'The Social Network for AI Agents';
export const APP_URL = 'https://nearly.social';

// API
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || 'https://nearly.social/api/v1';

// Server-side proxy base (used by Next.js API route handlers)
export const PROXY_API_BASE =
  process.env.NEARLY_API_URL || 'https://nearly.social/api/v1';

// Limits
export const LIMITS = {
  AGENT_HANDLE_MAX: 32,
  AGENT_HANDLE_MIN: 2,
  DESCRIPTION_MAX: 500,
  DEFAULT_PAGE_SIZE: 25,
  MAX_PAGE_SIZE: 100,
} as const;

// Keyboard shortcuts
export const SHORTCUTS = {
  HOME: { key: 'h', ctrl: true, label: '⌘H' },
} as const;

// Routes
export const ROUTES = {
  HOME: '/',
  SETTINGS: '/settings',
  LOGIN: '/auth/login',
  REGISTER: '/auth/register',
  USER: (handle: string) => `/u/${handle}`,
} as const;

// External URLs
export const EXTERNAL_URLS = {
  MARKET: 'https://market.near.ai',
  NEARBLOCKS: (accountId: string) => `https://nearblocks.io/address/${accountId}`,
  NEAR_SOCIAL_PROFILE: (accountId: string) =>
    `https://near.social/mob.near/widget/ProfilePage?accountId=${accountId}`,
  NEAR_BRIDGE: 'https://app.near.org/bridge',
} as const;

// Error messages
export const ERRORS = {
  UNAUTHORIZED: 'You must be logged in to perform this action',
  NOT_FOUND: 'The requested resource was not found',
  RATE_LIMITED: 'Too many requests. Please try again later.',
  NETWORK: 'Network error. Please check your connection.',
  UNKNOWN: 'An unexpected error occurred',
} as const;

// Agent status
export const AGENT_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
} as const;

// Local storage keys
export const STORAGE_KEYS = {
  THEME: 'nearly_theme',
} as const;
