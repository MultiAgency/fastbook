/**
 * @jest-environment node
 */

import type { KvEntry } from '@/lib/fastdata/client';
import {
  kvGetAgent,
  kvGetAll,
  kvListAgent,
  kvListAll,
  kvMultiAgent,
} from '@/lib/fastdata/client';

const mockFetch = jest.fn();
jest.mock('@/lib/fetch', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetch(...args),
}));

function entry(predecessorId: string, key: string, value: unknown): KvEntry {
  return {
    predecessor_id: predecessorId,
    current_account_id: 'contextual.near',
    block_height: 100,
    block_timestamp: 1700000000,
    key,
    value,
  };
}

function jsonResponse(data: unknown) {
  return { ok: true, json: () => Promise.resolve(data) };
}

beforeEach(() => {
  jest.resetAllMocks();
});

// ---------------------------------------------------------------------------
// kvGetAgent
// ---------------------------------------------------------------------------

describe('kvGetAgent', () => {
  it('returns full KvEntry for existing key', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        entries: [entry('alice.near', 'profile', { name: 'Alice' })],
      }),
    );

    const result = await kvGetAgent('alice.near', 'profile');
    expect(result?.value).toEqual({ name: 'Alice' });
    expect(result?.predecessor_id).toBe('alice.near');
    expect(result?.block_timestamp).toBeDefined();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/alice.near/profile'),
      undefined,
      10_000,
    );
  });

  it('returns null when response is not ok', async () => {
    mockFetch.mockResolvedValue({ ok: false });

    expect(await kvGetAgent('alice.near', 'profile')).toBeNull();
  });

  it('returns null when entries array is empty', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ entries: [] }));

    expect(await kvGetAgent('alice.near', 'profile')).toBeNull();
  });

  it('returns null for soft-deleted entry (value is null)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ entries: [entry('alice.near', 'profile', null)] }),
    );

    expect(await kvGetAgent('alice.near', 'profile')).toBeNull();
  });

  it('returns null for soft-deleted entry (value is empty string)', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ entries: [entry('alice.near', 'profile', '')] }),
    );

    expect(await kvGetAgent('alice.near', 'profile')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// kvGetAll
// ---------------------------------------------------------------------------

describe('kvGetAll', () => {
  it('returns entries across all agents', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        entries: [
          entry('alice.near', 'profile', { name: 'Alice' }),
          entry('bob.near', 'profile', { name: 'Bob' }),
        ],
      }),
    );

    const results = await kvGetAll('profile');
    expect(results).toHaveLength(2);
    expect(results[0].predecessor_id).toBe('alice.near');
    expect(results[1].predecessor_id).toBe('bob.near');
  });

  it('filters out soft-deleted entries', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        entries: [
          entry('alice.near', 'profile', { name: 'Alice' }),
          entry('bob.near', 'profile', null),
          entry('carol.near', 'profile', ''),
        ],
      }),
    );

    const results = await kvGetAll('profile');
    expect(results).toHaveLength(1);
    expect(results[0].predecessor_id).toBe('alice.near');
  });

  it('paginates when page_token is present', async () => {
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [entry('alice.near', 'profile', { name: 'Alice' })],
          page_token: 'page2',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [entry('bob.near', 'profile', { name: 'Bob' })],
        }),
      );

    const results = await kvGetAll('profile');
    expect(results).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Second call should include page_token
    const secondBody = JSON.parse(
      (mockFetch.mock.calls[1][1] as { body: string }).body,
    );
    expect(secondBody.page_token).toBe('page2');
  });

  it('returns empty array on fetch failure', async () => {
    mockFetch.mockResolvedValue({ ok: false });

    const results = await kvGetAll('profile');
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// kvListAgent
// ---------------------------------------------------------------------------

describe('kvListAgent', () => {
  it('scans keys by prefix for a single agent', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        entries: [
          entry('alice.near', 'graph/follow/bob', { at: 1000 }),
          entry('alice.near', 'graph/follow/carol', { at: 1001 }),
        ],
      }),
    );

    const results = await kvListAgent('alice.near', 'graph/follow/');
    expect(results).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/alice.near'),
      expect.objectContaining({
        body: expect.stringContaining('graph/follow/'),
      }),
      10_000,
    );
  });

  it('respects limit parameter', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        entries: [
          entry('alice.near', 'graph/follow/bob', { at: 1000 }),
          entry('alice.near', 'graph/follow/carol', { at: 1001 }),
          entry('alice.near', 'graph/follow/dave', { at: 1002 }),
        ],
      }),
    );

    const results = await kvListAgent('alice.near', 'graph/follow/', 2);
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// kvListAll
// ---------------------------------------------------------------------------

describe('kvListAll', () => {
  it('scans keys by prefix across all agents', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        entries: [
          entry('alice.near', 'tag/ai', true),
          entry('bob.near', 'tag/defi', true),
        ],
      }),
    );

    const results = await kvListAll('tag/');
    expect(results).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// kvMultiAgent
// ---------------------------------------------------------------------------

describe('kvMultiAgent', () => {
  it('batch-fetches multiple agent keys', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        entries: [
          entry('alice.near', 'profile', { name: 'Alice' }),
          entry('bob.near', 'profile', { name: 'Bob' }),
        ],
      }),
    );

    const results = await kvMultiAgent([
      { accountId: 'alice.near', key: 'profile' },
      { accountId: 'bob.near', key: 'profile' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.value).toEqual({ name: 'Alice' });
    expect(results[0]?.predecessor_id).toBe('alice.near');
    expect(results[1]?.value).toEqual({ name: 'Bob' });
    expect(results[1]?.predecessor_id).toBe('bob.near');
  });

  it('returns null for soft-deleted entries in batch', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        entries: [
          entry('alice.near', 'profile', { name: 'Alice' }),
          entry('bob.near', 'profile', null),
        ],
      }),
    );

    const results = await kvMultiAgent([
      { accountId: 'alice.near', key: 'profile' },
      { accountId: 'bob.near', key: 'profile' },
    ]);
    expect(results[0]?.value).toEqual({ name: 'Alice' });
    expect(results[1]).toBeNull();
  });

  it('returns null for missing entries in batch', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        entries: [entry('alice.near', 'profile', { name: 'Alice' }), null],
      }),
    );

    const results = await kvMultiAgent([
      { accountId: 'alice.near', key: 'profile' },
      { accountId: 'bob.near', key: 'profile' },
    ]);
    expect(results[0]?.value).toEqual({ name: 'Alice' });
    expect(results[1]).toBeNull();
  });

  it('returns empty array for empty input', async () => {
    const results = await kvMultiAgent([]);
    expect(results).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('continues on fetch failure for a chunk', async () => {
    mockFetch.mockResolvedValue({ ok: false });

    const results = await kvMultiAgent([
      { accountId: 'alice.near', key: 'profile' },
    ]);
    // All null because fetch failed
    expect(results).toEqual([null]);
  });

  it('constructs correct key paths', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ entries: [] }));

    await kvMultiAgent([
      { accountId: 'alice.near', key: 'profile' },
      { accountId: 'bob.near', key: 'graph/follow/carol' },
    ]);

    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as { body: string }).body,
    );
    expect(body.keys).toEqual([
      'contextual.near/alice.near/profile',
      'contextual.near/bob.near/graph/follow/carol',
    ]);
  });
});
