/**
 * Top-level helpers shared across per-concern client modules.
 */

import type { SkippedKeySuffix } from '../client';
import { NearlyError } from '../errors';
import { buildEndorsementCounts } from '../graph';
import { kvGetKey, type ReadTransport } from '../read';
import type { KvEntry } from '../types';
import { validateKeySuffix } from '../validate';

export async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

export async function fetchProfilesByIds(
  transport: ReadTransport,
  accountIds: readonly string[],
): Promise<KvEntry[]> {
  if (accountIds.length === 0) return [];
  // Deduplicate — a tag index never has duplicates per predecessor, but
  // callers pass raw lists and the cost is cheap.
  const uniq = [...new Set(accountIds)];
  const results = await Promise.all(
    uniq.map((id) => kvGetKey(transport, id, 'profile')),
  );
  return results.filter((e): e is KvEntry => e !== null);
}

/**
 * Aggregate KV entries under a prefix into `{ key, count }` rows sorted
 * descending. Used by `listTags` / `listCapabilities` over the existence
 * index suffix.
 */
export function aggregateBySuffix(
  entries: readonly KvEntry[],
  prefix: string,
): { key: string; count: number }[] {
  const counts = buildEndorsementCounts(entries, prefix);
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => ({ key, count }));
}

export function followTarget(key: string): string {
  return key.slice('graph/follow/'.length);
}

/**
 * Per-suffix partition for endorse/unendorse. Dedupes (first-occurrence
 * wins, order preserved), validates each, splits into valid/skipped.
 * Used by both single-target endorse/unendorse and the batch variants.
 */
export function partitionKeySuffixes(
  raw: readonly unknown[],
  prefix: string,
): { valid: string[]; skipped: SkippedKeySuffix[] } {
  const valid: string[] = [];
  const skipped: SkippedKeySuffix[] = [];
  const seen = new Set<string>();
  for (const ks of raw) {
    if (typeof ks !== 'string') {
      throw new NearlyError({
        code: 'VALIDATION_ERROR',
        field: 'keySuffixes',
        reason: 'must be strings',
        message: 'Validation failed for keySuffixes: must be strings',
      });
    }
    if (seen.has(ks)) continue;
    seen.add(ks);
    const e = validateKeySuffix(ks, prefix);
    if (e) skipped.push({ key_suffix: ks, reason: e.shape.message });
    else valid.push(ks);
  }
  return { valid, skipped };
}
