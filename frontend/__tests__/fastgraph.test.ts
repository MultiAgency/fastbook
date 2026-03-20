import {
  getAgentNode,
  getFollowGraph,
  getAllEdges,
  getRecentDecisions,
  getNamespaceStats,
} from '@/lib/fastgraph';

jest.mock('@/lib/fetch', () => ({
  fetchWithTimeout: jest.fn(),
}));

import { fetchWithTimeout } from '@/lib/fetch';

const mockFetch = fetchWithTimeout as jest.MockedFunction<
  typeof fetchWithTimeout
>;

beforeEach(() => {
  jest.clearAllMocks();
});

const validNode = {
  id: 'test_agent',
  node_type: 'agent',
  namespace: 'social',
  data: { handle: 'test_agent', near_account_id: 'test.near' },
  agent_id: 'test.near',
  created_at_ms: 1700000000000,
};

const validEdge = {
  source: 'agent_a',
  target: 'agent_b',
  label: 'follows',
  namespace: 'social',
  data: {},
  agent_id: 'a.near',
  created_at_ms: 1700000000000,
};

describe('getAgentNode', () => {
  it('returns a valid node', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(validNode),
    } as Response);

    const result = await getAgentNode('test_agent');
    expect(result).toEqual(validNode);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/node/social/test_agent'),
      undefined,
      expect.any(Number),
    );
  });

  it('returns null for wrong namespace', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ ...validNode, namespace: 'other' }),
    } as Response);

    expect(await getAgentNode('test_agent')).toBeNull();
  });

  it('returns null for wrong node_type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ ...validNode, node_type: 'contract' }),
    } as Response);

    expect(await getAgentNode('test_agent')).toBeNull();
  });

  it('returns null on fetch error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    expect(await getAgentNode('test_agent')).toBeNull();
  });

  it('returns null on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    } as Response);

    expect(await getAgentNode('test_agent')).toBeNull();
  });
});

describe('getFollowGraph', () => {
  it('returns filtered nodes and edges', async () => {
    const invalidEdge = { ...validEdge, label: 'blocked', namespace: 'social' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          nodes: [validNode, { ...validNode, namespace: 'other' }],
          edges: [validEdge, invalidEdge],
        }),
    } as Response);

    const result = await getFollowGraph('test_agent');
    expect(result.nodes).toHaveLength(1);
    expect(result.edges).toHaveLength(1);
    expect(result.nodes[0].id).toBe('test_agent');
    expect(result.edges[0].label).toBe('follows');
  });

  it('returns empty on error', async () => {
    mockFetch.mockRejectedValue(new Error('fail'));
    const result = await getFollowGraph('test_agent');
    expect(result).toEqual({ nodes: [], edges: [] });
  });
});

describe('getAllEdges', () => {
  it('returns filtered edges', async () => {
    const wrongNs = { ...validEdge, namespace: 'other' };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([validEdge, wrongNs]),
    } as Response);

    const edges = await getAllEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('agent_a');
  });

  it('returns empty on error', async () => {
    mockFetch.mockRejectedValue(new Error('fail'));
    expect(await getAllEdges()).toEqual([]);
  });
});

describe('getRecentDecisions', () => {
  it('filters to social namespace mutations', async () => {
    const socialEvent = {
      tx_hash: 'abc',
      signer_id: 'a.near',
      mutations: [{ op: 'create_edge', namespace: 'social' }],
      timestamp_ms: 1700000000000,
    };
    const otherEvent = {
      tx_hash: 'def',
      signer_id: 'b.near',
      mutations: [{ op: 'create_edge', namespace: 'other' }],
      timestamp_ms: 1700000000000,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([socialEvent, otherEvent]),
    } as Response);

    const events = await getRecentDecisions(10);
    expect(events).toHaveLength(1);
    expect(events[0].tx_hash).toBe('abc');
  });

  it('passes limit param', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    } as Response);

    await getRecentDecisions(5);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('limit=5'),
      undefined,
      expect.any(Number),
    );
  });

  it('returns empty on error', async () => {
    mockFetch.mockRejectedValue(new Error('fail'));
    expect(await getRecentDecisions()).toEqual([]);
  });
});

describe('getNamespaceStats', () => {
  it('returns stats', async () => {
    const stats = { node_count: 42, edge_count: 100 };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(stats),
    } as Response);

    expect(await getNamespaceStats()).toEqual(stats);
  });

  it('returns null on error', async () => {
    mockFetch.mockRejectedValue(new Error('fail'));
    expect(await getNamespaceStats()).toBeNull();
  });
});
