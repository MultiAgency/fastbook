export const APP_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://nearly.social';

export const LIMITS = {
  AGENT_NAME_MAX: 50,
  DESCRIPTION_MAX: 500,
  IMAGE_URL_MAX: 512,
  CAPABILITIES_MAX: 4096,
  DEFAULT_LIMIT: 25,
  MAX_LIMIT: 100,
  MAX_BODY_BYTES: 65_536,
  MAX_RESPONSE_BYTES: 1_048_576,
  MAX_VC_ACCOUNT_ID: 64,
  MAX_VC_PUBLIC_KEY: 128,
  MAX_VC_SIGNATURE: 256,
  MAX_VC_NONCE: 64,
  MAX_VC_FIELD: 1024,
  GRID_PAGE_SIZE: 24,
} as const;

export const MS_EPOCH_THRESHOLD = 1e12;

export const OUTLAYER_API_URL =
  process.env.NEXT_PUBLIC_OUTLAYER_API_URL ||
  'https://api.outlayer.fastnear.com';
export const OUTLAYER_PROJECT_OWNER =
  process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_OWNER || 'hack.near';
export const OUTLAYER_PROJECT_NAME =
  process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_NAME || 'nearly';

export const OUTLAYER_ADMIN_ACCOUNT = process.env.OUTLAYER_ADMIN_ACCOUNT || '';

export const API_TIMEOUT_MS = 10_000;

export const NEAR_RPC_URL = 'https://rpc.mainnet.near.org';

/** NEP-413 claim freshness window — timestamps outside this window are rejected. */
export const CLAIM_FRESHNESS_MS = (() => {
  const raw = process.env.CLAIM_FRESHNESS_MS;
  if (!raw) return 300_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
})();

/** Minimum NEAR to send for custody wallet gas. */
export const FUND_AMOUNT_NEAR = '0.01';

export const FASTDATA_KV_URL =
  process.env.FASTDATA_KV_URL || 'https://kv.main.fastnear.com';
export const FASTDATA_NAMESPACE =
  process.env.FASTDATA_NAMESPACE || 'contextual.near';
// FastData tuning constants (single source of truth for pagination & batching).
/** Max keys per /v0/multi request (API limit). */
export const FASTDATA_MULTI_BATCH_SIZE = 100;
/** Entries per page in kvList auto-pagination. */
export const FASTDATA_PAGE_SIZE = 200;

export const MARKET_API_URL =
  process.env.NEAR_MARKET_API_URL || 'https://market.near.ai/v1';

export const EXTERNAL_URLS = {
  NEAR_EXPLORER: (accountId: string) =>
    `https://near.rocks/account/${encodeURIComponent(accountId)}`,
  NEAR_EXPLORER_TX: (txHash: string) =>
    `https://near.rocks/block/${encodeURIComponent(txHash)}`,
  NEAR_ACCOUNT: (accountId: string) =>
    `https://${encodeURIComponent(accountId)}.near.rocks`,
  NEAR_BRIDGE: 'https://app.near.org/bridge',
  OUTLAYER_FUND: (accountId: string) =>
    `https://outlayer.fastnear.com/wallet/fund?to=${encodeURIComponent(accountId)}&amount=${FUND_AMOUNT_NEAR}&token=near&msg=Fund+agent+wallet+for+gas`,
} as const;
