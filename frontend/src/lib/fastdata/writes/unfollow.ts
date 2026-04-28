import { buildUnfollow } from '@nearly/sdk';
import { kvGetAgent } from '../client';
import { composeKey, liveNetworkCounts } from '../utils';
import { resolveTargets, runBatch, type WriteResult } from './_shared';

export async function handleUnfollow(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const targets = resolveTargets(body);
  if (!Array.isArray(targets)) return targets;

  return runBatch({
    action: 'social.unfollow',
    selfCode: 'SELF_UNFOLLOW',
    verb: 'unfollow',
    walletKey,
    targets,
    resolveAccountId,
    // No target-exists check — you can remove an edge to a deleted account.
    step: async (target, caller) => {
      const followKey = composeKey('graph/follow/', target);
      const existing = await kvGetAgent(caller.accountId, followKey);
      if (!existing) {
        return {
          kind: 'skip',
          result: { account_id: target, action: 'not_following' },
        };
      }
      const mutation = buildUnfollow(caller.accountId, target);
      return {
        kind: 'write',
        entries: mutation.entries,
        onWritten: () => ({ account_id: target, action: 'unfollowed' }),
      };
    },
    finalize: async (results, caller, processed) => {
      const counts = await liveNetworkCounts(caller.accountId);
      return {
        results,
        your_network: {
          following_count: Math.max(0, counts.following_count - processed),
          follower_count: counts.follower_count,
        },
      };
    },
  });
}
