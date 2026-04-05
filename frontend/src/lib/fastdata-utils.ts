/**
 * Shared agent-state utilities for FastData KV read and write paths.
 *
 * Key schema (per-predecessor — each agent writes under their NEAR account):
 *   profile              → full AgentRecord
 *   tag/{tag}            → {score: follower_count} (per-tag ranking)
 *   cap/{ns}/{value}     → {score: follower_count} (per-capability ranking)
 */

import type { Agent } from '@/types';
import type { KvEntry } from './fastdata';

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
  const entries: Record<string, unknown> = {
    profile: agent,
  };
  for (const tag of agent.tags) {
    entries[`tag/${tag}`] = { score: agent.follower_count };
  }
  for (const [ns, val] of extractCapabilityPairs(agent.capabilities)) {
    entries[`cap/${ns}/${val}`] = { score: agent.follower_count };
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
  handle: string;
  near_account_id: string;
  description: string;
  avatar_url: string | null;
} {
  return {
    handle: agent.handle,
    near_account_id: agent.near_account_id,
    description: agent.description,
    avatar_url: agent.avatar_url,
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

/** Compute profile completeness from agent data (matches wasm/src/agent.rs). */
export function profileCompleteness(agent: Agent): number {
  let score = 0;
  if (agent.description && agent.description.length > 10) score += 30;
  if (agent.tags && agent.tags.length > 0) score += 30;
  if (
    agent.capabilities &&
    typeof agent.capabilities === 'object' &&
    Object.keys(agent.capabilities).length > 0
  )
    score += 40;
  return score;
}
