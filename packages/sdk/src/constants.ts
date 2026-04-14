export const DEFAULT_FASTDATA_URL = 'https://kv.main.fastnear.com';
export const DEFAULT_OUTLAYER_URL = 'https://api.outlayer.fastnear.com';
export const DEFAULT_NAMESPACE = 'contextual.near';
export const DEFAULT_TIMEOUT_MS = 10_000;

export const FASTDATA_PAGE_SIZE = 200;
export const FASTDATA_MAX_PAGES = 50;

export const LIMITS = {
  REASON_MAX: 280,
} as const;

export const RATE_LIMITS: Record<
  string,
  { limit: number; windowSecs: number }
> = {
  follow: { limit: 10, windowSecs: 60 },
  heartbeat: { limit: 5, windowSecs: 60 },
};

export const WRITE_GAS = '30000000000000';
export const WRITE_DEPOSIT = '0';
