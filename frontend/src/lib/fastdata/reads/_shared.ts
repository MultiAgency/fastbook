/**
 * Shared read-path infrastructure for FastData KV dispatching.
 *
 * Result/error types, the per-handler caller-resolution helper
 * (`requireAgent`), the cursor pagination primitive (`cursorPaginate`),
 * and the live-counts overlay (`withLiveCounts`) live here so per-action
 * handler files can stay focused on their action's read shape.
 */

import type { Agent } from '@/types';
import { kvListAll } from '../client';
import {
  buildEndorsementCounts,
  endorsePrefix,
  liveNetworkCounts,
} from '../utils';

export type FastDataError = { error: string; status?: number };
export type FastDataResult = { data: unknown } | FastDataError;

export async function requireAgent(
  body: Record<string, unknown>,
): Promise<{ accountId: string } | FastDataError> {
  const accountId = body.account_id as string | undefined;
  if (!accountId) return { error: 'account_id is required', status: 400 };
  return { accountId };
}

export function cursorPaginate<T>(
  items: T[],
  cursor: string | undefined,
  limit: number,
  getKey: (t: T) => string,
): { page: T[]; nextCursor?: string; cursorReset?: boolean } {
  let startIdx = 0;
  let cursorReset: boolean | undefined;
  if (cursor) {
    const idx = items.findIndex((t) => getKey(t) === cursor);
    if (idx >= 0) {
      startIdx = idx + 1;
    } else {
      cursorReset = true;
    }
  }
  const slice = items.slice(startIdx, startIdx + limit + 1);
  const hasMore = slice.length > limit;
  return {
    page: slice.slice(0, limit),
    nextCursor: hasMore ? getKey(slice[limit - 1]) : undefined,
    cursorReset,
  };
}

/** Overlay live counts (endorsements, followers, following) onto a raw profile. */
export async function withLiveCounts(
  accountId: string,
  raw: Agent,
): Promise<Agent> {
  const [counts, endorseEntries] = await Promise.all([
    liveNetworkCounts(accountId),
    kvListAll(endorsePrefix(accountId)),
  ]);
  return {
    ...raw,
    endorsements: buildEndorsementCounts(endorseEntries, accountId),
    endorsement_count: endorseEntries.length,
    ...counts,
  };
}

/** Scan KV entries by prefix and aggregate counts by key suffix, sorted desc. */
export async function aggregateCounts(
  prefix: string,
): Promise<{ key: string; count: number }[]> {
  const entries = await kvListAll(prefix);
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const key = e.key.replace(prefix, '');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => ({ key, count }));
}
