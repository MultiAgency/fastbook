/**
 * Shared agent-state utilities for FastData KV read and write paths.
 *
 * Key schema (per-predecessor — each agent writes under their NEAR account):
 *   profile              → full AgentRecord
 *   tag/{tag}            → true (existence index)
 *   cap/{ns}/{value}     → true (existence index)
 */

import type { Agent } from '@/types';
import { type KvEntry, kvGetAll, kvListAgent } from './fastdata';

/**
 * Count an account's followers and following by scanning the live follow graph.
 * Used on write responses (which need freshness) and alongside endorsement
 * fetches on read paths that overlay live counts onto a stored profile.
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

/** Type-safe null filter for agent profile arrays. */
export function filterAgents(profiles: (unknown | null)[]): Agent[] {
  return profiles.filter((a): a is Agent => a !== null);
}

/**
 * Build endorsement counts from cross-predecessor endorsement entries.
 * Takes entries from kvListAll(`endorsing/${accountId}/`) and returns
 * {ns: {value: endorser_count}} — the live endorsement structure.
 */
export function buildEndorsementCounts(
  entries: KvEntry[],
  accountId: string,
): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  const prefix = endorsePrefix(accountId);
  for (const e of entries) {
    const suffix = e.key.startsWith(prefix)
      ? e.key.slice(prefix.length)
      : e.key;
    const slash = suffix.indexOf('/');
    if (slash < 0) continue;
    const ns = suffix.slice(0, slash);
    const value = suffix.slice(slash + 1);
    if (!counts[ns]) counts[ns] = {};
    counts[ns][value] = (counts[ns][value] ?? 0) + 1;
  }
  return counts;
}

/** Build per-agent KV entries for profile, tags, and capabilities. */
export function agentEntries(agent: Agent): Record<string, unknown> {
  const { follower_count: _, following_count: __, ...rest } = agent;
  const entries: Record<string, unknown> = {
    profile: { ...rest, follower_count: 0, following_count: 0 },
  };
  for (const tag of agent.tags) {
    entries[`tag/${tag}`] = true;
  }
  for (const [ns, val] of extractCapabilityPairs(agent.capabilities)) {
    entries[`cap/${ns}/${val}`] = true;
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

/**
 * Collect all endorsable (ns:value) strings from an agent's tags and capabilities.
 */
export function collectEndorsable(agent: Agent): Set<string> {
  const set = new Set<string>();
  for (const tag of agent.tags ?? []) set.add(`tags:${tag.toLowerCase()}`);
  for (const [ns, val] of extractCapabilityPairs(agent.capabilities))
    set.add(`${ns}:${val}`);
  return set;
}

/** Unix timestamp in seconds. */
export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

/** Build endorsement KV key for a target agent's tag/capability. */
export function endorsementKey(
  target: string,
  ns: string,
  value: string,
): string {
  return `endorsing/${target}/${ns}/${value}`;
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

/** Extract timestamp from a KV entry value. */
export function entryAt(value: unknown): number {
  return (value as Record<string, number> | null)?.at ?? 0;
}

/** Endorsement KV key prefix for listing all endorsements targeting an account. */
export function endorsePrefix(accountId: string): string {
  return `endorsing/${accountId}/`;
}

/** Profile fields that are missing or insufficient. */
export function profileGaps(agent: {
  description?: string | unknown;
  tags?: string[] | unknown;
  capabilities?: Record<string, unknown> | unknown;
}): string[] {
  const gaps: string[] = [];
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
  return gaps;
}

const GAP_SCORE: Record<string, number> = {
  description: 30,
  tags: 30,
  capabilities: 40,
};

/** Compute profile completeness from agent data. */
export function profileCompleteness(
  agent: Parameters<typeof profileGaps>[0],
): number {
  const gaps = profileGaps(agent);
  const total = Object.values(GAP_SCORE).reduce((a, b) => a + b, 0);
  const lost = gaps.reduce((s, g) => s + (GAP_SCORE[g] ?? 0), 0);
  return total - lost;
}
