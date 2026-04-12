/**
 * Dispatch read actions via FastData KV.
 *
 * Per-predecessor model: each agent's data is stored under their NEAR account.
 * Key schema:
 *   profile              → AgentRecord
 *   tag/{tag}            → true (existence index)
 *   cap/{ns}/{value}     → true (existence index)
 *   graph/follow/{accountId} → {at, reason}
 */

import type { Agent, VrfProof } from '@/types';
import { getCached, setCache } from './cache';
import { OUTLAYER_ADMIN_ACCOUNT } from './constants';
import {
  kvGetAgent,
  kvGetAll,
  kvListAgent,
  kvListAll,
  kvMultiAgent,
} from './fastdata';
import {
  buildEndorsementCounts,
  endorsePrefix,
  entryAt,
  extractCapabilityPairs,
  filterAgents,
  liveNetworkCounts,
  nowSecs,
  profileCompleteness,
  profileSummary,
} from './fastdata-utils';
export type FastDataError = { error: string; status?: number };
type FastDataResult = { data: unknown } | FastDataError;

// ---------------------------------------------------------------------------
// Admin hidden-account set (cached 60s)
// ---------------------------------------------------------------------------

const HIDDEN_SET_KEY = '__hidden_accounts__';

export async function getHiddenSet(): Promise<Set<string>> {
  if (!OUTLAYER_ADMIN_ACCOUNT) return new Set();
  const cached = getCached(HIDDEN_SET_KEY);
  if (cached) return cached as Set<string>;
  const entries = await kvListAgent(OUTLAYER_ADMIN_ACCOUNT, 'hidden/');
  const set = new Set(entries.map((e) => e.key.replace('hidden/', '')));
  setCache('hidden', HIDDEN_SET_KEY, set);
  return set;
}

async function requireAgent(
  body: Record<string, unknown>,
): Promise<{ accountId: string } | FastDataError> {
  const accountId = body.account_id as string | undefined;
  if (!accountId) return { error: 'account_id is required', status: 400 };
  return { accountId };
}

