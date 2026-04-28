import type { Agent } from '@/types';
import { kvGetAll, kvListAgent } from '../client';
import { fetchProfiles } from '../utils';
import { type FastDataResult, requireAgent } from './_shared';

export async function handleGetEdges(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 25, 100);
  const direction = (body.direction as string) || 'both';

  const wantIncoming = direction === 'incoming' || direction === 'both';
  const wantOutgoing = direction === 'outgoing' || direction === 'both';

  const [incomingEntries, outgoingEntries] = await Promise.all([
    wantIncoming ? kvGetAll(`graph/follow/${accountId}`) : Promise.resolve([]),
    wantOutgoing
      ? kvListAgent(accountId, 'graph/follow/')
      : Promise.resolve([]),
  ]);

  // Collect all account IDs needed, dedupe, single batch fetch.
  const incomingAccountIds = incomingEntries.map((e) => e.predecessor_id);
  const outgoingAccountIds = outgoingEntries.map((e) =>
    e.key.replace('graph/follow/', ''),
  );
  const allAccountIds = [
    ...new Set([...incomingAccountIds, ...outgoingAccountIds]),
  ];
  // Edges are identity views — no count overlay.
  const profileMap = new Map<string, Agent>();
  for (const a of await fetchProfiles(allAccountIds)) {
    profileMap.set(a.account_id, a);
  }

  const edges: Record<string, unknown>[] = [];
  const incomingByAccountId = new Map<string, Record<string, unknown>>();

  for (const id of incomingAccountIds) {
    const a = profileMap.get(id);
    if (!a) continue;
    const edge = { ...a, direction: 'incoming' };
    incomingByAccountId.set(a.account_id, edge);
    edges.push(edge);
  }

  for (const id of outgoingAccountIds) {
    const a = profileMap.get(id);
    if (!a) continue;
    const existing = incomingByAccountId.get(a.account_id);
    if (existing) {
      existing.direction = 'mutual';
    } else {
      edges.push({ ...a, direction: 'outgoing' });
    }
  }

  return {
    data: {
      account_id: accountId,
      edges: edges.slice(0, limit),
    },
  };
}
