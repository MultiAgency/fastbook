import type { FetchLike } from '../src/read';
import { createReadTransport, kvGetKey, kvListAgent } from '../src/read';
import type { KvEntry } from '../src/types';
import { entry } from './fixtures/entries';

interface Call {
  url: string;
  init?: RequestInit;
}

function mockFetch(responses: Response[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const res = responses[i++];
    if (!res) throw new Error(`unexpected fetch call #${i}`);
    return res;
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mkEntry(key: string, value: unknown, pred = 'alice.near'): KvEntry {
  return entry({ predecessor_id: pred, key, value });
}

describe('read.kvGetKey', () => {
  it('returns the first entry value when present', async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({ entries: [mkEntry('profile', { name: 'Alice' })] }),
    ]);
    const t = createReadTransport({
      fastdataUrl: 'https://kv.example',
      namespace: 'ns.near',
      fetch,
    });
    const result = await kvGetKey(t, 'alice.near', 'profile');
    expect(result?.value).toEqual({ name: 'Alice' });
    expect(calls[0]?.url).toBe(
      'https://kv.example/v0/latest/ns.near/alice.near/profile',
    );
  });

  it('returns null on 404', async () => {
    const { fetch } = mockFetch([new Response(null, { status: 404 })]);
    const t = createReadTransport({
      fastdataUrl: 'https://kv.example',
      namespace: 'ns.near',
      fetch,
    });
    expect(await kvGetKey(t, 'ghost.near', 'profile')).toBeNull();
  });

  it('drops tombstoned (empty-string value) entries', async () => {
    const { fetch } = mockFetch([
      jsonResponse({ entries: [mkEntry('profile', '')] }),
    ]);
    const t = createReadTransport({
      fastdataUrl: 'https://kv.example',
      namespace: 'ns.near',
      fetch,
    });
    expect(await kvGetKey(t, 'alice.near', 'profile')).toBeNull();
  });

  it('throws PROTOCOL on non-404 HTTP errors', async () => {
    const { fetch } = mockFetch([new Response(null, { status: 500 })]);
    const t = createReadTransport({
      fastdataUrl: 'https://kv.example',
      namespace: 'ns.near',
      fetch,
    });
    await expect(kvGetKey(t, 'alice.near', 'profile')).rejects.toMatchObject({
      code: 'PROTOCOL',
    });
  });
});

describe('read.kvListAgent', () => {
  it('yields across paginated responses and stops on missing page_token', async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({
        entries: [mkEntry('graph/follow/bob.near', { at: 1 })],
        page_token: 'tok1',
      }),
      jsonResponse({
        entries: [mkEntry('graph/follow/carol.near', { at: 2 })],
      }),
    ]);
    const t = createReadTransport({
      fastdataUrl: 'https://kv.example',
      namespace: 'ns.near',
      fetch,
    });
    const keys: string[] = [];
    for await (const e of kvListAgent(t, 'alice.near', 'graph/follow/')) {
      keys.push(e.key);
    }
    expect(keys).toEqual(['graph/follow/bob.near', 'graph/follow/carol.near']);
    expect(calls).toHaveLength(2);
    const body1 = JSON.parse(calls[1]!.init!.body as string);
    expect(body1.page_token).toBe('tok1');
    expect(body1.key_prefix).toBe('graph/follow/');
  });

  it('honors a caller limit across pages', async () => {
    const { fetch, calls } = mockFetch([
      jsonResponse({
        entries: [
          mkEntry('graph/follow/a.near', { at: 1 }),
          mkEntry('graph/follow/b.near', { at: 2 }),
        ],
        page_token: 'tok1',
      }),
    ]);
    const t = createReadTransport({
      fastdataUrl: 'https://kv.example',
      namespace: 'ns.near',
      fetch,
    });
    const collected: KvEntry[] = [];
    for await (const e of kvListAgent(t, 'alice.near', 'graph/follow/', 1)) {
      collected.push(e);
    }
    expect(collected).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('filters tombstoned entries', async () => {
    const { fetch } = mockFetch([
      jsonResponse({
        entries: [
          mkEntry('graph/follow/bob.near', ''),
          mkEntry('graph/follow/carol.near', { at: 1 }),
        ],
      }),
    ]);
    const t = createReadTransport({
      fastdataUrl: 'https://kv.example',
      namespace: 'ns.near',
      fetch,
    });
    const keys: string[] = [];
    for await (const e of kvListAgent(t, 'alice.near', 'graph/follow/')) {
      keys.push(e.key);
    }
    expect(keys).toEqual(['graph/follow/carol.near']);
  });
});
