/**
 * Dispatch read actions via FastData KV.
 *
 * Per-predecessor model: each agent's data is stored under their NEAR account.
 * Key schema:
 *   profile              → AgentRecord
 *   tag/{tag}            → {score: N}
 *   cap/{ns}/{value}     → {score: N}
 *   graph/follow/{accountId} → {at, reason}
 */

import type { Agent, VrfProof } from '@/types';
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
  nowSecs,
  profileCompleteness,
  profileSummary,
} from './fastdata-utils';

export type FastDataError = { error: string; status?: number };
type FastDataResult = { data: unknown } | FastDataError;

function accountIdOf(body: Record<string, unknown>): string | undefined {
  return body.account_id as string | undefined;
}

async function requireAgent(
  body: Record<string, unknown>,
): Promise<{ accountId: string } | FastDataError> {
  const accountId = accountIdOf(body);
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
      case 'get_profile':
        return await handleGetProfile(body);
      case 'list_tags':
        return { data: await handleListTags() };
      case 'list_capabilities':
        return { data: await handleListCapabilities() };
      case 'list_agents':
        return await handleListAgents(body);
      case 'get_followers':
        return await handleGetFollowers(body);
      case 'get_following':
        return await handleGetFollowing(body);
      case 'get_me':
        return await handleGetMe(body);
      case 'get_suggested':
        return await handleGetSuggested(body, null);
      case 'get_edges':
        return await handleGetEdges(body);
      case 'get_endorsers':
      case 'filter_endorsers':
        return await handleGetEndorsers(body);
      case 'get_activity':
        return await handleGetActivity(body);
      case 'get_network':
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
  // Count agents by scanning profile key (one entry per agent).
  const entries = await kvGetAll('profile');
  return { agent_count: entries.length, status: 'ok' };
}

/** Overlay live counts (endorsements, followers, following) onto a raw profile. */
async function withLiveCounts(accountId: string, raw: Agent): Promise<Agent> {
  const [endorseEntries, followerEntries, followingEntries] = await Promise.all(
    [
      kvListAll(endorsePrefix(accountId)),
      kvGetAll(`graph/follow/${accountId}`),
      kvListAgent(accountId, 'graph/follow/'),
    ],
  );
  return {
    ...raw,
    endorsements: buildEndorsementCounts(endorseEntries, accountId),
    follower_count: followerEntries.length,
    following_count: followingEntries.length,
  };
}

async function handleGetProfile(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const raw = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  if (!raw) return { error: 'Agent not found', status: 404 };

  return { data: { agent: await withLiveCounts(accountId, raw) } };
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
    // Filtered: enumerate via tag/cap index, then batch-fetch profiles for page.
    const key = capability
      ? `cap/${capability.toLowerCase()}`
      : `tag/${tag!.toLowerCase()}`;
    const entries = await kvGetAll(key);
    const accountIds = entries.map((e) => e.predecessor_id);
    const profiles = await kvMultiAgent(
      accountIds.map((a) => ({ accountId: a, key: 'profile' })),
    );
    allAgents = profiles.filter((a): a is Agent => a !== null);
  } else {
    // Unfiltered: enumerate all agents via profile key.
    const entries = await kvGetAll('profile');
    allAgents = entries
      .map((e) => e.value as Agent | null)
      .filter((a): a is Agent => a !== null);
  }

  // Sort by requested field from profile data.
  const sortFn = sortComparator(sort);
  allAgents.sort(sortFn);

  // Cursor-based pagination.
  const { page, nextCursor, cursorReset } = cursorPaginate(
    allAgents,
    cursor,
    limit,
    (a) => a.near_account_id,
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
      return (a, b) => endorsementTotal(b) - endorsementTotal(a);
    case 'newest':
      return (a, b) => b.created_at - a.created_at;
    case 'active':
      return (a, b) => b.last_active - a.last_active;
    default: // 'followers'
      return (a, b) => b.follower_count - a.follower_count;
  }
}

