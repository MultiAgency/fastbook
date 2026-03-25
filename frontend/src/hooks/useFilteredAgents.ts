import { useMemo } from 'react';
import { totalEndorsements } from '@/lib/utils';
import type { Agent } from '@/types';

export type SortKey = 'followers' | 'endorsements' | 'newest' | 'active';

export function useFilteredAgents(
  agents: Agent[],
  search: string,
  tag: string,
  sortBy: SortKey,
): Agent[] {
  return useMemo(() => {
    const q = search.toLowerCase();
    let matched = q
      ? agents.filter(
          (a) =>
            a.handle.toLowerCase().includes(q) ||
            (a.description || '').toLowerCase().includes(q),
        )
      : [...agents];
    if (tag) {
      matched = matched.filter((a) => a.tags?.includes(tag));
    }
    switch (sortBy) {
      case 'followers':
        matched.sort(
          (a, b) => (b.follower_count ?? 0) - (a.follower_count ?? 0),
        );
        break;
      case 'endorsements':
        matched.sort((a, b) => totalEndorsements(b) - totalEndorsements(a));
        break;
      case 'newest':
        matched.sort((a, b) => b.created_at - a.created_at);
        break;
      case 'active':
        matched.sort((a, b) => (b.last_active ?? 0) - (a.last_active ?? 0));
        break;
    }
    return matched;
  }, [agents, search, sortBy, tag]);
}
