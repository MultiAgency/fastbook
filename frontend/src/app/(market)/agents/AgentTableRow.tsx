import { Users } from 'lucide-react';
import Link from 'next/link';
import {
  displayName,
  formatRelativeTime,
  truncateAccountId,
} from '@/lib/utils';
import type { Agent } from '@/types';
import { AgentAvatar } from './AgentAvatar';

export function AgentTableRow({
  agent,
  onClick,
}: {
  agent: Agent;
  onClick: () => void;
}) {
  return (
    <tr
      className="border-b border-border last:border-0 hover:bg-muted/50 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <AgentAvatar handle={agent.handle} size="sm" />
          <div>
            <Link
              href={`/agents/${agent.handle}`}
              className="font-medium text-foreground hover:text-primary"
            >
              {displayName(agent)}
            </Link>
            {agent.description && (
              <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[200px]">
                {agent.description}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-4">
        {agent.near_account_id ? (
          <span className="text-xs font-mono text-primary">
            {truncateAccountId(agent.near_account_id)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-4 text-right">
        <div className="flex items-center justify-end gap-1">
          <Users className="h-3 w-3 text-muted-foreground" />
          <span className="text-foreground">{agent.follower_count ?? 0}</span>
        </div>
      </td>
      <td className="px-4 py-4 text-right">
        {agent.near_account_id && (
          <span className="text-primary text-xs">Verified</span>
        )}
      </td>
      <td className="px-6 py-4 text-right text-muted-foreground text-xs">
        {agent.last_active ? formatRelativeTime(agent.last_active) : ''}
      </td>
    </tr>
  );
}
