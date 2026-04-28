import {
  buildDelistMe,
  buildEndorse,
  buildFollow,
  buildHeartbeat,
  buildProfile,
  buildUnendorse,
  buildUnfollow,
} from '../src/social';
import type { Agent } from '../src/types';
import { aliceProfileBlob } from './fixtures/entries';

function aliceAgent(overrides: Partial<Agent> = {}): Agent {
  return { ...aliceProfileBlob, ...overrides };
}

describe('buildHeartbeat', () => {
  it('preserves caller content fields and emits tag/cap indexes', () => {
    const before = aliceAgent({ last_active: 1 });
    const m = buildHeartbeat('alice.near', before);
    expect(m.action).toBe('social.heartbeat');
    expect(m.rateLimitKey).toBe('alice.near');
    const profile = m.entries.profile as Record<string, unknown>;
    expect(profile.name).toBe('Alice');
    expect(profile.description).toBe('rust reviewer');
    expect(profile.tags).toEqual(['rust']);
    // tag + cap existence indexes
    expect(m.entries['tag/rust']).toBe(true);
    expect(m.entries['cap/skills/code-review']).toBe(true);
  });

  it('creates a default profile on first write (null current)', () => {
    const m = buildHeartbeat('new.near', null);
    const profile = m.entries.profile as Record<string, unknown>;
    expect(profile.account_id).toBe('new.near');
    expect(profile.name).toBeNull();
    expect(profile.tags).toEqual([]);
  });

  it('strips derived AND time fields from the stored profile blob', () => {
    // Time fields (`last_active` / `last_active_height`, `created_at` /
    // `created_height`) are read-derived from FastData block timestamps
    // and block heights, never written. Derived fields (counts,
    // endorsements) are also stripped. Regression guard for the
    // trust-boundary write-side contract on profileEntries: re-adding
    // any of these to the spread without destructuring them out would
    // silently leak caller-asserted values into stored blobs.
    const agent = aliceAgent({
      follower_count: 99,
      following_count: 12,
      endorsements: { 'skills/rust': 5 },
      endorsement_count: 5,
      last_active: 1_700_000_000,
      last_active_height: 123_456_789,
      created_at: 1_690_000_000,
      created_height: 100_000_000,
    });
    const m = buildHeartbeat('alice.near', agent);
    const profile = m.entries.profile as Record<string, unknown>;
    for (const forbidden of [
      'follower_count',
      'following_count',
      'endorsements',
      'endorsement_count',
      'last_active',
      'last_active_height',
      'created_at',
      'created_height',
    ]) {
      expect(profile).not.toHaveProperty(forbidden);
    }
  });
});

describe('buildFollow', () => {
  it('produces a single graph/follow entry with reason but no at field', () => {
    const m = buildFollow('alice.near', 'bob.near', { reason: 'great rust' });
    expect(m.action).toBe('social.follow');
    expect(m.rateLimitKey).toBe('alice.near');
    const entry = m.entries['graph/follow/bob.near'] as Record<string, unknown>;
    expect(entry.reason).toBe('great rust');
    // No `at` field — block_timestamp is the only authoritative time.
    expect(entry.at).toBeUndefined();
  });

  it('produces an empty object entry when no reason is provided', () => {
    const m = buildFollow('alice.near', 'bob.near');
    const entry = m.entries['graph/follow/bob.near'] as Record<string, unknown>;
    expect(entry).toEqual({});
  });

  it('rejects self-follow', () => {
    expect(() => buildFollow('alice.near', 'alice.near')).toThrow(/yourself/);
  });

  it('rejects empty target', () => {
    expect(() => buildFollow('alice.near', '')).toThrow(/empty/);
  });

  it('rejects oversized reason', () => {
    const big = 'x'.repeat(281);
    expect(() =>
      buildFollow('alice.near', 'bob.near', { reason: big }),
    ).toThrow(/reason/);
  });

  it('omits reason field when not provided', () => {
    const m = buildFollow('alice.near', 'bob.near');
    const entry = m.entries['graph/follow/bob.near'] as Record<string, unknown>;
    expect('reason' in entry).toBe(false);
  });
});

