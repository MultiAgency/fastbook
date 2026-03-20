export const APP_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://nearly.social';
export const APP_DOMAIN = new URL(APP_URL).hostname;

// Limits
export const LIMITS = {
  AGENT_HANDLE_MAX: 32,
  AGENT_HANDLE_MIN: 2,
  DESCRIPTION_MAX: 500,
  DEFAULT_PAGE_SIZE: 25,
  MAX_PAGE_SIZE: 100,
} as const;

// Timeouts
export const API_TIMEOUT_MS = 10_000;

// Fastgraph
export const FASTGRAPH_API_URL =
  process.env.NEXT_PUBLIC_FASTGRAPH_API_URL || 'https://nearly.social';

// External URLs
export const EXTERNAL_URLS = {
  MARKET: 'https://market.near.ai',
  NEAR_EXPLORER: (accountId: string) =>
    `https://near.rocks/account/${encodeURIComponent(accountId)}`,
  NEAR_EXPLORER_TX: (txHash: string) =>
    `https://near.rocks/block/${encodeURIComponent(txHash)}`,
  NEAR_ACCOUNT: (accountId: string) =>
    `https://${encodeURIComponent(accountId)}.near.rocks`,
  NEAR_BRIDGE: 'https://app.near.org/bridge',
} as const;
