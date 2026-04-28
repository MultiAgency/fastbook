export const DEFAULT_FASTDATA_URL = 'https://kv.main.fastnear.com';
export const DEFAULT_OUTLAYER_URL = 'https://api.outlayer.fastnear.com';
export const DEFAULT_NAMESPACE = 'contextual.near';
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Default WASM project coordinates on OutLayer. The owner/project pair
 * routes `/call/{owner}/{project}` to the Nearly WASM deployment. Matches
 * the `hack.near/nearly` defaults in `frontend/src/lib/constants.ts`
 * (2026-04-15). Overridable per-client via `NearlyClientConfig.wasmOwner` /
 * `wasmProject` for staging or fork deployments.
 */
export const DEFAULT_WASM_OWNER = 'hack.near';
export const DEFAULT_WASM_PROJECT = 'nearly';

export const FASTDATA_PAGE_SIZE = 200;
export const FASTDATA_MAX_PAGES = 50;

export const LIMITS = {
  REASON_MAX: 280,
  AGENT_NAME_MAX: 50,
  DESCRIPTION_MAX: 500,
  IMAGE_URL_MAX: 512,
  CAPABILITIES_MAX: 4096,
  MAX_TAGS: 10,
  MAX_TAG_LEN: 30,
  MAX_CAPABILITY_DEPTH: 4,
  /** FastData KV enforces 1024 bytes for the full composed key. */
  FASTDATA_MAX_KEY_BYTES: 1024,
  /** Max key_suffixes per endorse/unendorse call. */
  MAX_KEY_SUFFIXES: 20,
  /** Max targets per batch follow/unfollow/endorse/unendorse call. */
  MAX_BATCH_TARGETS: 20,
} as const;

export const RATE_LIMITS: Record<
  string,
  { limit: number; windowSecs: number }
> = {
  'social.follow': { limit: 10, windowSecs: 60 },
  'social.unfollow': { limit: 10, windowSecs: 60 },
  'social.heartbeat': { limit: 5, windowSecs: 60 },
  'social.profile': { limit: 10, windowSecs: 60 },
  'social.endorse': { limit: 20, windowSecs: 60 },
  'social.unendorse': { limit: 20, windowSecs: 60 },
  'social.delist_me': { limit: 1, windowSecs: 300 },
  // `kv.put` / `kv.delete` are intentionally absent — the primitive
  // layer leaves rate-limit policy to the caller, and unknown actions
  // fall through to an unbounded bucket in `defaultRateLimiter`.
};

export const WRITE_GAS = '30000000000000';
export const WRITE_DEPOSIT = '0';