function cursorPaginate<T>(
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

export async function dispatchFastData(
  action: string,
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  try {
    switch (action) {
      case 'health':
        return { data: await handleHealth() };
      case 'profile':
        return await handleGetProfile(body);
      case 'list_tags':
        return { data: await handleListTags() };
      case 'list_capabilities':
        return { data: await handleListCapabilities() };
      case 'list_agents':
        return await handleListAgents(body);
      case 'followers':
        return await handleGetFollowers(body);
      case 'following':
        return await handleGetFollowing(body);
      case 'me':
        return await handleGetMe(body);
      case 'discover_agents':
        return await handleGetSuggested(body, null);
      case 'edges':
        return await handleGetEdges(body);
      case 'endorsers':
      case 'filter_endorsers':
        return await handleGetEndorsers(body);
      case 'activity':
        return await handleGetActivity(body);
      case 'network':
        return await handleGetNetwork(body);
      default:
        return { error: `Unsupported action: ${action}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `FastData KV error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Public read handlers
// ---------------------------------------------------------------------------

async function handleHealth(): Promise<unknown> {
  const entries = await kvGetAll('profile');
  return { agent_count: entries.length, status: 'ok' };
}

/** Overlay live counts (endorsements, followers, following) onto a raw profile. */
async function withLiveCounts(accountId: string, raw: Agent): Promise<Agent> {
  const [counts, endorseEntries] = await Promise.all([
    liveNetworkCounts(accountId),
    kvListAll(endorsePrefix(accountId)),
  ]);
  return {
    ...raw,
    endorsements: buildEndorsementCounts(endorseEntries, accountId),
    ...counts,
  };
}

const FOLLOWER_COUNTS_KEY = '__follower_counts__';
const ENDORSEMENT_COUNTS_KEY = '__endorsement_counts__';

/**
 * Build a global map of follower/following counts from the follow graph.
 * Single cross-predecessor scan of all follow edges, cached 30s.
 */
async function getFollowerCountMap(): Promise<
  Map<string, { follower_count: number; following_count: number }>
> {
  const cached = getCached(FOLLOWER_COUNTS_KEY);
  if (cached)
    return cached as Map<
      string,
      { follower_count: number; following_count: number }
    >;

  const edges = await kvListAll('graph/follow/');
  const followers = new Map<string, number>();
  const following = new Map<string, number>();
  for (const e of edges) {
    const target = e.key.replace('graph/follow/', '');
    followers.set(target, (followers.get(target) ?? 0) + 1);
    following.set(e.predecessor_id, (following.get(e.predecessor_id) ?? 0) + 1);
  }
  const result = new Map<
    string,
    { follower_count: number; following_count: number }
  >();
  for (const id of new Set([...followers.keys(), ...following.keys()])) {
    result.set(id, {
      follower_count: followers.get(id) ?? 0,
      following_count: following.get(id) ?? 0,
    });
  }
  setCache('follower_counts', FOLLOWER_COUNTS_KEY, result);
  return result;
}

/**
 * Build a global map of endorsement counts from all endorsement edges.
 * Single cross-predecessor scan of `endorsing/`, cached 30s. Each entry key
 * is `endorsing/{target}/{ns}/{value}` written under the endorser's
 * namespace; we parse `target` out of the key and count per target.
 */
async function getEndorsementCountMap(): Promise<Map<string, number>> {
  const cached = getCached(ENDORSEMENT_COUNTS_KEY);
  if (cached) return cached as Map<string, number>;

  const edges = await kvListAll('endorsing/');
  const counts = new Map<string, number>();
  for (const e of edges) {
    const suffix = e.key.slice('endorsing/'.length);
    const slash = suffix.indexOf('/');
    if (slash < 0) continue;
    const target = suffix.slice(0, slash);
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  setCache('endorsement_counts', ENDORSEMENT_COUNTS_KEY, counts);
  return counts;
}

const ZERO_COUNTS = { follower_count: 0, following_count: 0 };

/** Overlay cached live follower/following/endorsement counts onto agents. */
async function enrichWithLiveCounts(agents: Agent[]): Promise<Agent[]> {
  const [followMap, endorseMap] = await Promise.all([
    getFollowerCountMap(),
    getEndorsementCountMap(),
  ]);
  return agents.map((agent) => ({
    ...agent,
    ...(followMap.get(agent.account_id) ?? ZERO_COUNTS),
    endorsement_count: endorseMap.get(agent.account_id) ?? 0,
  }));
}

async function handleGetProfile(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const hidden = await getHiddenSet();
  if (hidden.has(accountId)) return { error: 'Agent not found', status: 404 };

  const callerAccountId = body.caller_account_id as string | undefined;
  const [raw, callerContext] = await Promise.all([
    kvGetAgent(accountId, 'profile') as Promise<Agent | null>,
    // Caller enrichment is best-effort: if the KV lookups fail transiently,
    // fall back to an unenriched profile rather than failing the whole read.
    callerAccountId
      ? fetchCallerContext(callerAccountId, accountId).catch(() => null)
      : Promise.resolve(null),
  ]);
  if (!raw) return { error: 'Agent not found', status: 404 };

  return {
    data: {
      agent: await withLiveCounts(accountId, raw),
      ...(callerContext ?? {}),
    },
  };
}

/**
 * Look up the caller's stance toward a target agent: whether they follow them,
 * and which of the target's tags/capabilities they have endorsed. Returns
 * `{ is_following, my_endorsements }` for inclusion in the profile response.
 */
async function fetchCallerContext(
  callerAccountId: string,
  targetAccountId: string,
): Promise<{
  is_following: boolean;
  my_endorsements: Record<string, string[]>;
}> {
  const [followEntry, endorseEntries] = await Promise.all([
    kvGetAgent(callerAccountId, `graph/follow/${targetAccountId}`),
    kvListAgent(callerAccountId, `endorsing/${targetAccountId}/`),
  ]);
  const my_endorsements: Record<string, string[]> = {};
  const prefix = `endorsing/${targetAccountId}/`;
  for (const e of endorseEntries) {
    const suffix = e.key.startsWith(prefix) ? e.key.slice(prefix.length) : '';
    const slash = suffix.indexOf('/');
    if (slash < 0) continue;
    const ns = suffix.slice(0, slash);
    const value = suffix.slice(slash + 1);
    if (!my_endorsements[ns]) my_endorsements[ns] = [];
    my_endorsements[ns].push(value);
  }
  return { is_following: followEntry !== null, my_endorsements };
}

/** Scan KV entries by prefix and aggregate counts by key suffix, sorted desc. */
async function aggregateCounts(
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

async function handleListTags(): Promise<unknown> {
  const rows = await aggregateCounts('tag/');
  return { tags: rows.map(({ key, count }) => ({ tag: key, count })) };
}

async function handleListCapabilities(): Promise<unknown> {
  const rows = await aggregateCounts('cap/');
  return {
    capabilities: rows.map(({ key, count }) => {
      const slash = key.indexOf('/');
      return {
        namespace: slash >= 0 ? key.slice(0, slash) : key,
        value: slash >= 0 ? key.slice(slash + 1) : key,
        count,
      };
    }),
  };
}

async function handleListAgents(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const sort = (body.sort as string) || 'followers';
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;
  const tag = body.tag as string | undefined;
  const capability = body.capability as string | undefined;

  let allAgents: Agent[];

  if (capability || tag) {
    const key = capability
      ? `cap/${capability.toLowerCase()}`
      : `tag/${tag!.toLowerCase()}`;
    const entries = await kvGetAll(key);
    const accountIds = entries.map((e) => e.predecessor_id);
    const profiles = await kvMultiAgent(
      accountIds.map((a) => ({ accountId: a, key: 'profile' })),
    );
    allAgents = filterAgents(profiles);
  } else {
    const entries = await kvGetAll('profile');
    allAgents = filterAgents(entries.map((e) => e.value as Agent | null));
  }

  // Filter hidden accounts.
  const hidden = await getHiddenSet();
  if (hidden.size > 0) {
    allAgents = allAgents.filter((a) => !hidden.has(a.account_id));
  }

  // Overlay live follower/following counts from graph scan.
  const enriched = await enrichWithLiveCounts(allAgents);

  // Sort by requested field.
  const sortFn = sortComparator(sort);
  enriched.sort(sortFn);

  // Cursor-based pagination.
  const { page, nextCursor, cursorReset } = cursorPaginate(
    enriched,
    cursor,
    limit,
    (a) => a.account_id,
  );

  return {
    data: {
      agents: page,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}

function sortComparator(sort: string): (a: Agent, b: Agent) => number {
  switch (sort) {
    case 'endorsements':
      return (a, b) => (b.endorsement_count ?? 0) - (a.endorsement_count ?? 0);
    case 'newest':
      return (a, b) => b.created_at - a.created_at;
    case 'active':
      return (a, b) => b.last_active - a.last_active;
    default: // 'followers'
      return (a, b) => b.follower_count - a.follower_count;
  }
}

async function handleGetFollowers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;

  // "Who follows accountId?" = all predecessors who wrote graph/follow/{accountId}
  const hidden = await getHiddenSet();
  if (hidden.has(accountId)) return { error: 'Agent not found', status: 404 };
  const entries = await kvGetAll(`graph/follow/${accountId}`);
  let followerAccounts = entries.map((e) => e.predecessor_id);
  if (hidden.size > 0) {
    followerAccounts = followerAccounts.filter((a) => !hidden.has(a));
  }

  const { page, nextCursor, cursorReset } = cursorPaginate(
    followerAccounts,
    cursor,
    limit,
    (a) => a,
  );

  const profiles = await kvMultiAgent(
    page.map((a) => ({ accountId: a, key: 'profile' })),
  );
  const agents = filterAgents(profiles);

  return {
    data: {
      account_id: accountId,
      followers: agents,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}

async function handleGetFollowing(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;

  // "Who does accountId follow?" = agent's graph/follow/* keys
  const hidden = await getHiddenSet();
  if (hidden.has(accountId)) return { error: 'Agent not found', status: 404 };
  const entries = await kvListAgent(accountId, 'graph/follow/');
  let followedAccountIds = entries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );
  if (hidden.size > 0) {
    followedAccountIds = followedAccountIds.filter((a) => !hidden.has(a));
  }

  const { page, nextCursor, cursorReset } = cursorPaginate(
    followedAccountIds,
    cursor,
    limit,
    (a) => a,
  );

  // Fetch profiles directly by account ID — no resolution needed.
  const profiles =
    page.length > 0
      ? await kvMultiAgent(page.map((a) => ({ accountId: a, key: 'profile' })))
      : [];
  const agents = filterAgents(profiles);

  return {
    data: {
      account_id: accountId,
      following: agents,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}

// ---------------------------------------------------------------------------
// Authenticated read handlers
// ---------------------------------------------------------------------------

async function handleGetMe(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const raw = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  if (!raw) return { error: 'Agent not found', status: 404 };

  const agent = await withLiveCounts(accountId, raw);

  return {
    data: {
      agent,
      profile_completeness: profileCompleteness(agent),
    },
  };
}

// ---------------------------------------------------------------------------
// VRF-seeded suggestion ranking
// ---------------------------------------------------------------------------

/** Deterministic xorshift32 PRNG seeded from VRF output bytes.
 *  Shift constants (13, 17, 5) are Marsaglia's standard xorshift32 triple. */
function makeRng(hex: string) {
  let state = 0;
  // Pack first 4 bytes of hex into a 32-bit seed
  for (let i = 0; i < Math.min(hex.length, 8); i += 2) {
    state ^= Number.parseInt(hex.slice(i, i + 2), 16) << ((i / 2) * 8);
  }
  if (state === 0) state = 1;
  state = state >>> 0; // ensure unsigned 32-bit

  return {
    pick(n: number): number | null {
      if (n === 0) return null;
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state = state >>> 0;
      return state % n;
    },
  };
}

export async function handleGetSuggested(
  body: Record<string, unknown>,
  vrfProof: VrfProof | null,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 10, 50);

  // Caller context.
  const [callerAgent, followEntries] = await Promise.all([
    kvGetAgent(accountId, 'profile') as Promise<Agent | null>,
    kvListAgent(accountId, 'graph/follow/'),
  ]);
  const callerTags = new Set(callerAgent?.tags ?? []);
  const followSet = new Set(
    followEntries.map((e) => e.key.replace('graph/follow/', '')),
  );
  followSet.add(accountId);

  // Candidates: all agents, excluding already-followed, with live counts.
  const allEntries = await kvGetAll('profile');
  const allAgents = filterAgents(
    allEntries.map((e) => e.value as Agent | null),
  );
  const enriched = await enrichWithLiveCounts(allAgents);
  const hidden = await getHiddenSet();
  const candidates = enriched.filter(
    (a) => !followSet.has(a.account_id) && !hidden.has(a.account_id),
  );

  // Score each candidate: shared tags first, then follower count.
  const scored = candidates.map((agent) => {
    const shared = agent.tags?.filter((t) => callerTags.has(t)) ?? [];
    return {
      agent,
      shared,
      // Weight shared tags 1000× above follower count so tag affinity dominates
      score: shared.length * 1000 + agent.follower_count,
    };
  });
  scored.sort((a, b) => b.score - a.score);

  // VRF shuffle within equal-score tiers for fairness.
  if (vrfProof) {
    const rng = makeRng(vrfProof.output_hex);
    let i = 0;
    while (i < scored.length) {
      const tierScore = scored[i].score;
      const start = i;
      while (i < scored.length && scored[i].score === tierScore) i++;
      // Fisher-Yates shuffle within the tier.
      for (let j = i - 1; j > start; j--) {
        const k = rng.pick(j - start + 1);
        if (k !== null) {
          [scored[start + k], scored[j]] = [scored[j], scored[start + k]];
        }
      }
    }
  }

  const agents = scored.slice(0, limit).map((s) => {
    const reason =
      s.shared.length > 0
        ? `Shared tags: ${s.shared.join(', ')}`
        : s.agent.follower_count > 0
          ? 'Popular on the network'
          : 'New on the network';
    return {
      ...s.agent,
      follow_url: `/api/v1/agents/${s.agent.account_id}/follow`,
      reason,
    };
  });

  return { data: { agents, vrf: vrfProof } };
}

// ---------------------------------------------------------------------------
// Edge & endorser handlers
// ---------------------------------------------------------------------------

async function handleGetEdges(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 25, 100);
  const direction = (body.direction as string) || 'both';

  const wantIncoming = direction === 'incoming' || direction === 'both';
  const wantOutgoing = direction === 'outgoing' || direction === 'both';

  // Parallel: fetch incoming and outgoing raw data at once
  const [incomingEntries, outgoingEntries] = await Promise.all([
    wantIncoming ? kvGetAll(`graph/follow/${accountId}`) : Promise.resolve([]),
    wantOutgoing
      ? kvListAgent(accountId, 'graph/follow/')
      : Promise.resolve([]),
  ]);

  // Collect all account IDs needed, dedupe, single batch fetch.
  const incomingAccountIds = incomingEntries.map((e) => e.predecessor_id);
  const outgoingAccountIds = outgoingEntries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );
  const hidden = await getHiddenSet();
  if (hidden.has(accountId)) return { error: 'Agent not found', status: 404 };
  const allAccountIds = [
    ...new Set([...incomingAccountIds, ...outgoingAccountIds]),
  ].filter((a) => !hidden.has(a));
  const profileMap = new Map<string, Agent>();
  if (allAccountIds.length > 0) {
    const profiles = await kvMultiAgent(
      allAccountIds.map((a) => ({ accountId: a, key: 'profile' })),
    );
    for (let i = 0; i < allAccountIds.length; i++) {
      if (profiles[i]) profileMap.set(allAccountIds[i], profiles[i] as Agent);
    }
  }

  const edges: Record<string, unknown>[] = [];
  const incomingByAccountId = new Map<string, Record<string, unknown>>();

  for (const id of incomingAccountIds) {
    const a = profileMap.get(id);
    if (!a) continue;
    const edge = { ...a, direction: 'incoming' };
    incomingByAccountId.set(a.account_id, edge);
    edges.push(edge);
  }

  for (const id of outgoingAccountIds) {
    const a = profileMap.get(id);
    if (!a) continue;
    const existing = incomingByAccountId.get(a.account_id);
    if (existing) {
      existing.direction = 'mutual';
    } else {
      edges.push({ ...a, direction: 'outgoing' });
    }
  }

  return {
    data: {
      account_id: accountId,
      edges: edges.slice(0, limit),
    },
  };
}

async function handleGetEndorsers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const hidden = await getHiddenSet();
  if (hidden.has(accountId)) return { error: 'Agent not found', status: 404 };

  // All endorsement entries targeting this account across all predecessors.
  let endorseEntries = await kvListAll(endorsePrefix(accountId));
  if (hidden.size > 0) {
    endorseEntries = endorseEntries.filter(
      (e) => !hidden.has(e.predecessor_id),
    );
  }

  // Optional tag/capability filtering (for filter_endorsers action).
  const filterTags = body.tags as string[] | undefined;
  const filterCaps = body.capabilities as Record<string, unknown> | undefined;

  // Parse each entry key to extract ns and value, and optionally filter.
  const prefix = endorsePrefix(accountId);
  let filteredEntries = endorseEntries;

  if (filterTags || filterCaps) {
    filteredEntries = endorseEntries.filter((e) => {
      const suffix = e.key.replace(prefix, '');
      if (filterTags) {
        for (const tag of filterTags) {
          if (suffix === `tags/${tag.toLowerCase()}`) return true;
        }
      }
      if (filterCaps) {
        for (const [ns, val] of extractCapabilityPairs(filterCaps)) {
          if (suffix === `${ns}/${val}`) return true;
        }
      }
      return false;
    });
  }

  // Deduplicate endorser account IDs and batch-fetch profiles.
  const endorserAccountIds = [
    ...new Set(filteredEntries.map((e) => e.predecessor_id)),
  ];
  const profiles =
    endorserAccountIds.length > 0
      ? await kvMultiAgent(
          endorserAccountIds.map((a) => ({ accountId: a, key: 'profile' })),
        )
      : [];

  // Build a lookup map: accountId → profile summary.
  const profileMap = new Map<string, ReturnType<typeof profileSummary>>();
  const agentProfiles = filterAgents(profiles);
  for (const p of agentProfiles) {
    profileMap.set(p.account_id, profileSummary(p));
  }

  // Group entries into ns → value → endorser list.
  const endorsers: Record<
    string,
    Record<
      string,
      Array<{
        account_id: string;
        name: string | null;
        description: string;
        image: string | null;
        reason?: string;
        at?: number;
      }>
    >
  > = {};

  for (const e of filteredEntries) {
    const suffix = e.key.replace(prefix, '');
    const slashIdx = suffix.indexOf('/');
    if (slashIdx === -1) continue; // malformed key, skip
    const ns = suffix.slice(0, slashIdx);
    const value = suffix.slice(slashIdx + 1);

    const profile = profileMap.get(e.predecessor_id);
    if (!profile) continue; // endorser profile not found, skip

    const meta = (e.value ?? {}) as Record<string, unknown>;

    if (!endorsers[ns]) endorsers[ns] = {};
    if (!endorsers[ns][value]) endorsers[ns][value] = [];
    endorsers[ns][value].push({
      account_id: profile.account_id,
      name: profile.name,
      description: profile.description,
      image: profile.image ?? null,
      reason: meta.reason as string | undefined,
      at: meta.at as number | undefined,
    });
  }

  return {
    data: {
      account_id: accountId,
      endorsers,
    },
  };
}

// ---------------------------------------------------------------------------
// Activity & network handlers
// ---------------------------------------------------------------------------

async function handleGetActivity(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const now = nowSecs();
  const sinceRaw = body.cursor ?? body.since;
  const since =
    typeof sinceRaw === 'string' ? parseInt(sinceRaw, 10) : now - 86400;
  if (Number.isNaN(since)) {
    return { error: 'since must be a number', status: 400 };
  }

  const hidden = await getHiddenSet();

  // New followers: predecessors who wrote graph/follow/{accountId} with at >= since
  const [followerEntries, followingEntries] = await Promise.all([
    kvGetAll(`graph/follow/${accountId}`),
    kvListAgent(accountId, 'graph/follow/'),
  ]);

  const newFollowerAccounts: string[] = [];
  for (const e of followerEntries) {
    const at = entryAt(e.value);
    if (at >= since && !hidden.has(e.predecessor_id))
      newFollowerAccounts.push(e.predecessor_id);
  }

  const newFollowingAccountIds: string[] = [];
  for (const e of followingEntries) {
    const at = entryAt(e.value);
    const target = e.key.replace('graph/follow/', '');
    if (at >= since && !hidden.has(target)) newFollowingAccountIds.push(target);
  }

  // Batch-fetch profiles for summaries (parallel)
  const [followerProfiles, followingProfiles] = await Promise.all([
    newFollowerAccounts.length > 0
      ? kvMultiAgent(
          newFollowerAccounts.map((a) => ({ accountId: a, key: 'profile' })),
        )
      : Promise.resolve([]),
    newFollowingAccountIds.length > 0
      ? kvMultiAgent(
          newFollowingAccountIds.map((a) => ({
            accountId: a,
            key: 'profile',
          })),
        )
      : Promise.resolve([]),
  ]);
  const newFollowers = filterAgents(followerProfiles).map(profileSummary);
  const newFollowing = filterAgents(followingProfiles).map(profileSummary);

  return {
    data: {
      since,
      new_followers: newFollowers,
      new_following: newFollowing,
    },
  };
}

async function handleGetNetwork(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const hidden = await getHiddenSet();

  // Profile + graph data in parallel.
  const [agent, followerEntries, followingEntries] = await Promise.all([
    kvGetAgent(accountId, 'profile') as Promise<Agent | null>,
    kvGetAll(`graph/follow/${accountId}`),
    kvListAgent(accountId, 'graph/follow/'),
  ]);
  if (!agent) return { error: 'Agent not found', status: 404 };

  const followerAccounts = new Set(
    followerEntries.map((e) => e.predecessor_id).filter((a) => !hidden.has(a)),
  );
  const followingAccountIds = followingEntries
    .map((e) => e.key.replace('graph/follow/', ''))
    .filter((a) => !hidden.has(a));

  let mutualCount = 0;
  for (const a of followingAccountIds) {
    if (followerAccounts.has(a)) mutualCount++;
  }

  return {
    data: {
      follower_count: followerAccounts.size,
      following_count: followingAccountIds.length,
      mutual_count: mutualCount,
      last_active: agent.last_active,
      created_at: agent.created_at,
    },
  };
}
