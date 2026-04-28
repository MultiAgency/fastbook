/**
 * Read methods for NearlyClient — moved out of the class so the class
 * stays a thin facade. Each function accepts a `ClientContext` as first
 * arg; the class methods bind `this.ctx` and delegate.
 */

// Method-shape interfaces (`ListAgentsOpts`, etc.) live in `../client` so
// they stay re-exportable from `@nearly/sdk` via `index.ts` and so consumer
// import paths don't change. Imported below as types only — no runtime
// circular dependency.
import type {
  GetActivityOpts,
  GetEdgesOpts,
  GetSuggestedOpts,
  ListAgentsOpts,
  ListRelationOpts,
} from '../client';
import { NearlyError } from '../errors';
import { buildEndorsementCounts, foldProfile, foldProfileList } from '../graph';
import {
  kvGetAgentFirstWrite,
  kvGetAllKey,
  kvGetKey,
  kvHistoryFirstByPredecessor,
  kvListAgent,
  kvListAllPrefix,
} from '../read';
import {
  makeRng,
  scoreBySharedTags,
  shuffleWithinTiers,
  sortByScoreThenActive,
} from '../suggest';
import type {
  ActivityResponse,
  Agent,
  AgentSummary,
  CapabilityCount,
  Edge,
  EndorsementGraphSnapshot,
  EndorserEntry,
  EndorsingTargetGroup,
  GetSuggestedResponse,
  KvEntry,
  NetworkSummary,
  SuggestedAgent,
  TagCount,
} from '../types';
import { getVrfSeed } from '../vrf';
import type { ClientContext } from './_context';
import {
  aggregateBySuffix,
  drain,
  fetchProfilesByIds,
  followTarget,
} from './_shared';

// Private helper — used by getMe, getSuggested
export async function readProfile(ctx: ClientContext): Promise<Agent | null> {
  const entry = await kvGetKey(ctx.read, ctx.accountId, 'profile');
  if (!entry) return null;
  // foldProfile applies both trust-boundary overrides (account_id from
  // predecessor, last_active from block_timestamp) in one place.
  return foldProfile(entry);
}

export async function getMe(ctx: ClientContext): Promise<Agent | null> {
  return getAgent(ctx, ctx.accountId);
}

export async function getAgent(
  ctx: ClientContext,
  accountId: string,
): Promise<Agent | null> {
  const [
    latestEntry,
    firstEntry,
    followerEntries,
    followingEntries,
    endorseEntries,
  ] = await Promise.all([
    kvGetKey(ctx.read, accountId, 'profile'),
    kvGetAgentFirstWrite(ctx.read, accountId, 'profile'),
    drain(kvGetAllKey(ctx.read, `graph/follow/${accountId}`)),
    drain(kvListAgent(ctx.read, accountId, 'graph/follow/')),
    drain(kvListAllPrefix(ctx.read, `endorsing/${accountId}/`)),
  ]);
  if (!latestEntry) return null;
  const agent = foldProfile(latestEntry);
  if (!agent) return null;
  if (firstEntry) {
    agent.created_at = Math.floor(firstEntry.block_timestamp / 1e9);
    agent.created_height = firstEntry.block_height;
  }
  agent.follower_count = followerEntries.length;
  agent.following_count = followingEntries.length;
  agent.endorsement_count = endorseEntries.length;
  agent.endorsements = buildEndorsementCounts(
    endorseEntries,
    `endorsing/${accountId}/`,
  );
  return agent;
}

