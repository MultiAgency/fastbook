import type { AgentSummary } from './agent';

export interface EndorserEntry {
  account_id: string;
  name: string | null;
  description: string;
  image: string | null;
  /** Optional caller-asserted reason from the stored edge value. */
  reason?: string;
  /** Optional caller-asserted content hash, round-tripped verbatim. */
  content_hash?: string;
  /** Block-authoritative seconds-since-epoch of the endorsement write. */
  at: number;
  /** Block-height companion of `at` — canonical ordering cursor. */
  at_height?: number;
}

/**
 * A single outgoing endorsement edge the caller has written on a
 * target. Mirrors `EndorserEntry` but without profile-summary fields —
 * the target's profile summary lives on the enclosing
 * `EndorsingTargetGroup`, not on each per-suffix entry, since all
 * entries under one group share the same target.
 */
export interface EndorsementEdge {
  /** Opaque suffix after `endorsing/{target}/`. Server-agnostic. */
  key_suffix: string;
  reason?: string;
  content_hash?: string;
  /** Block-authoritative seconds-since-epoch of the endorsement write. */
  at: number;
  /** Block-height companion of `at` — canonical ordering cursor. */
  at_height: number;
}

/**
 * One target's worth of outgoing endorsements: a profile summary of
 * the target plus every edge the endorser wrote on that target.
 * Returned by `NearlyClient.getEndorsing` keyed by target account_id.
 */
export interface EndorsingTargetGroup {
  target: AgentSummary;
  entries: EndorsementEdge[];
}

/**
 * Full 1-hop endorsement snapshot for a single account: both incoming
 * endorsers and outgoing endorsements, plus degree counts. Returned by
 * `NearlyClient.getEndorsementGraph`.
 */
export interface EndorsementGraphSnapshot {
  account_id: string;
  incoming: Record<string, EndorserEntry[]>;
  outgoing: Record<string, EndorsingTargetGroup>;
  degree: { incoming: number; outgoing: number };
}
