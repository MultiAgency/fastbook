import { type KvEntry, kvGetAll, kvListAgent } from '../client';
import { entryBlockHeight, fetchProfiles, profileSummary } from '../utils';
import { type FastDataResult, requireAgent } from './_shared';

export async function handleGetActivity(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  // Opaque `block_height` cursor; absent cursor means "everything" — no
  // wall-clock default, so the feed can't depend on server time.
  const cursorRaw = body.cursor;
  let cursor: number | undefined;
  if (cursorRaw !== undefined) {
    const parsed =
      typeof cursorRaw === 'string'
        ? parseInt(cursorRaw, 10)
        : Number(cursorRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return {
        error: 'cursor must be a non-negative integer block_height',
        status: 400,
      };
    }
    cursor = parsed;
  }

  // Trust FastData-indexed `block_height` over caller-asserted value
  // fields — the activity feed can't be gamed by backdating edges.
  const [followerEntries, followingEntries] = await Promise.all([
    kvGetAll(`graph/follow/${accountId}`),
    kvListAgent(accountId, 'graph/follow/'),
  ]);

  const afterCursor = (e: KvEntry): boolean =>
    cursor === undefined || entryBlockHeight(e) > cursor;

  const newFollowerAccounts: string[] = [];
  let maxHeight = cursor ?? 0;
  for (const e of followerEntries) {
    if (afterCursor(e)) {
      newFollowerAccounts.push(e.predecessor_id);
      if (e.block_height > maxHeight) maxHeight = e.block_height;
    }
  }

  const newFollowingAccountIds: string[] = [];
  for (const e of followingEntries) {
    if (afterCursor(e)) {
      newFollowingAccountIds.push(e.key.replace('graph/follow/', ''));
      if (e.block_height > maxHeight) maxHeight = e.block_height;
    }
  }

  const [followerAgents, followingAgents] = await Promise.all([
    fetchProfiles(newFollowerAccounts),
    fetchProfiles(newFollowingAccountIds),
  ]);
  const newFollowers = followerAgents.map(profileSummary);
  const newFollowing = followingAgents.map(profileSummary);

  // Next cursor: max block_height observed across the cursor-filtered raw
  // entries (follower/following edges that passed `afterCursor`), NOT the
  // post-profile-filter summary arrays. A window full of new edges pointing
  // at agents with no `profile` blob would drop every summary to zero while
  // still advancing the high-water mark; echoing the input cursor there
  // strands callers in a re-read loop. Cursor stays on the input value only
  // when no raw entries advanced it at all.
  const nextCursor = maxHeight > (cursor ?? 0) ? maxHeight : cursor;

  return {
    data: {
      cursor: nextCursor,
      new_followers: newFollowers,
      new_following: newFollowing,
    },
  };
}
