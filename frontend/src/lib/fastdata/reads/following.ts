import { kvListAgent } from '../client';
import { fetchProfiles } from '../utils';
import { cursorPaginate, type FastDataResult, requireAgent } from './_shared';

export async function handleGetFollowing(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;

  // "Who does accountId follow?" = agent's graph/follow/* keys
  const entries = await kvListAgent(accountId, 'graph/follow/');
  const followedAccountIds = entries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );

  const { page, nextCursor, cursorReset } = cursorPaginate(
    followedAccountIds,
    cursor,
    limit,
    (a) => a,
  );

  const agents = await fetchProfiles(page);

  return {
    data: {
      account_id: accountId,
      following: agents,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}
