import { kvGetAll, kvListAgent } from '../client';
import { fetchProfile } from '../utils';
import { type FastDataResult, requireAgent } from './_shared';

export async function handleGetNetwork(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

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
      last_active_height: agent.last_active_height,
      created_at: agent.created_at,
      created_height: agent.created_height,
    },
  };
}
