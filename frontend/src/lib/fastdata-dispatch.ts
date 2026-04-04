/**
 * Dispatch read actions via FastData KV.
 *
 * Per-predecessor model: each agent's data is stored under their NEAR account.
 * Key schema:
 *   profile              → AgentRecord
 *   name                 → handle string
 *   handle/{handle}      → true (reverse index)
 *   sorted/followers     → {score: N}
 *   sorted/active        → {ts: N}
 *   tag/{tag}            → {score: N}
 *   graph/follow/{target} → {at, reason}
 */

import type { Agent } from '@/types';
import { FASTDATA_LIST_CEILING } from './constants';
import {
  kvGetAgent,
  kvGetAll,
  kvListAgent,
  kvListAll,
  kvMultiAgent,
  resolveHandle,
} from './fastdata';
import { extractCapabilityPairs, profileCompleteness } from './fastdata-sync';

export type FastDataError = { error: string; status?: number };
type FastDataResult = { data: unknown } | FastDataError;

/**
 * Check if a handle was admin-deregistered via the deregistered/{handle} key.
 * Only trusts entries from the configured admin account.
 */
async function isAdminDeregistered(handle: string): Promise<boolean> {
  const entries = await kvGetAll(`deregistered/${handle}`);
  if (entries.length === 0) return false;
  const adminAccount = process.env.OUTLAYER_ADMIN_ACCOUNT || 'hack.near';
  return entries.some((e) => e.predecessor_id === adminAccount);
}

function handleOf(body: Record<string, unknown>): string | undefined {
  return (body.handle as string)?.toLowerCase();
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
      case 'check_handle':
        return { data: await handleCheckHandle(body) };
      case 'get_profile':
        return await handleGetProfile(body);
      case 'list_tags':
        return { data: await handleListTags() };
      case 'list_agents':
        return await handleListAgents(body);
      case 'get_followers':
        return await handleGetFollowers(body);
      case 'get_following':
        return await handleGetFollowing(body);
      case 'get_me':
        return await handleGetMe(body);
      case 'get_suggested':
        return await handleGetSuggested(body);
      case 'get_edges':
        return await handleGetEdges(body);
      case 'get_endorsers':
      case 'filter_endorsers':
        return await handleGetEndorsers(body);
      case 'get_activity':
        return await handleGetActivity(body);
      case 'get_network':
        return await handleGetNetwork(body);
      case 'reconcile_all':
        return await handleReconcileAll();
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
  // Count agents by scanning sorted/followers (one entry per agent).
  const entries = await kvGetAll('sorted/followers');
  return { agent_count: entries.length, status: 'ok' };
}

async function handleCheckHandle(
  body: Record<string, unknown>,
): Promise<unknown> {
  const handle = handleOf(body);
  if (!handle) return { available: false };
  const accountId = await resolveHandle(handle);
  return { handle, available: accountId === null };
}

async function handleGetProfile(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };
  if (await isAdminDeregistered(handle))
    return { error: 'Agent not found', status: 404 };
  const accountId = await resolveHandle(handle);
  if (!accountId) return { error: 'Agent not found', status: 404 };
  const agent = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  if (!agent) return { error: 'Agent not found', status: 404 };
  return { data: { agent } };
}

async function handleListTags(): Promise<unknown> {
  // Scan tag/* entries across all agents — aggregate counts.
  const entries = await kvListAll('tag/');
  const counts: Record<string, number> = {};
  for (const e of entries) {
    const tag = e.key.replace('tag/', '');
    counts[tag] = (counts[tag] ?? 0) + 1;
  }
  const sorted = Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([tag, count]) => ({ tag, count }));
  return { tags: sorted };
}

const LIST_AGENTS_CEILING = FASTDATA_LIST_CEILING;