export async function getEndorsers(
  ctx: ClientContext,
  accountId: string,
): Promise<Record<string, EndorserEntry[]>> {
  const prefix = `endorsing/${accountId}/`;
  const endorseEntries = await drain(kvListAllPrefix(ctx.read, prefix));
  if (endorseEntries.length === 0) return {};

  // Fetch one profile per unique endorser for the summary fields.
  const endorserIds = [...new Set(endorseEntries.map((e) => e.predecessor_id))];
  const profileEntries = await fetchProfilesByIds(ctx.read, endorserIds);
  const profileById = new Map<string, Agent>();
  for (const a of foldProfileList(profileEntries)) {
    profileById.set(a.account_id, a);
  }

  const result: Record<string, EndorserEntry[]> = {};
  for (const e of endorseEntries) {
    if (!e.key.startsWith(prefix)) continue;
    const keySuffix = e.key.slice(prefix.length);
    if (!keySuffix) continue;
    const profile = profileById.get(e.predecessor_id);
    if (!profile) continue;
    const meta = (e.value ?? {}) as Record<string, unknown>;
    if (!result[keySuffix]) result[keySuffix] = [];
    result[keySuffix].push({
      account_id: profile.account_id,
      name: profile.name,
      description: profile.description,
      image: profile.image ?? null,
      reason: typeof meta.reason === 'string' ? meta.reason : undefined,
      content_hash:
        typeof meta.content_hash === 'string' ? meta.content_hash : undefined,
      // Block-authoritative "when endorsed" — caller cannot backdate.
      // `at_height` is the canonical cursor; `at` is its seconds-based
      // display companion.
      at: Math.floor(e.block_timestamp / 1e9),
      at_height: e.block_height,
    });
  }
  return result;
}

export async function getEndorsing(
  ctx: ClientContext,
  accountId: string,
): Promise<Record<string, EndorsingTargetGroup>> {
  const entries = await drain(kvListAgent(ctx.read, accountId, 'endorsing/'));
  if (entries.length === 0) return {};

  type ParsedEdge = {
    target: string;
    key_suffix: string;
    entry: KvEntry;
  };
  const parsed: ParsedEdge[] = [];
  const targets = new Set<string>();
  for (const e of entries) {
    if (!e.key.startsWith('endorsing/')) continue;
    const tail = e.key.slice('endorsing/'.length);
    const slash = tail.indexOf('/');
    if (slash <= 0) continue;
    const target = tail.slice(0, slash);
    const keySuffix = tail.slice(slash + 1);
    if (!keySuffix) continue;
    parsed.push({ target, key_suffix: keySuffix, entry: e });
    targets.add(target);
  }
  if (parsed.length === 0) return {};

  const profileEntries = await fetchProfilesByIds(ctx.read, [...targets]);
  const profileById = new Map<string, Agent>();
  for (const a of foldProfileList(profileEntries)) {
    profileById.set(a.account_id, a);
  }

  const result: Record<string, EndorsingTargetGroup> = {};
  for (const edge of parsed) {
    const profile = profileById.get(edge.target);
    const summary: AgentSummary = profile
      ? {
          account_id: profile.account_id,
          name: profile.name,
          description: profile.description,
          image: profile.image ?? null,
        }
      : {
          account_id: edge.target,
          name: null,
          description: '',
          image: null,
        };
    const meta = (edge.entry.value ?? {}) as Record<string, unknown>;
    if (!result[edge.target]) {
      result[edge.target] = { target: summary, entries: [] };
    }
    result[edge.target].entries.push({
      key_suffix: edge.key_suffix,
      reason: typeof meta.reason === 'string' ? meta.reason : undefined,
      content_hash:
        typeof meta.content_hash === 'string' ? meta.content_hash : undefined,
      at: Math.floor(edge.entry.block_timestamp / 1e9),
      at_height: edge.entry.block_height,
    });
  }
  return result;
}

export async function getEndorsementGraph(
  ctx: ClientContext,
  accountId: string,
): Promise<EndorsementGraphSnapshot> {
  const [incoming, outgoing] = await Promise.all([
    getEndorsers(ctx, accountId),
    getEndorsing(ctx, accountId),
  ]);

  const incomingIds = new Set<string>();
  for (const entries of Object.values(incoming)) {
    for (const entry of entries) incomingIds.add(entry.account_id);
  }

  return {
    account_id: accountId,
    incoming,
    outgoing,
    degree: {
      incoming: incomingIds.size,
      outgoing: Object.keys(outgoing).length,
    },
  };
}

