import type { EndorsementGraphReader } from '../src/graph';
import {
  defaultAgent,
  extractCapabilityPairs,
  foldProfile,
  profileCompleteness,
  profileGaps,
  walkEndorsementGraph,
} from '../src/graph';
import type { Agent, EndorserEntry, EndorsingTargetGroup } from '../src/types';
import { aliceProfileBlob, aliceProfileEntry, entry } from './fixtures/entries';

describe('graph.foldProfile', () => {
  it('uses the KvEntry predecessor_id as account_id', () => {
    const e = entry({
      predecessor_id: 'bob.near',
      key: 'profile',
      value: { ...aliceProfileBlob, account_id: 'alice.near' },
    });
    const agent = foldProfile(e);
    expect(agent!.account_id).toBe('bob.near');
  });

  it('overrides caller-asserted last_active with block_timestamp', () => {
    // block_timestamp is nanoseconds; the override divides by 1e9 and
    // floors to seconds. 1_700_000_000_500_000_000 ns → 1_700_000_000 s.
    // (Using a round number avoids JS number-literal precision loss — the
    // outer nine digits plus trailing zeros are all representable exactly.)
    const e = entry({
      predecessor_id: 'alice.near',
      key: 'profile',
      value: { ...aliceProfileBlob, last_active: 9_999_999_999 },
      block_timestamp: 1_700_000_000_500_000_000,
    });
    expect(foldProfile(e)?.last_active).toBe(1_700_000_000);
  });

  it('strips every trust-boundary and derived field from legacy blobs', () => {
    // `created_at` / `created_height` are only populated by read paths
    // that fetch FastData first-write history (`getAgent`, `listAgents`
    // sort=newest). Count / endorsement fields are overlaid elsewhere.
    // `foldProfile` must destructure all of them out of the blob so a
    // forged value in any slot can't leak into the returned Agent —
    // without this, sort=newest, sort=followers, and endorsement
    // rankings would all be manipulable by a malicious writer. This
    // test is the read-side complement of the write-side strip guard
    // in `social.test.ts::buildHeartbeat`.
    const e = entry({
      predecessor_id: 'alice.near',
      key: 'profile',
      value: {
        ...aliceProfileBlob,
        last_active: 9_999_999_999,
        last_active_height: 9_999_999,
        created_at: 9_999_999_999,
        created_height: 9_999_999,
        follower_count: 999,
        following_count: 888,
        endorsement_count: 777,
        endorsements: { 'forged/key': 666 },
      },
      block_timestamp: 1_700_000_000_000_000_000,
      block_height: 1_234,
    });
    const agent = foldProfile(e);
    // Trust-boundary overrides fire.
    expect(agent?.account_id).toBe('alice.near');
    expect(agent?.last_active).toBe(1_700_000_000);
    expect(agent?.last_active_height).toBe(1_234);
    // Forged fields with no authoritative replacement are genuinely
    // absent — not present with undefined — on foldProfile's return.
    for (const forbidden of [
      'created_at',
      'created_height',
      'follower_count',
      'following_count',
      'endorsement_count',
      'endorsements',
    ]) {
      expect(agent).not.toHaveProperty(forbidden);
    }
  });

  it('returns null when the entry value is a string', () => {
    const e = entry({
      predecessor_id: 'alice.near',
      key: 'profile',
      value: 'corrupted',
    });
    expect(foldProfile(e)).toBeNull();
  });

  it('returns null for arrays (typeof [] === object trap)', () => {
    const e = entry({
      predecessor_id: 'alice.near',
      key: 'profile',
      value: ['not', 'an', 'agent'],
    });
    expect(foldProfile(e)).toBeNull();
  });

  it('returns null for null/primitive values', () => {
    expect(
      foldProfile(entry({ predecessor_id: 'a', key: 'profile', value: null })),
    ).toBeNull();
    expect(
      foldProfile(entry({ predecessor_id: 'a', key: 'profile', value: 42 })),
    ).toBeNull();
  });

  it('round-trips a live profile entry', () => {
    const agent = foldProfile(aliceProfileEntry);
    expect(agent?.name).toBe('Alice');
    expect(agent?.tags).toEqual(['rust']);
  });
});

describe('graph.defaultAgent', () => {
  it('produces an empty profile with no time fields', () => {
    const a = defaultAgent('new.near');
    expect(a.account_id).toBe('new.near');
    expect(a.name).toBeNull();
    expect(a.description).toBe('');
    expect(a.tags).toEqual([]);
    expect(a.capabilities).toEqual({});
    expect(a.created_at).toBeUndefined();
    expect(a.last_active).toBeUndefined();
  });
});

