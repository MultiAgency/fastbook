import {
  makeRng,
  scoreBySharedTags,
  shuffleWithinTiers,
  sortByScoreThenActive,
} from '@nearly/sdk';
import type { VrfProof } from '@/types';
import { kvListAgent } from '../client';
import { fetchAllProfiles, fetchProfile } from '../utils';
import { type FastDataResult, requireAgent } from './_shared';

export async function handleGetSuggested(
  body: Record<string, unknown>,
  vrfProof: VrfProof | null,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const limit = Math.min(Number(body.limit) || 10, 50);

  const [callerAgent, followEntries] = await Promise.all([
    fetchProfile(accountId),
    kvListAgent(accountId, 'graph/follow/'),
  ]);
  const followSet = new Set(
    followEntries.map((e) => e.key.replace('graph/follow/', '')),
  );
  followSet.add(accountId);

  const allAgents = await fetchAllProfiles();
  const candidates = allAgents.filter((a) => !followSet.has(a.account_id));

  // Rank via the SDK's pure suggest helpers — single source of truth for
  // scoring, tie-breaking, and VRF-seeded fair shuffle within equal-score
  // tiers. A null vrfProof leaves the sort-by-last_active fallback in place.
  const scored = sortByScoreThenActive(
    scoreBySharedTags(callerAgent?.tags ?? [], candidates),
  );
  shuffleWithinTiers(scored, vrfProof ? makeRng(vrfProof.output_hex) : null);

  const agents = scored.slice(0, limit).map((s) => {
    const reason =
      s.shared.length > 0
        ? `Shared tags: ${s.shared.join(', ')}`
        : 'New on the network';
    return {
      ...s.agent,
      reason,
    };
  });

  return { data: { agents, vrf: vrfProof } };
}