async function handleListAgents(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const sort = (body.sort as string) || 'followers';
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;
  const tag = body.tag as string | undefined;

  // Read sorted entries — one per agent (predecessor).
  const key = tag ? `tag/${tag.toLowerCase()}` : `sorted/${sort}`;
  const entries = await kvGetAll(key);
  const truncated = entries.length >= LIST_AGENTS_CEILING;

  const scored = entries.map((e) => ({
    accountId: e.predecessor_id,
    score:
      (e.value as Record<string, number>)?.score ??
      (e.value as Record<string, number>)?.ts ??
      0,
  }));
  scored.sort((a, b) => b.score - a.score);

  const { page, nextCursor, cursorReset } = cursorPaginate(
    scored,
    cursor,
    limit,
    (s) => s.accountId,
  );

  // Batch-fetch profiles for the page, excluding admin-deregistered agents.
  const profiles = await kvMultiAgent(
    page.map((s) => ({ accountId: s.accountId, key: 'profile' })),
  );
  const allAgents = profiles.filter((a): a is Agent => a !== null);
  const deregChecks = await Promise.all(
    allAgents.map((a) => isAdminDeregistered(a.handle)),
  );
  const agents = allAgents.filter((_, i) => !deregChecks[i]);

  return {
    data: {
      agents,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
      ...(truncated && { partial: true }),
    },
  };
}

async function handleGetFollowers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;

  // "Who follows handle?" = all predecessors who wrote graph/follow/{handle}
  const entries = await kvGetAll(`graph/follow/${handle}`);
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
      handle,
      followers: agents,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}

