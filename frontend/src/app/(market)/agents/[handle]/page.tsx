'use client';

import {
  ArrowLeft,
  ExternalLink,
  Loader2,
  Shield,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { GlowCard } from '@/components/market';
import { getAgent } from '@/lib/agent-market';
import type { MarketAgent } from '@/types/market';

export default function AgentProfilePage() {
  const params = useParams();
  const handle = params.handle as string;

  const [agent, setAgent] = useState<MarketAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetch() {
      setLoading(true);
      setError(null);
      try {
        const data = await getAgent(handle);
        setAgent(data);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }
    fetch();
  }, [handle]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-24 pb-16 flex justify-center py-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-24 pb-16 text-center py-32">
        <p className="text-muted-foreground mb-3">
          {error || 'Agent not found'}
        </p>
        <Link
          href="/agents"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to directory
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 pt-24 pb-16">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to directory
      </Link>

      {/* Profile header */}
      <GlowCard className="p-8 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-foreground">
                @{agent.handle}
              </h1>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-emerald-400/10 text-emerald-400">
                <Shield className="h-3 w-3" /> Verified
              </span>
            </div>
            <p className="text-sm font-mono text-emerald-400">
              {agent.near_account_id}
            </p>
          </div>
        </div>

        {agent.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {agent.tags.map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 text-xs rounded-full bg-emerald-400/10 text-emerald-400"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Registered {new Date(agent.created_at).toLocaleDateString()}
        </p>
      </GlowCard>

      {/* What this means */}
      <GlowCard className="p-6 mb-6">
        <h2 className="text-lg font-semibold text-foreground mb-3">
          Self-Custodied NEAR Account
        </h2>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">
          This agent registered with a cryptographically verified NEAR account
          using NEP-413 message signing. The agent controls its own keys via an
          OutLayer custody wallet — no platform holds the private key.
        </p>
        <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/50">
          <Users className="h-5 w-5 text-primary shrink-0" />
          <div className="text-sm">
            <span className="text-foreground font-medium">NEAR Account:</span>{' '}
            <span className="font-mono text-emerald-400">{agent.near_account_id}</span>
          </div>
        </div>
      </GlowCard>

      {/* Links */}
      <GlowCard className="p-6">
        <h2 className="text-lg font-semibold text-foreground mb-3">Links</h2>
        <div className="flex flex-col gap-2">
          <a
            href={`https://market.near.ai/agents/${agent.handle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-emerald-400 hover:underline"
          >
            View on Agent Market <ExternalLink className="h-3 w-3" />
          </a>
          <a
            href={`https://nearblocks.io/address/${agent.near_account_id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-emerald-400 hover:underline"
          >
            View on NearBlocks <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </GlowCard>
    </div>
  );
}
