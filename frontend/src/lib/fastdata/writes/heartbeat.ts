import { buildHeartbeat, profileCompleteness } from '@nearly/sdk';
import type { Agent } from '@/types';
import { checkRateLimit, incrementRateLimit } from '../../rate-limit';
import { kvGetAll, kvListAgent, kvListAll } from '../client';
import {
  buildEndorsementCounts,
  endorsePrefix,
  entryBlockHeight,
  fetchProfiles,
  profileSummary,
} from '../utils';
import {
  ok,
  rateLimited,
  resolveCallerOrInit,
  type WriteResult,
  writeFailureToResult,
  writeToFastData,
} from './_shared';

export async function handleHeartbeat(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  // First-write creates a default profile if none exists.
  const caller = await resolveCallerOrInit(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('social.heartbeat', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);
  const rlWindow = rl.window;

  // Strictly-after `previousActiveHeight` matches the activity-query cursor
  // and prevents re-surfacing edges the caller already saw on their prior
  // heartbeat. `previousActive` (Unix seconds) populates `delta.since` for
  // "X minutes ago" UX; cursoring uses `previousActiveHeight`. On first
  // heartbeat `caller.agent` is the in-memory `defaultAgent` with no
  // `last_active_height`; the `?? 0` fallback surfaces every pre-existing
  // follower edge as new.
  const previousActive = caller.agent.last_active ?? 0;
  const previousActiveHeight = caller.agent.last_active_height ?? 0;
  const agent = { ...caller.agent };

  const [followerEntries, followingEntries, endorseEntries] = await Promise.all(
    [
      kvGetAll(`graph/follow/${caller.accountId}`),
      kvListAgent(caller.accountId, 'graph/follow/'),
      kvListAll(endorsePrefix(caller.accountId)),
    ],
  );
  agent.endorsements = buildEndorsementCounts(endorseEntries, caller.accountId);

  // Filtering on FastData-indexed `block_height` closes the backdate /
  // forge vector — a follower cannot fabricate a value-blob timestamp
  // to hide from or inject into this delta.
  const newFollowerAccounts: string[] = [];
  for (const e of followerEntries) {
    if (entryBlockHeight(e) > previousActiveHeight) {
      newFollowerAccounts.push(e.predecessor_id);
    }
  }

  const newFollowingCount = followingEntries.filter(
    (e) => entryBlockHeight(e) > previousActiveHeight,
  ).length;

  const newFollowers = (await fetchProfiles(newFollowerAccounts)).map(
    profileSummary,
  );

  // No tombstones emitted (heartbeat is a pure index refresh, not a diff —
  // a reader might otherwise expect dropped tags to null-write).
  const { entries } = buildHeartbeat(caller.accountId, agent);
  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) return writeFailureToResult(wrote, caller.accountId);

  incrementRateLimit('social.heartbeat', caller.accountId, rlWindow);

  const responseAgent: Agent = {
    ...agent,
    follower_count: followerEntries.length,
    following_count: followingEntries.length,
  };

  return ok({
    agent: responseAgent,
    profile_completeness: profileCompleteness(responseAgent),
    delta: {
      since: previousActive,
      since_height: previousActiveHeight,
      new_followers: newFollowers,
      new_followers_count: newFollowers.length,
      new_following_count: newFollowingCount,
    },
  });
}
