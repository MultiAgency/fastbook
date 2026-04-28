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
} from '../constants';
import { fetchWithTimeout } from '../fetch';

const DEFAULT_TIMEOUT_MS = 10_000;

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

/**
 * Read a single key for a known agent. Direct GET — no scanning. Returns
 * the full KvEntry (including `block_timestamp`, `block_height`,
 * `predecessor_id`) so callers that apply trust-boundary overrides for
 * `last_active` or similar have the metadata available. Callers that only
 * care about the stored value destructure `.value` at the call site; the
 * common case (truthy existence checks) works without destructuring.
 */
export async function kvGetAgent(
  accountId: string,
  key: string,
): Promise<KvEntry | null> {
  const url = `${FASTDATA_URL}/v0/latest/${NAMESPACE}/${accountId}/${key}`;
  const res = await fetchWithTimeout(url, undefined, DEFAULT_TIMEOUT_MS);
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
  return entry;
}

/**
 * Read the FIRST historical write of a key for a known agent, via
 * FastData's `/v0/history` endpoint with `asc=true,limit=1`. The returned
 * entry's `block_timestamp` is the block-authoritative time of that
 * agent's first profile write (or follow, or whatever key is queried) —
 * suitable for populating `created_at` without trusting any value-side
 * field. Returns null if no history exists.
 */
export async function kvGetAgentFirstWrite(
  accountId: string,
  key: string,
): Promise<KvEntry | null> {
  const url = `${FASTDATA_URL}/v0/history/${NAMESPACE}/${accountId}/${key}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asc: true, limit: 1 }),
    },
    DEFAULT_TIMEOUT_MS,
  );
  if (!res.ok) return null;
  const data = (await res.json()) as KvListResponse;
  const entry = data.entries?.[0];
  return entry ?? null;
}

/**
 * Walk the namespace-wide history of a key in ascending order, returning
 * the FIRST write per predecessor. Used by `sort=newest` to derive each
 * agent's block-authoritative `created_at` in a single paginated call
 * instead of N per-agent fetches. Pagination follows `page_token` until
 * exhausted; first-occurrence dedupe means each predecessor appears once.
 *
 * Scale cap: `MAX_PAGES` × 200 entries per page = 10,000 entries max per
 * call. For sort=newest specifically, this means an agent whose FIRST
 * profile write is older than the most recent 10K writes namespace-wide
 * silently drops out of the returned map and ends up with
 * `created_at: undefined` — sinking to the bottom of sort=newest. Fine
 * at the current scale (~50 agents × ~10 writes ≈ 500 entries), but if
 * the network grows past ~1K active agents, revisit: either raise
 * MAX_PAGES, cache results keyed by the oldest block_height seen, or
 * write a separate `first_seen` key on first-write and read it directly.
 */
export async function kvHistoryFirstByPredecessor(
  key: string,
): Promise<Map<string, KvEntry>> {
  const url = `${FASTDATA_URL}/v0/history/${NAMESPACE}`;
  const firstByAgent = new Map<string, KvEntry>();
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body: Record<string, unknown> = { key, asc: true, limit: 200 };
    if (pageToken) body.page_token = pageToken;
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) break;
    const data = (await res.json()) as KvListResponse;
    for (const e of data.entries ?? []) {
      // `asc=true` means we walk from oldest forward — the first time we
      // see each predecessor is their first write. Skip if already seen.
      if (!firstByAgent.has(e.predecessor_id)) {
        firstByAgent.set(e.predecessor_id, e);
      }
    }
    if (!data.page_token) break;
    pageToken = data.page_token;
  }
  return firstByAgent;
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
      DEFAULT_TIMEOUT_MS,
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

/**
 * Batch lookup for multiple agent keys. Returns KvEntries aligned to input,
 * with missing or tombstoned keys represented as `null`. Callers that only
 * need the stored value destructure `.value`; callers that apply trust-
 * boundary overrides (e.g. `last_active` from `block_timestamp`) have the
 * metadata on hand.
 */
export async function kvMultiAgent(
  lookups: { accountId: string; key: string }[],
): Promise<(KvEntry | null)[]> {
  if (lookups.length === 0) return [];

  const results: (KvEntry | null)[] = new Array(lookups.length).fill(null);
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
      DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) continue;
    const data = (await res.json()) as { entries: (KvEntry | null)[] };
    for (let j = 0; j < (data.entries ?? []).length; j++) {
      const e = data.entries[j];
      results[i + j] =
        e && e.value !== null && e.value !== undefined && e.value !== ''
          ? e
          : null;
    }
  }
  return results;
}

const MAX_PAGES = 50;
