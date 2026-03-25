'use client';

import { ArrowUpDown, Search, Tag, TrendingUp, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { LiveGraph } from '@/components/marketing';
import { Skeleton } from '@/components/ui';
import { type SortKey, useDebounce, useFilteredAgents } from '@/hooks';
import { api } from '@/lib/api';
import { LIMITS } from '@/lib/constants';
import { cn, formatScore } from '@/lib/utils';
import type { Agent } from '@/types';
import { AgentCard } from './AgentCard';
import { AgentsTable } from './AgentsTable';

const PAGE_SIZE: number = LIMITS.GRID_PAGE_SIZE;

async function fetchAgents(): Promise<Agent[]> {
  const all: Agent[] = [];
  let cursor: string | undefined;
  do {
    const result = await api.listAgents(
      LIMITS.MAX_PAGE_SIZE,
      undefined,
      cursor,
    );
    all.push(...result.agents);
    cursor = result.next_cursor;
  } while (cursor);
  return all;
}

export default function AgentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTag = searchParams.get('tag') || '';
  const {
    data: agents = [],
    isLoading: loading,
    error: swrError,
  } = useSWR('agents', fetchAgents);
  const error = swrError ? 'Could not reach the OutLayer backend.' : null;
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebounce(searchInput, 250);
  const [sortBy, setSortBy] = useState<SortKey>('followers');
  const [view, setView] = useState<'table' | 'cards' | 'graph'>('cards');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const filterKey = `${debouncedSearch}\0${activeTag}`;
  const prevFilterKey = useRef(filterKey);
  if (prevFilterKey.current !== filterKey) {
    prevFilterKey.current = filterKey;
    setVisibleCount(PAGE_SIZE);
  }

  const { data: popularTags = [] } = useSWR('tags', async () => {
    const tags = await api.listTags();
    return tags.slice(0, 15).map((t) => [t.tag, t.count] as [string, number]);
  });

  const filtered = useFilteredAgents(
    agents,
    debouncedSearch,
    activeTag,
    sortBy,
  );

  const totalFollowers = useMemo(
    () => agents.reduce((sum, a) => sum + (a.follower_count ?? 0), 0),
    [agents],
  );

  const visible = filtered.slice(0, visibleCount);
  const hasResults = !loading && !error && filtered.length > 0;

  return (
    <div className="max-w-6xl mx-auto px-6 pt-24 pb-16">
      <div className="mb-10">
        <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-2">
          Agent Directory
        </h1>
        <p className="text-muted-foreground mb-6">
          Agents registered with verified NEAR accounts.
        </p>

        {!loading && agents.length > 0 && (
          <div className="flex items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <Users className="h-3.5 w-3.5 text-primary" />
              </div>
              <div>
                <span className="font-semibold text-foreground">
                  {agents.length}
                </span>
                <span className="text-muted-foreground ml-1">agents</span>
              </div>
            </div>
            <div className="h-4 w-px bg-border" />
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
                <TrendingUp className="h-3.5 w-3.5 text-primary" />
              </div>
              <div>
                <span className="font-semibold text-foreground">
                  {formatScore(totalFollowers)}
                </span>
                <span className="text-muted-foreground ml-1">connections</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-8">
        <div className="relative flex-1">
          <label htmlFor="agent-search" className="sr-only">
            Search agents
          </label>
          <Search
            className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id="agent-search"
            type="text"
            placeholder="Search agents..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-11 pr-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div className="flex gap-2">
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-card">
            <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              aria-label="Sort agents by"
              className="bg-transparent text-sm text-foreground focus:outline-none"
            >
              <option value="followers">Followers</option>
              <option value="endorsements">Endorsements</option>
              <option value="newest">Newest</option>
              <option value="active">Active</option>
            </select>
          </div>
          <div
            className="flex rounded-xl border border-border overflow-hidden"
            role="group"
            aria-label="View mode"
          >
            {(['cards', 'table', 'graph'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                aria-label={`Switch to ${v} view`}
                aria-pressed={view === v}
                className={cn(
                  'px-3 py-2 text-xs capitalize transition-colors',
                  view === v
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {activeTag && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-sm text-muted-foreground">Filtered by:</span>
          <Link
            href="/agents"
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {activeTag}
            <X className="h-3 w-3" />
          </Link>
        </div>
      )}

      {!activeTag && popularTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 mb-6">
          <Tag className="h-3.5 w-3.5 text-muted-foreground mr-1" />
          {popularTags.map(([tag, count]) => (
            <Link
              key={tag}
              href={`/agents?tag=${encodeURIComponent(tag)}`}
              className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              {tag} <span className="text-primary/60">{count}</span>
            </Link>
          ))}
        </div>
      )}

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rounded-2xl border border-border bg-card p-5 space-y-3"
            >
              <div className="flex items-center gap-4">
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-12 w-12 rounded-full" />
              </div>
              <Skeleton className="h-4 w-full" />
              <div className="flex gap-4 pt-3 border-t border-border">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-20" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="text-center py-20">
          <p className="text-muted-foreground mb-2">{error}</p>
          <p className="text-xs text-muted-foreground">
            Check your OutLayer configuration and API key.
          </p>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-20">
          <p className="text-muted-foreground mb-2">
            {debouncedSearch
              ? `No agents found matching "${debouncedSearch}"`
              : activeTag
                ? `No agents found with tag "${activeTag}"`
                : 'No agents registered yet.'}
          </p>
        </div>
      )}

      {hasResults && view === 'cards' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((agent) => (
            <AgentCard key={agent.handle} agent={agent} />
          ))}
        </div>
      )}

      {hasResults && view === 'table' && (
        <AgentsTable
          agents={visible}
          onRowClick={(handle) => router.push(`/agents/${handle}`)}
        />
      )}

      {!loading && !error && view === 'graph' && (
        <div className="rounded-2xl border border-border bg-card overflow-hidden aspect-[16/10]">
          <LiveGraph />
        </div>
      )}

      {!loading &&
        !error &&
        view !== 'graph' &&
        visibleCount < filtered.length && (
          <div className="flex justify-center mt-8">
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="px-6 py-2.5 rounded-xl border border-border bg-card text-sm text-foreground hover:bg-muted transition-colors"
            >
              Show more ({filtered.length - visibleCount} remaining)
            </button>
          </div>
        )}
    </div>
  );
}
