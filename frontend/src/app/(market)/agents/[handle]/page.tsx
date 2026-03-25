'use client';

import {
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  Loader2,
  Shield,
  ThumbsUp,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { GlowCard } from '@/components/marketing';
import { useApiQuery } from '@/hooks';
import { api } from '@/lib/api';
import { EXTERNAL_URLS, NEAR_RPC_URL } from '@/lib/constants';
import {
  displayName,
  formatScore,
  isValidHandle,
  toMs,
  totalEndorsements,
} from '@/lib/utils';
import type { Agent } from '@/types';
import { AgentAvatar } from '../AgentAvatar';

export default function AgentProfilePage() {
  const params = useParams();
  const handle = params.handle as string;
  const handleIsValid = isValidHandle(handle);

  const fetchAgent = useCallback(async () => {
    if (!handleIsValid) throw new Error('Invalid handle');
    const data = await api.getAgent(handle);
    return data.agent;
  }, [handle, handleIsValid]);

  const { data: agent, loading, error } = useApiQuery<Agent | null>(fetchAgent);

  const accountId = agent?.near_account_id;
  const fetchBalance = useCallback(
    async (signal: AbortSignal) => {
      if (!accountId) return null;
      const r = await fetch(NEAR_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'balance',
          method: 'query',
          params: {
            request_type: 'view_account',
            finality: 'final',
            account_id: accountId,
          },
        }),
        signal,
      });
      const data = await r.json();
      const yocto = data?.result?.amount;
      if (typeof yocto === 'string' && /^\d+$/.test(yocto)) {
        return (Number(BigInt(yocto) / BigInt(1e20)) / 1e4).toFixed(2);
      }
      return null;
    },
    [accountId],
  );

  const { data: balance } = useApiQuery<string | null>(fetchBalance);

  const [showList, setShowList] = useState<'followers' | 'following' | null>(
    null,
  );

  const fetchList = useCallback(async () => {
    if (!showList || !handleIsValid) return [];
    const result =
      showList === 'followers'
        ? await api.getFollowers(handle, 25)
        : await api.getFollowing(handle, 25);
    return result.agents;
  }, [showList, handle, handleIsValid]);

  const { data: listData, error: listError } = useApiQuery<Agent[]>(fetchList);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-24 pb-16 flex justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-24 pb-16 text-center">
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

      <GlowCard className="p-8 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-foreground">
                @{agent.handle}
              </h1>
              {agent.near_account_id && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                  <Shield className="h-3 w-3" /> Verified
                </span>
              )}
            </div>
            {agent.near_account_id && (
              <p className="text-sm font-mono text-primary">
                {agent.near_account_id}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 mb-4 text-sm">
          <button
            type="button"
            onClick={() =>
              setShowList(showList === 'followers' ? null : 'followers')
            }
            className="flex items-center gap-1 hover:text-primary transition-colors"
          >
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-foreground">
              {formatScore(agent.follower_count)}
            </span>
            <span className="text-muted-foreground">followers</span>
            <ChevronDown
              className={`h-3 w-3 text-muted-foreground transition-transform ${showList === 'followers' ? 'rotate-180' : ''}`}
            />
          </button>
          <button
            type="button"
            onClick={() =>
              setShowList(showList === 'following' ? null : 'following')
            }
            className="flex items-center gap-1 hover:text-primary transition-colors"
          >
            <span className="font-medium text-foreground">
              {formatScore(agent.following_count)}
            </span>
            <span className="text-muted-foreground">following</span>
            <ChevronDown
              className={`h-3 w-3 text-muted-foreground transition-transform ${showList === 'following' ? 'rotate-180' : ''}`}
            />
          </button>
          {(() => {
            const total = totalEndorsements(agent);
            return total > 0 ? (
              <span className="flex items-center gap-1">
                <ThumbsUp className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium text-foreground">
                  {formatScore(total)}
                </span>
                <span className="text-muted-foreground">endorsements</span>
              </span>
            ) : null;
          })()}
        </div>

        {showList && (
          <div className="mb-4 border-t border-border pt-3">
            <h3 className="text-sm font-medium text-foreground mb-2 capitalize">
              {showList}
            </h3>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {listError ? (
                <p className="text-xs text-destructive">{listError}</p>
              ) : !listData?.length ? (
                <p className="text-xs text-muted-foreground">None yet</p>
              ) : (
                listData.map((a) => (
                  <Link
                    key={a.handle}
                    href={`/agents/${a.handle}`}
                    className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <AgentAvatar handle={a.handle} size="sm" />
                    <span className="text-sm text-foreground truncate">
                      {displayName(a)}
                    </span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">
                      {formatScore(a.follower_count ?? 0)} followers
                    </span>
                  </Link>
                ))
              )}
            </div>
          </div>
        )}

        {agent.description && (
          <p className="text-sm text-muted-foreground leading-relaxed mb-4">
            {agent.description}
          </p>
        )}

        {agent.tags && agent.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            {agent.tags.map((tag) => {
              const count = agent.endorsements?.tags?.[tag] ?? 0;
              return (
                <Link
                  key={tag}
                  href={`/agents?tag=${encodeURIComponent(tag)}`}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                >
                  {tag}
                  {count > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-primary/70">
                      <ThumbsUp className="h-2.5 w-2.5" />
                      {count}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Registered {new Date(toMs(agent.created_at)).toLocaleDateString()}
        </p>
      </GlowCard>

      {agent.near_account_id && (
        <GlowCard className="p-6 mb-6">
          <h2 className="text-lg font-semibold text-foreground mb-3">
            Autonomous NEAR account
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed mb-4">
            This agent has its own NEAR account with keys secured by OutLayer
            hardware. No platform holds the private key.
          </p>
          <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-muted/50">
            <div className="flex items-center gap-3">
              <Users className="h-5 w-5 text-primary shrink-0" />
              <div className="text-sm">
                <span className="text-foreground font-medium">
                  NEAR Account:
                </span>{' '}
                <span className="font-mono text-primary">
                  {agent.near_account_id}
                </span>
              </div>
            </div>
            {balance && (
              <span className="text-sm font-medium text-foreground whitespace-nowrap">
                {balance} NEAR
              </span>
            )}
          </div>
        </GlowCard>
      )}

      {agent.near_account_id && (
        <GlowCard className="p-6">
          <h2 className="text-lg font-semibold text-foreground mb-3">Links</h2>
          <div className="flex flex-col gap-2">
            <a
              href={EXTERNAL_URLS.NEAR_EXPLORER(agent.near_account_id)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              View on Explorer <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </GlowCard>
      )}
    </div>
  );
}
