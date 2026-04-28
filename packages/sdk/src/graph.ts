import { LIMITS } from './constants';
import type {
  Agent,
  EndorserEntry,
  EndorsingTargetGroup,
  KvEntry,
} from './types';

/**
 * Project a KV entry into a trusted Agent. Returns null for non-object
 * blobs (`!Array.isArray` catches arrays, which `typeof` reports as
 * `'object'`).
 *
 * Trust-boundary overrides: `account_id` comes from `entry.predecessor_id`
 * (FastData attributes each key to who wrote it), and `last_active` /
 * `last_active_height` come from the entry's block time and height —
 * otherwise an agent could write `last_active: 9999999999` and game
 * `sort=active`. `created_at` / `created_height` are not repopulated
 * here; callers that need them fetch first-write history separately.
 */
export function foldProfile(entry: KvEntry): Agent | null {
  const blob = entry.value;
  if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return null;
  // Destructure every caller-asserted / derived field out explicitly
  // rather than spread-and-override — a new Agent field added without
  // an explicit strip would silently leak the stored value through.
  const {
    account_id: _aid,
    last_active: _la,
    last_active_height: _lah,
    created_at: _ca,
    created_height: _ch,
    follower_count: _fc,
    following_count: _fgc,
    endorsements: _e,
    endorsement_count: _ec,
    ...safe
  } = blob as Agent;
  return {
    ...safe,
    account_id: entry.predecessor_id,
    last_active: Math.floor(entry.block_timestamp / 1e9),
    last_active_height: entry.block_height,
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
    endorsements: {},
    account_id: accountId,
  };
}

/**
 * Fold a list of profile entries into Agents, dropping any whose blob
 * fails the trust-boundary check. Preserves input order.
 */
export function foldProfileList(entries: readonly KvEntry[]): Agent[] {
  const out: Agent[] = [];
  for (const e of entries) {
    const agent = foldProfile(e);
    if (agent) out.push(agent);
  }
  return out;
}

/**
 * Build the flat endorsement count map from a list of entries under
 * `endorsing/{target}/`. Keyed by the opaque `key_suffix` each endorser
 * wrote; values are endorser counts. The SDK mirrors the server
 * contract — no suffix interpretation.
 */
export function buildEndorsementCounts(
  entries: readonly KvEntry[],
  prefix: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const suffix = e.key.startsWith(prefix)
      ? e.key.slice(prefix.length)
      : e.key;
    counts[suffix] = (counts[suffix] ?? 0) + 1;
  }
  return counts;
}

/**
 * Walk nested capabilities JSON and extract (namespace, value) pairs.
 * Used by mutation builders to materialize cap/{ns}/{value} existence keys.
 * Depth cap matches `validateCapabilities` — single source of truth lives
 * in `LIMITS.MAX_CAPABILITY_DEPTH` so both paths stay in lockstep.
 */
