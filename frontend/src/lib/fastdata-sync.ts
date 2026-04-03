/**
 * FastData KV write path: sync agent state after mutations.
 *
 * Per-predecessor model: each agent writes their own keys under their NEAR
 * account. The predecessor_id IS the agent's identity — keys don't need
 * the handle embedded.
 *
 * Key schema:
 *   profile              → full AgentRecord
 *   name                 → handle string (account→handle lookup)
 *   handle/{handle}      → true (handle→account reverse index)
 *   sorted/followers     → {score: N}
 *   sorted/endorsements  → {score: N}
 *   sorted/newest        → {ts: created_at}
 *   sorted/active        → {ts: last_active}
 *   tag/{tag}            → {score: follower_count} (per-tag ranking)
 */

import type { Agent } from '@/types';
import { FASTDATA_NAMESPACE, OUTLAYER_API_URL } from './constants';
import { fetchWithTimeout } from './fetch';

/** Compute endorsement total from nested {ns: {val: count}} structure. */
function endorsementTotal(
  endorsements: Record<string, Record<string, number>>,
): number {
  let total = 0;
  for (const ns of Object.values(endorsements)) {
    for (const count of Object.values(ns)) {
      total += count;
    }
  }
  return total;
}

/** Build per-agent entries (mirrors wasm/src/fastdata.rs key structure). */
function agentEntries(agent: Agent): Record<string, unknown> {
  const entries: Record<string, unknown> = {
    profile: agent,
    name: agent.handle,
    [`handle/${agent.handle}`]: true,
    'sorted/followers': { score: agent.follower_count },
    'sorted/endorsements': { score: endorsementTotal(agent.endorsements) },
    'sorted/newest': { ts: agent.created_at },
    'sorted/active': { ts: agent.last_active },
  };
  for (const tag of agent.tags) {
    entries[`tag/${tag}`] = { score: agent.follower_count };
  }
  return entries;
}

/** Build null entries to remove an agent from FastData KV. */
function nullAgentEntries(handle: string): Record<string, unknown> {
  return {
    profile: null,
    name: null,
    [`handle/${handle}`]: null,
    'sorted/followers': null,
    'sorted/endorsements': null,
    'sorted/newest': null,
    'sorted/active': null,
  };
}

/**
 * Build FastData KV sync entries from a WASM mutation response.
 * Returns null if the action doesn't need syncing or lacks data.
 */
export function buildSyncEntries(
  action: string,
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (action) {
    case 'register':
    case 'update_me':
    case 'heartbeat': {
      const agent = data.agent as Agent | undefined;
      if (!agent?.handle) return null;
      return agentEntries(agent);
    }
    case 'deregister': {
      const handle = data.handle as string | undefined;
      if (!handle) return null;
      return nullAgentEntries(handle);
    }
    default:
      return null;
  }
}

/**
 * Fire-and-forget: submit __fastdata_kv via the agent's custody wallet.
 * Logs errors but never throws — OutLayer storage is the source of truth.
 */
export function syncToFastData(
  walletKey: string,
  entries: Record<string, unknown>,
): void {
  const url = `${OUTLAYER_API_URL}/wallet/v1/call`;
  fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${walletKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receiver_id: FASTDATA_NAMESPACE,
        method_name: '__fastdata_kv',
        args: entries,
        gas: '30000000000000',
        deposit: '0',
      }),
    },
    15_000,
  ).catch((err) => {
    console.error('[fastdata-sync] failed:', err);
  });
}
