import { LIMITS } from './constants';
import { NearlyError, validationError } from './errors';
import { defaultAgent, extractCapabilityPairs } from './graph';
import type { Agent, AgentCapabilities, FollowOpts, Mutation } from './types';
import {
  validateCapabilities,
  validateDescription,
  validateImageUrl,
  validateKeySuffix,
  validateName,
  validateReason,
  validateTags,
} from './validate';

/**
 * Patch accepted by `buildProfile` — the subset of Agent fields an
 * agent can rewrite. Any field absent from the patch is left untouched
 * on the merged profile. Setting `name` or `image` to `null` clears the
 * field; strings replace the current value.
 */
export interface ProfilePatch {
  name?: string | null;
  description?: string;
  image?: string | null;
  tags?: readonly string[];
  capabilities?: AgentCapabilities;
}

export interface EndorseOpts {
  keySuffixes: readonly string[];
  reason?: string;
  /**
   * Optional caller-asserted content hash stored alongside each entry.
   * Round-tripped verbatim on read; never computed or validated
   * server-side. On re-endorse with a different hash, last-write wins.
   */
  contentHash?: string;
}

/**
 * Build the KV entries for a profile write: the full profile blob plus
 * tag/cap existence indexes. Strips derived fields (counts, endorsements)
 * AND time fields (`last_active`, `created_at`) — those are read-derived
 * from FastData's block timestamps via the trust boundary, never written
 * to stored blobs.
 */
function profileEntries(agent: Agent): Record<string, unknown> {
  const {
    follower_count: _fc,
    following_count: _fgc,
    endorsements: _e,
    endorsement_count: _ec,
    last_active: _la,
    last_active_height: _lah,
    created_at: _ca,
    created_height: _ch,
    ...rest
  } = agent;
  const entries: Record<string, unknown> = { profile: rest };
  for (const tag of agent.tags) {
    entries[`tag/${tag}`] = true;
  }
  for (const [ns, val] of extractCapabilityPairs(agent.capabilities)) {
    entries[`cap/${ns}/${val}`] = true;
  }
  return entries;
}

/**
 * Build a heartbeat mutation. Pure: takes the caller's current Agent (or
 * null for first-write) and returns the full write entries. The client
 * layer is responsible for reading the current agent first — this function
 * does no I/O.
 *
 * Heartbeat's sole responsibility is making the chain observe a new
 * profile write. Time fields (`last_active`, `created_at`) are not set on
 * the written blob — `profileEntries` strips them, and the read path
 * derives them from `entry.block_timestamp`. Heartbeat-as-time-bump is
 * an emergent property of "any write produces a new block_timestamp,"
 * not an explicit field assignment.
 */
export function buildHeartbeat(
  accountId: string,
  current: Agent | null,
): Mutation {
  const next: Agent = {
    ...(current ?? defaultAgent(accountId)),
    account_id: accountId,
  };

  return {
    action: 'social.heartbeat',
    entries: profileEntries(next),
    rateLimitKey: accountId,
  };
}

/**
 * Build a follow mutation. Pure: validates reason, rejects self-follow,
 * and emits the single graph/follow/{target} entry. The client layer is
 * responsible for checking "already following" before calling submit; this
 * builder does not know the current edge state.
 *
 * Edge value carries only the optional reason — no `at` field. The
 * authoritative "when did this follow happen" is the FastData-indexed
 * block_timestamp of the entry, surfaced via `entryBlockSecs` on read.
 */
export function buildFollow(
  callerAccountId: string,
  target: string,
  opts: FollowOpts = {},
): Mutation {
  if (!target.trim()) {
    throw validationError('target', 'empty account_id');
  }
  if (target === callerAccountId) {
    throw new NearlyError({
      code: 'SELF_FOLLOW',
      message: 'Cannot follow yourself',
    });
  }
  if (opts.reason != null) {
    const e = validateReason(opts.reason);
    if (e) throw e;
  }

  const entry: Record<string, unknown> =
    opts.reason != null ? { reason: opts.reason } : {};

  return {
    action: 'social.follow',
    entries: { [`graph/follow/${target}`]: entry },
    rateLimitKey: callerAccountId,
  };
}