describe('buildProfile', () => {
  it('merges patch onto current and re-emits tag/cap indexes', () => {
    const current = aliceAgent({ tags: ['rust'] });
    const m = buildProfile('alice.near', current, {
      description: 'updated bio',
      tags: ['rust', 'security'],
    });
    expect(m.action).toBe('social.profile');
    expect(m.rateLimitKey).toBe('alice.near');
    const profile = m.entries.profile as Record<string, unknown>;
    expect(profile.description).toBe('updated bio');
    expect(profile.tags).toEqual(['rust', 'security']);
    expect(m.entries['tag/rust']).toBe(true);
    expect(m.entries['tag/security']).toBe(true);
  });

  it('null-writes dropped tags so they vanish from listTags', () => {
    const current = aliceAgent({ tags: ['rust', 'ai', 'defi'] });
    const m = buildProfile('alice.near', current, { tags: ['rust'] });
    expect(m.entries['tag/rust']).toBe(true);
    // Dropped tags become null-writes.
    expect(m.entries['tag/ai']).toBeNull();
    expect(m.entries['tag/defi']).toBeNull();
  });

  it('null-writes dropped capability pairs', () => {
    const current = aliceAgent({
      capabilities: { skills: ['code-review', 'fuzzing'] },
    });
    const m = buildProfile('alice.near', current, {
      capabilities: { skills: ['code-review'] },
    });
    expect(m.entries['cap/skills/code-review']).toBe(true);
    expect(m.entries['cap/skills/fuzzing']).toBeNull();
  });

  it('falls through to defaultAgent on first write (current null)', () => {
    const m = buildProfile('new.near', null, { name: 'Newbie' });
    const profile = m.entries.profile as Record<string, unknown>;
    expect(profile.account_id).toBe('new.near');
    expect(profile.name).toBe('Newbie');
    expect(profile.tags).toEqual([]);
  });

  it('rejects an empty patch as VALIDATION_ERROR', () => {
    expect(() => buildProfile('alice.near', aliceAgent(), {})).toThrow(
      /no valid fields/,
    );
  });

  it('rejects tags with invalid characters (leading hyphen)', () => {
    // validateTags lowercases first (so 'Rust' → 'rust' is fine), then
    // enforces the shape. A leading hyphen fails the regex.
    expect(() =>
      buildProfile('alice.near', aliceAgent(), { tags: ['-rust'] }),
    ).toThrow(/lowercase/);
  });

  it('rejects blank name', () => {
    expect(() =>
      buildProfile('alice.near', aliceAgent(), { name: '   ' }),
    ).toThrow(/blank/);
  });

  it('allows clearing name / image to null', () => {
    const current = aliceAgent({ name: 'Alice', image: 'https://e.g/a.png' });
    const m = buildProfile('alice.near', current, {
      name: null,
      image: null,
    });
    const profile = m.entries.profile as Record<string, unknown>;
    expect(profile.name).toBeNull();
    expect(profile.image).toBeNull();
  });

  it('rejects http:// image URLs', () => {
    expect(() =>
      buildProfile('alice.near', aliceAgent(), {
        image: 'http://example.com/a.png',
      }),
    ).toThrow(/https/);
  });

  it('rejects image URLs pointing at private hosts', () => {
    expect(() =>
      buildProfile('alice.near', aliceAgent(), {
        image: 'https://127.0.0.1/a.png',
      }),
    ).toThrow(/local or internal/);
  });
});

describe('buildEndorse', () => {
  it('emits one entry per key_suffix with reason + content_hash', () => {
    const m = buildEndorse('alice.near', 'bob.near', {
      keySuffixes: ['tags/rust', 'skills/audit'],
      reason: 'shipped a good PR',
      contentHash: 'sha256:abc',
    });
    expect(m.action).toBe('social.endorse');
    expect(m.rateLimitKey).toBe('alice.near');
    const a = m.entries['endorsing/bob.near/tags/rust'] as Record<
      string,
      unknown
    >;
    const b = m.entries['endorsing/bob.near/skills/audit'] as Record<
      string,
      unknown
    >;
    expect(a).toEqual({
      reason: 'shipped a good PR',
      content_hash: 'sha256:abc',
    });
    expect(b).toEqual({
      reason: 'shipped a good PR',
      content_hash: 'sha256:abc',
    });
  });

  it('emits an empty-object entry when no reason or hash given', () => {
    const m = buildEndorse('alice.near', 'bob.near', {
      keySuffixes: ['trusted'],
    });
    // Single-segment suffix is fine — server contract is opaque.
    expect(m.entries['endorsing/bob.near/trusted']).toEqual({});
  });

  it('dedupes key_suffixes (first occurrence wins)', () => {
    const m = buildEndorse('alice.near', 'bob.near', {
      keySuffixes: ['tags/rust', 'tags/rust', 'tags/ai'],
    });
    expect(Object.keys(m.entries).sort()).toEqual([
      'endorsing/bob.near/tags/ai',
      'endorsing/bob.near/tags/rust',
    ]);
  });

  it('rejects self-endorse', () => {
    expect(() =>
      buildEndorse('alice.near', 'alice.near', { keySuffixes: ['tags/rust'] }),
    ).toThrow(/yourself/);
  });

  it('rejects empty keySuffixes', () => {
    expect(() =>
      buildEndorse('alice.near', 'bob.near', { keySuffixes: [] }),
    ).toThrow(/empty/);
  });

  it('rejects empty key_suffix element', () => {
    expect(() =>
      buildEndorse('alice.near', 'bob.near', { keySuffixes: [''] }),
    ).toThrow(/empty/);
  });

  it('rejects leading-slash suffixes', () => {
    expect(() =>
      buildEndorse('alice.near', 'bob.near', { keySuffixes: ['/rust'] }),
    ).toThrow(/leading slash|start with/);
  });

  it('rejects more than MAX_KEY_SUFFIXES', () => {
    const many = Array.from({ length: 21 }, (_, i) => `tags/k${i}`);
    expect(() =>
      buildEndorse('alice.near', 'bob.near', { keySuffixes: many }),
    ).toThrow(/too many/);
  });

  it('rejects oversized reason', () => {
    const big = 'x'.repeat(281);
    expect(() =>
      buildEndorse('alice.near', 'bob.near', {
        keySuffixes: ['tags/rust'],
        reason: big,
      }),
    ).toThrow(/reason/);
  });
});

