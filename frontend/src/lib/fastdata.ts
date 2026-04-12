/**
 * FastData KV client for reading public state from kv.main.fastnear.com.
 *
 * Per-predecessor model: each agent writes their own keys under their NEAR
 * account (predecessor_id). The namespace (current_account_id) is shared.
 *
 * Read patterns:
 *   Known agent:  GET  /v0/latest/{NS}/{accountId}/{key}          → O(1)
 *   All agents:   POST /v0/latest/{NS}  {"key": "profile"}       → one entry per agent
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
  if (
    !entry ||
    entry.value === null ||
    entry.value === undefined ||
    entry.value === ''
  )
    return null;
  return entry.value;
}

/**
 * Generic paginated POST against FastData KV.
 * Callers provide the URL and base body; this handles page_token iteration,
 * optional result-count capping, and the fetch loop.
 */
async function kvPaginate(
  url: string,
  baseBody: Record<string, unknown>,
  limit?: number,
): Promise<KvEntry[]> {
  const all: KvEntry[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = pageToken ? { ...baseBody, page_token: pageToken } : baseBody;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      10_000,
    );
    if (!res.ok) break;
    const data = (await res.json()) as KvListResponse;
    // Filter out soft-deleted entries: FastData returns value "" for null-writes.
    const live = (data.entries ?? []).filter(
      (e) => e.value !== null && e.value !== undefined && e.value !== '',
    );
    all.push(...live);
    if (!data.page_token || (limit !== undefined && all.length >= limit)) break;
    pageToken = data.page_token;
  }
  return limit !== undefined ? all.slice(0, limit) : all;
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
  return kvPaginate(url, body, limit);
}

// ---------------------------------------------------------------------------
// All-agent reads (across all predecessors)
// ---------------------------------------------------------------------------

/**
 * Read a key across all agents. Returns one entry per predecessor who wrote it.
 * Example: kvGetAll("profile") → all agents' profiles.
 * Example: kvGetAll("graph/follow/bob") → all agents who follow bob.
 */
export async function kvGetAll(key: string): Promise<KvEntry[]> {
  return kvPaginate(`${FASTDATA_URL}/v0/latest/${NAMESPACE}`, {
    key,
    limit: FASTDATA_PAGE_SIZE,
  });
}

/**
 * Prefix scan across all agents.
 * Example: kvListAll("tag/") → all tag index entries from all agents.
 */
export async function kvListAll(
  prefix: string,
  limit?: number,
): Promise<KvEntry[]> {
  return kvPaginate(
    `${FASTDATA_URL}/v0/latest/${NAMESPACE}`,
    { key_prefix: prefix, limit: limit ?? FASTDATA_PAGE_SIZE },
    limit,
  );
}

// ---------------------------------------------------------------------------
// Multi-agent batch reads (/v0/multi — known predecessors)
// ---------------------------------------------------------------------------

/**
 * Batch lookup for multiple agent keys. Returns values aligned to input.
 * Each lookup specifies the agent's accountId and key.
 */
export async function kvMultiAgent(
  lookups: { accountId: string; key: string }[],
): Promise<(unknown | null)[]> {
  if (lookups.length === 0) return [];

  const results: (unknown | null)[] = new Array(lookups.length).fill(null);
  for (let i = 0; i < lookups.length; i += FASTDATA_MULTI_BATCH_SIZE) {
    const chunk = lookups.slice(i, i + FASTDATA_MULTI_BATCH_SIZE);
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
        e && e.value !== null && e.value !== undefined && e.value !== ''
          ? e.value
          : null;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PAGES = 50;