export async function getActivity(
  ctx: ClientContext,
  opts: GetActivityOpts = {},
): Promise<ActivityResponse> {
  const accountId = opts.accountId ?? ctx.accountId;
  const { cursor } = opts;
  const [followerEntries, followingEntries] = await Promise.all([
    drain(kvGetAllKey(ctx.read, `graph/follow/${accountId}`)),
    drain(kvListAgent(ctx.read, accountId, 'graph/follow/')),
  ]);

  const afterCursor = (e: KvEntry): boolean =>
    cursor === undefined || e.block_height > cursor;

  let maxHeight = cursor ?? 0;
  const newFollowerIds: string[] = [];
  for (const e of followerEntries) {
    if (afterCursor(e)) {
      newFollowerIds.push(e.predecessor_id);
      if (e.block_height > maxHeight) maxHeight = e.block_height;
    }
  }

  const newFollowingIds: string[] = [];
  for (const e of followingEntries) {
    if (afterCursor(e)) {
      newFollowingIds.push(followTarget(e.key));
      if (e.block_height > maxHeight) maxHeight = e.block_height;
    }
  }

  const allIds = [...new Set([...newFollowerIds, ...newFollowingIds])];
  const profileEntries = await fetchProfilesByIds(ctx.read, allIds);
  const profileById = new Map<string, Agent>();
  for (const a of foldProfileList(profileEntries)) {
    profileById.set(a.account_id, a);
  }

  const toSummary = (id: string): AgentSummary | null => {
    const a = profileById.get(id);
    if (!a) return null;
    return {
      account_id: a.account_id,
      name: a.name,
      description: a.description,
      image: a.image,
    };
  };

  const new_followers = newFollowerIds
    .map(toSummary)
    .filter((s): s is AgentSummary => s !== null);
  const new_following = newFollowingIds
    .map(toSummary)
    .filter((s): s is AgentSummary => s !== null);

  // Advance cursor off the raw entry high-water mark, not the post-
  // profile-filter summary arrays. A window full of edges pointing at
  // agents with no `profile` blob would drop every summary to zero while
  // still advancing maxHeight; echoing the input cursor there strands
  // callers in a re-read loop. Cursor stays on the input only when no
  // raw entry advanced it at all. Mirrors handleGetActivity in the frontend.
  const nextCursor = maxHeight > (cursor ?? 0) ? maxHeight : cursor;

  return { cursor: nextCursor, new_followers, new_following };
}

export async function getNetwork(
  ctx: ClientContext,
  accountId?: string,
): Promise<NetworkSummary | null> {
  const target = accountId ?? ctx.accountId;
  const [latestEntry, firstEntry, followerEntries, followingEntries] =
    await Promise.all([
      kvGetKey(ctx.read, target, 'profile'),
      kvGetAgentFirstWrite(ctx.read, target, 'profile'),
      drain(kvGetAllKey(ctx.read, `graph/follow/${target}`)),
      drain(kvListAgent(ctx.read, target, 'graph/follow/')),
    ]);
  if (!latestEntry) return null;
  const agent = foldProfile(latestEntry);
  if (!agent) return null;

  const followerSet = new Set(followerEntries.map((e) => e.predecessor_id));
  const followingIds = followingEntries.map((e) => followTarget(e.key));
  let mutual_count = 0;
  for (const id of followingIds) {
    if (followerSet.has(id)) mutual_count++;
  }

  return {
    follower_count: followerSet.size,
    following_count: followingIds.length,
    mutual_count,
    last_active: agent.last_active,
    last_active_height: agent.last_active_height,
    created_at: firstEntry
      ? Math.floor(firstEntry.block_timestamp / 1e9)
      : undefined,
    created_height: firstEntry ? firstEntry.block_height : undefined,
  };
}

