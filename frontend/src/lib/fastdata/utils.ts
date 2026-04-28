/**
 * Shared agent-state utilities for FastData KV read and write paths.
 *
 * Key schema (per-predecessor — each agent writes under their NEAR account):
 *   profile              → full AgentRecord
 *   tag/{tag}            → true (existence index)
 *   cap/{ns}/{value}     → true (existence index)
 */

import {
  foldProfile,
  foldProfileList,
  buildEndorsementCounts as sdkBuildEndorsementCounts,
} from '@nearly/sdk';
import type { Agent } from '@/types';
import { resolveAdminWriterAccount } from '../admin-near-token';
import { getCached, setCache } from '../cache';
import {
  type KvEntry,
  kvGetAgent,
  kvGetAgentFirstWrite,
  kvGetAll,
  kvListAgent,
  kvMultiAgent,
} from './client';

const HIDDEN_SET_KEY = '__hidden_accounts__';

/** Set of account IDs the admin has hidden. Cached 60s unless bypassed. */
export async function getHiddenSet(skipCache = false): Promise<Set<string>> {
  const writerAccount = await resolveAdminWriterAccount();
  if (!writerAccount) return new Set();
  if (!skipCache) {
    const cached = getCached(HIDDEN_SET_KEY);
    if (cached) return cached as Set<string>;
  }
  const entries = await kvListAgent(writerAccount, 'hidden/');
  const set = new Set(entries.map((e) => e.key.replace('hidden/', '')));
  if (!skipCache) {
    setCache('hidden', HIDDEN_SET_KEY, set);
  }
  return set;
}

/**
 * Count an account's followers and following by scanning the live follow graph.
 * Used on write responses (which need freshness) and alongside endorsement
 * fetches on read paths that overlay live counts onto a stored profile.
 * Returns raw ground-truth counts — hiding is a UI concern, not a data one.
 */
export async function liveNetworkCounts(
  accountId: string,
): Promise<{ follower_count: number; following_count: number }> {
  const [followerEntries, followingEntries] = await Promise.all([
    kvGetAll(`graph/follow/${accountId}`),
    kvListAgent(accountId, 'graph/follow/'),
  ]);
  return {
    follower_count: followerEntries.length,
    following_count: followingEntries.length,
  };
}

// ---------------------------------------------------------------------------
// Profile reads — trust-boundary-enforced wrappers over the KV client.
//
// FastData's trust boundary is the predecessor namespace: each agent's
// account ID comes from who wrote the key, not from the stored blob's
// self-reported `account_id` field. Everything in the app that reads
// profiles should go through these wrappers so the override happens in
// one place and no handler can forget it.
// ---------------------------------------------------------------------------

/**
 * If the first-history call fails, `created_at` / `created_height` stay
 * undefined — falling back to caller-asserted values would mix trust
 * models in one field and reintroduce a manipulation gap.
 *
 * Count fields are not populated: `foldProfile` strips them and this
 * function does not overlay. Callers that need live counts wrap with
 * `withLiveCounts` (see `fastdata/reads/profile.ts::handleGetProfile`).
 */
export async function fetchProfile(accountId: string): Promise<Agent | null> {
  const [latest, firstWrite] = await Promise.all([
    kvGetAgent(accountId, 'profile'),
    kvGetAgentFirstWrite(accountId, 'profile'),
  ]);
  if (!latest) return null;
  const agent = foldProfile(latest);
  if (agent && firstWrite) {
    agent.created_at = entryBlockSecs(firstWrite);
    agent.created_height = entryBlockHeight(firstWrite);
  }
  return agent;
}

/**
 * The trust boundary fires per entry, so list views sorting on
 * `last_active` stay block-authoritative even under tag/capability
 * filters.
 */
export async function fetchProfiles(
  accountIds: readonly string[],
): Promise<Agent[]> {
  if (accountIds.length === 0) return [];
  const entries = await kvMultiAgent(
    accountIds.map((id) => ({ accountId: id, key: 'profile' })),
  );
  const out: Agent[] = [];
  for (const e of entries) {
    if (!e) continue;
    const agent = foldProfile(e);
    if (agent) out.push(agent);
  }
  return out;
}

export async function fetchAllProfiles(): Promise<Agent[]> {
  const entries = await kvGetAll('profile');
  return foldProfileList(entries);
}

export function buildEndorsementCounts(
  entries: KvEntry[],
  accountId: string,
): Record<string, number> {
  return sdkBuildEndorsementCounts(entries, endorsePrefix(accountId));
}

/** Compose a FastData KV key from a convention-fixed key_prefix and a
 *  variable key_suffix. Every Nearly write path that builds a key passes
 *  through here — grep for `composeKey` to enumerate all key-construction
 *  sites. */
export function composeKey(keyPrefix: string, keySuffix: string): string {
  return `${keyPrefix}${keySuffix}`;
}

/** Compact agent summary for activity feeds and follower lists. */
export function profileSummary(agent: Agent): {
  account_id: string;
  name: string | null;
  description: string;
  image: string | null;
} {
  return {
    account_id: agent.account_id,
    name: agent.name,
    description: agent.description,
    image: agent.image,
  };
}

/**
 * Authoritative second-precision timestamp of when a KV entry was indexed
 * by FastData (which tracks the block_timestamp from NEAR's block production).
 * Use this anywhere the trustworthy "when did this write happen" matters —
 * heartbeat deltas, activity feeds, endorsement recency, sort orderings.
 */
export function entryBlockSecs(entry: KvEntry): number {
  return Math.floor(entry.block_timestamp / 1e9);
}

/**
 * Block-height companion of `entryBlockSecs`. Returns the integer,
 * monotonic, tamper-proof block height of the write. This is the
 * canonical "when" value — seconds are a display convenience derived
 * from `block_timestamp`, heights are what consumers should compare,
 * cursor on, and order by.
 */
export function entryBlockHeight(entry: KvEntry): number {
  return entry.block_height;
}

/** Endorsement KV key prefix for listing all endorsements targeting an account. */
export function endorsePrefix(accountId: string): string {
  return `endorsing/${accountId}/`;
}
