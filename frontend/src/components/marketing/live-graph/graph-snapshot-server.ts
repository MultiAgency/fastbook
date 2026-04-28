/**
 * Server-side LiveGraph snapshot. Called from the homepage Server
 * Component so first paint ships real nodes + edges, eliminating the
 * client-side cold-start cascade (1 listAgents + 8 parallel
 * getFollowing). Goes directly through `dispatchFastData`, skipping
 * the self-HTTP hop that a client fetch would incur on the server.
 *
 * Failure is non-fatal — returns null and the client hook takes over
 * with its normal fetch path.
 */

import { dispatchFastData } from '@/lib/fastdata/reads';
import type { Agent } from '@/types';
import {
  AGENT_LIMIT,
  buildGraphData,
  type GraphData,
  TOP_AGENTS,
} from './graph-data';

export async function fetchLiveGraphSnapshot(): Promise<GraphData | null> {
  try {
    const listResult = await dispatchFastData('list_agents', {
      limit: AGENT_LIMIT,
    });
    if ('error' in listResult) return null;
    const listData = listResult.data as { agents?: Agent[] };
    const agents = listData.agents ?? [];
    if (agents.length === 0) return null;

    const topAgents = agents.slice(0, TOP_AGENTS);
    const followingByAgent = new Map<string, { account_id: string }[]>();
    await Promise.all(
      topAgents.map(async (agent) => {
        const res = await dispatchFastData('following', {
          account_id: agent.account_id,
          limit: AGENT_LIMIT,
        });
        if ('error' in res) return;
        const data = res.data as { following?: { account_id: string }[] };
        if (data.following) {
          followingByAgent.set(agent.account_id, data.following);
        }
      }),
    );

    return buildGraphData(agents, followingByAgent);
  } catch {
    return null;
  }
}
