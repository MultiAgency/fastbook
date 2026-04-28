import { kvGetAll } from '../client';
import { fetchProfiles } from '../utils';
import { cursorPaginate, type FastDataResult, requireAgent } from './_shared';

export async function handleGetFollowers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;

  // "Who follows accountId?" = all predecessors who wrote graph/follow/{accountId}
  const entries = await kvGetAll(`graph/follow/${accountId}`);
  const followerAccounts = entries.map((e) => e.predecessor_id);

  const { page, nextCursor, cursorReset } = cursorPaginate(
    followerAccounts,
    cursor,
    limit,
    (a) => a,
  );

  const agents = await fetchProfiles(page);

  return {
    data: {
      account_id: accountId,
      followers: agents,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}