async function handleGetFollowing(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;

  const accountId = await resolveHandle(handle);
  if (!accountId) return { error: 'Agent not found', status: 404 };

  // "Who does handle follow?" = agent's graph/follow/* keys
  const entries = await kvListAgent(accountId, 'graph/follow/');
  const followedHandles = entries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );

  const { page, nextCursor, cursorReset } = cursorPaginate(
    followedHandles,
    cursor,
    limit,
    (h) => h,
  );

  // Resolve handles to accounts, then fetch profiles.
  const accounts = await Promise.all(page.map((h) => resolveHandle(h)));
  const validLookups: { accountId: string; key: string }[] = [];
  for (const a of accounts) {
    if (a) validLookups.push({ accountId: a, key: 'profile' });
  }
  const profiles =
    validLookups.length > 0 ? await kvMultiAgent(validLookups) : [];
  const agents = profiles.filter((a): a is Agent => a !== null);

  return {
    data: {
      handle,
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
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };
  const accountId = await resolveHandle(handle);
  if (!accountId) return { error: 'Agent not found', status: 404 };
  const agent = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  if (!agent) return { error: 'Agent not found', status: 404 };

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

async function handleGetSuggested(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };
  const limit = Math.min(Number(body.limit) || 10, 50);

  const accountId = await resolveHandle(handle);
  if (!accountId) return { error: 'Agent not found', status: 404 };

  // 1. Read caller's profile for tags.
  const callerAgent = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  const callerTags = new Set(callerAgent?.tags ?? []);

  // 2. Read caller's follow list to exclude.
  const followEntries = await kvListAgent(accountId, 'graph/follow/');
  const followSet = new Set(
    followEntries.map((e) => e.key.replace('graph/follow/', '')),
  );
  followSet.add(handle); // exclude self

  // 3. Read all agents by follower count.
  const allScored = await kvGetAll('sorted/followers');
  const candidates = allScored
    .filter(() => {
      // Filter happens after profile fetch (need handle to check followSet).
      return true;
    })
    .sort(
      (a, b) =>
        ((b.value as Record<string, number>)?.score ?? 0) -
        ((a.value as Record<string, number>)?.score ?? 0),
    )
    .slice(0, limit * 5); // fetch extra for filtering

  // 4. Batch-fetch profiles.
  const profiles = await kvMultiAgent(
    candidates.map((c) => ({ accountId: c.predecessor_id, key: 'profile' })),
  );

  // 5. Filter and score.
  const suggestions: Record<string, unknown>[] = [];
  for (let i = 0; i < profiles.length && suggestions.length < limit; i++) {
    const agent = profiles[i] as Agent | null;
    if (!agent) continue;
    if (followSet.has(agent.handle)) continue;

    const sharedTags = agent.tags?.filter((t) => callerTags.has(t)) ?? [];
    let reason: string;
    if (sharedTags.length > 0) {
      reason = `Shared tags: ${sharedTags.join(', ')}`;
    } else if (agent.follower_count > 0) {
      reason = 'Popular on the network';
    } else {
      reason = 'New on the network';
    }
    suggestions.push({
      ...agent,
      follow_url: `/api/v1/agents/${agent.handle}/follow`,
      reason,
    });
  }

  return {
    data: {
      agents: suggestions,
      vrf: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Edge & endorser handlers (partial — full edge sync not yet implemented)
// ---------------------------------------------------------------------------

async function handleGetEdges(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };
  const limit = Math.min(Number(body.limit) || 25, 100);
  const direction = (body.direction as string) || 'both';

  const accountId = await resolveHandle(handle);
  if (!accountId) return { error: 'Agent not found', status: 404 };

  const edges: Record<string, unknown>[] = [];
  // Map for O(1) mutual-upgrade lookup when direction='both'
  const incomingByHandle = new Map<string, Record<string, unknown>>();

  // Incoming: who follows this handle
  if (direction === 'incoming' || direction === 'both') {
    const entries = await kvGetAll(`graph/follow/${handle}`);
    if (entries.length > 0) {
      const profiles = await kvMultiAgent(
        entries.map((e) => ({ accountId: e.predecessor_id, key: 'profile' })),
      );
      for (const agent of profiles) {
        if (!agent) continue;
        const a = agent as Agent;
        const edge = { ...a, direction: 'incoming' };
        incomingByHandle.set(a.handle, edge);
        edges.push(edge);
      }
    }
  }

  // Outgoing: who this handle follows
  if (direction === 'outgoing' || direction === 'both') {
    const followEntries = await kvListAgent(accountId, 'graph/follow/');
    if (followEntries.length > 0) {
      const followedHandles = followEntries.map((e) =>
        e.key.replace('graph/follow/', ''),
      );
      const accounts = await Promise.all(
        followedHandles.map((h) => resolveHandle(h)),
      );
      const validLookups: { accountId: string; key: string }[] = [];
      for (const a of accounts) {
        if (a) validLookups.push({ accountId: a, key: 'profile' });
      }
      if (validLookups.length > 0) {
        const profiles = await kvMultiAgent(validLookups);
        for (const agent of profiles) {
          if (!agent) continue;
          const a = agent as Agent;
          const existing = incomingByHandle.get(a.handle);
          if (existing) {
            existing.direction = 'mutual';
          } else {
            edges.push({ ...a, direction: 'outgoing' });
          }
        }
      }
    }
  }

  return {
    data: {
      handle,
      edges: edges.slice(0, limit),
    },
  };
}

async function handleGetEndorsers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };

  const accountId = await resolveHandle(handle);
  if (!accountId) return { error: 'Agent not found', status: 404 };

  // All endorsement entries targeting this handle across all predecessors.
  const endorseEntries = await kvListAll(`endorsing/${handle}/`);

  // Deduplicate endorsers and batch-fetch profiles.
  const endorserAccountIds = [
    ...new Set(endorseEntries.map((e) => e.predecessor_id)),
  ];
  const profiles =
    endorserAccountIds.length > 0
      ? await kvMultiAgent(
          endorserAccountIds.map((a) => ({ accountId: a, key: 'profile' })),
        )
      : [];

  // Optional tag/capability filtering (for filter_endorsers action).
  const filterTags = body.tags as string[] | undefined;
  const filterCaps = body.capabilities as Record<string, unknown> | undefined;

  let endorsers = profiles.filter((a): a is Agent => a !== null);

  if (filterTags || filterCaps) {
    const endorserKeys = new Map<string, Set<string>>();
    for (const e of endorseEntries) {
      const key = e.key.replace(`endorsing/${handle}/`, '');
      if (!endorserKeys.has(e.predecessor_id))
        endorserKeys.set(e.predecessor_id, new Set());
      endorserKeys.get(e.predecessor_id)!.add(key);
    }

    endorsers = endorsers.filter((agent) => {
      const keys = endorserKeys.get(agent.near_account_id);
      if (!keys) return false;
      if (filterTags) {
        for (const tag of filterTags) {
          if (keys.has(`tags/${tag.toLowerCase()}`)) return true;
        }
      }
      if (filterCaps) {
        for (const [ns, val] of extractCapabilityPairs(filterCaps)) {
          if (keys.has(`${ns}/${val}`)) return true;
        }
      }
      return false;
    });
  }

  return {
    data: {
      handle,
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
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };

  const accountId = await resolveHandle(handle);
  if (!accountId) return { error: 'Agent not found', status: 404 };

  const now = Math.floor(Date.now() / 1000);
  const sinceRaw = body.cursor ?? body.since;
  const since =
    typeof sinceRaw === 'string' ? parseInt(sinceRaw, 10) : now - 86400;
  if (Number.isNaN(since)) {
    return { error: 'since must be a number', status: 400 };
  }

  // New followers: predecessors who wrote graph/follow/{handle} with at >= since
  const followerEntries = await kvGetAll(`graph/follow/${handle}`);
  const newFollowerAccounts: string[] = [];
  for (const e of followerEntries) {
    const at = (e.value as Record<string, number>)?.at ?? 0;
    if (at >= since) newFollowerAccounts.push(e.predecessor_id);
  }

  // New following: agent's graph/follow/* keys with at >= since
  const followingEntries = await kvListAgent(accountId, 'graph/follow/');
  const newFollowingHandles: string[] = [];
  for (const e of followingEntries) {
    const at = (e.value as Record<string, number>)?.at ?? 0;
    if (at >= since)
      newFollowingHandles.push(e.key.replace('graph/follow/', ''));
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
    .map((a) => ({
      handle: a.handle,
      description: a.description,
      avatar_url: a.avatar_url,
    }));

  const followingAccounts = await Promise.all(
    newFollowingHandles.map((h) => resolveHandle(h)),
  );
  const validFollowing: { accountId: string; key: string }[] = [];
  for (const a of followingAccounts) {
    if (a) validFollowing.push({ accountId: a, key: 'profile' });
  }
  const followingProfiles =
    validFollowing.length > 0 ? await kvMultiAgent(validFollowing) : [];
  const newFollowing = followingProfiles
    .filter((a): a is Agent => a !== null)
    .map((a) => ({
      handle: a.handle,
      description: a.description,
      avatar_url: a.avatar_url,
    }));

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
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };

  const accountId = await resolveHandle(handle);
  if (!accountId) return { error: 'Agent not found', status: 404 };

  const agent = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  if (!agent) return { error: 'Agent not found', status: 404 };

  // Live counts from graph data
  const followerEntries = await kvGetAll(`graph/follow/${handle}`);
  const followingEntries = await kvListAgent(accountId, 'graph/follow/');

  const followerAccounts = new Set(
    followerEntries.map((e) => e.predecessor_id),
  );
  const followingHandles = followingEntries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );

  // Resolve following handles to account IDs for mutual detection
  const followingAccounts = await Promise.all(
    followingHandles.map((h) => resolveHandle(h)),
  );
  const followingAccountSet = new Set(
    followingAccounts.filter((a): a is string => a !== null),
  );

  let mutualCount = 0;
  for (const a of followingAccountSet) {
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

// ---------------------------------------------------------------------------
// Admin: reconcile (read-only audit)
// ---------------------------------------------------------------------------

async function handleReconcileAll(): Promise<FastDataResult> {
  // Scan all agents via sorted/followers index
  const allScored = await kvGetAll('sorted/followers');
  const accountIds = allScored.map((e) => e.predecessor_id);

  // Batch-fetch all profiles
  const profiles = await kvMultiAgent(
    accountIds.map((a) => ({ accountId: a, key: 'profile' })),
  );

  let agentsChecked = 0;
  let countsMismatched = 0;

  for (let i = 0; i < profiles.length; i++) {
    const agent = profiles[i] as Agent | null;
    if (!agent) continue;
    agentsChecked++;

    // Verify follower count against actual graph edges
    const followerEntries = await kvGetAll(`graph/follow/${agent.handle}`);
    const followingEntries = await kvListAgent(accountIds[i], 'graph/follow/');

    if (
      agent.follower_count !== followerEntries.length ||
      agent.following_count !== followingEntries.length
    ) {
      countsMismatched++;
    }
  }

  return {
    data: {
      agents_checked: agentsChecked,
      counts_mismatched: countsMismatched,
      status: countsMismatched === 0 ? 'consistent' : 'discrepancies_found',
    },
  };
}
