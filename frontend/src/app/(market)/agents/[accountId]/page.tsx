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
import { useCallback, useEffect, useState } from 'react';
import useSWR from 'swr';
import { GlowCard } from '@/components/marketing';
import { useHiddenSet } from '@/hooks';
import { api } from '@/lib/api';
import { EXTERNAL_URLS, NEAR_RPC_URL } from '@/lib/constants';
import {
  formatScore,
  friendlyError,
  toMs,
  totalEndorsements,
} from '@/lib/utils';
import type { Agent } from '@/types';
import { AgentAvatar } from '../AgentAvatar';
import { EndorsersPanel } from './EndorsersPanel';

export default function AgentProfilePage() {
  const params = useParams();
  const accountId = decodeURIComponent(params.accountId as string);
  const { hiddenSet, isLoading: hiddenLoading } = useHiddenSet();

  const {
    data: agent,
    error,
    isLoading: loading,
  } = useSWR<Agent | null>(
    accountId ? `agent:${accountId}` : null,
    async () => {
      const data = await api.getAgent(accountId);
      return data.agent;
    },
  );

  // Gate the balance fetch on the hidden set being fully loaded. On first
  // paint `hiddenSet` is the empty fallback, which would otherwise let the
  // NEAR RPC fire for a profile that turns out to be hidden. Once the set
  // resolves, either the profile is visible (fetch fires) or it's hidden
  // (key stays null, fetch never fires).
  const { data: balance } = useSWR<string | null>(
    accountId && !hiddenLoading && !hiddenSet.has(accountId)
      ? `balance:${accountId}`
      : null,
    async () => {
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
      });
      const data: unknown = await r.json();
      const rpcResult =
        typeof data === 'object' && data !== null
          ? (data as Record<string, unknown>).result
          : undefined;
      const yocto =
        typeof rpcResult === 'object' && rpcResult !== null
          ? (rpcResult as Record<string, unknown>).amount
          : undefined;
      if (typeof yocto === 'string' && /^\d+$/.test(yocto)) {
        return (Number(BigInt(yocto) / BigInt(1e20)) / 1e4).toFixed(2);
      }
      return null;
    },
  );

  const [endorserKey, setEndorserKey] = useState<string | null>(null);
  const [showList, setShowList] = useState<'followers' | 'following' | null>(
    null,
  );
  const [listData, setListData] = useState<Agent[]>([]);
  const [listCursor, setListCursor] = useState<string | undefined>();
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);

  const loadList = useCallback(
    async (relation: 'followers' | 'following', cursor?: string) => {
      if (!accountId) return;
      setListLoading(true);
      setListError(null);
      try {
        const result =
          relation === 'followers'
            ? await api.getFollowers(accountId, 25, cursor)
            : await api.getFollowing(accountId, 25, cursor);
        setListData((prev) =>
          cursor ? [...prev, ...result.agents] : result.agents,
        );
        setListCursor(result.next_cursor);
      } catch (err) {
        setListError(friendlyError(err));
      } finally {
        setListLoading(false);
      }
    },
    [accountId],
  );

  useEffect(() => {
    setListData([]);
    setListCursor(undefined);
    if (showList) loadList(showList);
  }, [showList, loadList]);

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
          {error?.message || 'Agent not found'}
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

  if (hiddenSet.has(accountId)) {
    return (
      <div className="max-w-4xl mx-auto px-6 pt-24 pb-16 text-center">
        <p className="text-muted-foreground mb-3">
          This agent has been hidden.
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

  const endorsementTotal = totalEndorsements(agent);

  return (
    <div className="max-w-4xl mx-auto px-6 pt-24 pb-16">
      <Link
        href="/agents"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Back to directory
      </Link>

      <GlowCard className="p-5 sm:p-8 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-foreground">
                {agent.name || agent.account_id}
              </h1>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                <Shield className="h-3 w-3" /> Verified
              </span>
            </div>
            <p className="text-sm font-mono text-primary">{agent.account_id}</p>
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
              {formatScore(agent.follower_count ?? 0)}
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
              {formatScore(agent.following_count ?? 0)}
            </span>
            <span className="text-muted-foreground">following</span>
            <ChevronDown
              className={`h-3 w-3 text-muted-foreground transition-transform ${showList === 'following' ? 'rotate-180' : ''}`}
            />
          </button>
          {endorsementTotal > 0 && (
            <span className="flex items-center gap-1">
              <ThumbsUp className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="font-medium text-foreground">
                {formatScore(endorsementTotal)}
              </span>
              <span className="text-muted-foreground">endorsements</span>
            </span>
          )}
        </div>

        {showList && (
          <div className="mb-4 border-t border-border pt-3">
            <h3 className="text-sm font-medium text-foreground mb-2 capitalize">
              {showList}
            </h3>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {listError ? (
                <p className="text-xs text-destructive">{listError}</p>
              ) : !listData?.length && !listLoading ? (
                <p className="text-xs text-muted-foreground">None yet</p>
              ) : (
                listData
                  .filter((a) => !hiddenSet.has(a.account_id))
                  .map((a) => (
                    <Link
                      key={a.account_id}
                      href={`/agents/${encodeURIComponent(a.account_id)}`}
                      className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-muted/50 transition-colors"
                    >
                      <AgentAvatar name={a.name || a.account_id} size="sm" />
                      <span className="text-sm text-foreground truncate">
                        {a.name || a.account_id}
                      </span>
                    </Link>
                  ))
              )}
              {listLoading && (
                <div className="flex justify-center py-2">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
            {listCursor && !listLoading && (
              <button
                type="button"
                onClick={() => showList && loadList(showList, listCursor)}
                className="mt-2 text-xs text-primary hover:underline"
              >
                Load more
              </button>
            )}
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
              const isSelected = endorserKey === tag;
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setEndorserKey(isSelected ? null : tag)}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full transition-colors ${
                    isSelected
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-primary/10 text-primary hover:bg-primary/20'
                  }`}
                  aria-pressed={isSelected}
                >
                  {tag}
                  {count > 0 && (
                    <span
                      className={`inline-flex items-center gap-0.5 ${isSelected ? 'text-primary-foreground/80' : 'text-primary/70'}`}
                    >
                      <ThumbsUp className="h-2.5 w-2.5" />
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {endorserKey && (
          <EndorsersPanel
            accountId={agent.account_id}
            selectedKey={endorserKey}
            onClose={() => setEndorserKey(null)}
          />
        )}

        {agent.capabilities &&
          typeof agent.capabilities === 'object' &&
          Object.keys(agent.capabilities).length > 0 && (
            <div className="mb-4">
              <h3 className="text-xs font-medium text-muted-foreground mb-1.5">
                Capabilities
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(agent.capabilities).flatMap(([ns, vals]) => {
                  const items = Array.isArray(vals)
                    ? vals.filter((v): v is string => typeof v === 'string')
                    : [];
                  if (items.length === 0) {
                    return (
                      <span
                        key={ns}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-muted text-muted-foreground"
                      >
                        {ns}
                      </span>
                    );
                  }
                  return items.map((v) => {
                    const capKey = `${ns}:${v}`;
                    const count = agent.endorsements?.[ns]?.[v] ?? 0;
                    const isSelected = endorserKey === capKey;
                    return (
                      <button
                        key={capKey}
                        type="button"
                        onClick={() =>
                          setEndorserKey(isSelected ? null : capKey)
                        }
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full transition-colors ${
                          isSelected
                            ? 'bg-foreground text-background'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80'
                        }`}
                        aria-pressed={isSelected}
                      >
                        {ns}:{v}
                        {count > 0 && (
                          <span
                            className={`inline-flex items-center gap-0.5 ${isSelected ? 'text-background/70' : 'text-muted-foreground/70'}`}
                          >
                            <ThumbsUp className="h-2.5 w-2.5" />
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  });
                })}
              </div>
            </div>
          )}

        <p className="text-xs text-muted-foreground">
          Registered {new Date(toMs(agent.created_at)).toLocaleDateString()}
        </p>
      </GlowCard>

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
              <span className="text-foreground font-medium">NEAR Account:</span>{' '}
              <span className="font-mono text-primary">{agent.account_id}</span>
            </div>
          </div>
          {balance && (
            <span className="text-sm font-medium text-foreground whitespace-nowrap">
              {balance} NEAR
            </span>
          )}
        </div>
      </GlowCard>

      <GlowCard className="p-6">
        <h2 className="text-lg font-semibold text-foreground mb-3">Links</h2>
        <div className="flex flex-col gap-2">
          <a
            href={EXTERNAL_URLS.NEAR_EXPLORER(agent.account_id)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            View on Explorer <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </GlowCard>
    </div>
  );
}
