import { kvListAll } from '../client';
import {
  endorsePrefix,
  entryBlockHeight,
  entryBlockSecs,
  fetchProfiles,
  profileSummary,
} from '../utils';
import { type FastDataResult, requireAgent } from './_shared';

export async function handleGetEndorsers(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const prefix = endorsePrefix(accountId);
  const endorseEntries = await kvListAll(prefix);

  const endorserAccountIds = [
    ...new Set(endorseEntries.map((e) => e.predecessor_id)),
  ];
  const profileMap = new Map<string, ReturnType<typeof profileSummary>>();
  for (const p of await fetchProfiles(endorserAccountIds)) {
    profileMap.set(p.account_id, profileSummary(p));
  }

  // Group entries by opaque key_suffix. The tail after `endorsing/{target}/`
  // is passed through unchanged — the server does not interpret segments.
  const endorsers: Record<
    string,
    Array<{
      account_id: string;
      name: string | null;
      description: string;
      image: string | null;
      reason?: string;
      content_hash?: string;
      at?: number;
      at_height?: number;
    }>
  > = {};

  for (const e of endorseEntries) {
    if (!e.key.startsWith(prefix)) continue;
    const keySuffix = e.key.slice(prefix.length);
    if (!keySuffix) continue;

    const profile = profileMap.get(e.predecessor_id);
    if (!profile) continue;

    const meta = (e.value ?? {}) as Record<string, unknown>;

    if (!endorsers[keySuffix]) endorsers[keySuffix] = [];
    endorsers[keySuffix].push({
      account_id: profile.account_id,
      name: profile.name,
      description: profile.description,
      image: profile.image ?? null,
      reason: meta.reason as string | undefined,
      content_hash: meta.content_hash as string | undefined,
      // Block-authoritative — endorsers cannot backdate or forward-date
      // by lying in the value blob. `at_height` is the canonical "when";
      // `at` is emitted alongside for consumers not yet on `at_height`.
      at: entryBlockSecs(e),
      at_height: entryBlockHeight(e),
    });
  }

  return {
    data: {
      account_id: accountId,
      endorsers,
    },
  };
}
