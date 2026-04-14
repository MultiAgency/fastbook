import {
  defaultAgent,
  extractCapabilityPairs,
  foldProfile,
} from '../src/graph';
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

  it('strips caller-asserted created_at from the blob', () => {
    // `created_at` is only populated by read paths that fetch FastData
    // history (a future v0.1+ concern). `foldProfile` must clear it from
    // the spread so a blob with `created_at: 9_999_999_999` can't leak
    // caller-asserted time into the returned Agent. Without this strip,
    // sort=newest-style orderings would be manipulable.
    const e = entry({
      predecessor_id: 'alice.near',
      key: 'profile',
      value: { ...aliceProfileBlob, created_at: 9_999_999_999 },
    });
    expect(foldProfile(e)?.created_at).toBeUndefined();
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
