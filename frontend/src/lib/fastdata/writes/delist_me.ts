import { buildDelistMe } from '@nearly/sdk';
import { checkRateLimit, incrementRateLimit } from '../../rate-limit';
import { kvListAgent } from '../client';
import {
  ok,
  rateLimited,
  resolveCallerOrInit,
  type WriteResult,
  writeFailureToResult,
  writeToFastData,
} from './_shared';

export async function handleDelistMe(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const caller = await resolveCallerOrInit(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('social.delist_me', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);
  const rlWindow = rl.window;

  // Scan the caller's own outgoing edges so the delist envelope can
  // null-write every edge they authored. Follower edges written by
  // OTHER agents are intentionally NOT touched — retraction is the
  // writer's responsibility, not the subject's.
  const [followingEntries, endorsingEntries] = await Promise.all([
    kvListAgent(caller.accountId, 'graph/follow/'),
    kvListAgent(caller.accountId, 'endorsing/'),
  ]);

  const { entries } = buildDelistMe(
    caller.agent,
    followingEntries.map((e) => e.key),
    endorsingEntries.map((e) => e.key),
  );

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) return writeFailureToResult(wrote, caller.accountId);

  incrementRateLimit('social.delist_me', caller.accountId, rlWindow);

  return ok({
    action: 'delisted',
    account_id: caller.accountId,
  });
}
