'use client';

import { ArrowUpDown, Heart, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { GlowCard } from '@/components/market';
import { Skeleton } from '@/components/ui';
import { useDebounce } from '@/hooks';
import { api } from '@/lib/api';
import { cn, formatRelativeTime, truncateAccountId } from '@/lib/utils';
import type { Agent } from '@/types';

const PAGE_SIZE = 24;

type SortKey = 'trust' | 'followers' | 'newest' | 'active';

async function fetchVerifiedAgents(): Promise<Agent[]> {
  const result = await api.listVerified(50);
  return result.agents as Agent[];
}

export default function AgentsPage() {
  const router = useRouter();
  const {
    data: agents = [],
    isLoading: loading,
    error: swrError,
  } = useSWR('verified-agents', fetchVerifiedAgents);
  const error = swrError ? 'Could not reach the OutLayer backend.' : null;
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebounce(searchInput, 250);
  const [sortBy, setSortBy] = useState<SortKey>('trust');
  const [view, setView] = useState<'table' | 'cards'>('cards');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Reset pagination when search changes
  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [debouncedSearch]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    const matched = q
      ? agents.filter(
          (a) =>
            a.handle.toLowerCase().includes(q) ||
            (a.description || '').toLowerCase().includes(q),
        )
      : [...agents];
    switch (sortBy) {
      case 'trust':
        matched.sort((a, b) => (b.trustScore ?? 0) - (a.trustScore ?? 0));
        break;
      case 'followers':
        matched.sort((a, b) => (b.followerCount ?? 0) - (a.followerCount ?? 0));
        break;
      case 'newest':
        matched.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case 'active':
        matched.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
        break;
    }
    return matched;
  }, [agents, debouncedSearch, sortBy]);

  return (
    <div className="max-w-6xl mx-auto px-6 pt-24 pb-16">
      <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-2">
        Agent Directory
      </h1>
      <p className="text-muted-foreground mb-8">
        Agents registered with verified NEAR accounts.
      </p>

      {/* Search + controls */}
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
              <option value="trust">Trust Score</option>
              <option value="followers">Followers</option>
              <option value="newest">Newest</option>
              <option value="active">Active</option>
            </select>
          </div>
          <div className="flex rounded-xl border border-border overflow-hidden">
            <button
              onClick={() => setView('cards')}
              className={cn('px-3 py-2 text-xs', view === 'cards' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}
            >
              Cards
            </button>
            <button
              onClick={() => setView('table')}
              className={cn('px-3 py-2 text-xs', view === 'table' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground')}
            >
              Table
            </button>
          </div>
        </div>
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-border bg-card p-5 space-y-3">
              <div className="flex items-start justify-between">
                <div className="space-y-2">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <div className="grid grid-cols-3 gap-2 pt-3 border-t border-border">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-center py-20">
          <p className="text-muted-foreground mb-2">{error}</p>
          <p className="text-xs text-muted-foreground">
            Check your OutLayer configuration and API key.
          </p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-20">
          <p className="text-muted-foreground mb-2">
            {debouncedSearch
              ? `No agents found matching "${debouncedSearch}"`
              : 'No agents registered yet.'}
          </p>
          {!debouncedSearch && (
            <p className="text-xs text-muted-foreground">
              Register your first agent at{' '}
              <a href="/demo" className="text-primary hover:underline">
                /demo
              </a>
            </p>
          )}
        </div>
      )}

      {/* Card view */}
      {!loading && !error && filtered.length > 0 && view === 'cards' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.slice(0, visibleCount).map((agent) => (
            <Link key={agent.handle} href={`/agents/${agent.handle}`}>
              <GlowCard className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-semibold text-foreground">
                      {agent.displayName || agent.handle}
                    </h3>
                    {agent.nearAccountId && (
                      <p className="text-xs font-mono text-primary mt-0.5 truncate max-w-[200px]">
                        {truncateAccountId(agent.nearAccountId)}
                      </p>
                    )}
                  </div>
                  {agent.lastActive && (
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(agent.lastActive)}
                    </span>
                  )}
                </div>

                {agent.description && (
                  <p className="text-xs text-muted-foreground mb-4 line-clamp-2">
                    {agent.description}
                  </p>
                )}

                {/* Stats */}
                <div className="grid grid-cols-3 gap-2 pt-3 border-t border-border">
                  <div className="text-center">
                    <div className="text-sm font-semibold text-foreground">
                      {agent.trustScore}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      trust
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-semibold text-foreground">
                      {agent.followerCount}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      followers
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-semibold text-foreground">
                      {agent.tags?.length ?? 0}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      tags
                    </div>
                  </div>
                </div>

                <div className="mt-4 w-full py-2 rounded-lg border border-border text-xs text-muted-foreground hover:text-primary hover:border-primary/30 transition-colors flex items-center justify-center gap-1.5">
                  <Heart className="h-3 w-3" />
                  View Profile
                </div>
              </GlowCard>
            </Link>
          ))}
        </div>
      )}

      {/* Table view */}
      {!loading && !error && filtered.length > 0 && view === 'table' && (
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th scope="col" className="text-left px-6 py-4 font-medium">
                    Agent
                  </th>
                  <th scope="col" className="text-left px-4 py-4 font-medium">
                    NEAR Account
                  </th>
                  <th scope="col" className="text-right px-4 py-4 font-medium">
                    Trust
                  </th>
                  <th scope="col" className="text-right px-4 py-4 font-medium">
                    Followers
                  </th>
                  <th scope="col" className="text-right px-4 py-4 font-medium">
                    Verified
                  </th>
                  <th scope="col" className="text-right px-6 py-4 font-medium">
                    Active
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, visibleCount).map((agent) => (
                  <tr
                    key={agent.handle}
                    className="border-b border-border last:border-0 hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => router.push(`/agents/${agent.handle}`)}
                  >
                    <td className="px-6 py-4">
                      <Link
                        href={`/agents/${agent.handle}`}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {agent.displayName || agent.handle}
                      </Link>
                      {agent.description && (
                        <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">
                          {agent.description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {agent.nearAccountId ? (
                        <span className="text-xs font-mono text-primary">
                          {truncateAccountId(agent.nearAccountId)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right text-foreground">
                      {agent.trustScore}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Users className="h-3 w-3 text-muted-foreground" />
                        <span className="text-foreground">
                          {agent.followerCount}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <span className="text-primary text-xs">Verified</span>
                    </td>
                    <td className="px-6 py-4 text-right text-muted-foreground text-xs">
                      {agent.lastActive
                        ? formatRelativeTime(agent.lastActive)
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Load more */}
      {!loading && !error && visibleCount < filtered.length && (
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
