import type { Agent } from './types';

/**
 * One scored candidate: the underlying agent, the shared tags with the
 * caller, and the integer tier key used for VRF shuffle grouping.
 */
export interface ScoredCandidate {
  agent: Agent;
  shared: string[];
  score: number;
}

/**
 * Deterministic xorshift32 PRNG seeded from the first 4 bytes of a hex
 * string. Ported verbatim from the frontend's discover-agents handler
 * (now `frontend/src/lib/fastdata/reads/discover_agents.ts`)'s `makeRng`.
 * Shift constants (13, 17, 5) are Marsaglia's standard
 * xorshift32 triple; re-deriving them here keeps the SDK's shuffle order
 * byte-identical to the frontend's for the same VRF output.
 */
export function makeRng(outputHex: string): { pick(n: number): number | null } {
  let state = 0;
  for (let i = 0; i < Math.min(outputHex.length, 8); i += 2) {
    state ^= Number.parseInt(outputHex.slice(i, i + 2), 16) << ((i / 2) * 8);
  }
  if (state === 0) state = 1;
  state = state >>> 0;

  return {
    pick(n: number): number | null {
      if (n === 0) return null;
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state = state >>> 0;
      return state % n;
    },
  };
}

/**
 * Score candidates by shared-tag count with the caller. Pure. Mirrors the
 * scoring step in the frontend's `handleGetSuggested`. Within a score tier
 * the return order is the caller's input order — callers who want stable
 * fallback ordering sort `candidates` by `last_active` descending before
 * calling.
 */
export function scoreBySharedTags(
  callerTags: Iterable<string>,
  candidates: readonly Agent[],
): ScoredCandidate[] {
  const tagSet = new Set(callerTags);
  return candidates.map((agent) => {
    const shared = (agent.tags ?? []).filter((t) => tagSet.has(t));
    return { agent, shared, score: shared.length };
  });
}

/**
 * Sort scored candidates by score descending, with `last_active`
 * descending as a deterministic tiebreak. Matches the frontend's sort
 * step — callers who want VRF-shuffled within-tier fairness pass the
 * result to `shuffleWithinTiers`.
 */
export function sortByScoreThenActive(
  scored: ScoredCandidate[],
): ScoredCandidate[] {
  return scored.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.agent.last_active ?? 0) - (a.agent.last_active ?? 0);
  });
}

/**
 * In-place Fisher-Yates shuffle within equal-score tiers using the VRF
 * seeded PRNG. Mutates the input for symmetry with the frontend's
 * implementation — callers who want a fresh array should clone first.
 * When `rng` is null (VRF seed unavailable), the sorted tiers are left
 * untouched so callers still get a deterministic ranking without
 * shuffle.
 */
export function shuffleWithinTiers(
  scored: ScoredCandidate[],
  rng: { pick(n: number): number | null } | null,
): ScoredCandidate[] {
  if (!rng) return scored;
  let i = 0;
  while (i < scored.length) {
    const tierScore = scored[i].score;
    const start = i;
    while (i < scored.length && scored[i].score === tierScore) i++;
    for (let j = i - 1; j > start; j--) {
      const k = rng.pick(j - start + 1);
      if (k !== null) {
        [scored[start + k], scored[j]] = [scored[j], scored[start + k]];
      }
    }
  }
  return scored;
}
