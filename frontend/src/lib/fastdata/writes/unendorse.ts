import { buildUnendorse } from '@nearly/sdk';
import { kvMultiAgent } from '../client';
import { composeKey } from '../utils';
import { runBatch, type WriteResult } from './_shared';
import { partitionEndorseKeySuffixes, resolveEndorseTargets } from './endorse';

export async function handleUnendorse(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const resolved = resolveEndorseTargets(body);
  if ('success' in resolved) return resolved;
  const { targetIds, opts: targetOpts } = resolved;

  return runBatch({
    action: 'social.unendorse',
    selfCode: 'SELF_UNENDORSE',
    verb: 'unendorse',
    walletKey,
    targets: targetIds,
    resolveAccountId,
    step: async (target, caller) => {
      const tOpts = targetOpts.get(target)!;

      // Read only the caller's own keys — gating on the target's
      // current profile would break retraction after the target mutated,
      // and scanning every endorsement on this target is the high-fanout
      // cliff. Validation rules mirror endorse so a retract can't land
      // on a key the endorse path would reject. No "retract everything"
      // path — callers compose the key_suffix list themselves.
      const partition = partitionEndorseKeySuffixes(target, tOpts.keySuffixes);
      if (partition.kind === 'fail') return partition;
      const { keyPrefix, validKeySuffixes, skipped } = partition;

      const fullKeys = validKeySuffixes.map((ks) => composeKey(keyPrefix, ks));
      const existingEntries = await kvMultiAgent(
        fullKeys.map((key) => ({ accountId: caller.accountId, key })),
      );

      // FastData no-ops null-writes on absent keys, so the filter is for
      // response accuracy only — `removed` must list only edges that
      // actually transitioned live → tombstone.
      const removed: string[] = [];
      for (let i = 0; i < validKeySuffixes.length; i++) {
        if (existingEntries[i] != null) {
          removed.push(validKeySuffixes[i]!);
        }
      }

      const entries: Record<string, unknown> =
        removed.length > 0
          ? buildUnendorse(caller.accountId, target, removed).entries
          : {};

      const result: Record<string, unknown> = {
        account_id: target,
        action: 'unendorsed',
        removed,
      };
      if (skipped.length > 0) result.skipped = skipped;

      if (removed.length === 0) {
        return { kind: 'skip', result };
      }
      return { kind: 'write', entries, onWritten: () => result };
    },
  });
}
