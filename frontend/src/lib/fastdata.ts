/**
 * FastData KV client for reading public state from kv.main.fastnear.com.
 *
 * Write path: OutLayer WASM → __fastdata_kv → FastNear indexes it.
 * Read path: this module → GET/POST kv.main.fastnear.com → free reads.
 */

import {
  FASTDATA_MULTI_BATCH_SIZE,
  FASTDATA_PAGE_SIZE,
  FASTDATA_KV_URL as FASTDATA_URL,
  FASTDATA_NAMESPACE as NAMESPACE,
  FASTDATA_SIGNER as SIGNER,
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

/**
 * Read a single key. Returns the parsed value, or null if not found / value is null.
 *
 * Null contract: missing key, JSON null value, and HTTP 404 all return null.
 * Callers should check `=== null` uniformly.
 */
export async function kvGet(key: string): Promise<unknown | null> {
  const url = `${FASTDATA_URL}/v0/latest/${NAMESPACE}/${SIGNER}/${key}`;
  const res = await fetchWithTimeout(url, undefined, 10_000);
  if (!res.ok) {
    console.warn(
      `[fastdata] kvGet ${res.status}: ${await res.text().catch(() => '')}`,
    );
    return null;
  }
  const data = (await res.json()) as KvListResponse;
  const entry = data.entries?.[0];
  if (!entry || entry.value === null || entry.value === undefined) return null;
  return entry.value;
}

const PAGE_SIZE = FASTDATA_PAGE_SIZE;
/** Safety cap: stop after this many pages to prevent runaway loops. */
const MAX_PAGES = 50;

/**
 * Prefix scan. Auto-paginates via `page_token` to return all matching entries.
 * Pass `limit` to fetch only that many entries (single page, no auto-pagination).
 */
export async function kvList(
  prefix: string,
  limit?: number,
): Promise<KvEntry[]> {
  if (limit !== undefined) {
    const result = await kvPage(prefix, limit);
    return result.entries;
  }
  const all: KvEntry[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const result = await kvPage(prefix, PAGE_SIZE, pageToken);
    all.push(...result.entries);
    if (!result.pageToken) break;
    pageToken = result.pageToken;
  }
  return all;
}

/** Single-page fetch (internal). */
async function kvPage(
  prefix: string,
  limit: number,
  pageToken?: string,
): Promise<{ entries: KvEntry[]; pageToken?: string }> {
  const url = `${FASTDATA_URL}/v0/latest/${NAMESPACE}/${SIGNER}`;
  const body: Record<string, unknown> = { key_prefix: prefix, limit };
  if (pageToken) body.page_token = pageToken;

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    10_000,
  );
  if (!res.ok) {
    console.warn(
      `[fastdata] kvList ${res.status}: ${await res.text().catch(() => '')}`,
    );
    return { entries: [] };
  }
  const data = (await res.json()) as KvListResponse;
  return {
    entries: data.entries ?? [],
    pageToken: data.page_token,
  };
}

/**
 * Batch lookup for multiple keys (max 100). Returns values aligned to input keys.
 * Missing entries return null.
 */
const MULTI_BATCH_SIZE = FASTDATA_MULTI_BATCH_SIZE;

export async function kvMulti(keys: string[]): Promise<(unknown | null)[]> {
  if (keys.length === 0) return [];
  if (keys.length <= MULTI_BATCH_SIZE) return kvMultiBatch(keys);

  // Chunk into batches of 100 and merge results in order.
  const results: (unknown | null)[] = [];
  for (let i = 0; i < keys.length; i += MULTI_BATCH_SIZE) {
    const chunk = keys.slice(i, i + MULTI_BATCH_SIZE);
    const batch = await kvMultiBatch(chunk);
    results.push(...batch);
  }
  return results;
}

async function kvMultiBatch(keys: string[]): Promise<(unknown | null)[]> {
  const url = `${FASTDATA_URL}/v0/multi`;
  const fullKeys = keys.map((k) => `${NAMESPACE}/${SIGNER}/${k}`);
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: fullKeys }),
    },
    10_000,
  );
  if (!res.ok) {
    console.warn(
      `[fastdata] kvMulti ${res.status}: ${await res.text().catch(() => '')}`,
    );
    return keys.map(() => null);
  }
  const data = (await res.json()) as { entries: (KvEntry | null)[] };
  return (data.entries ?? []).map((e) => {
    if (!e || e.value === null || e.value === undefined) return null;
    return e.value;
  });
}