function endorsementTotal(agent: Agent): number {
  let total = 0;
  for (const ns of Object.values(agent.endorsements ?? {})) {
    for (const count of Object.values(ns)) {
      total += count;
    }
  }
  return total;
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
  const entries = await kvGetAll(`graph/follow/${accountId}`);
  const followerAccounts = entries.map((e) => e.predecessor_id);

  const { page, nextCursor, cursorReset } = cursorPaginate(
    followerAccounts,
    cursor,
    limit,
    (a) => a,
  );

  const profiles = await kvMultiAgent(
    page.map((a) => ({ accountId: a, key: 'profile' })),
  );
  const agents = profiles.filter((a): a is Agent => a !== null);

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
  const entries = await kvListAgent(accountId, 'graph/follow/');
  const followedAccountIds = entries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );

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
  const agents = profiles.filter((a): a is Agent => a !== null);

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
      suggestions: {
        quality: agent.tags?.length > 0 ? 'personalized' : 'generic',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// VRF-seeded suggestion ranking
// ---------------------------------------------------------------------------

export type { VrfProof } from '@/types';

/** Deterministic xorshift32 PRNG seeded from VRF output bytes. */
function makeRng(hex: string) {
  let state = 0;
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

  // Candidates: all agents, excluding already-followed.
  const allEntries = await kvGetAll('profile');
  const allAgents = allEntries
    .map((e) => e.value as Agent | null)
    .filter((a): a is Agent => a !== null);
  const candidates = allAgents.filter((a) => !followSet.has(a.near_account_id));

  // Score each candidate: shared tags first, then follower count.
  const scored = candidates.map((agent) => {
    const shared = agent.tags?.filter((t) => callerTags.has(t)) ?? [];
    return {
      agent,
      shared,
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
      follow_url: `/api/v1/agents/${s.agent.near_account_id}/follow`,
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
  const allAccountIds = [
    ...new Set([...incomingAccountIds, ...outgoingAccountIds]),
  ];
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
    incomingByAccountId.set(a.near_account_id, edge);
    edges.push(edge);
  }

  for (const id of outgoingAccountIds) {
    const a = profileMap.get(id);
    if (!a) continue;
    const existing = incomingByAccountId.get(a.near_account_id);
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

  // All endorsement entries targeting this account across all predecessors.
  const endorseEntries = await kvListAll(endorsePrefix(accountId));

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
  const agentProfiles = profiles.filter((a): a is Agent => a !== null);
  for (const p of agentProfiles) {
    profileMap.set(p.near_account_id, profileSummary(p));
  }

  // Group entries into ns → value → endorser list.
  const endorsers: Record<
    string,
    Record<
      string,
      Array<{
        handle: string;
        near_account_id: string;
        description: string | null;
        avatar_url: string | null;
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
      handle: profile.handle,
      near_account_id: profile.near_account_id,
      description: profile.description,
      avatar_url: profile.avatar_url ?? null,
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

  // New followers: predecessors who wrote graph/follow/{accountId} with at >= since
  const followerEntries = await kvGetAll(`graph/follow/${accountId}`);
  const newFollowerAccounts: string[] = [];
  for (const e of followerEntries) {
    const at = entryAt(e.value);
    if (at >= since) newFollowerAccounts.push(e.predecessor_id);
  }

  // New following: agent's graph/follow/* keys with at >= since
  const followingEntries = await kvListAgent(accountId, 'graph/follow/');
  const newFollowingAccountIds: string[] = [];
  for (const e of followingEntries) {
    const at = entryAt(e.value);
    if (at >= since)
      newFollowingAccountIds.push(e.key.replace('graph/follow/', ''));
  }

  // Batch-fetch profiles for summaries
  const followerProfiles =
    newFollowerAccounts.length > 0
      ? await kvMultiAgent(
          newFollowerAccounts.map((a) => ({ accountId: a, key: 'profile' })),
        )
      : [];
  const newFollowers = followerProfiles
    .filter((a): a is Agent => a !== null)
    .map(profileSummary);

  const followingProfiles =
    newFollowingAccountIds.length > 0
      ? await kvMultiAgent(
          newFollowingAccountIds.map((a) => ({
            accountId: a,
            key: 'profile',
          })),
        )
      : [];
  const newFollowing = followingProfiles
    .filter((a): a is Agent => a !== null)
    .map(profileSummary);

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

  // Profile + graph data in parallel.
  const [agent, followerEntries, followingEntries] = await Promise.all([
    kvGetAgent(accountId, 'profile') as Promise<Agent | null>,
    kvGetAll(`graph/follow/${accountId}`),
    kvListAgent(accountId, 'graph/follow/'),
  ]);
  if (!agent) return { error: 'Agent not found', status: 404 };

  const followerAccounts = new Set(
    followerEntries.map((e) => e.predecessor_id),
  );
  // Following entries now store account IDs directly
  const followingAccountIds = followingEntries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );

  let mutualCount = 0;
  for (const a of followingAccountIds) {
    if (followerAccounts.has(a)) mutualCount++;
  }

  return {
    data: {
      follower_count: followerEntries.length,
      following_count: followingEntries.length,
      mutual_count: mutualCount,
      last_active: agent.last_active,
      created_at: agent.created_at,
    },
  };
}
