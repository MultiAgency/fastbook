import type { Agent, KvEntry } from './types';

/**
 * Fold a single KvEntry into an Agent, applying FastData's trust boundary:
 *
 * - `account_id` — overridden with the entry's `predecessor_id`, because
 *   FastData attributes each key to whoever wrote it, not to whatever the
 *   caller wrote into the stored blob.
 * - `last_active` — overridden with the block-time of the entry (seconds
 *   since epoch from `block_timestamp`), because caller-asserted activity
 *   time is manipulable. An agent could write `last_active: 9999999999`
 *   into their profile blob and appear eternally fresh in `sort=active`;
 *   overriding on read closes that hole without touching writers.
 *
 * Returns null for non-object blobs. The `!Array.isArray` guard matters:
 * `typeof [] === 'object'` is true, so without it an array stored under
 * `profile` would spread into `{0: ..., 1: ..., account_id: id}` — a
 * valid-looking Agent with numeric-string keys.
 */
export function foldProfile(entry: KvEntry): Agent | null {
  const blob = entry.value;
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null;
  return {
    ...(blob as Agent),
    account_id: entry.predecessor_id,
    last_active: Math.floor(entry.block_timestamp / 1e9),
    // Strip caller-asserted `created_at` from the blob. v0.0 SDK doesn't
    // surface it (no history-fetching read methods yet); v0.1+ will
    // populate it from history in the same parallel-fetch pattern as
    // the frontend's `fetchProfile`. Without this strip, legacy profiles
    // would surface their wall-clock `created_at` from the blob.
    created_at: undefined,
  };
}

/**
 * Create a default agent shape for callers that have no profile blob
 * yet. Holds no time fields — `last_active` and `created_at` are
 * read-derived from block timestamps. Callers that need a baseline for
 * first-heartbeat delta math use `agent.last_active ?? 0`.
 */
export function defaultAgent(accountId: string): Agent {
  return {
    name: null,
    description: '',
    image: null,
    tags: [],
    capabilities: {},
    account_id: accountId,
  };
}

/**
 * Walk nested capabilities JSON and extract (namespace, value) pairs.
 * Used by mutation builders to materialize cap/{ns}/{value} existence keys.
 */
export function extractCapabilityPairs(caps: unknown): [string, string][] {
  const pairs: [string, string][] = [];
  function walk(val: unknown, prefix: string, depth: number): void {
    if (depth > 4) return;
    if (typeof val === 'string' && prefix) {
      pairs.push([prefix, val.toLowerCase()]);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') pairs.push([prefix, item.toLowerCase()]);
      }
    } else if (val && typeof val === 'object') {
      for (const [key, child] of Object.entries(val)) {
        walk(child, prefix ? `${prefix}.${key}` : key, depth + 1);
      }
    }
  }
  if (caps) walk(caps, '', 0);
  return pairs;
}
