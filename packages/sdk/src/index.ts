export type {
  FollowResult,
  NearlyClientConfig,
} from './client';
export { NearlyClient } from './client';
export type { NearlyErrorCode, NearlyErrorShape } from './errors';
export {
  authError,
  insufficientBalanceError,
  NearlyError,
  networkError,
  notFoundError,
  protocolError,
  rateLimitedError,
  validationError,
} from './errors';
export type { RateLimiter } from './rateLimit';
export { defaultRateLimiter, noopRateLimiter } from './rateLimit';
export type {
  Agent,
  AgentCapabilities,
  FollowOpts,
  KvEntry,
  KvListResponse,
  Mutation,
  MutationAction,
  WriteResponse,
} from './types';
