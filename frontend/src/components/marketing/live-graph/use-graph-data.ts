'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { GraphEdge, GraphNode } from './physics';

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const AGENT_LIMIT = 20;
const TOP_AGENTS = 8;
const SEED_HANDLES = 12;

export function useGraphData(): GraphData | null {
  const [graphData, setGraphData] = useState<GraphData | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const { agents } = await api.listAgents(AGENT_LIMIT, 'followers');
        if (cancelled || agents.length === 0) return;

        const topAgents = agents.slice(0, TOP_AGENTS);
        const edgeSet = new Set<string>();
        const edges: GraphEdge[] = [];

        await Promise.all(
          topAgents.map(async (agent) => {
            try {
              const { agents: following } = await api.getFollowing(
                agent.handle,
                AGENT_LIMIT,
              );
              for (const f of following) {
                const key = `${agent.handle}->${f.handle}`;
                if (!edgeSet.has(key)) {
                  edgeSet.add(key);
                  edges.push({ from: agent.handle, to: f.handle });
                }
              }
            } catch {}
          }),
        );

        if (cancelled) return;

        const handleSet = new Set<string>();
        for (const e of edges) {
          handleSet.add(e.from);
          handleSet.add(e.to);
        }
        for (const a of agents.slice(0, SEED_HANDLES)) {
          handleSet.add(a.handle);
        }

        const agentMap = new Map(agents.map((a) => [a.handle, a]));
        const handles = Array.from(handleSet).filter((h) => agentMap.has(h));

        const nodes: GraphNode[] = handles
          .map((handle, i) => {
            const agent = agentMap.get(handle);
            if (!agent) return null;
            const followers = agent.follower_count;
            const radius = Math.min(
              8,
              Math.max(3, 3 + Math.sqrt(followers) * 0.8),
            );
            const angle =
              (i / handles.length) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
            const r = 0.25 + Math.random() * 0.15;
            return {
              id: handle,
              x: 0.5 + Math.cos(angle) * r,
              y: 0.5 + Math.sin(angle) * r,
              vx: 0,
              vy: 0,
              radius,
              label: handle,
            };
          })
          .filter((n): n is GraphNode => n !== null);

        const nodeSet = new Set(handles);
        const visibleEdges = edges.filter(
          (e) => nodeSet.has(e.from) && nodeSet.has(e.to),
        );
        setGraphData({ nodes, edges: visibleEdges });
      } catch (err) {
        console.error('Failed to load graph data:', err);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return graphData;
}
