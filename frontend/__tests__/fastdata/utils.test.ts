/**
 * @jest-environment node
 */

import * as fastdata from '@/lib/fastdata/client';
import {
  fetchAllProfiles,
  fetchProfile,
  fetchProfiles,
} from '@/lib/fastdata/utils';

jest.mock('@/lib/fastdata/client');

const mockKvGetAgent = fastdata.kvGetAgent as jest.MockedFunction<
  typeof fastdata.kvGetAgent
>;
const mockKvGetAgentFirstWrite =
  fastdata.kvGetAgentFirstWrite as jest.MockedFunction<
    typeof fastdata.kvGetAgentFirstWrite
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
  blockHeight = 1,
): fastdata.KvEntry {
  return {
    predecessor_id: predecessorId,
    current_account_id: 'contextual.near',
    block_height: blockHeight,
    block_timestamp: blockTimestamp,
    key: 'profile',
    value,
  };
}

beforeEach(() => {
  mockKvGetAgent.mockReset();
  mockKvGetAgentFirstWrite.mockReset();
  mockKvMultiAgent.mockReset();
  mockKvGetAll.mockReset();
});

// These wrappers call @nearly/sdk's foldProfile / foldProfileList under the
// hood. Trust-boundary invariants (account_id/last_active override, legacy
// blob stripping, null-on-invalid) are exhaustively covered in the SDK at
// packages/sdk/__tests__/graph.test.ts. Tests here cover only wrapper-local
// behavior — `created_*` overlay from firstWrite history, batch-level null
// handling, empty-input short-circuit — plus a single delegation pin per
// wrapper asserting foldProfile is actually called.

describe('fetchProfile', () => {
  // Delegation pin: if the wrapper ever stopped routing through foldProfile
  // (e.g. started returning the raw entry value), the predecessor_id vs
  // stored account_id divergence would leak through and this test fires.
  it('delegates trust-boundary to foldProfile (predecessor wins over blob account_id)', async () => {
    mockKvGetAgent.mockResolvedValue(
      profileEntry('alice.near', {
        account_id: 'imposter.near',
        name: 'Alice',
        tags: ['ai'],
      }),
    );

    const result = await fetchProfile('alice.near');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('account_id', 'alice.near');
    expect(result).toHaveProperty('name', 'Alice');
  });

  it('populates both created_at and created_height from the first-write entry', async () => {
    // Step 3 of the wall clock → block height transition: fetchProfile
    // fans out to the latest entry (for last_active / last_active_height)
    // and the first-write entry (for created_at / created_height). Both
    // block-derived fields ship together on every single-profile read.
    // The first-write block_timestamp and block_height are deliberately
    // distinct from the latest entry's values — the assertion catches
    // any regression that crosses them.
    mockKvGetAgent.mockResolvedValue(
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', name: 'Alice' },
        1_700_005_000_000_000_000,
        200,
      ),
    );
    mockKvGetAgentFirstWrite.mockResolvedValue(
      profileEntry(
        'alice.near',
        { account_id: 'alice.near', name: 'Alice' },
        1_700_000_000_000_000_000,
        100,
      ),
    );

    const result = await fetchProfile('alice.near');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('last_active', 1_700_005_000);
    expect(result).toHaveProperty('last_active_height', 200);
    expect(result).toHaveProperty('created_at', 1_700_000_000);
    expect(result).toHaveProperty('created_height', 100);
  });

  it('leaves created fields absent when history fetch returns null', async () => {
    // If the first-write entry is missing (history call failed, or the
    // agent's first write hasn't been indexed yet), both created fields
    // stay genuinely absent from the returned Agent — `foldProfile`
    // destructured them out and fetchProfile does not re-assign when
    // firstWrite is null. We never fall back to the latest entry's block
    // values, because that would conflate "when was this written" with
    // "when was this first written" and re-introduce a manipulation gap.
    mockKvGetAgent.mockResolvedValue(
      profileEntry('alice.near', { account_id: 'alice.near', name: 'Alice' }),
    );
    mockKvGetAgentFirstWrite.mockResolvedValue(null);

    const result = await fetchProfile('alice.near');
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('created_at');
    expect(result).not.toHaveProperty('created_height');
  });

  it('returns null when the latest entry is null (wrapper guard, before foldProfile)', async () => {
    mockKvGetAgent.mockResolvedValue(null);
    expect(await fetchProfile('alice.near')).toBeNull();
  });
});

describe('fetchProfiles', () => {
  // Delegation pin: forged account_ids in stored blobs must not leak through
  // the batch wrapper. Full trust-boundary coverage lives in SDK graph.test.
  it('delegates per-entry trust-boundary to foldProfile on each batch row', async () => {
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
  // Delegation pin: per-entry trust-boundary must fire across the full scan.
  it('delegates trust-boundary to foldProfileList (predecessor wins on every row)', async () => {
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

  // foldProfileList's per-entry null-filter has no SDK test — this is its
  // sole coverage. If the wrapper ever stops routing through foldProfileList,
  // non-object entries would leak through as garbage agents.
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
