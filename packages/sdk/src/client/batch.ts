/**
 * Batch write methods for NearlyClient — partial-success loops matching
 * the frontend's `runBatch` semantics. Each function accepts a
 * `ClientContext` as first arg.
 *
 * Per-target failures (self-target, rate-limit, storage error) appear as
 * `{ action: 'error' }` items in the returned array — the batch
 * continues. INSUFFICIENT_BALANCE on any write aborts the batch and
 * throws (`categorizeBatchWriteError` rethrows it).
 */

import type {
  BatchEndorseItem,
  BatchFollowItem,
  BatchItemError,
  BatchUnendorseItem,
  BatchUnfollowItem,
  EndorseTarget,
  SkippedKeySuffix,
  UnendorseTarget,
} from '../client';
import { LIMITS } from '../constants';
import { NearlyError } from '../errors';
import { kvGetKey } from '../read';
import {
  buildEndorse,
  buildFollow,
  buildUnendorse,
  buildUnfollow,
} from '../social';
import type { FollowOpts } from '../types';
import { writeEntries } from '../wallet';
import type { ClientContext } from './_context';
import { partitionKeySuffixes } from './_shared';

// Build a batch per-item error. `skipped` applies to endorse/unendorse
// all-invalid-suffix cases; omitted otherwise.
function batchError(
  target: string,
  code: string,
  error: string,
  skipped?: SkippedKeySuffix[],
): BatchItemError {
  return {
    account_id: target,
    action: 'error',
    code,
    error,
    ...(skipped && skipped.length > 0 && { skipped }),
  };
}

// Gate shared by the four batch methods — self-target or empty target.
function batchTargetError(
  target: string,
  callerAccountId: string,
  selfCode: string,
  verb: string,
): BatchItemError | null {
  if (target === callerAccountId) {
    return batchError(target, selfCode, `cannot ${verb} yourself`);
  }
  if (!target) {
    return batchError(target, 'VALIDATION_ERROR', 'account_id is required');
  }
  return null;
}

// Rethrows INSUFFICIENT_BALANCE so the caller aborts the whole batch;
// all other write errors map to a per-item error.
function categorizeBatchWriteError(
  err: unknown,
  target: string,
): BatchItemError {
  if (err instanceof NearlyError && err.shape.code === 'INSUFFICIENT_BALANCE') {
    throw err;
  }
  return batchError(
    target,
    err instanceof NearlyError ? err.shape.code : 'STORAGE_ERROR',
    err instanceof NearlyError ? err.shape.message : 'write failed',
  );
}

function tooManyTargetsError(): NearlyError {
  return new NearlyError({
    code: 'VALIDATION_ERROR',
    field: 'targets',
    reason: `max ${LIMITS.MAX_BATCH_TARGETS}`,
    message: `Too many targets (max ${LIMITS.MAX_BATCH_TARGETS})`,
  });
}

export async function followMany(
  ctx: ClientContext,
  targets: readonly string[],
  opts: FollowOpts = {},
): Promise<BatchFollowItem[]> {
  if (targets.length === 0) return [];
  if (targets.length > LIMITS.MAX_BATCH_TARGETS) throw tooManyTargetsError();

  const results: BatchFollowItem[] = [];
  for (const target of targets) {
    const guard = batchTargetError(
      target,
      ctx.accountId,
      'SELF_FOLLOW',
      'follow',
    );
    if (guard) {
      results.push(guard);
      continue;
    }

    const rl = ctx.rateLimiter.check('social.follow', ctx.accountId);
    if (!rl.ok) {
      results.push(
        batchError(target, 'RATE_LIMITED', 'rate limit reached within batch'),
      );
      continue;
    }

    try {
      const existing = await kvGetKey(
        ctx.read,
        ctx.accountId,
        `graph/follow/${target}`,
      );
      if (existing) {
        results.push({
          account_id: target,
          action: 'already_following',
          target,
        });
        continue;
      }
    } catch {
      results.push(batchError(target, 'STORAGE_ERROR', 'read failed'));
      continue;
    }

    try {
      const mutation = buildFollow(ctx.accountId, target, opts);
      await writeEntries(ctx.wallet, mutation.entries);
    } catch (err) {
      results.push(categorizeBatchWriteError(err, target));
      continue;
    }
    ctx.rateLimiter.record('social.follow', ctx.accountId);
    results.push({ account_id: target, action: 'followed', target });
  }
  return results;
}