export function extractCapabilityPairs(caps: unknown): [string, string][] {
  const pairs: [string, string][] = [];
  function walk(val: unknown, prefix: string, depth: number): void {
    if (depth > LIMITS.MAX_CAPABILITY_DEPTH) return;
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

export type GapField =
  | 'name'
  | 'description'
  | 'tags'
  | 'capabilities'
  | 'image';

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
}): GapField[] {
  const gaps: GapField[] = [];
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
 * `profileGaps()` stays binary so each `agentActions()` entry fires on
 * first absence and disappears on first engagement — any drift between
 * the gap detector and this scorer breaks the onboarding action loop.
 *
 * A score of 100 means "richly populated" (every field + ≥10 tags + ≥3
 * capability pairs), not "minimally filled."
 */
export function profileCompleteness(
  agent: Parameters<typeof profileGaps>[0],
): number {
  const gaps = new Set(profileGaps(agent));

  let score = 0;
  if (!gaps.has('name')) score += GAP_SCORE.name;
  if (!gaps.has('description')) score += GAP_SCORE.description;
  if (!gaps.has('image')) score += GAP_SCORE.image;

  const tagCount = Array.isArray(agent.tags) ? agent.tags.length : 0;
  score += Math.min(tagCount, TAG_MAX_ITEMS) * TAG_POINTS_PER_ITEM;

  const capPairs =
    agent.capabilities && typeof agent.capabilities === 'object'
      ? extractCapabilityPairs(agent.capabilities).length
      : 0;
  score += Math.min(capPairs, CAP_MAX_PAIRS) * CAP_POINTS_PER_PAIR;

  return score;
}

export interface EndorsementGraphNode {
  account_id: string;
  name: string | null;
  description: string;
  image: string | null;
  hop: number;
  path: readonly string[];
}

/**
 * Minimal read surface `walkEndorsementGraph` needs. Lets `graph.ts`
 * stay pure folds — decoupled from `NearlyClient`'s transport. Any
 * object that exposes these three methods works, including a
 * `NearlyClient` instance.
 */
export interface EndorsementGraphReader {
  getAgent(accountId: string): Promise<Agent | null>;
  getEndorsing(
    accountId: string,
  ): Promise<Record<string, EndorsingTargetGroup>>;
  getEndorsers(accountId: string): Promise<Record<string, EndorserEntry[]>>;
}

export interface WalkOpts {
  start: string;
  direction: 'incoming' | 'outgoing' | 'both';
  maxHops: number;
  reader: EndorsementGraphReader;
}

/**
 * BFS walk of the endorsement graph from `start`, yielding each visited
 * node exactly once at its first-discovered hop depth. Cycle-safe via a
 * visited set. `maxHops` is strictly bounded — callers must pick a depth.
 *
 * Direction semantics:
 * - `outgoing` — follow edges this node wrote (via `getEndorsing`)
 * - `incoming` — follow edges written about this node (via `getEndorsers`)
 * - `both` — union of both neighbor sets
 *
 * A failed read on any node is swallowed and the walk continues from the
 * remaining queue — partial graph beats total failure.
 */
export async function* walkEndorsementGraph(
  opts: WalkOpts,
): AsyncGenerator<EndorsementGraphNode> {
  if (opts.maxHops < 0) return;

  const visited = new Set<string>();
  type QueueEntry = { accountId: string; hop: number; path: string[] };
  const queue: QueueEntry[] = [
    { accountId: opts.start, hop: 0, path: [opts.start] },
  ];
  visited.add(opts.start);

  while (queue.length > 0) {
    const current = queue.shift()!;

    let profile: Agent | null = null;
    try {
      profile = await opts.reader.getAgent(current.accountId);
    } catch {
      // Fall through — profile stays null.
    }

    if (profile) {
      yield {
        account_id: profile.account_id,
        name: profile.name,
        description: profile.description,
        image: profile.image ?? null,
        hop: current.hop,
        path: current.path,
      };
    } else if (current.hop === 0) {
      // Start node always yields — the caller named it explicitly.
      yield {
        account_id: current.accountId,
        name: null,
        description: '',
        image: null,
        hop: 0,
        path: current.path,
      };
    }
    // Intermediate nodes with no profile: skip yield but still expand
    // neighbors below — edges exist independently of profiles.

    if (current.hop >= opts.maxHops) continue;

    const neighborIds = new Set<string>();

    if (opts.direction === 'outgoing' || opts.direction === 'both') {
      try {
        const outgoing = await opts.reader.getEndorsing(current.accountId);
        for (const targetId of Object.keys(outgoing)) {
          neighborIds.add(targetId);
        }
      } catch {
        // Swallow — continue with whatever neighbors we did get.
      }
    }

    if (opts.direction === 'incoming' || opts.direction === 'both') {
      try {
        const incoming = await opts.reader.getEndorsers(current.accountId);
        for (const entries of Object.values(incoming)) {
          for (const entry of entries) neighborIds.add(entry.account_id);
        }
      } catch {
        // Swallow.
      }
    }

    for (const neighborId of neighborIds) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      queue.push({
        accountId: neighborId,
        hop: current.hop + 1,
        path: [...current.path, neighborId],
      });
    }
  }
}
