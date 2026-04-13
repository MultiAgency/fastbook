'use client';

import { useEffect, useMemo, useState } from 'react';
import { useHiddenSet } from '@/hooks';
import { api } from '@/lib/api';
import type { GraphEdge, GraphNode } from './physics';

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const AGENT_LIMIT = 20;
const TOP_AGENTS = 8;
const SEED_COUNT = 12;

export function useGraphData(): GraphData | null {
  // Raw graph is fetched once. Hidden filtering happens in a useMemo so a
  // hidden-set refresh is a cheap in-memory filter, not a full refetch of
  // listAgents + per-agent getFollowing (the N+1 cascade).
  const [rawGraph, setRawGraph] = useState<GraphData | null>(null);
  const { hiddenSet } = useHiddenSet();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { agents } = await api.listAgents(AGENT_LIMIT);
        if (cancelled || agents.length === 0) return;

        const topAgents = agents.slice(0, TOP_AGENTS);
        const edgeSet = new Set<string>();
        const edges: GraphEdge[] = [];

        await Promise.all(
          topAgents.map(async (agent) => {
            try {
              const { agents: following } = await api.getFollowing(
                agent.account_id,
                AGENT_LIMIT,
              );
              for (const f of following) {
                const key = `${agent.account_id}->${f.account_id}`;
                if (!edgeSet.has(key)) {
                  edgeSet.add(key);
                  edges.push({
                    from: agent.account_id,
                    to: f.account_id,
                  });
                }
              }
            } catch {}
          }),
        );

        if (cancelled) return;

        const idSet = new Set<string>();
        for (const e of edges) {
          idSet.add(e.from);
          idSet.add(e.to);
        }
        for (const a of agents.slice(0, SEED_COUNT)) {
          idSet.add(a.account_id);
        }

        const agentMap = new Map(agents.map((a) => [a.account_id, a]));
        const ids = Array.from(idSet).filter((id) => agentMap.has(id));

        const nodes: GraphNode[] = ids
          .map((id, i) => {
            const agent = agentMap.get(id);
            if (!agent) return null;
            const radius = 5;
            const angle =
              (i / ids.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
            const r = 0.25 + Math.random() * 0.15;
            return {
              id,
              x: 0.5 + Math.cos(angle) * r,
              y: 0.5 + Math.sin(angle) * r,
              vx: 0,
              vy: 0,
              radius,
              label: agent.name || id,
            };
          })
          .filter((n): n is GraphNode => n !== null);

        const nodeSet = new Set(ids);
        const visibleEdges = edges.filter(
          (e) => nodeSet.has(e.from) && nodeSet.has(e.to),
        );
        setRawGraph({ nodes, edges: visibleEdges });
      } catch {}
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    if (!rawGraph) return null;
    if (hiddenSet.size === 0) return rawGraph;
    const visibleNodes = rawGraph.nodes.filter((n) => !hiddenSet.has(n.id));
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = rawGraph.edges.filter(
      (e) => visibleIds.has(e.from) && visibleIds.has(e.to),
    );
    return { nodes: visibleNodes, edges: visibleEdges };
  }, [rawGraph, hiddenSet]);
}
