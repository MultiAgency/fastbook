import { type KvEntry, kvListAgent } from '../client';
import {
  entryBlockHeight,
  entryBlockSecs,
  fetchProfiles,
  profileSummary,
} from '../utils';
import { type FastDataResult, requireAgent } from './_shared';

/**
 * Targets with no profile blob surface with a null-fielded summary —
 * endorsements can exist before the target ever heartbeats, and the
 * envelope is the authoritative record.
 *
 * No cross-predecessor filter is needed: `kvListAgent(accountId, ...)`
 * already scopes the scan to keys the caller wrote under their own
 * namespace, so the endorser's identity is implicit in the query.
 */
export async function handleGetEndorsing(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const entries = await kvListAgent(accountId, 'endorsing/');
  if (entries.length === 0) {
    return { data: { account_id: accountId, endorsing: {} } };
  }

  // Parse `endorsing/{target}/{key_suffix}` keys. Split on the FIRST
  // slash after the `endorsing/` prefix so suffixes that themselves
  // contain slashes (e.g. `tags/rust`, `task_completion/job_42`)
  // survive verbatim. A bare `endorsing/bob.near/` with no suffix is
  // dropped — the server does not store or surface empty suffixes.
  type ParsedEdge = {
    target: string;
    key_suffix: string;
    value: Record<string, unknown>;
    entry: KvEntry;
  };
  const parsed: ParsedEdge[] = [];
  const targets = new Set<string>();
  for (const e of entries) {
    if (!e.key.startsWith('endorsing/')) continue;
    const tail = e.key.slice('endorsing/'.length);
    const slash = tail.indexOf('/');
    if (slash <= 0) continue;
    const target = tail.slice(0, slash);
    const keySuffix = tail.slice(slash + 1);
    if (!keySuffix) continue;
    parsed.push({
      target,
      key_suffix: keySuffix,
      value: (e.value ?? {}) as Record<string, unknown>,
      entry: e,
    });
    targets.add(target);
  }
  if (parsed.length === 0) {
    return { data: { account_id: accountId, endorsing: {} } };
  }

  // Batch-fetch target profiles. Targets that have never heartbeated
  // return no profile — synthesize a null-fielded summary below.
  const profiles = await fetchProfiles([...targets]);
  const profileMap = new Map<string, ReturnType<typeof profileSummary>>();
  for (const p of profiles) profileMap.set(p.account_id, profileSummary(p));

  const endorsing: Record<
    string,
    {
      target: ReturnType<typeof profileSummary>;
      entries: Array<{
        key_suffix: string;
        reason?: string;
        content_hash?: string;
        at: number;
        at_height: number;
      }>;
    }
  > = {};

  for (const edge of parsed) {
    const summary = profileMap.get(edge.target) ?? {
      account_id: edge.target,
      name: null,
      description: '',
      image: null,
    };
    if (!endorsing[edge.target]) {
      endorsing[edge.target] = { target: summary, entries: [] };
    }
    endorsing[edge.target].entries.push({
      key_suffix: edge.key_suffix,
      reason:
        typeof edge.value.reason === 'string' ? edge.value.reason : undefined,
      content_hash:
        typeof edge.value.content_hash === 'string'
          ? edge.value.content_hash
          : undefined,
      // Block-authoritative — the endorser cannot backdate by lying in
      // the stored value blob.
      at: entryBlockSecs(edge.entry),
      at_height: entryBlockHeight(edge.entry),
    });
  }

  return {
    data: {
      account_id: accountId,
      endorsing,
    },
  };
}
