import {
  buildEndorse,
  LIMITS,
  validateKeySuffix,
  validateReason,
} from '@nearly/sdk';
import { kvMultiAgent } from '../client';
import { composeKey, endorsePrefix, fetchProfile } from '../utils';
import { fail, runBatch, validationFail, type WriteResult } from './_shared';

function resolveKeySuffixes(
  raw: unknown,
): { keySuffixes: string[] } | WriteResult {
  if (!Array.isArray(raw) || raw.length === 0)
    return fail('VALIDATION_ERROR', 'key_suffixes array must not be empty');
  if (raw.length > LIMITS.MAX_KEY_SUFFIXES)
    return fail(
      'VALIDATION_ERROR',
      `Too many key_suffixes (max ${LIMITS.MAX_KEY_SUFFIXES})`,
    );
  // Dedupe: duplicate key_suffixes in a single call would write the same
  // KV key twice and return misleading duplicate entries in endorsed[].
  // Order-preserving: first occurrence wins.
  const seen = new Set<string>();
  const keySuffixes: string[] = [];
  for (const ks of raw) {
    if (typeof ks !== 'string')
      return fail('VALIDATION_ERROR', 'key_suffixes must be strings');
    if (seen.has(ks)) continue;
    seen.add(ks);
    keySuffixes.push(ks);
  }
  return { keySuffixes };
}

export interface EndorseTargetOpts {
  readonly keySuffixes: readonly string[];
  readonly reason?: string;
  readonly contentHash?: string;
}

/**
 * Parse the endorse/unendorse request body into a per-target map.
 *
 * Accepts two formats:
 * 1. Per-target batch: `{ targets: [{ account_id, key_suffixes, reason?, content_hash? }] }`
 * 2. Single-target (path-param): `{ account_id, key_suffixes, reason?, content_hash? }`
 */
export function resolveEndorseTargets(body: Record<string, unknown>):
  | {
      targetIds: string[];
      opts: Map<string, EndorseTargetOpts>;
    }
  | WriteResult {
  const opts = new Map<string, EndorseTargetOpts>();

  if (Array.isArray(body.targets)) {
    const targets = body.targets;
    if (targets.length === 0)
      return fail('VALIDATION_ERROR', 'targets array must not be empty');
    if (targets.length > LIMITS.MAX_BATCH_TARGETS)
      return fail(
        'VALIDATION_ERROR',
        `Too many targets (max ${LIMITS.MAX_BATCH_TARGETS})`,
      );

    const targetIds: string[] = [];
    for (const t of targets) {
      if (!t || typeof t !== 'object' || typeof t.account_id !== 'string') {
        return fail(
          'VALIDATION_ERROR',
          'targets[] items must be { account_id, key_suffixes } objects',
        );
      }
      const accountId = t.account_id as string;
      const ksResult = resolveKeySuffixes(t.key_suffixes);
      if ('success' in ksResult) return ksResult;
      const reason = t.reason as string | undefined;
      if (reason != null) {
        const e = validateReason(reason);
        if (e) return validationFail(e);
      }
      opts.set(accountId, {
        keySuffixes: ksResult.keySuffixes,
        reason,
        contentHash: t.content_hash as string | undefined,
      });
      targetIds.push(accountId);
    }
    return { targetIds, opts };
  }

  // Single-target path-param form
  const accountId = body.account_id;
  if (typeof accountId !== 'string' || !accountId)
    return fail('VALIDATION_ERROR', 'account_id is required');
  const ksResult = resolveKeySuffixes(body.key_suffixes);
  if ('success' in ksResult) return ksResult;
  const reason = body.reason as string | undefined;
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }
  opts.set(accountId, {
    keySuffixes: ksResult.keySuffixes,
    reason,
    contentHash: body.content_hash as string | undefined,
  });
  return { targetIds: [accountId], opts };
}

