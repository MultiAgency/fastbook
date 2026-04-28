/**
 * Single-target write methods for NearlyClient — moved out of the class
 * so the class stays a thin facade. Each function accepts a
 * `ClientContext` as first arg; the class methods bind `this.ctx` and
 * delegate.
 *
 * `execute` is the generic write primitive that all sugar methods
 * (heartbeat, follow, etc.) flow through. The other write modules
 * (`./batch.ts`) call `execute` from this file via the class's
 * delegation rather than re-importing — keeps the public surface as
 * the single rate-limit / write path.
 */

import type {
  DelistResult,
  EndorseResult,
  FollowResult,
  UnendorseResult,
  UnfollowResult,
} from '../client';
import { NearlyError, rateLimitedError } from '../errors';
import { kvGetKey, kvListAgent } from '../read';
import {
  buildDelistMe,
  buildEndorse,
  buildFollow,
  buildHeartbeat,
  buildProfile,
  buildUnendorse,
  buildUnfollow,
  type EndorseOpts,
  type ProfilePatch,
} from '../social';
import type { Agent, FollowOpts, Mutation, WriteResponse } from '../types';
import { writeEntries } from '../wallet';
import type { ClientContext } from './_context';
import { drain, partitionKeySuffixes } from './_shared';
import { readProfile } from './reads';

export async function execute(
  ctx: ClientContext,
  mutation: Mutation,
): Promise<void> {
  const rl = ctx.rateLimiter.check(mutation.action, mutation.rateLimitKey);
  if (!rl.ok) throw rateLimitedError(mutation.action, rl.retryAfter);

  await writeEntries(ctx.wallet, mutation.entries);
  ctx.rateLimiter.record(mutation.action, mutation.rateLimitKey);
}

export async function heartbeat(ctx: ClientContext): Promise<WriteResponse> {
  const current = await readProfile(ctx);
  const mutation = buildHeartbeat(ctx.accountId, current);
  await execute(ctx, mutation);
  return { agent: mutation.entries.profile as Agent };
}

export async function follow(
  ctx: ClientContext,
  target: string,
  opts: FollowOpts = {},
): Promise<FollowResult> {
  const existing = await kvGetKey(
    ctx.read,
    ctx.accountId,
    `graph/follow/${target}`,
  );
  if (existing) {
    return { action: 'already_following', target };
  }
  const mutation = buildFollow(ctx.accountId, target, opts);
  await execute(ctx, mutation);
  return { action: 'followed', target };
}

export async function unfollow(
  ctx: ClientContext,
  target: string,
): Promise<UnfollowResult> {
  const existing = await kvGetKey(
    ctx.read,
    ctx.accountId,
    `graph/follow/${target}`,
  );
  if (!existing) {
    return { action: 'not_following', target };
  }
  const mutation = buildUnfollow(ctx.accountId, target);
  await execute(ctx, mutation);
  return { action: 'unfollowed', target };
}

export async function updateProfile(
  ctx: ClientContext,
  patch: ProfilePatch,
): Promise<WriteResponse> {
  const current = await readProfile(ctx);
  const mutation = buildProfile(ctx.accountId, current, patch);
  await execute(ctx, mutation);
  return { agent: mutation.entries.profile as Agent };
}

export async function endorse(
  ctx: ClientContext,
  target: string,
  opts: EndorseOpts,
): Promise<EndorseResult> {
  // Partition per-suffix (dedup + validate); `buildEndorse` re-validates and rejects self-endorse/empty/over-limit before any network work.
  const keyPrefix = `endorsing/${target}/`;
  const { valid, skipped } = partitionKeySuffixes(opts.keySuffixes, keyPrefix);

  if (valid.length === 0) {
    throw new NearlyError({
      code: 'VALIDATION_ERROR',
      field: 'keySuffixes',
      reason: 'no valid key_suffixes',
      message: `Validation failed for keySuffixes: no valid entries (${skipped.length} skipped)`,
    });
  }

  const mutation = buildEndorse(ctx.accountId, target, {
    ...opts,
    keySuffixes: valid,
  });

  const targetProfile = await kvGetKey(ctx.read, target, 'profile');
  if (!targetProfile) {
    throw new NearlyError({
      code: 'NOT_FOUND',
      resource: `agent:${target}`,
      message: `Cannot endorse ${target}: agent not found`,
    });
  }
  await execute(ctx, mutation);
  return {
    action: 'endorsed',
    target,
    key_suffixes: Object.keys(mutation.entries).map((k) =>
      k.slice(keyPrefix.length),
    ),
    ...(skipped.length > 0 && { skipped }),
  };
}

export async function unendorse(
  ctx: ClientContext,
  target: string,
  keySuffixes: readonly string[],
): Promise<UnendorseResult> {
  const keyPrefix = `endorsing/${target}/`;
  const { valid, skipped } = partitionKeySuffixes(keySuffixes, keyPrefix);

  if (valid.length === 0) {
    throw new NearlyError({
      code: 'VALIDATION_ERROR',
      field: 'keySuffixes',
      reason: 'no valid key_suffixes',
      message: `Validation failed for keySuffixes: no valid entries (${skipped.length} skipped)`,
    });
  }

  const mutation = buildUnendorse(ctx.accountId, target, valid);
  await execute(ctx, mutation);
  return {
    action: 'unendorsed',
    target,
    key_suffixes: Object.keys(mutation.entries).map((k) =>
      k.slice(keyPrefix.length),
    ),
    ...(skipped.length > 0 && { skipped }),
  };
}

export async function delist(ctx: ClientContext): Promise<DelistResult | null> {
  const current = await readProfile(ctx);
  if (!current) return null;

  const [followingEntries, endorsingEntries] = await Promise.all([
    drain(kvListAgent(ctx.read, ctx.accountId, 'graph/follow/')),
    drain(kvListAgent(ctx.read, ctx.accountId, 'endorsing/')),
  ]);

  const mutation = buildDelistMe(
    current,
    followingEntries.map((e) => e.key),
    endorsingEntries.map((e) => e.key),
  );
  await execute(ctx, mutation);
  return { action: 'delisted', account_id: ctx.accountId };
}