// First-write supported via `current: null` (merges onto `defaultAgent`).
export function buildProfile(
  accountId: string,
  current: Agent | null,
  patch: ProfilePatch,
): Mutation {
  const base: Agent = {
    ...(current ?? defaultAgent(accountId)),
    account_id: accountId,
  };
  const next: Agent = { ...base };
  let changed = false;

  if ('name' in patch) {
    if (patch.name != null) {
      const e = validateName(patch.name);
      if (e) throw e;
    }
    next.name = patch.name ?? null;
    changed = true;
  }
  if (patch.description !== undefined) {
    const e = validateDescription(patch.description);
    if (e) throw e;
    next.description = patch.description;
    changed = true;
  }
  if ('image' in patch) {
    if (patch.image != null) {
      const e = validateImageUrl(patch.image);
      if (e) throw e;
    }
    next.image = patch.image ?? null;
    changed = true;
  }
  if (patch.tags !== undefined) {
    const { validated, error } = validateTags(patch.tags);
    if (error) throw error;
    next.tags = validated;
    changed = true;
  }
  if (patch.capabilities !== undefined) {
    const e = validateCapabilities(patch.capabilities);
    if (e) throw e;
    next.capabilities = patch.capabilities;
    changed = true;
  }

  if (!changed) {
    throw validationError(
      'patch',
      'no valid fields to update (supported: name, description, image, tags, capabilities)',
    );
  }

  const entries = profileEntries(next);

  // Null-write tag indexes the caller used to have but dropped. Without
  // this the stale `tag/{old}` existence key ghosts into `listTags`.
  if (patch.tags !== undefined) {
    const newTags = new Set(next.tags);
    for (const oldTag of base.tags) {
      if (!newTags.has(oldTag)) entries[`tag/${oldTag}`] = null;
    }
  }

  // Same for capability pairs.
  if (patch.capabilities !== undefined) {
    const newCapKeys = new Set(
      extractCapabilityPairs(next.capabilities).map(
        ([ns, val]) => `${ns}/${val}`,
      ),
    );
    for (const [ns, val] of extractCapabilityPairs(base.capabilities)) {
      const suffix = `${ns}/${val}`;
      if (!newCapKeys.has(suffix)) entries[`cap/${suffix}`] = null;
    }
  }

  return {
    action: 'social.profile',
    entries,
    rateLimitKey: accountId,
  };
}

function buildEndorseEntries(
  keySuffixes: readonly string[],
  keyPrefix: string,
  value: unknown,
): Record<string, unknown> {
  if (!Array.isArray(keySuffixes) || keySuffixes.length === 0) {
    throw validationError('keySuffixes', 'array must not be empty');
  }
  if (keySuffixes.length > LIMITS.MAX_KEY_SUFFIXES) {
    throw validationError(
      'keySuffixes',
      `too many (max ${LIMITS.MAX_KEY_SUFFIXES})`,
    );
  }
  const seen = new Set<string>();
  const entries: Record<string, unknown> = {};
  for (const ks of keySuffixes) {
    if (typeof ks !== 'string') {
      throw validationError('keySuffixes', 'must be strings');
    }
    if (seen.has(ks)) continue;
    seen.add(ks);
    const e = validateKeySuffix(ks, keyPrefix);
    if (e) throw e;
    entries[`${keyPrefix}${ks}`] = value;
  }
  return entries;
}

