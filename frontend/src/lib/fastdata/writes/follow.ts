import { buildFollow, validateReason } from '@nearly/sdk';
import { kvGetAgent } from '../client';
import { composeKey, fetchProfile, liveNetworkCounts } from '../utils';
import {
  resolveTargets,
  runBatch,
  validationFail,
  type WriteResult,
} from './_shared';

export async function handleFollow(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const reason = body.reason as string | undefined;
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }

  const targets = resolveTargets(body);
  if (!Array.isArray(targets)) return targets;

  return runBatch({
    action: 'social.follow',
    selfCode: 'SELF_FOLLOW',
    verb: 'follow',
    walletKey,
    targets,
    resolveAccountId,
    step: async (target, caller) => {
      const followKey = composeKey('graph/follow/', target);
      const existing = await kvGetAgent(caller.accountId, followKey);
      if (existing) {
        return {
          kind: 'skip',
          result: { account_id: target, action: 'already_following' },
        };
      }
      const targetAgent = await fetchProfile(target);
      if (!targetAgent) {
        return {
          kind: 'fail',
          result: {
            account_id: target,
            action: 'error',
            code: 'NOT_FOUND',
            error: 'agent not found',
          },
        };
      }
      const mutation = buildFollow(
        caller.accountId,
        target,
        reason != null ? { reason } : undefined,
      );
      return {
        kind: 'write',
        entries: mutation.entries,
        onWritten: () => ({ account_id: target, action: 'followed' }),
      };
    },
    finalize: async (results, caller, processed) => {
      const counts = await liveNetworkCounts(caller.accountId);
      return {
        results,
        your_network: {
          following_count: counts.following_count + processed,
          follower_count: counts.follower_count,
        },
      };
    },
  });
}
