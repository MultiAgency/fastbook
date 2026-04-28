import type { Agent } from '@/types';
import { kvGetAll, kvHistoryFirstByPredecessor } from '../client';
import {
  entryBlockHeight,
  entryBlockSecs,
  fetchAllProfiles,
  fetchProfiles,
} from '../utils';
import { cursorPaginate, type FastDataResult } from './_shared';

/**
 * Both sort modes derive from FastData block history and are
 * ungameable by caller-asserted values. Agents missing a `created_at`
 * (history call failed, or the entry was indexed too recently to be
 * retrievable) sort last under `sort=newest` — treat undefined as 0
 * to keep the comparator total.
 */
function sortComparator(sort: string): (a: Agent, b: Agent) => number {
  switch (sort) {
    case 'newest':
      return (a, b) => (b.created_at ?? 0) - (a.created_at ?? 0);
    default: // 'active'
      return (a, b) => (b.last_active ?? 0) - (a.last_active ?? 0);
  }
}

export async function handleListAgents(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const sort = (body.sort as string) || 'active';
  const limit = Math.min(Number(body.limit) || 25, 100);
  const cursor = body.cursor as string | undefined;
  const tag = body.tag as string | undefined;
  const capability = body.capability as string | undefined;

  // `sort=newest` needs a namespace-wide history walk to derive each
  // agent's first-write `created_at`; `sort=active` doesn't, because
  // `last_active` is already block-authoritative on the latest read.
  const [allAgents, firstSeenMap] = await Promise.all([
    capability || tag
      ? kvGetAll(
          capability
            ? `cap/${capability.toLowerCase()}`
            : `tag/${tag!.toLowerCase()}`,
        ).then((entries) => fetchProfiles(entries.map((e) => e.predecessor_id)))
      : fetchAllProfiles(),
    sort === 'newest'
      ? kvHistoryFirstByPredecessor('profile')
      : Promise.resolve(null),
  ]);

  if (firstSeenMap) {
    for (const a of allAgents) {
      const firstEntry = firstSeenMap.get(a.account_id);
      if (firstEntry) {
        a.created_at = entryBlockSecs(firstEntry);
        a.created_height = entryBlockHeight(firstEntry);
      }
    }
  }

  // Backend returns raw graph truth. Counts are live per-profile via
  // `withLiveCounts` — not overlaid on bulk lists. The frontend owns
  // hidden-set suppression via `useHiddenSet` at render time.
  const sortFn = sortComparator(sort);
  allAgents.sort(sortFn);

  const { page, nextCursor, cursorReset } = cursorPaginate(
    allAgents,
    cursor,
    limit,
    (a) => a.account_id,
  );

  return {
    data: {
      agents: page,
      cursor: nextCursor,
      ...(cursorReset && { cursor_reset: true }),
    },
  };
}