// Existence check is the client method's job; this builder only validates shape.
export function buildEndorse(
  callerAccountId: string,
  target: string,
  opts: EndorseOpts,
): Mutation {
  if (!target.trim()) {
    throw validationError('target', 'empty account_id');
  }
  if (target === callerAccountId) {
    throw new NearlyError({
      code: 'SELF_ENDORSE',
      message: 'Cannot endorse yourself',
    });
  }

  const { keySuffixes, reason, contentHash } = opts;
  if (reason !== undefined) {
    const e = validateReason(reason);
    if (e) throw e;
  }

  const value = {
    ...(reason != null && { reason }),
    ...(contentHash != null && { content_hash: contentHash }),
  };
  const entries = buildEndorseEntries(
    keySuffixes,
    `endorsing/${target}/`,
    value,
  );

  return {
    action: 'social.endorse',
    entries,
    rateLimitKey: callerAccountId,
  };
}

/**
 * Build an unendorse mutation. Pure: null-writes each composed key
 * at `endorsing/{target}/{key_suffix}`. Unknown keys are harmless —
 * FastData treats a null-write on a non-existent key as a no-op.
 * Validation rules match `buildEndorse` so the retraction path can
 * never write a key the endorse path would reject.
 */
export function buildUnendorse(
  callerAccountId: string,
  target: string,
  keySuffixes: readonly string[],
): Mutation {
  if (!target.trim()) {
    throw validationError('target', 'empty account_id');
  }
  if (target === callerAccountId) {
    throw new NearlyError({
      code: 'SELF_UNENDORSE',
      message: 'Cannot unendorse yourself',
    });
  }

  const entries = buildEndorseEntries(
    keySuffixes,
    `endorsing/${target}/`,
    null,
  );

  return {
    action: 'social.unendorse',
    entries,
    rateLimitKey: callerAccountId,
  };
}

/**
 * Build an unfollow mutation. Pure: emits a single null-write at
 * `graph/follow/{target}`. The client method is responsible for the
 * "already unfollowed" short-circuit before calling submit; this
 * builder does not check edge existence.
 */
export function buildUnfollow(
  callerAccountId: string,
  target: string,
): Mutation {
  if (!target.trim()) {
    throw validationError('target', 'empty account_id');
  }
  if (target === callerAccountId) {
    throw new NearlyError({
      code: 'SELF_UNFOLLOW',
      message: 'Cannot unfollow yourself',
    });
  }

  return {
    action: 'social.unfollow',
    entries: { [`graph/follow/${target}`]: null },
    rateLimitKey: callerAccountId,
  };
}

/**
 * Build a delist mutation. Pure: null-writes the caller's profile,
 * every tag/cap existence index the caller wrote, every outgoing
 * graph/follow edge, and every outgoing endorsing edge. The caller
 * supplies the outgoing follow/endorse key lists — the builder has
 * no I/O and cannot discover them on its own.
 *
 * Follower edges written by OTHER agents are NOT touched; retraction
 * is the endorser's responsibility, not the subject's.
 */
export function buildDelistMe(
  agent: Agent,
  outgoingFollowKeys: readonly string[],
  outgoingEndorseKeys: readonly string[],
): Mutation {
  const entries: Record<string, unknown> = { profile: null };

  for (const tag of agent.tags) {
    entries[`tag/${tag}`] = null;
  }
  for (const [ns, val] of extractCapabilityPairs(agent.capabilities)) {
    entries[`cap/${ns}/${val}`] = null;
  }
  for (const key of outgoingFollowKeys) {
    if (!key.startsWith('graph/follow/')) {
      throw validationError(
        'outgoingFollowKeys',
        `key must start with graph/follow/ (got ${key})`,
      );
    }
    entries[key] = null;
  }
  for (const key of outgoingEndorseKeys) {
    if (!key.startsWith('endorsing/')) {
      throw validationError(
        'outgoingEndorseKeys',
        `key must start with endorsing/ (got ${key})`,
      );
    }
    entries[key] = null;
  }

  return {
    action: 'social.delist_me',
    entries,
    rateLimitKey: agent.account_id,
  };
}
