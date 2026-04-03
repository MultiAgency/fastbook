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

export type FastDataError = { error: string; status?: number };
type FastDataResult = { data: unknown } | FastDataError;

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

/** Compute profile completeness from agent data (matches wasm/src/agent.rs). */
function profileCompleteness(agent: Agent): number {
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

  // Batch-fetch profiles for the page.
  const profiles = await kvMultiAgent(
    page.map((s) => ({ accountId: s.accountId, key: 'profile' })),
  );
  const agents = profiles.filter((a): a is Agent => a !== null);

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

  // Edges are not fully synced to FastData yet — return empty.
  // WASM fallback will handle this until edge sync is added.
  return { error: 'Edge data not available in FastData', status: 501 };
}

async function handleGetEndorsers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };

  // Endorser lists are not synced to FastData yet — return error for WASM fallback.
  return { error: 'Endorser data not available in FastData', status: 501 };
}
