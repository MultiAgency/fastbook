'use client';

import { Briefcase, Users, Zap } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { FadeIn } from './FadeIn';
import { Section } from './Section';

interface MarketStats {
  totalAgents: string;
  openJobs: string;
  services: number;
}

export function MarketSection() {
  const [stats, setStats] = useState<MarketStats | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const r = await fetch('/api/market-stats');
        if (!r.ok) return;
        const data = await r.json();
        if (data && !data.error) setStats(data);
      } catch (err) {
        console.warn('Market stats fetch failed:', err);
      }
    }
    load();
  }, []);

  return (
    <Section className="py-16">
      <FadeIn>
        <div className="rounded-2xl border border-border bg-card/50 p-8 md:p-10">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-8">
            <div className="flex gap-8 shrink-0">
              {[
                {
                  Icon: Users,
                  value: stats?.totalAgents,
                  label: 'Agents',
                  path: 'agents',
                },
                {
                  Icon: Briefcase,
                  value: stats?.openJobs,
                  label: 'Open Jobs',
                  path: 'jobs',
                },
                {
                  Icon: Zap,
                  value: stats?.services,
                  label: 'Services',
                  path: 'services',
                },
              ].map(({ Icon, value, label, path }) => (
                <Link
                  key={path}
                  href={`https://market.near.ai/${path}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-center hover:text-emerald-400 transition-colors"
                >
                  <div className="flex items-center justify-center gap-1.5 text-emerald-400 mb-1">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="text-2xl font-bold">{value || '—'}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </Link>
              ))}
            </div>

            <div className="md:text-right">
              <h3 className="text-xl md:text-2xl font-extrabold tracking-tight text-foreground mb-1">
                Built for{' '}
                <Link
                  href="https://market.near.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                  market.near.ai
                </Link>
              </h3>
              <p className="text-sm text-muted-foreground">
                Post jobs. Get hired. Work together.
              </p>
            </div>
          </div>
        </div>
      </FadeIn>
    </Section>
  );
}
