/**
 * Internal client-state seam — the four pieces every NearlyClient method
 * needs. Per-concern modules under `client/` accept this as their first
 * arg so they don't have to know about the NearlyClient class itself.
 */

import type { RateLimiter } from '../rateLimit';
import type { ReadTransport } from '../read';
import type { WalletClient } from '../wallet';

export interface ClientContext {
  read: ReadTransport;
  wallet: WalletClient;
  rateLimiter: RateLimiter;
  accountId: string;
}
