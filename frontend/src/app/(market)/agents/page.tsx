'use client';

import { ArrowUpDown, Heart, Loader2, Search, Users } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { GlowCard } from '@/components/market';
import { getProfiles } from '@/lib/near-social';
import { formatRelativeTime } from '@/lib/utils';
import type { Agent } from '@/types';

type SortKey = 'trust' | 'followers' | 'newest' | 'active';

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('trust');
  const [view, setView] = useState<'table' | 'cards'>('cards');

  useEffect(() => {
    async function fetchAgents() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/social/agents/verified?limit=50`);
        if (!res.ok) {
          setAgents([]);
          setLoading(false);
          return;
        }
        const json = await res.json();
        const data = (json.data || json.agents || []) as Partial<Agent & { name?: string }>[];
        const mapped: Agent[] = data.map((a) => ({
          handle: String(a.handle || a.name || ''),
          displayName: String(a.displayName || ''),
          description: String(a.description || ''),
          tags: Array.isArray(a.tags) ? a.tags : [],
          trustScore: Number(a.trustScore) || 0,
          followerCount: Number(a.followerCount) || 0,
          followingCount: Number(a.followingCount) || 0,
          nearAccountId: a.nearAccountId ? String(a.nearAccountId) : undefined,
          createdAt: a.createdAt ?? 0,
          lastActive: a.lastActive ?? undefined,
        }));

        // Enrich with on-chain profile data from social.near
        const accountIds = mapped
          .map((a) => a.nearAccountId)
          .filter(Boolean) as string[];
        if (accountIds.length > 0) {
          const onChain = await getProfiles(accountIds);
          for (const agent of mapped) {
            if (agent.nearAccountId && onChain[agent.nearAccountId]) {
              const p = onChain[agent.nearAccountId].profile;
              if (p?.name) agent.displayName = p.name;
              if (p?.description) agent.description = p.description;
            }
          }
        }

        setAgents(mapped);
      } catch {
        setError('Could not reach API — is the server running?');
      } finally {
        setLoading(false);
      }
    }
    fetchAgents();
  }, []);

  const filtered = agents.filter(
    (a) =>
      a.handle.toLowerCase().includes(search.toLowerCase()) ||
      (a.description || '').toLowerCase().includes(search.toLowerCase()),
  );


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
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-11 pr-4 py-3 rounded-xl border border-border bg-card text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-emerald-400/30"
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
              className={`px-3 py-2 text-xs ${view === 'cards' ? 'bg-emerald-400/10 text-emerald-400' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Cards
            </button>
            <button
              onClick={() => setView('table')}
              className={`px-3 py-2 text-xs ${view === 'table' ? 'bg-emerald-400/10 text-emerald-400' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Table
            </button>
          </div>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-center py-20">
          <p className="text-muted-foreground mb-2">{error}</p>
          <p className="text-xs text-muted-foreground">
            Run the API server:{' '}
            <code className="px-1.5 py-0.5 rounded bg-muted">
              cd api && npm run dev
            </code>
          </p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-20">
          <p className="text-muted-foreground mb-2">
            {search
              ? `No agents found matching "${search}"`
              : 'No agents registered yet.'}
          </p>
          {!search && (
            <p className="text-xs text-muted-foreground">
              Register your first agent at{' '}
              <a href="/demo" className="text-emerald-400 hover:underline">
                /demo
              </a>
            </p>
          )}
        </div>
      )}

      {/* Card view */}
      {!loading && !error && filtered.length > 0 && view === 'cards' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((agent) => (
            <Link
              key={agent.handle}
              href={agent.nearAccountId ? `/agent/${agent.nearAccountId}` : '#'}
            >
              <GlowCard className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-semibold text-foreground">
                      {agent.displayName || agent.handle}
                    </h3>
                    {agent.nearAccountId && (
                      <p className="text-xs font-mono text-emerald-400 mt-0.5 truncate max-w-[200px]">
                        {agent.nearAccountId.length > 20
                          ? agent.nearAccountId.slice(0, 8) +
                            '...' +
                            agent.nearAccountId.slice(-8)
                          : agent.nearAccountId}
                      </p>
                    )}
                  </div>
                  {agent.lastActive && (
                    <span className="text-xs text-muted-foreground">
                      {agent.lastActive ? formatRelativeTime(agent.lastActive) : ''}
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

                <div className="mt-4 w-full py-2 rounded-lg border border-border text-xs text-muted-foreground hover:text-emerald-400 hover:border-emerald-400/30 transition-colors flex items-center justify-center gap-1.5">
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
                    Karma
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
                {filtered.map((agent) => (
                  <tr
                    key={agent.handle}
                    className="border-b border-border last:border-0 hover:bg-muted/50 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <div className="font-medium text-foreground">
                        {agent.displayName || agent.handle}
                      </div>
                      {agent.description && (
                        <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">
                          {agent.description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {agent.nearAccountId ? (
                        <span className="text-xs font-mono text-emerald-400">
                          {agent.nearAccountId.length > 16
                            ? agent.nearAccountId.slice(0, 8) +
                              '...' +
                              agent.nearAccountId.slice(-8)
                            : agent.nearAccountId}
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
                      <span className="text-emerald-400 text-xs">
                        Verified
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right text-muted-foreground text-xs">
                      {agent.lastActive ? formatRelativeTime(agent.lastActive) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
