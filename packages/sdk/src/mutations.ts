import { NearlyError, rateLimitedError } from './errors';
import { defaultAgent, extractCapabilityPairs } from './graph';
import type { RateLimiter } from './rateLimit';
import type { Agent, FollowOpts, Mutation } from './types';
import { validateReason } from './validate';
import { submitWrite, type WalletClient } from './wallet';

/**
 * Build the KV entries for a profile write: the full profile blob plus
 * tag/cap existence indexes. Strips derived fields (counts, endorsements)
 * AND time fields (`last_active`, `created_at`) — those are read-derived
 * from FastData's block timestamps via the trust boundary, never written
 * to stored blobs.
 */
function profileEntries(agent: Agent): Record<string, unknown> {
  const {
    follower_count: _fc,
    following_count: _fgc,
    endorsements: _e,
    endorsement_count: _ec,
    last_active: _la,
    created_at: _ca,
    ...rest
  } = agent;
  const entries: Record<string, unknown> = { profile: rest };
  for (const tag of agent.tags) {
    entries[`tag/${tag}`] = true;
  }
  for (const [ns, val] of extractCapabilityPairs(agent.capabilities)) {
    entries[`cap/${ns}/${val}`] = true;
  }
  return entries;
}

/**
 * Build a heartbeat mutation. Pure: takes the caller's current Agent (or
 * null for first-write) and returns the full write entries. The client
 * layer is responsible for reading the current agent first — this function
 * does no I/O.
 *
 * Heartbeat's sole responsibility is making the chain observe a new
 * profile write. Time fields (`last_active`, `created_at`) are not set on
 * the written blob — `profileEntries` strips them, and the read path
 * derives them from `entry.block_timestamp`. Heartbeat-as-time-bump is
 * an emergent property of "any write produces a new block_timestamp,"
 * not an explicit field assignment.
 */
export function buildHeartbeat(
  accountId: string,
  current: Agent | null,
): Mutation {
  const next: Agent = {
    ...(current ?? defaultAgent(accountId)),
    account_id: accountId,
  };

  return {
    action: 'heartbeat',
    entries: profileEntries(next),
    rateLimitKey: accountId,
  };
}

/**
 * Build a follow mutation. Pure: validates reason, rejects self-follow,
 * and emits the single graph/follow/{target} entry. The client layer is
 * responsible for checking "already following" before calling submit; this
 * builder does not know the current edge state.
 *
 * Edge value carries only the optional reason — no `at` field. The
 * authoritative "when did this follow happen" is the FastData-indexed
 * block_timestamp of the entry, surfaced via `entryBlockSecs` on read.
 */
export function buildFollow(
  callerAccountId: string,
  target: string,
  opts: FollowOpts = {},
): Mutation {
  if (!target.trim()) {
    throw new NearlyError({
      code: 'VALIDATION_ERROR',
      field: 'target',
      reason: 'empty account_id',
      message: 'Validation failed for target: empty account_id',
    });
  }
  if (target === callerAccountId) {
    throw new NearlyError({
      code: 'SELF_FOLLOW',
      message: 'Cannot follow yourself',
    });
  }
  if (opts.reason !== undefined) {
    const e = validateReason(opts.reason);
    if (e) throw e;
  }

  const entry: Record<string, unknown> =
    opts.reason !== undefined ? { reason: opts.reason } : {};

  return {
    action: 'follow',
    entries: { [`graph/follow/${target}`]: entry },
    rateLimitKey: callerAccountId,
  };
}

// ---------------------------------------------------------------------------
// Submit funnel
// ---------------------------------------------------------------------------

export interface SubmitContext {
  wallet: WalletClient;
  rateLimiter: RateLimiter;
}

/**
 * The one write funnel. Rate-limits, submits via OutLayer, records usage on
 * success. Throws NearlyError on any failure. All v0.0+ mutations go here.
 */
export async function submit(
  ctx: SubmitContext,
  mutation: Mutation,
): Promise<void> {
  const rl = ctx.rateLimiter.check(mutation.action, mutation.rateLimitKey);
  if (!rl.ok) throw rateLimitedError(mutation.action, rl.retryAfter);

  await submitWrite(ctx.wallet, mutation.entries);
  ctx.rateLimiter.record(mutation.action, mutation.rateLimitKey);
}
