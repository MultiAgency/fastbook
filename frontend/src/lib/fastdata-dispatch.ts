/**
 * Dispatch public read actions via FastData KV.
 *
 * Returns `{ data }` on success or `{ error }` on failure.
 * No fallback — if FastData KV is down, the error surfaces to the caller.
 */

import type { Agent } from '@/types';
import { FASTDATA_LIST_CEILING } from './constants';
import { kvGet, kvList, kvMulti } from './fastdata';

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

async function handleHealth(): Promise<unknown> {
  const count = await kvGet('meta/agent_count');
  return { agent_count: count ?? 0, status: 'ok' };
}

async function handleCheckHandle(
  body: Record<string, unknown>,
): Promise<unknown> {
  const handle = handleOf(body);
  if (!handle) return { available: false };
  const agent = await kvGet(`agent/${handle}`);
  return { handle, available: agent === null };
}

async function handleGetProfile(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };
  const agent = (await kvGet(`agent/${handle}`)) as Agent | null;
  if (!agent) return { error: 'Agent not found', status: 404 };
  return { data: { agent } };
}

async function handleListTags(): Promise<unknown> {
  const counts = (await kvGet('tag_counts')) as Record<string, number> | null;
  if (!counts) return { tags: [] };
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

  // When a tag filter is present, use the tag-indexed sorted list directly.
  // This avoids fetching all agents just to filter by tag.
  // Note: tag-indexed lists are only maintained for the "followers" sort.
  // Combining tag filtering with other sort orders (newest, active, endorsements)
  // will still sort by followers. Acceptable at current scale.
  const prefix = tag
    ? `sorted/followers/tag:${tag.toLowerCase()}/`
    : `sorted/${sort}/`;

  const entries = await kvList(prefix, LIST_AGENTS_CEILING);
  const truncated = entries.length >= LIST_AGENTS_CEILING;

  const scored = entries.map((e) => ({
    handle: e.key.split('/').pop()!,
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
    (s) => s.handle,
  );
  const pageHandles = page.map((s) => s.handle);

  const agentKeys = pageHandles.map((h) => `agent/${h}`);
  const agentRecords = await kvMulti(agentKeys);
  const agents = agentRecords.filter((a): a is Agent => a !== null);

  return {
    data: {
      agents,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
      ...(truncated && { partial: true }),
    },
  };
}

async function paginateEdgeList(
  prefix: string,
  field: string,
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;

  const entries = await kvList(`${prefix}/${handle}/`);
  const handles = entries.map((e) => e.key.split('/').pop()!);

  const {
    page: pageHandles,
    nextCursor,
    cursorReset,
  } = cursorPaginate(handles, cursor, limit, (h) => h);

  const agentKeys = pageHandles.map((h) => `agent/${h}`);
  const agentRecords = await kvMulti(agentKeys);
  const agents = agentRecords.filter((a): a is Agent => a !== null);

  return {
    data: {
      handle,
      [field]: agents,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}

async function handleGetFollowers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  return paginateEdgeList('follower', 'followers', body);
}

async function handleGetFollowing(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  return paginateEdgeList('following', 'following', body);
}

async function handleGetEdges(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };
  const direction = (body.direction as string) || 'both';
  const limit = Math.min(Number(body.limit) || 25, 100);

  const edges: { from: string; to: string; data: unknown }[] = [];

  if (direction === 'outgoing' || direction === 'both') {
    const entries = await kvList(`edge/${handle}/`);
    for (const e of entries) {
      const to = e.key.split('/').pop()!;
      edges.push({ from: handle, to, data: e.value });
    }
  }

  if (direction === 'incoming' || direction === 'both') {
    const followers = await kvList(`follower/${handle}/`);
    if (followers.length > 0) {
      const edgeKeys = followers.map((f) => {
        const from = f.key.split('/').pop()!;
        return `edge/${from}/${handle}`;
      });
      const edgeValues = await kvMulti(edgeKeys);
      for (let i = 0; i < followers.length; i++) {
        const from = followers[i].key.split('/').pop()!;
        if (edgeValues[i] !== null) {
          edges.push({ from, to: handle, data: edgeValues[i] });
        }
      }
    }
  }

  return { data: { handle, edges: edges.slice(0, limit) } };
}

async function handleGetEndorsers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const handle = handleOf(body);
  if (!handle) return { error: 'Handle is required', status: 400 };

  const agent = (await kvGet(`agent/${handle}`)) as Agent | null;
  if (!agent) return { error: 'Agent not found', status: 404 };

  const endorsers: Record<string, Record<string, unknown[]>> = {};

  // Collect endorsable (ns, value) pairs — filtered when tags/capabilities provided.
  const filterTags = body.tags as string[] | undefined;
  const filterCaps = body.capabilities as Record<string, unknown> | undefined;
  const hasFilter = !!(
    filterTags?.length ||
    (filterCaps && Object.keys(filterCaps).length)
  );

  const pairs: [string, string][] = [];

  if (hasFilter) {
    const agentTags = new Set(agent.tags ?? []);
    if (filterTags?.length) {
      for (const tag of filterTags) {
        if (agentTags.has(tag)) pairs.push(['tags', tag]);
      }
    }
    if (filterCaps && typeof filterCaps === 'object') {
      for (const [ns, vals] of Object.entries(filterCaps)) {
        if (Array.isArray(vals)) {
          for (const v of vals) {
            if (typeof v === 'string') pairs.push([ns, v]);
          }
        }
      }
    }
  } else {
    for (const tag of agent.tags ?? []) {
      pairs.push(['tags', tag]);
    }
    const caps = agent.capabilities as Record<string, unknown> | null;
    if (caps && typeof caps === 'object') {
      for (const [ns, vals] of Object.entries(caps)) {
        if (Array.isArray(vals)) {
          for (const v of vals) {
            if (typeof v === 'string') pairs.push([ns, v]);
          }
        }
      }
    }
  }

  // Phase 1: fetch all endorser lists in parallel.
  const endorserLists = await Promise.all(
    pairs.map(([ns, val]) =>
      kvGet(`endorsers/${handle}/${ns}/${val}`).then((r) => ({
        ns,
        val,
        list: (r as string[] | null) ?? [],
      })),
    ),
  );

  // Phase 2: batch-fetch all unique endorser agent records.
  const uniqueHandles = new Set<string>();
  for (const { list } of endorserLists) {
    for (const h of list) uniqueHandles.add(h);
  }
  const handleArr = Array.from(uniqueHandles);
  const agentMap = new Map<string, Agent>();
  if (handleArr.length > 0) {
    const records = await kvMulti(handleArr.map((h) => `agent/${h}`));
    for (let i = 0; i < handleArr.length; i++) {
      if (records[i]) agentMap.set(handleArr[i], records[i] as Agent);
    }
  }

  // Phase 3: assemble response.
  for (const { ns, val, list } of endorserLists) {
    if (list.length === 0) continue;
    if (!endorsers[ns]) endorsers[ns] = {};
    endorsers[ns][val] = list.map((h) => {
      const a = agentMap.get(h);
      return {
        handle: h,
        description: a?.description,
        avatar_url: a?.avatar_url,
      };
    });
  }

  return { data: { handle, endorsers } };
}