export async function getSuggested(
  ctx: ClientContext,
  opts: GetSuggestedOpts = {},
): Promise<GetSuggestedResponse> {
  const limit = Math.min(opts.limit ?? 10, 50);

  const [callerProfile, followEntries] = await Promise.all([
    readProfile(ctx),
    drain(kvListAgent(ctx.read, ctx.accountId, 'graph/follow/')),
  ]);

  const callerTags = callerProfile?.tags ?? [];
  const followSet = new Set(
    followEntries.map((e) => e.key.replace('graph/follow/', '')),
  );
  followSet.add(ctx.accountId);

  const profileEntries = await drain(kvGetAllKey(ctx.read, 'profile'));
  const candidates = foldProfileList(profileEntries).filter(
    (a) => !followSet.has(a.account_id),
  );

  const scored = sortByScoreThenActive(
    scoreBySharedTags(callerTags, candidates),
  );

  // VRF seed is best-effort. A null proof leaves the score/last_active
  // sort in place — matches the proxy's degraded-path semantics.
  let vrf: Awaited<ReturnType<typeof getVrfSeed>> = null;
  let vrfError: { code: string; message: string } | undefined;
  try {
    vrf = await getVrfSeed(ctx.wallet, ctx.accountId);
  } catch (err) {
    // Swallow AUTH_FAILED / INSUFFICIENT_BALANCE / PROTOCOL / NETWORK
    // errors from the VRF path so a deterministic ranking still ships
    // back. Capture the error shape so callers can diagnose why VRF
    // failed. Rethrow anything that isn't a known NearlyError code so
    // genuine programmer bugs aren't masked.
    if (!(err instanceof NearlyError)) throw err;
    vrfError = { code: err.shape.code, message: err.shape.message };
  }

  const rng = vrf ? makeRng(vrf.output_hex) : null;
  shuffleWithinTiers(scored, rng);

  const agents: SuggestedAgent[] = scored.slice(0, limit).map((s) => ({
    ...s.agent,
    reason:
      s.shared.length > 0
        ? `Shared tags: ${s.shared.join(', ')}`
        : 'New on the network',
  }));

  return { agents, vrf, vrfError };
}

export async function kvGet(
  ctx: ClientContext,
  accountId: string,
  key: string,
): Promise<KvEntry | null> {
  return kvGetKey(ctx.read, accountId, key);
}

export function listAgents(
  ctx: ClientContext,
  opts: ListAgentsOpts = {},
): AsyncIterable<Agent> {
  const { sort = 'active', tag, capability, limit } = opts;
  const read = ctx.read;

  async function* iterate(): AsyncIterable<Agent> {
    let profileEntries: KvEntry[];
    if (capability) {
      const capEntries = await drain(
        kvGetAllKey(read, `cap/${capability.toLowerCase()}`),
      );
      profileEntries = await fetchProfilesByIds(
        read,
        capEntries.map((e) => e.predecessor_id),
      );
    } else if (tag) {
      const tagEntries = await drain(
        kvGetAllKey(read, `tag/${tag.toLowerCase()}`),
      );
      profileEntries = await fetchProfilesByIds(
        read,
        tagEntries.map((e) => e.predecessor_id),
      );
    } else {
      profileEntries = await drain(kvGetAllKey(read, 'profile'));
    }

    const agents = foldProfileList(profileEntries);

    if (sort === 'newest') {
      // Join block-authoritative first-write timestamps for created_at
      // and the monotonic created_height cursor. Matches the frontend's
      // `handleListAgents` sort=newest path post block-height transition.
      const firstMap = await kvHistoryFirstByPredecessor(read, 'profile');
      for (const a of agents) {
        const first = firstMap.get(a.account_id);
        if (first) {
          a.created_at = Math.floor(first.block_timestamp / 1e9);
          a.created_height = first.block_height;
        }
      }
    }

    agents.sort(
      sort === 'newest'
        ? (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)
        : (a, b) => (b.last_active ?? 0) - (a.last_active ?? 0),
    );

    const cap = limit ?? agents.length;
    for (let i = 0; i < Math.min(cap, agents.length); i++) {
      yield agents[i];
    }
  }

  return iterate();
}

export function getFollowers(
  ctx: ClientContext,
  accountId: string,
  opts: ListRelationOpts = {},
): AsyncIterable<Agent> {
  const read = ctx.read;
  const { limit } = opts;

  async function* iterate(): AsyncIterable<Agent> {
    const followEntries = await drain(
      kvGetAllKey(read, `graph/follow/${accountId}`),
    );
    const followerIds = followEntries.map((e) => e.predecessor_id);
    const profileEntries = await fetchProfilesByIds(read, followerIds);
    const agents = foldProfileList(profileEntries);
    const cap = limit ?? agents.length;
    for (let i = 0; i < Math.min(cap, agents.length); i++) yield agents[i];
  }

  return iterate();
}