describe('graph.extractCapabilityPairs', () => {
  it('flattens nested objects into dot-paths', () => {
    const pairs = extractCapabilityPairs({
      languages: { primary: 'Rust', secondary: 'TypeScript' },
    });
    expect(pairs).toContainEqual(['languages.primary', 'rust']);
    expect(pairs).toContainEqual(['languages.secondary', 'typescript']);
  });

  it('lowercases values', () => {
    const pairs = extractCapabilityPairs({ skills: ['Rust', 'Go'] });
    expect(pairs).toEqual([
      ['skills', 'rust'],
      ['skills', 'go'],
    ]);
  });

  it('caps depth at 4', () => {
    const deep = { a: { b: { c: { d: { e: 'too-deep' } } } } };
    const pairs = extractCapabilityPairs(deep);
    expect(pairs).toEqual([]);
  });

  it('returns empty on null/undefined', () => {
    expect(extractCapabilityPairs(null)).toEqual([]);
    expect(extractCapabilityPairs(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// profileGaps / profileCompleteness
// ---------------------------------------------------------------------------

const COMPLETE_PROFILE = {
  name: 'Alice',
  description: 'A description longer than 10 chars',
  image: 'https://example.com/avatar.png',
  tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10'],
  capabilities: { skills: ['s1', 's2', 's3'] },
};

describe('profileGaps', () => {
  it('returns empty for a complete profile', () => {
    expect(profileGaps(COMPLETE_PROFILE)).toEqual([]);
  });

  it('flags only name when name is null', () => {
    expect(profileGaps({ ...COMPLETE_PROFILE, name: null })).toEqual(['name']);
  });

  it('flags only description when empty', () => {
    expect(profileGaps({ ...COMPLETE_PROFILE, description: '' })).toEqual([
      'description',
    ]);
  });

  it('flags description at exactly 10 chars (boundary)', () => {
    expect(
      profileGaps({ ...COMPLETE_PROFILE, description: '0123456789' }),
    ).toEqual(['description']);
  });

  it('accepts description at 11 chars', () => {
    expect(
      profileGaps({ ...COMPLETE_PROFILE, description: '01234567890' }),
    ).toEqual([]);
  });

  it('flags only tags when empty', () => {
    expect(profileGaps({ ...COMPLETE_PROFILE, tags: [] })).toEqual(['tags']);
  });

  it('flags only capabilities when empty', () => {
    expect(profileGaps({ ...COMPLETE_PROFILE, capabilities: {} })).toEqual([
      'capabilities',
    ]);
  });

  it('flags only image when null', () => {
    expect(profileGaps({ ...COMPLETE_PROFILE, image: null })).toEqual([
      'image',
    ]);
  });

  it('flags all fields for a completely empty profile', () => {
    expect(
      profileGaps({
        name: null,
        description: '',
        image: null,
        tags: [],
        capabilities: {},
      }),
    ).toEqual(['name', 'description', 'tags', 'capabilities', 'image']);
  });
});

describe('profileCompleteness', () => {
  it('returns 100 for a complete profile', () => {
    expect(profileCompleteness(COMPLETE_PROFILE)).toBe(100);
  });

  it('scores tags continuously (2 points per tag, cap 10)', () => {
    expect(profileCompleteness({ ...COMPLETE_PROFILE, tags: ['t1'] })).toBe(82);
    expect(
      profileCompleteness({
        ...COMPLETE_PROFILE,
        tags: ['t1', 't2', 't3', 't4', 't5'],
      }),
    ).toBe(90);
    // 15 tags: capped at 10 → 20 points → 100 total
    expect(
      profileCompleteness({
        ...COMPLETE_PROFILE,
        tags: Array.from({ length: 15 }, (_, i) => `t${i}`),
      }),
    ).toBe(100);
  });

  it('scores capabilities continuously (10 points per leaf pair, cap 3)', () => {
    expect(
      profileCompleteness({
        ...COMPLETE_PROFILE,
        capabilities: { skills: ['s1'] },
      }),
    ).toBe(80);
    // 5 pairs: capped at 3 → 30 points → 100 total
    expect(
      profileCompleteness({
        ...COMPLETE_PROFILE,
        capabilities: { skills: ['s1', 's2', 's3'], languages: ['l1', 'l2'] },
      }),
    ).toBe(100);
  });

  it('scores a sparse profile (description + 1 tag + 1 cap pair = 32)', () => {
    expect(
      profileCompleteness({
        name: null,
        description: 'rust reviewer',
        image: null,
        tags: ['rust'],
        capabilities: { skills: ['code-review'] },
      }),
    ).toBe(32);
  });

  it('returns 0 for a completely empty profile', () => {
    expect(
      profileCompleteness({
        name: null,
        description: '',
        image: null,
        tags: [],
        capabilities: {},
      }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// walkEndorsementGraph
// ---------------------------------------------------------------------------

function agentFixture(accountId: string, name: string): Agent {
  return {
    account_id: accountId,
    name,
    description: `${name} description`,
    image: null,
    tags: [],
    capabilities: {},
    endorsements: {},
  };
}

function endorserEntry(accountId: string): EndorserEntry {
  return {
    account_id: accountId,
    name: accountId,
    description: '',
    image: null,
    at: 1_700_000_000,
    at_height: 100,
  };
}

function targetGroup(accountId: string): EndorsingTargetGroup {
  return {
    target: {
      account_id: accountId,
      name: accountId,
      description: '',
      image: null,
    },
    entries: [{ key_suffix: 'skills/test', at: 1_700_000_000, at_height: 100 }],
  };
}

/**
 * Build a mock reader with a fixed graph. `outgoing` maps account_id →
 * list of target account_ids. `incoming` maps account_id → list of
 * endorser account_ids.
 */
function mockReader(graph: {
  outgoing: Record<string, string[]>;
  incoming: Record<string, string[]>;
}): EndorsementGraphReader {
  return {
    getAgent: jest.fn(async (id: string) => agentFixture(id, id)),
    getEndorsing: jest.fn(
      async (id: string): Promise<Record<string, EndorsingTargetGroup>> => {
        const targets = graph.outgoing[id] ?? [];
        const result: Record<string, EndorsingTargetGroup> = {};
        for (const t of targets) result[t] = targetGroup(t);
        return result;
      },
    ),
    getEndorsers: jest.fn(
      async (id: string): Promise<Record<string, EndorserEntry[]>> => {
        const endorsers = graph.incoming[id] ?? [];
        if (endorsers.length === 0) return {};
        return { 'skills/test': endorsers.map(endorserEntry) };
      },
    ),
  };
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe('walkEndorsementGraph', () => {
  it('maxHops: 0 yields only the start node', async () => {
    const reader = mockReader({ outgoing: {}, incoming: {} });
    const nodes = await drain(
      walkEndorsementGraph({
        start: 'alice.near',
        direction: 'outgoing',
        maxHops: 0,
        reader,
      }),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].account_id).toBe('alice.near');
    expect(nodes[0].hop).toBe(0);
    expect(nodes[0].path).toEqual(['alice.near']);
  });

  it('maxHops: 1 outgoing yields start + direct neighbors', async () => {
    const reader = mockReader({
      outgoing: { 'alice.near': ['bob.near', 'carol.near'] },
      incoming: {},
    });
    const nodes = await drain(
      walkEndorsementGraph({
        start: 'alice.near',
        direction: 'outgoing',
        maxHops: 1,
        reader,
      }),
    );
    expect(nodes).toHaveLength(3);
    expect(nodes[0].account_id).toBe('alice.near');
    expect(nodes[0].hop).toBe(0);
    const hop1 = nodes.filter((n) => n.hop === 1);
    expect(hop1.map((n) => n.account_id).sort()).toEqual([
      'bob.near',
      'carol.near',
    ]);
  });

  it('cycle guard: mutual endorsement does not loop', async () => {
    const reader = mockReader({
      outgoing: { 'alice.near': ['bob.near'], 'bob.near': ['alice.near'] },
      incoming: {},
    });
    const nodes = await drain(
      walkEndorsementGraph({
        start: 'alice.near',
        direction: 'outgoing',
        maxHops: 5,
        reader,
      }),
    );
    // Each node yielded exactly once despite the cycle.
    const ids = nodes.map((n) => n.account_id);
    expect(ids).toEqual(['alice.near', 'bob.near']);
  });

  it('direction incoming walks via getEndorsers', async () => {
    const reader = mockReader({
      outgoing: {},
      incoming: { 'alice.near': ['bob.near'] },
    });
    const nodes = await drain(
      walkEndorsementGraph({
        start: 'alice.near',
        direction: 'incoming',
        maxHops: 1,
        reader,
      }),
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[1].account_id).toBe('bob.near');
    expect(reader.getEndorsers).toHaveBeenCalledWith('alice.near');
    expect(reader.getEndorsing).not.toHaveBeenCalled();
  });

  it('direction both unions neighbors from both reads', async () => {
    const reader = mockReader({
      outgoing: { 'alice.near': ['bob.near'] },
      incoming: { 'alice.near': ['carol.near'] },
    });
    const nodes = await drain(
      walkEndorsementGraph({
        start: 'alice.near',
        direction: 'both',
        maxHops: 1,
        reader,
      }),
    );
    expect(nodes).toHaveLength(3);
    const hop1 = nodes
      .filter((n) => n.hop === 1)
      .map((n) => n.account_id)
      .sort();
    expect(hop1).toEqual(['bob.near', 'carol.near']);
  });

  it('failed read is swallowed; walk continues', async () => {
    const reader = mockReader({
      outgoing: { 'alice.near': ['bob.near', 'carol.near'] },
      incoming: {},
    });
    // bob.near's getAgent throws — should be skipped, carol.near still yields.
    (reader.getAgent as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'bob.near') throw new Error('network failure');
      return agentFixture(id, id);
    });
    const nodes = await drain(
      walkEndorsementGraph({
        start: 'alice.near',
        direction: 'outgoing',
        maxHops: 1,
        reader,
      }),
    );
    // alice + carol (bob skipped).
    expect(nodes.map((n) => n.account_id)).toEqual([
      'alice.near',
      'carol.near',
    ]);
  });

  it('hop equals path.length - 1', async () => {
    const reader = mockReader({
      outgoing: {
        'alice.near': ['bob.near'],
        'bob.near': ['carol.near'],
      },
      incoming: {},
    });
    const nodes = await drain(
      walkEndorsementGraph({
        start: 'alice.near',
        direction: 'outgoing',
        maxHops: 2,
        reader,
      }),
    );
    for (const node of nodes) {
      expect(node.hop).toBe(node.path.length - 1);
    }
    const carol = nodes.find((n) => n.account_id === 'carol.near');
    expect(carol?.path).toEqual(['alice.near', 'bob.near', 'carol.near']);
  });

  it('start node yields synthetic summary when getAgent returns null', async () => {
    const reader = mockReader({
      outgoing: { 'ghost.near': ['bob.near'] },
      incoming: {},
    });
    (reader.getAgent as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'ghost.near') return null;
      return agentFixture(id, id);
    });
    const nodes = await drain(
      walkEndorsementGraph({
        start: 'ghost.near',
        direction: 'outgoing',
        maxHops: 1,
        reader,
      }),
    );
    expect(nodes[0]).toEqual({
      account_id: 'ghost.near',
      name: null,
      description: '',
      image: null,
      hop: 0,
      path: ['ghost.near'],
    });
    // Neighbors still expanded despite profileless start.
    expect(nodes).toHaveLength(2);
    expect(nodes[1].account_id).toBe('bob.near');
  });

  it('intermediate profileless node is skipped but its neighbors are still reachable', async () => {
    // A → B → C, B has no profile. C should still appear.
    const reader = mockReader({
      outgoing: {
        'alice.near': ['bob.near'],
        'bob.near': ['carol.near'],
      },
      incoming: {},
    });
    (reader.getAgent as jest.Mock).mockImplementation(async (id: string) => {
      if (id === 'bob.near') return null;
      return agentFixture(id, id);
    });
    const nodes = await drain(
      walkEndorsementGraph({
        start: 'alice.near',
        direction: 'outgoing',
        maxHops: 2,
        reader,
      }),
    );
    const ids = nodes.map((n) => n.account_id);
    // alice yields, bob is skipped (no profile), carol yields.
    expect(ids).toEqual(['alice.near', 'carol.near']);
    expect(nodes[1].hop).toBe(2);
    expect(nodes[1].path).toEqual(['alice.near', 'bob.near', 'carol.near']);
  });

  it('negative maxHops yields nothing', async () => {
    const reader = mockReader({ outgoing: {}, incoming: {} });
    const nodes = await drain(
      walkEndorsementGraph({
        start: 'alice.near',
        direction: 'outgoing',
        maxHops: -1,
        reader,
      }),
    );
    expect(nodes).toEqual([]);
  });
});