export async function unfollowMany(
  ctx: ClientContext,
  targets: readonly string[],
): Promise<BatchUnfollowItem[]> {
  if (targets.length === 0) return [];
  if (targets.length > LIMITS.MAX_BATCH_TARGETS) throw tooManyTargetsError();

  const results: BatchUnfollowItem[] = [];
  for (const target of targets) {
    const guard = batchTargetError(
      target,
      ctx.accountId,
      'SELF_UNFOLLOW',
      'unfollow',
    );
    if (guard) {
      results.push(guard);
      continue;
    }

    const rl = ctx.rateLimiter.check('social.unfollow', ctx.accountId);
    if (!rl.ok) {
      results.push(
        batchError(target, 'RATE_LIMITED', 'rate limit reached within batch'),
      );
      continue;
    }

    try {
      const existing = await kvGetKey(
        ctx.read,
        ctx.accountId,
        `graph/follow/${target}`,
      );
      if (!existing) {
        results.push({
          account_id: target,
          action: 'not_following',
          target,
        });
        continue;
      }
    } catch {
      results.push(batchError(target, 'STORAGE_ERROR', 'read failed'));
      continue;
    }

    try {
      const mutation = buildUnfollow(ctx.accountId, target);
      await writeEntries(ctx.wallet, mutation.entries);
    } catch (err) {
      results.push(categorizeBatchWriteError(err, target));
      continue;
    }
    ctx.rateLimiter.record('social.unfollow', ctx.accountId);
    results.push({ account_id: target, action: 'unfollowed', target });
  }
  return results;
}

export async function endorseMany(
  ctx: ClientContext,
  targets: readonly EndorseTarget[],
): Promise<BatchEndorseItem[]> {
  if (targets.length === 0) return [];
  if (targets.length > LIMITS.MAX_BATCH_TARGETS) throw tooManyTargetsError();

  const results: BatchEndorseItem[] = [];
  for (const entry of targets) {
    const target = entry.account_id;
    const guard = batchTargetError(
      target,
      ctx.accountId,
      'SELF_ENDORSE',
      'endorse',
    );
    if (guard) {
      results.push(guard);
      continue;
    }

    const keyPrefix = `endorsing/${target}/`;
    const { valid, skipped } = partitionKeySuffixes(
      entry.keySuffixes,
      keyPrefix,
    );
    if (valid.length === 0) {
      results.push(
        batchError(
          target,
          'VALIDATION_ERROR',
          'no valid key_suffixes',
          skipped,
        ),
      );
      continue;
    }

    const rl = ctx.rateLimiter.check('social.endorse', ctx.accountId);
    if (!rl.ok) {
      results.push(
        batchError(target, 'RATE_LIMITED', 'rate limit reached within batch'),
      );
      continue;
    }

    try {
      const targetProfile = await kvGetKey(ctx.read, target, 'profile');
      if (!targetProfile) {
        results.push(
          batchError(target, 'NOT_FOUND', `agent not found: ${target}`),
        );
        continue;
      }
    } catch {
      results.push(batchError(target, 'STORAGE_ERROR', 'read failed'));
      continue;
    }

    let mutation: ReturnType<typeof buildEndorse>;
    try {
      mutation = buildEndorse(ctx.accountId, target, {
        keySuffixes: valid,
        ...(entry.reason != null && { reason: entry.reason }),
        ...(entry.contentHash != null && { contentHash: entry.contentHash }),
      });
      await writeEntries(ctx.wallet, mutation.entries);
    } catch (err) {
      results.push(categorizeBatchWriteError(err, target));
      continue;
    }
    ctx.rateLimiter.record('social.endorse', ctx.accountId);
    results.push({
      account_id: target,
      action: 'endorsed',
      target,
      key_suffixes: Object.keys(mutation.entries).map((k) =>
        k.slice(keyPrefix.length),
      ),
      ...(skipped.length > 0 && { skipped }),
    });
  }
  return results;
}

export async function unendorseMany(
  ctx: ClientContext,
  targets: readonly UnendorseTarget[],
): Promise<BatchUnendorseItem[]> {
  if (targets.length === 0) return [];
  if (targets.length > LIMITS.MAX_BATCH_TARGETS) throw tooManyTargetsError();

  const results: BatchUnendorseItem[] = [];
  for (const entry of targets) {
    const target = entry.account_id;
    const guard = batchTargetError(
      target,
      ctx.accountId,
      'SELF_UNENDORSE',
      'unendorse',
    );
    if (guard) {
      results.push(guard);
      continue;
    }

    const keyPrefix = `endorsing/${target}/`;
    const { valid, skipped } = partitionKeySuffixes(
      entry.keySuffixes,
      keyPrefix,
    );
    if (valid.length === 0) {
      results.push(
        batchError(
          target,
          'VALIDATION_ERROR',
          'no valid key_suffixes',
          skipped,
        ),
      );
      continue;
    }

    const rl = ctx.rateLimiter.check('social.unendorse', ctx.accountId);
    if (!rl.ok) {
      results.push(
        batchError(target, 'RATE_LIMITED', 'rate limit reached within batch'),
      );
      continue;
    }

    let mutation: ReturnType<typeof buildUnendorse>;
    try {
      mutation = buildUnendorse(ctx.accountId, target, valid);
      await writeEntries(ctx.wallet, mutation.entries);
    } catch (err) {
      results.push(categorizeBatchWriteError(err, target));
      continue;
    }
    ctx.rateLimiter.record('social.unendorse', ctx.accountId);
    results.push({
      account_id: target,
      action: 'unendorsed',
      target,
      key_suffixes: Object.keys(mutation.entries).map((k) =>
        k.slice(keyPrefix.length),
      ),
      ...(skipped.length > 0 && { skipped }),
    });
  }
  return results;
}
