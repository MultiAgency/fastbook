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
    mockKvGetAgent.mockResolvedValue({
      account_id: 'imposter.near',
      name: 'Alice',
      tags: ['ai'],
    });

    const result = await fetchProfile('alice.near');
    expect(result).not.toBeNull();
    expect(result?.account_id).toBe('alice.near');
    expect(result?.name).toBe('Alice');
  });

  it('returns null when the stored blob is null', async () => {
    mockKvGetAgent.mockResolvedValue(null);
    expect(await fetchProfile('alice.near')).toBeNull();
  });

  it('returns null when the stored blob is a primitive', async () => {
    mockKvGetAgent.mockResolvedValue('oops' as unknown as object);
    expect(await fetchProfile('alice.near')).toBeNull();
  });

  it('returns null when the stored blob is an array', async () => {
    // Arrays are `typeof 'object'`; spreading one would yield a "profile"
    // with numeric-string keys. applyTrustBoundary must reject arrays
    // explicitly or this class of garbage leaks through.
    mockKvGetAgent.mockResolvedValue([1, 2, 3] as unknown as object);
    expect(await fetchProfile('alice.near')).toBeNull();
  });
});

describe('fetchProfiles', () => {
  it('returns paired agents with authoritative account_ids', async () => {
    mockKvMultiAgent.mockResolvedValue([
      { account_id: 'wrong1', name: 'A' },
      { account_id: 'wrong2', name: 'B' },
    ]);

    const result = await fetchProfiles(['alice.near', 'bob.near']);
    expect(result).toHaveLength(2);
    expect(result[0].account_id).toBe('alice.near');
    expect(result[0].name).toBe('A');
    expect(result[1].account_id).toBe('bob.near');
    expect(result[1].name).toBe('B');
  });

  it('drops null entries without shifting the remaining indices', async () => {
    mockKvMultiAgent.mockResolvedValue([
      { account_id: 'whatever', name: 'A' },
      null,
      { account_id: 'whatever', name: 'C' },
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
      {
        predecessor_id: 'alice.near',
        current_account_id: 'ns',
        block_height: 1,
        block_timestamp: 1,
        key: 'profile',
        value: { account_id: 'lying.near', name: 'Alice' },
      },
      {
        predecessor_id: 'bob.near',
        current_account_id: 'ns',
        block_height: 1,
        block_timestamp: 1,
        key: 'profile',
        value: { account_id: 'also.lying', name: 'Bob' },
      },
    ]);

    const result = await fetchAllProfiles();
    expect(result).toHaveLength(2);
    expect(result[0].account_id).toBe('alice.near');
    expect(result[0].name).toBe('Alice');
    expect(result[1].account_id).toBe('bob.near');
    expect(result[1].name).toBe('Bob');
  });

  it('drops entries whose value is not an object', async () => {
    mockKvGetAll.mockResolvedValue([
      {
        predecessor_id: 'alice.near',
        current_account_id: 'ns',
        block_height: 1,
        block_timestamp: 1,
        key: 'profile',
        value: { name: 'Alice' },
      },
      {
        predecessor_id: 'bob.near',
        current_account_id: 'ns',
        block_height: 1,
        block_timestamp: 1,
        key: 'profile',
        value: 'garbage',
      },
    ]);

    const result = await fetchAllProfiles();
    expect(result).toHaveLength(1);
    expect(result[0].account_id).toBe('alice.near');
  });
});
