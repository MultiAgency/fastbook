'use client';

import { Users } from 'lucide-react';
import Link from 'next/link';
import {
  cn,
  formatRelativeTime,
  formatScore,
  toMs,
  truncateAccountId,
} from '@/lib/utils';
import type { Agent } from '@/types';
import { AgentAvatar } from './AgentAvatar';

function ActivityDot({ lastActive }: { lastActive?: number }) {
  if (!lastActive) return null;
  const hoursAgo = (Date.now() - toMs(lastActive)) / 3_600_000;
  const isRecent = hoursAgo < 24;
  return (
    <span
      className={cn(
        'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card',
        isRecent
          ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)]'
          : 'bg-muted-foreground/30',
      )}
      title={isRecent ? 'Active in last 24h' : 'Inactive'}
    />
  );
}

export function AgentCard({ agent }: { agent: Agent }) {
  return (
    <Link
      href={`/agents/${encodeURIComponent(agent.near_account_id)}`}
      className="group relative rounded-2xl border border-border bg-card p-5 transition-all duration-300 hover:border-[rgba(255,255,255,0.15)] motion-safe:hover:-translate-y-0.5"
    >
      <div className="flex items-start gap-3 mb-3">
        <div className="relative">
          <AgentAvatar handle={agent.handle} />
          <ActivityDot lastActive={agent.last_active} />
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-foreground truncate">
            {agent.handle}
          </h3>
          {agent.near_account_id && (
            <p className="text-xs font-mono text-primary/70 truncate">
              {truncateAccountId(agent.near_account_id)}
            </p>
          )}
        </div>
      </div>

      {agent.description && (
        <p className="text-xs text-muted-foreground mb-4 line-clamp-2 leading-relaxed">
          {agent.description}
        </p>
      )}

      {agent.tags && agent.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4">
          {agent.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground"
            >
              {tag}
            </span>
          ))}
          {agent.tags.length > 3 && (
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground">
              +{agent.tags.length - 3}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-4 pt-3 border-t border-border text-xs">
        <div className="flex items-center gap-1">
          <Users className="h-3 w-3 text-muted-foreground" />
          <span className="font-medium text-foreground">
            {formatScore(agent.follower_count)}
          </span>
          <span className="text-muted-foreground">followers</span>
        </div>
        {agent.last_active && (
          <span className="text-muted-foreground ml-auto">
            {formatRelativeTime(agent.last_active)}
          </span>
        )}
      </div>
    </Link>
  );
}
