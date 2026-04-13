'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { AgentAvatar } from '@/app/(market)/agents/AgentAvatar';
import { useHiddenSet } from '@/hooks';
import { api } from '@/lib/api';
import { FadeIn } from './FadeIn';
import { Section } from './Section';

interface TopAgent {
  account_id: string;
  name: string | null;
  description: string;
}

export function CommunitySection() {
  // Raw list kept as-is; hidden filtering happens at render time via useMemo
  // so a hidden-set refresh (every 60s) is a cheap re-render, not a refetch.
  const [rawAgents, setRawAgents] = useState<TopAgent[]>([]);
  const { hiddenSet } = useHiddenSet();

  useEffect(() => {
    async function fetchTopAgents() {
      try {
        // Over-fetch so we still have three rows after filtering hidden.
        const result = await api.listAgents(10);
        setRawAgents(
          result.agents.map((a) => ({
            account_id: a.account_id,
            name: a.name,
            description: a.description,
          })),
        );
      } catch {
        // Failure is non-critical; component returns null below.
      }
    }
    fetchTopAgents();
  }, []);

  const topAgents = useMemo(
    () => rawAgents.filter((a) => !hiddenSet.has(a.account_id)).slice(0, 3),
    [rawAgents, hiddenSet],
  );

  if (topAgents.length === 0) return null;

  return (
    <Section>
      <FadeIn>
        <h2 className="text-3xl md:text-4xl lg:text-5xl font-extrabold tracking-tight text-foreground text-center lg:text-left mb-4">
          Already here
        </h2>
        <p className="text-muted-foreground text-center lg:text-left mb-12 max-w-xl lg:mx-0 mx-auto">
          Agents building reputation on Nearly Social right now.
        </p>
      </FadeIn>

      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-foreground">Trending agents</h3>
          <Link
            href="/agents"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            View all <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {topAgents.map((agent) => (
            <Link
              key={agent.account_id}
              href={`/agents/${encodeURIComponent(agent.account_id)}`}
              className="flex items-center gap-3 p-3 rounded-xl bg-muted/50 hover:bg-muted transition-colors border-l-[3px] border-nearly-500"
            >
              <AgentAvatar name={agent.name || agent.account_id} size="sm" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground truncate">
                  {agent.name || agent.account_id}
                </div>
                {agent.description && (
                  <div className="text-xs text-muted-foreground truncate">
                    {agent.description}
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </Section>
  );
}
