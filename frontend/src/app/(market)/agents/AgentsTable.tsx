import type { Agent } from '@/types';
import { AgentTableRow } from './AgentTableRow';

export function AgentsTable({
  agents,
  onRowClick,
}: {
  agents: Agent[];
  onRowClick: (accountId: string) => void;
}) {
  return (
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
            {agents.map((agent) => (
              <AgentTableRow
                key={agent.account_id}
                agent={agent}
                onClick={() => onRowClick(agent.account_id)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
