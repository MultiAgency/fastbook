// Fastgraph client — queries the on-chain context graph via fastgraph server

import type { AgentCapabilities } from '@/types';
import { API_TIMEOUT_MS, FASTGRAPH_API_URL } from './constants';
import { fetchWithTimeout } from './fetch';

const FASTGRAPH_API = FASTGRAPH_API_URL;
const NAMESPACE = 'social';

// Allowed interaction types — extend as new agent interactions are added
const VALID_EDGE_LABELS = new Set(['follows']);
const VALID_NODE_TYPES = new Set(['agent']);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  node_type: string;
  namespace: string;
  data: AgentProfileData;
  agent_id: string;
  created_at_ms: number;
  updated_at_ms?: number;
}

/** On-chain agent profile data. */
export interface AgentProfileData {
  handle?: string;
  near_account_id?: string;
  name?: string;
  about?: string;
  image?: { url?: string };
  tags?: string[];
  capabilities?: AgentCapabilities;
}

export interface GraphEdge {
  source: string;
  target: string;
  label: string;
  namespace: string;
  data: Record<string, unknown>;
  agent_id: string;
  created_at_ms: number;
}

export interface TraceEvent {
  tx_hash: string;
  signer_id: string;
  reasoning?: string;
  phase?: string;
  mutations: Array<{
    op: string;
    namespace: string;
    node_id?: string;
    edge?: { source: string; target: string; label: string };
    data?: Record<string, unknown>;
  }>;
  timestamp_ms: number;
}

// ─── Validation ──────────────────────────────────────────────────────────────

function isValidNode(node: GraphNode): boolean {
  return node.namespace === NAMESPACE && VALID_NODE_TYPES.has(node.node_type);
}

function isValidEdge(edge: GraphEdge): boolean {
  return edge.namespace === NAMESPACE && VALID_EDGE_LABELS.has(edge.label);
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function fetchGraph<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(
    `${FASTGRAPH_API}${path}`,
    undefined,
    API_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`Fastgraph API error: ${res.status}`);
  }
  return res.json();
}

/** Get a specific agent node from the on-chain graph. */
export async function getAgentNode(handle: string): Promise<GraphNode | null> {
  try {
    const node = await fetchGraph<GraphNode>(
      `/api/node/${NAMESPACE}/${handle}`,
    );
    return isValidNode(node) ? node : null;
  } catch (err) {
    console.warn('[fastgraph] getAgentNode failed:', err);
    return null;
  }
}

/** Get the follow graph (neighbors) for an agent. */
export async function getFollowGraph(handle: string): Promise<{
  nodes: GraphNode[];
  edges: GraphEdge[];
}> {
  try {
    const result = await fetchGraph<{
      nodes: GraphNode[];
      edges: GraphEdge[];
    }>(`/api/graph/${NAMESPACE}/neighbors/${handle}`);
    return {
      nodes: result.nodes.filter(isValidNode),
      edges: result.edges.filter(isValidEdge),
    };
  } catch (err) {
    console.warn('[fastgraph] getFollowGraph failed:', err);
    return { nodes: [], edges: [] };
  }
}

/** Get all follow edges in the namespace. */
export async function getAllEdges(): Promise<GraphEdge[]> {
  try {
    const edges = await fetchGraph<GraphEdge[]>(
      `/api/namespace/${NAMESPACE}/edges`,
    );
    return edges.filter(isValidEdge);
  } catch (err) {
    console.warn('[fastgraph] getAllEdges failed:', err);
    return [];
  }
}

/** Get recent follow/unfollow decisions with reasoning. */
export async function getRecentDecisions(limit = 20): Promise<TraceEvent[]> {
  try {
    const events = await fetchGraph<TraceEvent[]>(
      `/api/trace/recent?limit=${limit}`,
    );
    // Filter to only events in our namespace
    return events.filter((e) =>
      e.mutations.some((m) => m.namespace === NAMESPACE),
    );
  } catch (err) {
    console.warn('[fastgraph] getRecentDecisions failed:', err);
    return [];
  }
}

/** Get namespace metadata/stats. */
export async function getNamespaceStats(): Promise<{
  node_count: number;
  edge_count: number;
} | null> {
  try {
    return await fetchGraph<{ node_count: number; edge_count: number }>(
      `/api/namespace/${NAMESPACE}/meta`,
    );
  } catch (err) {
    console.warn('[fastgraph] getNamespaceStats failed:', err);
    return null;
  }
}
