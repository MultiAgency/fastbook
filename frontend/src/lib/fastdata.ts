/**
 * FastData KV client for reading public state from kv.main.fastnear.com.
 *
 * Per-predecessor model: each agent writes their own keys under their NEAR
 * account (predecessor_id). The namespace (current_account_id) is shared.
 *
 * Read patterns:
 *   Known agent:  GET  /v0/latest/{NS}/{accountId}/{key}          → O(1)
 *   All agents:   POST /v0/latest/{NS}  {"key": "sorted/..."}    → one entry per agent
 *   Agent's keys: POST /v0/latest/{NS}/{accountId}  {"key_prefix":"graph/follow/"}
 *   Multi-agent:  POST /v0/multi  ["NS/acct1/profile", "NS/acct2/profile"]
 */

import {
  FASTDATA_MULTI_BATCH_SIZE,
  FASTDATA_PAGE_SIZE,
  FASTDATA_KV_URL as FASTDATA_URL,
  FASTDATA_NAMESPACE as NAMESPACE,
} from './constants';
import { fetchWithTimeout } from './fetch';

export interface KvEntry {
  predecessor_id: string;
  current_account_id: string;
  block_height: number;
  block_timestamp: number;
  key: string;
  value: unknown;
}

interface KvListResponse {
  entries: KvEntry[];
  page_token?: string;
}

// ---------------------------------------------------------------------------
// Single-agent reads (known predecessor — fast, O(1))
// ---------------------------------------------------------------------------

/**
 * Read a single key for a known agent. Direct GET — no scanning.
 */
export async function kvGetAgent(
  accountId: string,
  key: string,
): Promise<unknown | null> {
  const url = `${FASTDATA_URL}/v0/latest/${NAMESPACE}/${accountId}/${key}`;
  const res = await fetchWithTimeout(url, undefined, 10_000);
  if (!res.ok) return null;
  const data = (await res.json()) as KvListResponse;
  const entry = data.entries?.[0];
  if (!entry || entry.value === null || entry.value === undefined) return null;
  return entry.value;
}

/**
 * Prefix scan for a known agent's keys.
 * Example: kvListAgent("abc.near", "graph/follow/") → all of abc's follows.
 */
export async function kvListAgent(
  accountId: string,
  prefix: string,
  limit?: number,
): Promise<KvEntry[]> {
  const url = `${FASTDATA_URL}/v0/latest/${NAMESPACE}/${accountId}`;
  const body: Record<string, unknown> = { key_prefix: prefix };
  if (limit !== undefined) body.limit = limit;

  const all: KvEntry[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const pageBody = pageToken ? { ...body, page_token: pageToken } : body;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pageBody),
      },
      10_000,
    );
    if (!res.ok) break;
    const data = (await res.json()) as KvListResponse;
    all.push(...(data.entries ?? []));
    if (!data.page_token || (limit !== undefined && all.length >= limit)) break;
    pageToken = data.page_token;
  }
  return limit !== undefined ? all.slice(0, limit) : all;
}

// ---------------------------------------------------------------------------
// All-agent reads (across all predecessors)
// ---------------------------------------------------------------------------

/**
 * Read a key across all agents. Returns one entry per predecessor who wrote it.
 * Example: kvGetAll("sorted/followers") → all agents' follower scores.
 * Example: kvGetAll("graph/follow/bob") → all agents who follow bob.
 */
export async function kvGetAll(key: string): Promise<KvEntry[]> {
  const all: KvEntry[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body: Record<string, unknown> = { key, limit: PAGE_SIZE };
    if (pageToken) body.page_token = pageToken;
    const res = await fetchWithTimeout(
      `${FASTDATA_URL}/v0/latest/${NAMESPACE}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      10_000,
    );
    if (!res.ok) break;
    const data = (await res.json()) as KvListResponse;
    all.push(...(data.entries ?? []));
    if (!data.page_token) break;
    pageToken = data.page_token;
  }
  return all;
}

/**
 * Prefix scan across all agents.
 * Example: kvListAll("sorted/") → all sorted index entries from all agents.
 */
export async function kvListAll(
  prefix: string,
  limit?: number,
): Promise<KvEntry[]> {
  const all: KvEntry[] = [];
  let pageToken: string | undefined;
  const pageLimit = limit ?? PAGE_SIZE;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body: Record<string, unknown> = {
      key_prefix: prefix,
      limit: pageLimit,
    };
    if (pageToken) body.page_token = pageToken;
    const res = await fetchWithTimeout(
      `${FASTDATA_URL}/v0/latest/${NAMESPACE}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      10_000,
    );
    if (!res.ok) break;
    const data = (await res.json()) as KvListResponse;
    all.push(...(data.entries ?? []));
    if (!data.page_token || (limit !== undefined && all.length >= limit)) break;
    pageToken = data.page_token;
  }
  return limit !== undefined ? all.slice(0, limit) : all;
}

// ---------------------------------------------------------------------------
// Multi-agent batch reads (/v0/multi — known predecessors)
// ---------------------------------------------------------------------------

const MULTI_BATCH_SIZE = FASTDATA_MULTI_BATCH_SIZE;

/**
 * Batch lookup for multiple agent keys. Returns values aligned to input.
 * Each lookup specifies the agent's accountId and key.
 */
export async function kvMultiAgent(
  lookups: { accountId: string; key: string }[],
): Promise<(unknown | null)[]> {
  if (lookups.length === 0) return [];

  const results: (unknown | null)[] = new Array(lookups.length).fill(null);
  for (let i = 0; i < lookups.length; i += MULTI_BATCH_SIZE) {
    const chunk = lookups.slice(i, i + MULTI_BATCH_SIZE);
    const keys = chunk.map((l) => `${NAMESPACE}/${l.accountId}/${l.key}`);
    const res = await fetchWithTimeout(
      `${FASTDATA_URL}/v0/multi`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      },
      10_000,
    );
    if (!res.ok) continue;
    const data = (await res.json()) as { entries: (KvEntry | null)[] };
    for (let j = 0; j < (data.entries ?? []).length; j++) {
      const e = data.entries[j];
      results[i + j] =
        e && e.value !== null && e.value !== undefined ? e.value : null;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Handle resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a handle to the agent's account ID via the handle/ index.
 * Returns the predecessor_id (NEAR account) or null if not found.
 */
export async function resolveHandle(handle: string): Promise<string | null> {
  const entries = await kvGetAll(`handle/${handle}`);
  if (entries.length === 0) return null;
  // The predecessor who wrote this key is the agent's account.
  return entries[0].predecessor_id;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = FASTDATA_PAGE_SIZE;
const MAX_PAGES = 50;
