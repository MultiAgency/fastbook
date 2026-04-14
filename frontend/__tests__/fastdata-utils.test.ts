/**
 * @jest-environment node
 */

import * as fastdata from '@/lib/fastdata';
import {
  fetchAllProfiles,
  fetchProfile,
  fetchProfiles,
} from '@/lib/fastdata-utils';

jest.mock('@/lib/fastdata');

const mockKvGetAgent = fastdata.kvGetAgent as jest.MockedFunction<
  typeof fastdata.kvGetAgent
>;
const mockKvMultiAgent = fastdata.kvMultiAgent as jest.MockedFunction<
  typeof fastdata.kvMultiAgent
>;
const mockKvGetAll = fastdata.kvGetAll as jest.MockedFunction<
  typeof fastdata.kvGetAll
>;

function profileEntry(
  predecessorId: string,
  value: unknown,
  blockTimestamp = 1_700_000_000_000_000_000,
): fastdata.KvEntry {
  return {
    predecessor_id: predecessorId,
    current_account_id: 'contextual.near',
    block_height: 1,
    block_timestamp: blockTimestamp,
    key: 'profile',
    value,
  };
}

beforeEach(() => {
  mockKvGetAgent.mockReset();
  mockKvMultiAgent.mockReset();
  mockKvGetAll.mockReset();
});

// The wrappers exist to enforce FastData's trust boundary: the
// predecessor namespace (who wrote the key) is authoritative, and the
// stored blob's own `account_id` field is content that may be stale,
// missing, or corrupt. These tests verify the override actually fires
// — the rest of the suite uses fixtures whose stored account_id
// matches the lookup key, which is a no-op case.

describe('fetchProfile', () => {
  it('overrides stale account_id in the stored blob', async () => {
    mockKvGetAgent.mockResolvedValue(
      profileEntry('alice.near', {
        account_id: 'imposter.near',
        name: 'Alice',
        tags: ['ai'],
      }),
    );

    const result = await fetchProfile('alice.near');
    expect(result).not.toBeNull();
    expect(result?.account_id).toBe('alice.near');
    expect(result?.name).toBe('Alice');
  });

  it('overrides caller-asserted last_active with block timestamp', async () => {
    // The caller claims year 2286; the block was indexed at 1_700_000_000s.
    // The override prevents sort=active manipulation. The literal is kept
    // within JS's safe integer range (round nanoseconds) to satisfy Biome.
    mockKvGetAgent.mockResolvedValue(
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', name: 'Alice', last_active: 9_999_999_999 },
        1_700_000_000_500_000_000,
      ),
    );

    const result = await fetchProfile('alice.near');
    expect(result?.last_active).toBe(1_700_000_000);
  });

  it('returns null when the entry is null', async () => {
    mockKvGetAgent.mockResolvedValue(null);
    expect(await fetchProfile('alice.near')).toBeNull();
  });

  it('returns null when the stored blob is a primitive', async () => {
    mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', 'oops'));
    expect(await fetchProfile('alice.near')).toBeNull();
  });

  it('returns null when the stored blob is an array', async () => {
    // Arrays are `typeof 'object'`; spreading one would yield a "profile"
    // with numeric-string keys. applyTrustBoundary must reject arrays
    // explicitly or this class of garbage leaks through.
    mockKvGetAgent.mockResolvedValue(profileEntry('alice.near', [1, 2, 3]));
    expect(await fetchProfile('alice.near')).toBeNull();
  });
});

describe('fetchProfiles', () => {
  it('returns paired agents with authoritative account_ids', async () => {
    mockKvMultiAgent.mockResolvedValue([
      profileEntry('alice.near', { account_id: 'wrong1', name: 'A' }),
      profileEntry('bob.near', { account_id: 'wrong2', name: 'B' }),
    ]);

    const result = await fetchProfiles(['alice.near', 'bob.near']);
    expect(result).toHaveLength(2);
    expect(result[0].account_id).toBe('alice.near');
    expect(result[0].name).toBe('A');
    expect(result[1].account_id).toBe('bob.near');
    expect(result[1].name).toBe('B');
  });

  it('overrides last_active from each entry block_timestamp', async () => {
    // Block times are per-entry, so batch reads preserve the trust
    // boundary across the whole list — not just fetchProfile's single
    // case. This is the audit closure for sort=active under tag/cap
    // filters, which used to bypass the override via kvMultiAgent.
    mockKvMultiAgent.mockResolvedValue([
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', last_active: 9_999_999_999 },
        1_700_000_001_000_000_000,
      ),
      profileEntry(
        'bob.near',
        { account_id: 'bob.near', last_active: 1 },
        1_700_000_002_000_000_000,
      ),
    ]);

    const result = await fetchProfiles(['alice.near', 'bob.near']);
    expect(result[0].last_active).toBe(1_700_000_001);
    expect(result[1].last_active).toBe(1_700_000_002);
  });

  it('drops null entries without shifting the remaining indices', async () => {
    mockKvMultiAgent.mockResolvedValue([
      profileEntry('alice.near', { account_id: 'whatever', name: 'A' }),
      null,
      profileEntry('carol.near', { account_id: 'whatever', name: 'C' }),
    ]);

    const result = await fetchProfiles([
      'alice.near',
      'bob.near',
      'carol.near',
    ]);
    expect(result).toHaveLength(2);
    // Dropped entry for bob.near — remaining agents keep their authoritative ids.
    expect(result[0].account_id).toBe('alice.near');
    expect(result[1].account_id).toBe('carol.near');
  });

  it('short-circuits on empty input without hitting the KV layer', async () => {
    const result = await fetchProfiles([]);
    expect(result).toEqual([]);
    expect(mockKvMultiAgent).not.toHaveBeenCalled();
  });
});

describe('fetchAllProfiles', () => {
  it('uses each entry predecessor_id as the authoritative account_id', async () => {
    mockKvGetAll.mockResolvedValue([
      profileEntry('alice.near', { account_id: 'lying.near', name: 'Alice' }),
      profileEntry('bob.near', { account_id: 'also.lying', name: 'Bob' }),
    ]);

    const result = await fetchAllProfiles();
    expect(result).toHaveLength(2);
    expect(result[0].account_id).toBe('alice.near');
    expect(result[0].name).toBe('Alice');
    expect(result[1].account_id).toBe('bob.near');
    expect(result[1].name).toBe('Bob');
  });

  it('overrides caller-asserted last_active with block timestamp', async () => {
    mockKvGetAll.mockResolvedValue([
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', last_active: 9_999_999_999 },
        1_700_000_000_000_000_000,
      ),
    ]);
    const result = await fetchAllProfiles();
    expect(result[0].last_active).toBe(1_700_000_000);
  });

  it('strips caller-asserted created_at from blobs (history is the only source)', async () => {
    // The blob carries an obviously-fake `created_at: 9_999_999_999`. The
    // trust boundary must drop it, leaving the field undefined for list
    // paths that don't fetch history. If the blob value leaked through,
    // sort=newest would be manipulable by writing a large `created_at`
    // into the profile blob — that's the exact gap the audit closes.
    mockKvGetAll.mockResolvedValue([
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', created_at: 9_999_999_999 },
        1_700_000_000_000_000_000,
      ),
    ]);
    const result = await fetchAllProfiles();
    expect(result[0].created_at).toBeUndefined();
  });

  it('drops entries whose value is not an object', async () => {
    mockKvGetAll.mockResolvedValue([
      profileEntry('alice.near', { name: 'Alice' }),
      profileEntry('bob.near', 'garbage'),
    ]);

    const result = await fetchAllProfiles();
    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe('alice.near');
  });
});