export type EndorseKeySuffixPartition =
  | {
      kind: 'ok';
      keyPrefix: string;
      validKeySuffixes: string[];
      skipped: { key_suffix: string; reason: string }[];
    }
  | { kind: 'fail'; result: Record<string, unknown> };

export function partitionEndorseKeySuffixes(
  target: string,
  keySuffixes: readonly string[],
): EndorseKeySuffixPartition {
  const keyPrefix = endorsePrefix(target);
  const validKeySuffixes: string[] = [];
  const skipped: { key_suffix: string; reason: string }[] = [];
  for (const ks of keySuffixes) {
    const e = validateKeySuffix(ks, keyPrefix);
    if (e) skipped.push({ key_suffix: ks, reason: e.message });
    else validKeySuffixes.push(ks);
  }

  if (validKeySuffixes.length === 0) {
    return {
      kind: 'fail',
      result: {
        account_id: target,
        action: 'error',
        code: 'VALIDATION_ERROR',
        error: 'no valid key_suffixes',
        ...(skipped.length > 0 && { skipped }),
      },
    };
  }

  return { kind: 'ok', keyPrefix, validKeySuffixes, skipped };
}

export async function handleEndorse(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const resolved = resolveEndorseTargets(body);
  if ('success' in resolved) return resolved;
  const { targetIds, opts: targetOpts } = resolved;

  return runBatch({
    action: 'social.endorse',
    selfCode: 'SELF_ENDORSE',
    verb: 'endorse',
    walletKey,
    targets: targetIds,
    resolveAccountId,
    // Rate-limit unit: one per target regardless of key_suffixes count.
    step: async (target, caller) => {
      const tOpts = targetOpts.get(target)!;

      if ((await fetchProfile(target)) == null) {
        return {
          kind: 'fail',
          result: {
            account_id: target,
            action: 'error',
            code: 'NOT_FOUND',
            error: 'agent not found',
          },
        };
      }

      const partition = partitionEndorseKeySuffixes(target, tOpts.keySuffixes);
      if (partition.kind === 'fail') return partition;
      const { keyPrefix, validKeySuffixes, skipped } = partition;

      const fullKeys = validKeySuffixes.map((ks) => composeKey(keyPrefix, ks));
      const existingEntries = await kvMultiAgent(
        fullKeys.map((key) => ({ accountId: caller.accountId, key })),
      );

      // Skip suffixes whose stored `content_hash` already matches; last
      // write wins on mismatch.
      const suffixesToWrite: string[] = [];
      const endorsed: string[] = [];
      const alreadyEndorsed: string[] = [];

      for (let i = 0; i < validKeySuffixes.length; i++) {
        const ks = validKeySuffixes[i]!;
        const existing = existingEntries[i]?.value as
          | { content_hash?: string }
          | null
          | undefined;
        const existingHash = existing?.content_hash;
        const sameHash = tOpts.contentHash
          ? existingHash === tOpts.contentHash
          : existingHash == null;
        if (existing && sameHash) {
          alreadyEndorsed.push(ks);
          continue;
        }
        suffixesToWrite.push(ks);
        endorsed.push(ks);
      }

      const entries: Record<string, unknown> =
        suffixesToWrite.length > 0
          ? buildEndorse(caller.accountId, target, {
              keySuffixes: suffixesToWrite,
              ...(tOpts.reason != null && { reason: tOpts.reason }),
              ...(tOpts.contentHash != null && {
                contentHash: tOpts.contentHash,
              }),
            }).entries
          : {};

      const buildResult = (): Record<string, unknown> => {
        const result: Record<string, unknown> = {
          account_id: target,
          action: 'endorsed',
          endorsed,
        };
        if (alreadyEndorsed.length > 0)
          result.already_endorsed = alreadyEndorsed;
        if (skipped.length > 0) result.skipped = skipped;
        return result;
      };

      if (endorsed.length === 0) {
        return { kind: 'skip', result: buildResult() };
      }
      return { kind: 'write', entries, onWritten: buildResult };
    },
  });
}
