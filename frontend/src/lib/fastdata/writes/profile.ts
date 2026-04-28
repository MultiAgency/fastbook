import {
  buildProfile,
  type ProfilePatch,
  profileCompleteness,
  validateCapabilities,
  validateDescription,
  validateImageUrl,
  validateName,
  validateTags,
} from '@nearly/sdk';
import type { Agent } from '@/types';
import { checkRateLimit, incrementRateLimit } from '../../rate-limit';
import { liveNetworkCounts } from '../utils';
import {
  fail,
  ok,
  rateLimited,
  resolveCallerOrInit,
  validationFail,
  type WriteResult,
  writeFailureToResult,
  writeToFastData,
} from './_shared';

export async function handleUpdateProfile(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  // First-write creates a default profile if none exists.
  const caller = await resolveCallerOrInit(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('social.profile', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);
  const rlWindow = rl.window;

  // Validation runs here (not inside `buildProfile`) so failures land
  // as structured `WriteResult`s — the SDK builder throws, which would
  // require try/catch translation at every call site.
  const agent = { ...caller.agent };
  const patch: ProfilePatch = {};
  let changed = false;

  if ('name' in body) {
    const name = body.name as string | null;
    if (name != null) {
      const e = validateName(name);
      if (e) return validationFail(e);
    }
    agent.name = name;
    patch.name = name;
    changed = true;
  }
  if (typeof body.description === 'string') {
    const e = validateDescription(body.description);
    if (e) return validationFail(e);
    agent.description = body.description;
    patch.description = body.description;
    changed = true;
  }
  if ('image' in body) {
    const url = body.image as string | null;
    if (url != null) {
      const e = validateImageUrl(url);
      if (e) return validationFail(e);
    }
    agent.image = url;
    patch.image = url;
    changed = true;
  }
  if (Array.isArray(body.tags)) {
    const { validated, error } = validateTags(body.tags as string[]);
    if (error) return validationFail(error);
    agent.tags = validated;
    patch.tags = validated;
    changed = true;
  }
  if (body.capabilities !== undefined) {
    const e = validateCapabilities(body.capabilities);
    if (e) return validationFail(e);
    agent.capabilities = body.capabilities as Agent['capabilities'];
    patch.capabilities = body.capabilities as Agent['capabilities'];
    changed = true;
  }

  if (!changed) {
    return fail(
      'VALIDATION_ERROR',
      'No valid fields to update (supported: name, description, image, tags, capabilities)',
    );
  }

  // Dropped tags and capability pairs must emit explicit null-writes —
  // otherwise `list_tags` / `list_capabilities` keep returning ghost indexes.
  const { entries } = buildProfile(caller.accountId, caller.agent, patch);
  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) return writeFailureToResult(wrote, caller.accountId);

  incrementRateLimit('social.profile', caller.accountId, rlWindow);

  // Overlay live counts on the response so clients receive the same agent
  // shape as heartbeat returns (stored profiles don't carry count fields).
  const counts = await liveNetworkCounts(caller.accountId);
  const responseAgent: Agent = { ...agent, ...counts };
  return ok({
    agent: responseAgent,
    profile_completeness: profileCompleteness(responseAgent),
  });
}
