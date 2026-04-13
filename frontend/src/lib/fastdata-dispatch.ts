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
import { kvGetAgent, kvGetAll, kvListAgent, kvListAll } from './fastdata';
import {
  buildEndorsementCounts,
  endorsePrefix,
  entryAt,
  fetchAllProfiles,
  fetchProfile,
  fetchProfiles,
  liveNetworkCounts,
  nowSecs,
  profileCompleteness,
  profileSummary,
} from './fastdata-utils';
export type FastDataError = { error: string; status?: number };
type FastDataResult = { data: unknown } | FastDataError;

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
    endorsement_count: endorseEntries.length,
    ...counts,
  };
}

async function handleGetProfile(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const callerAccountId = body.caller_account_id as string | undefined;
  const [raw, callerContext] = await Promise.all([
    fetchProfile(accountId),
    // Caller enrichment is best-effort: if the KV lookups fail transiently,
    // fall back to an unenriched profile rather than failing the whole read.
    callerAccountId
      ? fetchCallerContext(callerAccountId, accountId).catch((err) => {
          console.error(
            '[fastdata-dispatch] caller context fetch failed:',
            err instanceof Error ? err.message : String(err),
          );
          return null;
        })
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
    kvGetAgent<{ at: number }>(
      callerAccountId,
      `graph/follow/${targetAccountId}`,
    ),
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
  const sort = (body.sort as string) || 'active';
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;
  const tag = body.tag as string | undefined;
  const capability = body.capability as string | undefined;

  // Profile reads go through `fetchProfiles` / `fetchAllProfiles`,
  // which enforce the FastData trust boundary (authoritative account
  // IDs come from the predecessor namespace, never the stored blob).
  let allAgents: Agent[];

  if (capability || tag) {
    const key = capability
      ? `cap/${capability.toLowerCase()}`
      : `tag/${tag!.toLowerCase()}`;
    const entries = await kvGetAll(key);
    allAgents = await fetchProfiles(entries.map((e) => e.predecessor_id));
  } else {
    allAgents = await fetchAllProfiles();
  }

  // Backend returns raw graph truth. Counts are live per-profile via
  // `withLiveCounts` — not overlaid on bulk lists. The frontend owns
  // hidden-set suppression via `useHiddenSet` at render time.
  const sortFn = sortComparator(sort);
  allAgents.sort(sortFn);

  // Cursor-based pagination.
  const { page, nextCursor, cursorReset } = cursorPaginate(
    allAgents,
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
    case 'newest':
      return (a, b) => b.created_at - a.created_at;
    default: // 'active'
      return (a, b) => b.last_active - a.last_active;
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
  const entries = await kvGetAll(`graph/follow/${accountId}`);
  const followerAccounts = entries.map((e) => e.predecessor_id);

  const { page, nextCursor, cursorReset } = cursorPaginate(
    followerAccounts,
    cursor,
    limit,
    (a) => a,
  );

  const agents = await fetchProfiles(page);

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
  const agents = await fetchProfiles(page);

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
  const raw = await fetchProfile(accountId);
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
    fetchProfile(accountId),
    kvListAgent(accountId, 'graph/follow/'),
  ]);
  const callerTags = new Set(callerAgent?.tags ?? []);
  const followSet = new Set(
    followEntries.map((e) => e.key.replace('graph/follow/', '')),
  );
  followSet.add(accountId);

  // Candidates: all agents, excluding already-followed.
  const allAgents = await fetchAllProfiles();
  const candidates = allAgents.filter((a) => !followSet.has(a.account_id));

  // Score = shared tag count (integer tier key for VRF shuffle). Within a
  // tier, sort by last_active descending as a deterministic fallback order.
  // When a VRF proof is supplied, the tier is re-shuffled for fairness —
  // the last_active ordering is only visible when vrfProof is null.
  const scored = candidates.map((agent) => {
    const shared = agent.tags?.filter((t) => callerTags.has(t)) ?? [];
    return {
      agent,
      shared,
      score: shared.length,
    };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.agent.last_active - a.agent.last_active;
  });

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
        : 'New on the network';
    return {
      ...s.agent,
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
  // Edges are identity views — no count overlay. `fetchProfiles`
  // enforces the trust-boundary override for every agent.
  const profileMap = new Map<string, Agent>();
  for (const a of await fetchProfiles(allAccountIds)) {
    profileMap.set(a.account_id, a);
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

  // All endorsement entries targeting this account across all predecessors.
  const endorseEntries = await kvListAll(endorsePrefix(accountId));

  const prefix = endorsePrefix(accountId);

  // Deduplicate endorser account IDs and batch-fetch profiles.
  const endorserAccountIds = [
    ...new Set(endorseEntries.map((e) => e.predecessor_id)),
  ];

  // Build a lookup map: accountId → profile summary. `fetchProfiles`
  // enforces the trust-boundary override, so the map keys match the
  // authoritative predecessor_id we look up with below.
  const profileMap = new Map<string, ReturnType<typeof profileSummary>>();
  for (const p of await fetchProfiles(endorserAccountIds)) {
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

  for (const e of endorseEntries) {
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

  // New followers: predecessors who wrote graph/follow/{accountId} with at >= since
  const [followerEntries, followingEntries] = await Promise.all([
    kvGetAll(`graph/follow/${accountId}`),
    kvListAgent(accountId, 'graph/follow/'),
  ]);

  const newFollowerAccounts: string[] = [];
  for (const e of followerEntries) {
    const at = entryAt(e.value);
    if (at >= since) newFollowerAccounts.push(e.predecessor_id);
  }

  const newFollowingAccountIds: string[] = [];
  for (const e of followingEntries) {
    const at = entryAt(e.value);
    if (at >= since)
      newFollowingAccountIds.push(e.key.replace('graph/follow/', ''));
  }

  // Batch-fetch profiles for summaries (parallel).
  const [followerAgents, followingAgents] = await Promise.all([
    fetchProfiles(newFollowerAccounts),
    fetchProfiles(newFollowingAccountIds),
  ]);
  const newFollowers = followerAgents.map(profileSummary);
  const newFollowing = followingAgents.map(profileSummary);

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
    fetchProfile(accountId),
    kvGetAll(`graph/follow/${accountId}`),
    kvListAgent(accountId, 'graph/follow/'),
  ]);
  if (!agent) return { error: 'Agent not found', status: 404 };

  const followerAccounts = new Set(
    followerEntries.map((e) => e.predecessor_id),
  );
  const followingAccountIds = followingEntries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );

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
