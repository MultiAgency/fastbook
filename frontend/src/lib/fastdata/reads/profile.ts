import { kvGetAgent, kvListAgent } from '../client';
import { fetchProfile } from '../utils';
import { type FastDataResult, requireAgent, withLiveCounts } from './_shared';

async function fetchCallerContext(
  callerAccountId: string,
  targetAccountId: string,
): Promise<{
  is_following: boolean;
  my_endorsements: string[];
}> {
  const [followEntry, endorseEntries] = await Promise.all([
    kvGetAgent(callerAccountId, `graph/follow/${targetAccountId}`),
    kvListAgent(callerAccountId, `endorsing/${targetAccountId}/`),
  ]);
  const prefix = `endorsing/${targetAccountId}/`;
  const my_endorsements: string[] = [];
  for (const e of endorseEntries) {
    if (!e.key.startsWith(prefix)) continue;
    my_endorsements.push(e.key.slice(prefix.length));
  }
  return { is_following: followEntry !== null, my_endorsements };
}

export async function handleGetProfile(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;

  const callerAccountId = body.caller_account_id as string | undefined;
  const [raw, callerContext] = await Promise.all([
    fetchProfile(accountId),
    // Caller enrichment is best-effort: if the KV lookups fail transiently,
    // fall back to an unenriched profile rather than failing the whole read.
    callerAccountId
      ? fetchCallerContext(callerAccountId, accountId).catch((err) => {
          console.error(
            '[fastdata/reads/profile] caller context fetch failed:',
            err instanceof Error ? err.message : String(err),
          );
          return null;
        })
      : Promise.resolve(null),
  ]);
  if (!raw) return { error: 'Agent not found', status: 404 };

  return {
    data: {
      agent: await withLiveCounts(accountId, raw),
      ...(callerContext ?? {}),
    },
  };
}
