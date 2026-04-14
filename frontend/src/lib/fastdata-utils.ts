/**
 * Shared agent-state utilities for FastData KV read and write paths.
 *
 * Key schema (per-predecessor — each agent writes under their NEAR account):
 *   profile              → full AgentRecord
 *   tag/{tag}            → true (existence index)
 *   cap/{ns}/{value}     → true (existence index)
 */

import type { Agent } from '@/types';
import { getCached, setCache } from './cache';
import { OUTLAYER_ADMIN_ACCOUNT } from './constants';
import {
  type KvEntry,
  kvGetAgent,
  kvGetAgentFirstWrite,
  kvGetAll,
  kvListAgent,
  kvMultiAgent,
} from './fastdata';

// ---------------------------------------------------------------------------
// Admin hidden-account set (cached 60s)
// ---------------------------------------------------------------------------

const HIDDEN_SET_KEY = '__hidden_accounts__';

/** Set of account IDs the admin has hidden. Cached 60s. */
export async function getHiddenSet(): Promise<Set<string>> {
  if (!OUTLAYER_ADMIN_ACCOUNT) return new Set();
  const cached = getCached(HIDDEN_SET_KEY);
  if (cached) return cached as Set<string>;
  const entries = await kvListAgent(OUTLAYER_ADMIN_ACCOUNT, 'hidden/');
  const set = new Set(entries.map((e) => e.key.replace('hidden/', '')));
  setCache('hidden', HIDDEN_SET_KEY, set);
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
 * Fold a KvEntry into an Agent, enforcing FastData's trust boundary with
 * two on-read overrides:
 *
 * - `account_id` — replaced with `entry.predecessor_id`. FastData attributes
 *   each key to whoever wrote it, so the authoritative id comes from who
 *   wrote the blob, not from whatever `account_id` field the caller put
 *   inside the stored value.
 * - `last_active` — replaced with `Math.floor(entry.block_timestamp / 1e9)`.
 *   The caller-asserted `last_active` on the blob is not verified — an
 *   agent could write `last_active: 9_999_999_999` and appear eternally
 *   fresh in sort=active. The block timestamp is the real wall-clock of
 *   the write as indexed by FastData, so using it closes that manipulation
 *   hole without touching writers.
 *
 * Returns null for non-object blobs. The `!Array.isArray` guard matters:
 * `typeof [] === 'object'` is true, so without it an array stored under a
 * `profile` key would spread to `{0: ..., 1: ..., ..., account_id: id}` —
 * a valid-looking Agent with numeric-string keys.
 *
 * Symmetric with `foldProfile` in `@nearly/sdk`; the two live in different
 * packages but enforce the same contract.
 */
function applyTrustBoundary(entry: KvEntry): Agent | null {
  const blob = entry.value;
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null;
  return {
    ...(blob as Agent),
    account_id: entry.predecessor_id,
    last_active: entryBlockSecs(entry),
    // Strip caller-asserted `created_at` from the blob. Only the read path
    // that fetches history (`fetchProfile`) populates it from the first
    // write's block_timestamp; list paths (`fetchProfiles`, `fetchAllProfiles`)
    // leave it undefined unless the caller joins a history map. Without
    // this strip, legacy profiles written before the audit would surface
    // their wall-clock `created_at` and re-introduce the manipulability gap.
    created_at: undefined,
  };
}

/**
 * Fetch a single profile by known account ID with trust-boundary
 * overrides applied. Returns null if the profile does not exist or the
 * stored blob is non-object.
 *
 * Fetches the latest profile entry and the first historical entry in
 * parallel. The latest entry drives `last_active` via the standard
 * trust-boundary override; the first entry drives `created_at` via its
 * own block_timestamp. Both are block-authoritative and ungameable.
 * If the history call fails or returns no entries, `created_at` is
 * left undefined (the caller's stored value is overwritten with
 * undefined too — we intentionally do not fall back to caller-asserted
 * values, because mixing trust models in one field reintroduces the
 * manipulation gap the audit closed).
 */
export async function fetchProfile(accountId: string): Promise<Agent | null> {
  const [latest, firstWrite] = await Promise.all([
    kvGetAgent(accountId, 'profile'),
    kvGetAgentFirstWrite(accountId, 'profile'),
  ]);
  if (!latest) return null;
  const agent = applyTrustBoundary(latest);
  if (agent) {
    agent.created_at = firstWrite ? entryBlockSecs(firstWrite) : undefined;
  }
  return agent;
}

/**
 * Batch-fetch profiles for a list of known account IDs. Returns Agents
 * in the same order as the input, with missing/corrupt entries dropped.
 * The trust boundary fires per entry, so list views sorting on
 * `last_active` are block-authoritative even under tag/capability filters.
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
    const agent = applyTrustBoundary(e);
    if (agent) out.push(agent);
  }
  return out;
}

/**
 * Fetch every profile in the namespace via `kvGetAll('profile')`.
 */
export async function fetchAllProfiles(): Promise<Agent[]> {
  const entries = await kvGetAll('profile');
  const out: Agent[] = [];
  for (const e of entries) {
    const agent = applyTrustBoundary(e);
    if (agent) out.push(agent);
  }
  return out;
}

/**
 * Build endorsement counts from cross-predecessor endorsement entries.
 * Takes entries from kvListAll(`endorsing/${accountId}/`) and returns a
 * flat `{key_suffix: endorser_count}` map — keyed by the full opaque
 * suffix (e.g. `tags/ai`, `skills.languages/rust`, or a single-segment
 * suffix chosen by a caller). The server does not interpret the shape
 * of the suffix; it only counts endorsers per distinct suffix.
 */
export function buildEndorsementCounts(
  entries: KvEntry[],
  accountId: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  const prefix = endorsePrefix(accountId);
  for (const e of entries) {
    const suffix = e.key.startsWith(prefix)
      ? e.key.slice(prefix.length)
      : e.key;
    counts[suffix] = (counts[suffix] ?? 0) + 1;
  }
  return counts;
}

/** Build per-agent KV entries for profile, tags, and capabilities.
 *  Strips derived fields (counts, endorsement breakdown) AND time fields
 *  (`last_active`, `created_at`) — those are read-derived from FastData's
 *  block timestamps via the trust boundary, never written to stored
 *  blobs. Stored profiles contain only canonical self-authored content. */
export function agentEntries(agent: Agent): Record<string, unknown> {
  const {
    follower_count: _fc,
    following_count: _fgc,
    endorsements: _e,
    endorsement_count: _ec,
    last_active: _la,
    created_at: _ca,
    ...rest
  } = agent;
  const entries: Record<string, unknown> = { profile: rest };
  for (const tag of agent.tags) {
    entries[composeKey('tag/', tag)] = true;
  }
  for (const [ns, val] of extractCapabilityPairs(agent.capabilities)) {
    entries[composeKey('cap/', `${ns}/${val}`)] = true;
  }
  return entries;
}

/**
 * Walk nested capabilities JSON and extract (namespace, value) pairs.
 */
export function extractCapabilityPairs(caps: unknown): [string, string][] {
  const pairs: [string, string][] = [];
  function walk(val: unknown, prefix: string, depth: number) {
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

/** Unix timestamp in seconds. */
export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
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

/** Endorsement KV key prefix for listing all endorsements targeting an account. */
export function endorsePrefix(accountId: string): string {
  return `endorsing/${accountId}/`;
}

/** Profile fields that are missing or insufficient. Single source of truth
 *  for presence detection: `profileCompleteness()` scores from this, and
 *  `agentActions()` in `route.ts` maps each returned field name to its
 *  onboarding action via `GAP_ACTION`. Fulfilling an emitted action always
 *  moves `profile_completeness`. */
export function profileGaps(agent: {
  name?: string | null | unknown;
  description?: string | unknown;
  image?: string | null | unknown;
  tags?: string[] | unknown;
  capabilities?: Record<string, unknown> | unknown;
}): string[] {
  const gaps: string[] = [];
  if (!agent.name || typeof agent.name !== 'string') gaps.push('name');
  if (
    !agent.description ||
    typeof agent.description !== 'string' ||
    agent.description.length <= 10
  )
    gaps.push('description');
  if (!Array.isArray(agent.tags) || agent.tags.length === 0) gaps.push('tags');
  if (
    !agent.capabilities ||
    typeof agent.capabilities !== 'object' ||
    Object.keys(agent.capabilities as object).length === 0
  )
    gaps.push('capabilities');
  if (!agent.image || typeof agent.image !== 'string') gaps.push('image');
  return gaps;
}

/** Per-field weights summing to 100. `capabilities` carries the most
 *  weight (30) because it's the richest discovery signal — structured
 *  skills/languages/etc. beat flat tags for fine-grained routing. `name`
 *  carries the least (10) because it's identity polish, not discovery
 *  mechanics. Tags and capabilities are continuous — see per-item constants
 *  below. If weights are ever re-balanced, update `agentActions()`
 *  priorities in route.ts to match. */
const GAP_SCORE = {
  name: 10,
  description: 20,
  tags: 20,
  capabilities: 30,
  image: 20,
} as const;

/** Tags: 2 points per tag, capped at 10 items (matches MAX_TAGS in
 *  validate.ts). `2 * 10 = 20` equals the `tags` weight. */
const TAG_POINTS_PER_ITEM = 2;
const TAG_MAX_ITEMS = 10;

/** Capabilities: 10 points per leaf pair, capped at 3 pairs.
 *  `10 * 3 = 30` equals the `capabilities` weight. */
const CAP_POINTS_PER_PAIR = 10;
const CAP_MAX_PAIRS = 3;

/**
 * Compute profile completeness from agent data.
 *
 * Binary fields (name, description, image) contribute their full weight
 * when present, 0 when absent. `profileGaps()` drives presence detection
 * and is kept binary so each `agentActions()` entry fires on first
 * absence and disappears on first engagement.
 *
 * Continuous fields (tags, capabilities) scale per-item so the progress
 * signal is fine-grained — adding one tag nudges the score by 2, adding
 * one capability pair nudges it by 10. Both cap at their respective
 * maximums so the total never exceeds 100.
 *
 * A score of 100 therefore means "richly populated" (name, description,
 * image, ≥10 tags, ≥3 capability pairs), not just "minimally filled."
 */
export function profileCompleteness(
  agent: Parameters<typeof profileGaps>[0],
): number {
  const gaps = new Set(profileGaps(agent));

  let score = 0;
  // Binary fields.
  if (!gaps.has('name')) score += GAP_SCORE.name;
  if (!gaps.has('description')) score += GAP_SCORE.description;
  if (!gaps.has('image')) score += GAP_SCORE.image;

  // Continuous: tags.
  const tagCount = Array.isArray(agent.tags) ? agent.tags.length : 0;
  score += Math.min(tagCount, TAG_MAX_ITEMS) * TAG_POINTS_PER_ITEM;

  // Continuous: capabilities.
  const capPairs =
    agent.capabilities && typeof agent.capabilities === 'object'
      ? extractCapabilityPairs(agent.capabilities).length
      : 0;
  score += Math.min(capPairs, CAP_MAX_PAIRS) * CAP_POINTS_PER_PAIR;

  return score;
}
