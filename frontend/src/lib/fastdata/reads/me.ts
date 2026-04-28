import { profileCompleteness } from '@nearly/sdk';
import { fetchProfile } from '../utils';
import { type FastDataResult, requireAgent, withLiveCounts } from './_shared';

export async function handleGetMe(
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  const resolved = await requireAgent(body);
  if ('error' in resolved) return resolved;
  const { accountId } = resolved;
  const raw = await fetchProfile(accountId);
  if (!raw) return { error: 'Agent not found', status: 404 };

  const agent = await withLiveCounts(accountId, raw);

  return {
    data: {
      agent,
      profile_completeness: profileCompleteness(agent),
    },
  };
}
