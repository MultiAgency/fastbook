// INVALIDATION_MAP lives next to `dispatchWrite` so the typed
// `Record<WriteAction, …>` enforces row completeness at the call site;
// a missing row would silently fall back to "clear everything".

import type { ActionName } from '../../routes';
import { fail, type WriteResult } from './_shared';
import { handleDelistMe } from './delist_me';
import { handleEndorse } from './endorse';
import { handleFollow } from './follow';
import { handleHeartbeat } from './heartbeat';
import { handleUpdateProfile } from './profile';
import { handleUnendorse } from './unendorse';
import { handleUnfollow } from './unfollow';

export { writeToFastData } from './_shared';
export {
  handleDelistMe,
  handleEndorse,
  handleFollow,
  handleHeartbeat,
  handleUnendorse,
  handleUnfollow,
  handleUpdateProfile,
};

// All actions that perform a FastData KV write. The `satisfies readonly
// ActionName[]` constraint enforces that every entry is a real route-
// table action — adding a write action that isn't routed through the
// table is a tsc error.
const WRITE_ACTIONS = [
  'hide_agent',
  'social.delist_me',
  'social.endorse',
  'social.follow',
  'social.heartbeat',
  'social.unendorse',
  'social.unfollow',
  'social.profile',
  'unhide_agent',
] as const satisfies readonly ActionName[];

type WriteAction = (typeof WRITE_ACTIONS)[number];

export const INVALIDATION_MAP: Record<WriteAction, readonly string[]> = {
  'social.profile': [
    'list_agents',
    'list_tags',
    'list_capabilities',
    'profile',
  ],
  'social.follow': ['profile', 'followers', 'following', 'edges'],
  'social.unfollow': ['profile', 'followers', 'following', 'edges'],
  'social.endorse': ['profile', 'endorsers', 'endorsing'],
  'social.unendorse': ['profile', 'endorsers', 'endorsing'],
  'social.heartbeat': [
    'list_agents',
    'profile',
    'health',
    'list_tags',
    'list_capabilities',
  ],
  'social.delist_me': [
    'list_agents',
    'list_tags',
    'list_capabilities',
    'health',
    'profile',
    'followers',
    'following',
    'edges',
    'endorsers',
    'endorsing',
  ],
  hide_agent: ['hidden'],
  unhide_agent: ['hidden'],
};

export async function dispatchWrite(
  action: string,
  body: Record<string, unknown>,
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  let result: WriteResult;

  switch (action) {
    case 'social.follow':
      result = await handleFollow(walletKey, body, resolveAccountId);
      break;
    case 'social.unfollow':
      result = await handleUnfollow(walletKey, body, resolveAccountId);
      break;
    case 'social.endorse':
      result = await handleEndorse(walletKey, body, resolveAccountId);
      break;
    case 'social.unendorse':
      result = await handleUnendorse(walletKey, body, resolveAccountId);
      break;
    case 'social.profile':
      result = await handleUpdateProfile(walletKey, body, resolveAccountId);
      break;
    case 'social.heartbeat':
      result = await handleHeartbeat(walletKey, resolveAccountId);
      break;
    case 'social.delist_me':
      result = await handleDelistMe(walletKey, resolveAccountId);
      break;
    default:
      return fail(
        'VALIDATION_ERROR',
        `Action '${action}' not supported for direct write`,
      );
  }

  // Attach invalidation targets to successful results.
  if (result.success) {
    result.invalidates = INVALIDATION_MAP[action] ?? null;
  }
  return result;
}