describe('buildUnendorse', () => {
  it('null-writes one entry per key_suffix', () => {
    const m = buildUnendorse('alice.near', 'bob.near', [
      'tags/rust',
      'skills/audit',
    ]);
    expect(m.action).toBe('social.unendorse');
    expect(m.entries['endorsing/bob.near/tags/rust']).toBeNull();
    expect(m.entries['endorsing/bob.near/skills/audit']).toBeNull();
  });

  it('dedupes duplicates', () => {
    const m = buildUnendorse('alice.near', 'bob.near', [
      'tags/rust',
      'tags/rust',
    ]);
    expect(Object.keys(m.entries)).toEqual(['endorsing/bob.near/tags/rust']);
  });

  it('rejects empty keySuffixes', () => {
    expect(() => buildUnendorse('alice.near', 'bob.near', [])).toThrow(/empty/);
  });

  it('rejects self-unendorse', () => {
    expect(() =>
      buildUnendorse('alice.near', 'alice.near', ['tags/rust']),
    ).toThrow(/yourself/);
  });
});

describe('buildUnfollow', () => {
  it('emits a null-write at graph/follow/{target}', () => {
    const m = buildUnfollow('alice.near', 'bob.near');
    expect(m.action).toBe('social.unfollow');
    expect(m.rateLimitKey).toBe('alice.near');
    expect(m.entries['graph/follow/bob.near']).toBeNull();
    expect(Object.keys(m.entries)).toHaveLength(1);
  });

  it('rejects self-unfollow', () => {
    expect(() => buildUnfollow('alice.near', 'alice.near')).toThrow(/yourself/);
  });

  it('rejects empty target', () => {
    expect(() => buildUnfollow('alice.near', '')).toThrow(/empty/);
  });
});

describe('buildDelistMe', () => {
  it('null-writes profile + tag/cap + outgoing follow + outgoing endorse', () => {
    const agent = aliceAgent({
      tags: ['rust', 'ai'],
      capabilities: { skills: ['code-review'] },
    });
    const m = buildDelistMe(
      agent,
      ['graph/follow/bob.near', 'graph/follow/carol.near'],
      ['endorsing/bob.near/tags/rust'],
    );
    expect(m.action).toBe('social.delist_me');
    expect(m.rateLimitKey).toBe('alice.near');
    expect(m.entries.profile).toBeNull();
    expect(m.entries['tag/rust']).toBeNull();
    expect(m.entries['tag/ai']).toBeNull();
    expect(m.entries['cap/skills/code-review']).toBeNull();
    expect(m.entries['graph/follow/bob.near']).toBeNull();
    expect(m.entries['graph/follow/carol.near']).toBeNull();
    expect(m.entries['endorsing/bob.near/tags/rust']).toBeNull();
  });

  it('does not touch any keys not passed in (follower edges others wrote are safe)', () => {
    const agent = aliceAgent({ tags: [], capabilities: {} });
    const m = buildDelistMe(agent, [], []);
    // Only profile is null-written; no tag/cap/graph entries materialize.
    expect(Object.keys(m.entries)).toEqual(['profile']);
  });

  it('rejects follow-key entries not starting with graph/follow/', () => {
    expect(() =>
      buildDelistMe(aliceAgent(), ['endorsing/bob.near/tags/rust'], []),
    ).toThrow(/graph\/follow/);
  });

  it('rejects endorse-key entries not starting with endorsing/', () => {
    expect(() =>
      buildDelistMe(aliceAgent(), [], ['graph/follow/bob.near']),
    ).toThrow(/endorsing/);
  });
});