export function getFollowing(
  ctx: ClientContext,
  accountId: string,
  opts: ListRelationOpts = {},
): AsyncIterable<Agent> {
  const read = ctx.read;
  const { limit } = opts;

  async function* iterate(): AsyncIterable<Agent> {
    const edgeEntries = await drain(
      kvListAgent(read, accountId, 'graph/follow/'),
    );
    // The target account ID is the tail of the composed key; the
    // key_prefix is fixed convention so stripping it is unambiguous.
    const targetIds = edgeEntries.map((e) => followTarget(e.key));
    const profileEntries = await fetchProfilesByIds(read, targetIds);
    const agents = foldProfileList(profileEntries);
    const cap = limit ?? agents.length;
    for (let i = 0; i < Math.min(cap, agents.length); i++) yield agents[i];
  }

  return iterate();
}

export function getEdges(
  ctx: ClientContext,
  accountId: string,
  opts: GetEdgesOpts = {},
): AsyncIterable<Edge> {
  const read = ctx.read;
  const { direction = 'both', limit } = opts;
  const wantIncoming = direction === 'incoming' || direction === 'both';
  const wantOutgoing = direction === 'outgoing' || direction === 'both';

  async function* iterate(): AsyncIterable<Edge> {
    const [incomingEntries, outgoingEntries] = await Promise.all([
      wantIncoming
        ? drain(kvGetAllKey(read, `graph/follow/${accountId}`))
        : Promise.resolve([] as KvEntry[]),
      wantOutgoing
        ? drain(kvListAgent(read, accountId, 'graph/follow/'))
        : Promise.resolve([] as KvEntry[]),
    ]);

    const incomingIds = incomingEntries.map((e) => e.predecessor_id);
    const outgoingIds = outgoingEntries.map((e) => followTarget(e.key));
    const allIds = [...new Set([...incomingIds, ...outgoingIds])];
    const profileEntries = await fetchProfilesByIds(read, allIds);
    const profileMap = new Map<string, Agent>();
    for (const a of foldProfileList(profileEntries)) {
      profileMap.set(a.account_id, a);
    }

    const edges: Edge[] = [];
    const incomingByAccountId = new Map<string, Edge>();
    for (const id of incomingIds) {
      const a = profileMap.get(id);
      if (!a) continue;
      const edge: Edge = { ...a, direction: 'incoming' };
      incomingByAccountId.set(a.account_id, edge);
      edges.push(edge);
    }
    for (const id of outgoingIds) {
      const a = profileMap.get(id);
      if (!a) continue;
      const existing = incomingByAccountId.get(a.account_id);
      if (existing) {
        existing.direction = 'mutual';
      } else {
        edges.push({ ...a, direction: 'outgoing' });
      }
    }

    const cap = limit ?? edges.length;
    for (let i = 0; i < Math.min(cap, edges.length); i++) yield edges[i];
  }

  return iterate();
}

export function listTags(ctx: ClientContext): AsyncIterable<TagCount> {
  const read = ctx.read;
  async function* iterate(): AsyncIterable<TagCount> {
    const entries = await drain(kvListAllPrefix(read, 'tag/'));
    const counts = aggregateBySuffix(entries, 'tag/');
    for (const { key, count } of counts) {
      yield { tag: key, count };
    }
  }
  return iterate();
}

export function listCapabilities(
  ctx: ClientContext,
): AsyncIterable<CapabilityCount> {
  const read = ctx.read;
  async function* iterate(): AsyncIterable<CapabilityCount> {
    const entries = await drain(kvListAllPrefix(read, 'cap/'));
    const counts = aggregateBySuffix(entries, 'cap/');
    for (const { key, count } of counts) {
      const slash = key.indexOf('/');
      yield {
        namespace: slash >= 0 ? key.slice(0, slash) : key,
        value: slash >= 0 ? key.slice(slash + 1) : key,
        count,
      };
    }
  }
  return iterate();
}

export function kvList(
  ctx: ClientContext,
  accountId: string,
  prefix: string,
  limit?: number,
): AsyncIterable<KvEntry> {
  return kvListAgent(ctx.read, accountId, prefix, limit);
}
