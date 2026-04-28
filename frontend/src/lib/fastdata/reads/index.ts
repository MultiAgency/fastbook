/**
 * FastData KV read path — module boundary.
 *
 * Re-exports each per-action read handler and dispatches incoming
 * actions. Read counterpart of `writes/index.ts`. No INVALIDATION_MAP
 * here — invalidation is the inverse direction (writes invalidate
 * reads); that map lives in `writes/index.ts`.
 */

import type { FastDataResult } from './_shared';
import { handleGetActivity } from './activity';
import { handleGetSuggested } from './discover_agents';
import { handleGetEdges } from './edges';
import { handleGetEndorsers } from './endorsers';
import { handleGetEndorsing } from './endorsing';
import { handleGetFollowers } from './followers';
import { handleGetFollowing } from './following';
import { handleHealth } from './health';
import { handleListAgents } from './list_agents';
import { handleListCapabilities } from './list_capabilities';
import { handleListTags } from './list_tags';
import { handleGetMe } from './me';
import { handleGetNetwork } from './network';
import { handleGetProfile } from './profile';

export type { FastDataError } from './_shared';
export {
  handleGetActivity,
  handleGetEdges,
  handleGetEndorsers,
  handleGetEndorsing,
  handleGetFollowers,
  handleGetFollowing,
  handleGetMe,
  handleGetNetwork,
  handleGetProfile,
  handleGetSuggested,
  handleHealth,
  handleListAgents,
  handleListCapabilities,
  handleListTags,
};

export async function dispatchFastData(
  action: string,
  body: Record<string, unknown>,
): Promise<FastDataResult> {
  try {
    switch (action) {
      case 'health':
        return { data: await handleHealth() };
      case 'profile':
        return await handleGetProfile(body);
      case 'list_tags':
        return { data: await handleListTags() };
      case 'list_capabilities':
        return { data: await handleListCapabilities() };
      case 'list_agents':
        return await handleListAgents(body);
      case 'followers':
        return await handleGetFollowers(body);
      case 'following':
        return await handleGetFollowing(body);
      case 'me':
        return await handleGetMe(body);
      case 'discover_agents':
        return await handleGetSuggested(body, null);
      case 'edges':
        return await handleGetEdges(body);
      case 'endorsers':
        return await handleGetEndorsers(body);
      case 'endorsing':
        return await handleGetEndorsing(body);
      case 'activity':
        return await handleGetActivity(body);
      case 'network':
        return await handleGetNetwork(body);
      default:
        return { error: `Unsupported action: ${action}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `FastData KV error: ${msg}` };
  }
}
