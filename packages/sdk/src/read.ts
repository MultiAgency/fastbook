import {
  DEFAULT_TIMEOUT_MS,
  FASTDATA_MAX_PAGES,
  FASTDATA_PAGE_SIZE,
} from './constants';
import { networkError, protocolError } from './errors';
import type { KvEntry, KvListResponse } from './types';

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface ReadTransport {
  fastdataUrl: string;
  namespace: string;
  fetch: FetchLike;
  timeoutMs: number;
}

export function createReadTransport(opts: {
  fastdataUrl: string;
  namespace: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): ReadTransport {
  return {
    fastdataUrl: opts.fastdataUrl,
    namespace: opts.namespace,
    fetch: opts.fetch ?? (globalThis.fetch as FetchLike),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function withTimeout(
  transport: ReadTransport,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), transport.timeoutMs);
  try {
    return await transport.fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }
}

function isLive(e: KvEntry): boolean {
  return e.value !== null && e.value !== undefined && e.value !== '';
}

/**
 * Read a single key for a known agent. Returns the raw KvEntry, or null if
 * the key is missing or tombstoned. Domain interpretation belongs in graph.ts.
 */
export async function kvGetKey(
  transport: ReadTransport,
  accountId: string,
  key: string,
): Promise<KvEntry | null> {
  const url = `${transport.fastdataUrl}/v0/latest/${transport.namespace}/${accountId}/${key}`;
  const res = await withTimeout(transport, url);
  if (res.status === 404) return null;
  if (!res.ok) throw protocolError(`kvGetKey ${res.status}`);
  let data: KvListResponse;
  try {
    data = (await res.json()) as KvListResponse;
  } catch {
    throw protocolError('kvGetKey: malformed JSON');
  }
  const entry = data.entries?.[0];
  return entry && isLive(entry) ? entry : null;
}

/**
 * Generic paginated POST against FastData KV, yielding live entries lazily.
 * Stops when page_token is absent or the optional caller limit is reached.
 */
export async function* kvPaginate(
  transport: ReadTransport,
  url: string,
  baseBody: Record<string, unknown>,
  limit?: number,
): AsyncIterable<KvEntry> {
  let pageToken: string | undefined;
  let yielded = 0;
  for (let i = 0; i < FASTDATA_MAX_PAGES; i++) {
    const body = pageToken ? { ...baseBody, page_token: pageToken } : baseBody;
    const res = await withTimeout(transport, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw protocolError(`kvPaginate ${res.status}`);
    let data: KvListResponse;
    try {
      data = (await res.json()) as KvListResponse;
    } catch {
      throw protocolError('kvPaginate: malformed JSON');
    }
    for (const e of data.entries ?? []) {
      if (!isLive(e)) continue;
      yield e;
      yielded++;
      if (limit !== undefined && yielded >= limit) return;
    }
    if (!data.page_token) return;
    pageToken = data.page_token;
  }
}

/**
 * Prefix scan for a known agent's keys. Yields entries lazily.
 */
export function kvListAgent(
  transport: ReadTransport,
  accountId: string,
  prefix: string,
  limit?: number,
): AsyncIterable<KvEntry> {
  const url = `${transport.fastdataUrl}/v0/latest/${transport.namespace}/${accountId}`;
  const body: Record<string, unknown> = {
    key_prefix: prefix,
    limit: limit ?? FASTDATA_PAGE_SIZE,
  };
  return kvPaginate(transport, url, body, limit);
}
