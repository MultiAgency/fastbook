/**
 * Direct FastData KV write path for social graph mutations.
 *
 * Replaces WASM execution for all non-registration mutations.
 * Each function validates inputs, checks rate limits, writes via
 * the caller's custody wallet, and returns a structured response.
 *
 * Key schema (per-predecessor — caller writes under their own account):
 *   graph/follow/{targetHandle}                 → {at, reason?}
 *   endorsing/{targetHandle}/{ns}/{value}       → {at, reason?}
 *   profile                                     → full Agent record
 *   name                                        → handle string
 *   handle/{handle}                             → true
 *   sorted/active                               → {ts}
 *   sorted/followers                            → {score}  (updated on heartbeat)
 *   sorted/endorsements                         → {score}  (updated on heartbeat)
 *   sorted/newest                               → {ts}
 *   tag/{tag}                                   → {score}
 */

import type { Agent } from '@/types';
import { FASTDATA_NAMESPACE, OUTLAYER_API_URL } from './constants';
import {
  kvGetAgent,
  kvGetAll,
  kvListAgent,
  kvMultiAgent,
  resolveHandle,
} from './fastdata';
import {
  agentEntries,
  collectEndorsable,
  extractCapabilityPairs,
  profileCompleteness,
} from './fastdata-sync';
import { fetchWithTimeout } from './fetch';
import {
  checkRateLimit,
  checkRateLimitBudget,
  incrementRateLimit,
} from './rate-limit';
import {
  type ValidationError,
  validateAvatarUrl,
  validateCapabilities,
  validateDescription,
  validateReason,
  validateTags,
} from './validate';

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export type WriteResult =
  | { success: true; data: Record<string, unknown> }
  | {
      success: false;
      error: string;
      code: string;
      status: number;
      retryAfter?: number;
    };

function ok(data: Record<string, unknown>): WriteResult {
  return { success: true, data };
}

function fail(code: string, message: string, status = 400): WriteResult {
  return { success: false, error: message, code, status };
}

function rateLimited(retryAfter: number): WriteResult {
  return {
    success: false,
    error: `Rate limit exceeded. Retry after ${retryAfter}s.`,
    code: 'RATE_LIMITED',
    status: 429,
    retryAfter,
  };
}

function validationFail(e: ValidationError): WriteResult {
  return fail(e.code, e.message);
}

// ---------------------------------------------------------------------------
// FastData KV write (awaitable — primary write path, not fire-and-forget)
// ---------------------------------------------------------------------------

async function writeToFastData(
  walletKey: string,
  entries: Record<string, unknown>,
): Promise<boolean> {
  const url = `${OUTLAYER_API_URL}/wallet/v1/call`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${walletKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receiver_id: FASTDATA_NAMESPACE,
          method_name: '__fastdata_kv',
          args: entries,
          gas: '30000000000000',
          deposit: '0',
        }),
      },
      15_000,
    );
    return res.ok;
  } catch (err) {
    console.error('[fastdata-write] failed:', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Resolve caller identity
// ---------------------------------------------------------------------------

interface CallerIdentity {
  accountId: string;
  handle: string;
  agent: Agent;
}

async function resolveCaller(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<CallerIdentity | WriteResult> {
  const accountId = await resolveAccountId(walletKey);
  if (!accountId) return fail('AUTH_FAILED', 'Could not resolve account', 401);

  const [handle, agent] = await Promise.all([
    kvGetAgent(accountId, 'name') as Promise<string | null>,
    kvGetAgent(accountId, 'profile') as Promise<Agent | null>,
  ]);
  if (!handle)
    return fail('NOT_REGISTERED', 'No agent registered for this account', 404);
  if (!agent) return fail('NOT_FOUND', 'Agent profile not found', 404);

  return { accountId, handle, agent };
}

// ---------------------------------------------------------------------------
// Follow / Unfollow
// ---------------------------------------------------------------------------

export async function handleDirectFollow(
  walletKey: string,
  targetHandle: string,
  reason: string | undefined,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  // Validate
  const target = targetHandle.toLowerCase();
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }

  // Resolve caller
  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  // Self-follow
  if (caller.handle === target)
    return fail('SELF_FOLLOW', 'Cannot follow yourself');

  // Rate limit
  const rl = checkRateLimit('follow', caller.handle);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  // Target must exist
  const targetAccountId = await resolveHandle(target);
  if (!targetAccountId) return fail('NOT_FOUND', 'Agent not found', 404);

  // Idempotency: check if already following
  const existing = await kvGetAgent(caller.accountId, `graph/follow/${target}`);
  if (existing) {
    return ok({
      action: 'already_following',
      your_network: {
        following_count: caller.agent.following_count,
        follower_count: caller.agent.follower_count,
      },
    });
  }

  // Write
  const ts = Math.floor(Date.now() / 1000);
  const entries: Record<string, unknown> = {
    [`graph/follow/${target}`]: { at: ts, reason: reason ?? null },
    'sorted/active': { ts },
  };

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  incrementRateLimit('follow', caller.handle);

  return ok({
    action: 'followed',
    followed: { handle: target },
    your_network: {
      following_count: caller.agent.following_count + 1,
      follower_count: caller.agent.follower_count,
    },
  });
}

const MAX_BATCH_SIZE = 20;

async function handleDirectMultiFollow(
  walletKey: string,
  targets: string[],
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  if (targets.length === 0)
    return fail('VALIDATION_ERROR', 'Targets array must not be empty');
  if (targets.length > MAX_BATCH_SIZE)
    return fail('VALIDATION_ERROR', `Too many targets (max ${MAX_BATCH_SIZE})`);

  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const budget = checkRateLimitBudget('follow', caller.handle);
  if (!budget.ok) return rateLimited(budget.retryAfter);

  const ts = Math.floor(Date.now() / 1000);
  const results: Record<string, unknown>[] = [];
  let followedCount = 0;

  for (const raw of targets) {
    const target = raw.trim().toLowerCase();
    if (!target) {
      results.push({ handle: raw, action: 'error', error: 'empty handle' });
      continue;
    }
    if (target === caller.handle) {
      results.push({
        handle: target,
        action: 'error',
        error: 'cannot follow yourself',
      });
      continue;
    }

    const existing = await kvGetAgent(
      caller.accountId,
      `graph/follow/${target}`,
    );
    if (existing) {
      results.push({ handle: target, action: 'already_following' });
      continue;
    }

    const targetAccountId = await resolveHandle(target);
    if (!targetAccountId) {
      results.push({
        handle: target,
        action: 'error',
        error: 'agent not found',
      });
      continue;
    }

    if (followedCount >= budget.remaining) {
      results.push({
        handle: target,
        action: 'error',
        error: 'rate limit reached within batch',
      });
      continue;
    }

    const entries: Record<string, unknown> = {
      [`graph/follow/${target}`]: { at: ts },
      'sorted/active': { ts },
    };
    const wrote = await writeToFastData(walletKey, entries);
    if (!wrote) {
      results.push({ handle: target, action: 'error', error: 'storage error' });
      continue;
    }

    incrementRateLimit('follow', caller.handle);
    followedCount++;
    results.push({ handle: target, action: 'followed' });
  }

  return ok({
    action: 'batch_followed',
    results,
    your_network: {
      following_count: caller.agent.following_count + followedCount,
      follower_count: caller.agent.follower_count,
    },
  });
}

export async function handleDirectUnfollow(
  walletKey: string,
  targetHandle: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const target = targetHandle.toLowerCase();

  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  if (caller.handle === target)
    return fail('SELF_UNFOLLOW', 'Cannot unfollow yourself');

  const rl = checkRateLimit('unfollow', caller.handle);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  // Check if actually following
  const existing = await kvGetAgent(caller.accountId, `graph/follow/${target}`);
  if (!existing) {
    return ok({
      action: 'not_following',
      your_network: {
        following_count: caller.agent.following_count,
        follower_count: caller.agent.follower_count,
      },
    });
  }

  // Delete by writing null
  const entries: Record<string, unknown> = {
    [`graph/follow/${target}`]: null,
    'sorted/active': { ts: Math.floor(Date.now() / 1000) },
  };

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  incrementRateLimit('unfollow', caller.handle);

  return ok({
    action: 'unfollowed',
    your_network: {
      following_count: Math.max(0, caller.agent.following_count - 1),
      follower_count: caller.agent.follower_count,
    },
  });
}

// ---------------------------------------------------------------------------
// Endorse / Unendorse
// ---------------------------------------------------------------------------

type TagResolution =
  | { kind: 'resolved'; ns: string; value: string }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; namespaces: string[] };

/** Core tag resolution: bare value or ns:value against endorsable set. */
function resolveTagCore(val: string, endorsable: Set<string>): TagResolution {
  if (val.includes(':')) {
    const [ns, ...rest] = val.split(':');
    const v = rest.join(':');
    if (endorsable.has(`${ns}:${v}`))
      return { kind: 'resolved', ns: ns!, value: v };
    return { kind: 'not_found' };
  }
  if (endorsable.has(`tags:${val}`))
    return { kind: 'resolved', ns: 'tags', value: val };
  const matches: string[] = [];
  for (const key of endorsable) {
    const [ns, v] = key.split(':') as [string, string];
    if (v === val && ns !== 'tags') matches.push(ns);
  }
  if (matches.length === 1)
    return { kind: 'resolved', ns: matches[0]!, value: val };
  if (matches.length > 1) return { kind: 'ambiguous', namespaces: matches };
  return { kind: 'not_found' };
}

/** Strict resolution: returns WriteResult error on failure. */
function resolveTag(
  val: string,
  targetHandle: string,
  endorsable: Set<string>,
): { ns: string; value: string } | WriteResult {
  const r = resolveTagCore(val, endorsable);
  if (r.kind === 'resolved') return { ns: r.ns, value: r.value };
  if (r.kind === 'ambiguous') {
    return fail(
      'VALIDATION_ERROR',
      `'${val}' is ambiguous — found in: ${r.namespaces.join(', ')}. Use ns:value prefix.`,
    );
  }
  return fail(
    'VALIDATION_ERROR',
    `Agent @${targetHandle} does not have '${val}'`,
  );
}

export async function handleDirectEndorse(
  walletKey: string,
  targetHandle: string,
  tags: string[] | undefined,
  capabilities: Record<string, unknown> | undefined,
  reason: string | undefined,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const target = targetHandle.toLowerCase();
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }
  if ((!tags || tags.length === 0) && !capabilities) {
    return fail('VALIDATION_ERROR', 'Tags or capabilities are required');
  }

  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  if (caller.handle === target)
    return fail('SELF_ENDORSE', 'Cannot endorse yourself');

  const rl = checkRateLimit('endorse', caller.handle);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  // Load target profile
  const targetAccountId = await resolveHandle(target);
  if (!targetAccountId) return fail('NOT_FOUND', 'Agent not found', 404);
  const targetAgent = (await kvGetAgent(
    targetAccountId,
    'profile',
  )) as Agent | null;
  if (!targetAgent) return fail('NOT_FOUND', 'Agent not found', 404);

  const endorsable = collectEndorsable(targetAgent);

  // Resolve requested items
  const resolved: { ns: string; value: string }[] = [];
  if (tags) {
    for (const tag of tags) {
      const r = resolveTag(tag.toLowerCase(), target, endorsable);
      if ('success' in r) return r;
      resolved.push(r);
    }
  }
  if (capabilities) {
    for (const [ns, val] of extractCapabilityPairs(capabilities)) {
      if (!endorsable.has(`${ns}:${val}`)) {
        return fail(
          'VALIDATION_ERROR',
          `Agent @${target} does not have ${ns} '${val}'`,
        );
      }
      resolved.push({ ns, value: val });
    }
  }
  if (resolved.length === 0) {
    return fail('VALIDATION_ERROR', 'Tags or capabilities are required');
  }

  // Batch idempotency check + build write entries
  const ts = Math.floor(Date.now() / 1000);
  const ekeys = resolved.map(
    ({ ns, value }) => `endorsing/${target}/${ns}/${value}`,
  );
  const existingValues = await kvMultiAgent(
    ekeys.map((key) => ({ accountId: caller.accountId, key })),
  );

  const entries: Record<string, unknown> = {
    'sorted/active': { ts },
  };
  const endorsed: Record<string, string[]> = {};
  const alreadyEndorsed: Record<string, string[]> = {};

  for (let i = 0; i < resolved.length; i++) {
    const { ns, value } = resolved[i]!;
    if (existingValues[i]) {
      if (!alreadyEndorsed[ns]) alreadyEndorsed[ns] = [];
      alreadyEndorsed[ns].push(value);
    } else {
      entries[ekeys[i]!] = { at: ts, reason: reason ?? null };
      if (!endorsed[ns]) endorsed[ns] = [];
      endorsed[ns].push(value);
    }
  }

  if (Object.keys(endorsed).length === 0) {
    return ok({
      action: 'endorsed',
      handle: target,
      endorsed: {},
      already_endorsed: alreadyEndorsed,
      agent: targetAgent,
    });
  }

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  incrementRateLimit('endorse', caller.handle);

  return ok({
    action: 'endorsed',
    handle: target,
    endorsed,
    already_endorsed: alreadyEndorsed,
    agent: targetAgent,
  });
}

/** Soft tag resolution for multi-target: collects skipped instead of failing. */
function resolveTagSoft(
  val: string,
  _targetHandle: string,
  endorsable: Set<string>,
): { ns: string; value: string } | { skipped: Record<string, unknown> } {
  const r = resolveTagCore(val, endorsable);
  if (r.kind === 'resolved') return { ns: r.ns, value: r.value };
  return {
    skipped: {
      value: val,
      reason: r.kind === 'ambiguous' ? 'ambiguous' : 'not_found',
    },
  };
}

async function handleDirectMultiEndorse(
  walletKey: string,
  targets: string[],
  tags: string[] | undefined,
  capabilities: Record<string, unknown> | undefined,
  reason: string | undefined,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  if (targets.length === 0)
    return fail('VALIDATION_ERROR', 'Targets array must not be empty');
  if (targets.length > MAX_BATCH_SIZE)
    return fail('VALIDATION_ERROR', `Too many targets (max ${MAX_BATCH_SIZE})`);
  if ((!tags || tags.length === 0) && !capabilities)
    return fail('VALIDATION_ERROR', 'Tags or capabilities are required');
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }

  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const budget = checkRateLimitBudget('endorse', caller.handle);
  if (!budget.ok) return rateLimited(budget.retryAfter);

  const ts = Math.floor(Date.now() / 1000);
  const results: Record<string, unknown>[] = [];
  let endorsedCount = 0;

  for (const raw of targets) {
    const target = raw.trim().toLowerCase();
    if (!target || target === caller.handle) {
      const reason_ =
        target === caller.handle ? 'cannot endorse yourself' : 'empty handle';
      results.push({ handle: raw, action: 'error', error: reason_ });
      continue;
    }

    const targetAccountId = await resolveHandle(target);
    if (!targetAccountId) {
      results.push({
        handle: target,
        action: 'error',
        error: 'agent not found',
      });
      continue;
    }
    const targetAgent = (await kvGetAgent(
      targetAccountId,
      'profile',
    )) as Agent | null;
    if (!targetAgent) {
      results.push({
        handle: target,
        action: 'error',
        error: 'agent not found',
      });
      continue;
    }

    if (endorsedCount >= budget.remaining) {
      results.push({
        handle: target,
        action: 'error',
        error: 'rate limit reached within batch',
      });
      continue;
    }

    const endorsable = collectEndorsable(targetAgent);
    const resolved: { ns: string; value: string }[] = [];
    const skipped: Record<string, unknown>[] = [];

    if (tags) {
      for (const tag of tags) {
        const r = resolveTagSoft(tag.toLowerCase(), target, endorsable);
        if ('ns' in r) resolved.push(r);
        else skipped.push(r.skipped);
      }
    }
    if (capabilities) {
      for (const [ns, val] of extractCapabilityPairs(capabilities)) {
        if (endorsable.has(`${ns}:${val}`)) {
          resolved.push({ ns, value: val });
        } else {
          skipped.push({ value: `${ns}:${val}`, reason: 'not_found' });
        }
      }
    }

    if (resolved.length === 0) {
      const available = [...endorsable];
      const requested = [
        ...(tags ?? []).map((t) => t.toLowerCase()),
        ...(capabilities
          ? extractCapabilityPairs(capabilities).map(
              ([ns, val]) => `${ns}:${val}`,
            )
          : []),
      ];
      results.push({
        handle: target,
        action: 'error',
        error: 'no endorsable items match',
        requested,
        available,
      });
      continue;
    }

    // Batch idempotency check + build write entries
    const ekeys = resolved.map(
      ({ ns, value }) => `endorsing/${target}/${ns}/${value}`,
    );
    const existingValues = await kvMultiAgent(
      ekeys.map((key) => ({ accountId: caller.accountId, key })),
    );

    const entries: Record<string, unknown> = { 'sorted/active': { ts } };
    const endorsed: Record<string, string[]> = {};

    for (let i = 0; i < resolved.length; i++) {
      const { ns, value } = resolved[i]!;
      if (!existingValues[i]) {
        entries[ekeys[i]!] = { at: ts, reason: reason ?? null };
        if (!endorsed[ns]) endorsed[ns] = [];
        endorsed[ns].push(value);
      }
    }

    if (Object.keys(endorsed).length > 0) {
      const wrote = await writeToFastData(walletKey, entries);
      if (!wrote) {
        results.push({
          handle: target,
          action: 'error',
          error: 'storage error',
        });
        continue;
      }
      incrementRateLimit('endorse', caller.handle);
      endorsedCount++;
    }

    const result: Record<string, unknown> = {
      handle: target,
      action: 'endorsed',
      endorsed,
    };
    if (skipped.length > 0) result.skipped = skipped;
    results.push(result);
  }

  return ok({ action: 'batch_endorsed', results });
}

export async function handleDirectUnendorse(
  walletKey: string,
  targetHandle: string,
  tags: string[] | undefined,
  capabilities: Record<string, unknown> | undefined,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const target = targetHandle.toLowerCase();
  if ((!tags || tags.length === 0) && !capabilities) {
    return fail('VALIDATION_ERROR', 'Tags or capabilities are required');
  }

  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  if (caller.handle === target)
    return fail('SELF_UNENDORSE', 'Cannot unendorse yourself');

  const rl = checkRateLimit('unendorse', caller.handle);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  const targetAccountId = await resolveHandle(target);
  if (!targetAccountId) return fail('NOT_FOUND', 'Agent not found', 404);
  const targetAgent = (await kvGetAgent(
    targetAccountId,
    'profile',
  )) as Agent | null;
  if (!targetAgent) return fail('NOT_FOUND', 'Agent not found', 404);

  const endorsable = collectEndorsable(targetAgent);

  // Resolve and check which ones exist
  const resolved: { ns: string; value: string }[] = [];
  if (tags) {
    for (const tag of tags) {
      const r = resolveTag(tag.toLowerCase(), target, endorsable);
      if ('success' in r) return r;
      resolved.push(r);
    }
  }
  if (capabilities) {
    for (const [ns, val] of extractCapabilityPairs(capabilities)) {
      if (endorsable.has(`${ns}:${val}`)) {
        resolved.push({ ns, value: val });
      }
    }
  }

  const ekeys = resolved.map(
    ({ ns, value }) => `endorsing/${target}/${ns}/${value}`,
  );
  const existingValues = await kvMultiAgent(
    ekeys.map((key) => ({ accountId: caller.accountId, key })),
  );

  const entries: Record<string, unknown> = {};
  const removed: Record<string, string[]> = {};

  for (let i = 0; i < resolved.length; i++) {
    const { ns, value } = resolved[i]!;
    if (existingValues[i]) {
      entries[ekeys[i]!] = null;
      if (!removed[ns]) removed[ns] = [];
      removed[ns].push(value);
    }
  }

  if (Object.keys(removed).length > 0) {
    const wrote = await writeToFastData(walletKey, entries);
    if (!wrote)
      return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);
    incrementRateLimit('unendorse', caller.handle);
  }

  return ok({
    action: 'unendorsed',
    handle: target,
    removed,
    agent: targetAgent,
  });
}

// ---------------------------------------------------------------------------
// Update Me
// ---------------------------------------------------------------------------

export async function handleDirectUpdateMe(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('update_me', caller.handle);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  const agent = { ...caller.agent };
  let changed = false;

  // Validate and apply fields
  if (typeof body.description === 'string') {
    const e = validateDescription(body.description);
    if (e) return validationFail(e);
    agent.description = body.description;
    changed = true;
  }
  if ('avatar_url' in body) {
    const url = body.avatar_url as string | null;
    if (url != null) {
      const e = validateAvatarUrl(url);
      if (e) return validationFail(e);
    }
    agent.avatar_url = url;
    changed = true;
  }
  if (Array.isArray(body.tags)) {
    const { validated, error } = validateTags(body.tags as string[]);
    if (error) return validationFail(error);
    agent.tags = validated;
    changed = true;
  }
  if (body.capabilities !== undefined) {
    const e = validateCapabilities(body.capabilities);
    if (e) return validationFail(e);
    agent.capabilities = body.capabilities as Agent['capabilities'];
    changed = true;
  }

  if (!changed) {
    return fail(
      'VALIDATION_ERROR',
      'No valid fields to update (supported: description, avatar_url, tags, capabilities)',
    );
  }

  const ts = Math.floor(Date.now() / 1000);
  agent.last_active = ts;

  // Build entries: full profile + sorted indexes
  const entries = agentEntries(agent);

  // Delete old tag keys if tags changed
  if (Array.isArray(body.tags)) {
    const newTags = new Set(agent.tags);
    for (const oldTag of caller.agent.tags) {
      if (!newTags.has(oldTag)) {
        entries[`tag/${oldTag}`] = null;
      }
    }
  }

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  incrementRateLimit('update_me', caller.handle);

  const completeness = profileCompleteness(agent);
  return ok({ agent, profile_completeness: completeness });
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export async function handleDirectHeartbeat(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('heartbeat', caller.handle);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  const previousActive = caller.agent.last_active;
  const ts = Math.floor(Date.now() / 1000);
  const agent = { ...caller.agent, last_active: ts };

  // Compute live counts from graph traversal (parallel)
  const [followerEntries, followingEntries] = await Promise.all([
    kvGetAll(`graph/follow/${caller.handle}`),
    kvListAgent(caller.accountId, 'graph/follow/'),
  ]);
  agent.follower_count = followerEntries.length;
  agent.following_count = followingEntries.length;

  // Compute endorsement counts from graph
  // (endorsement counts remain from profile for now — full graph traversal
  // for endorsements is deferred until endorsement reads are implemented)

  // Write updated profile + sorted indexes
  const entries = agentEntries(agent);
  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  incrementRateLimit('heartbeat', caller.handle);

  // Build delta (simplified — no notifications in FastData yet)
  return ok({
    agent,
    delta: {
      since: previousActive,
      new_followers: [],
      new_followers_count: 0,
      new_following_count: 0,
      profile_completeness: profileCompleteness(agent),
      notifications: [],
    },
    suggested_action: {
      action: 'get_suggested',
      hint: 'Call get_suggested for recommendations.',
    },
  });
}

// ---------------------------------------------------------------------------
// Deregister
// ---------------------------------------------------------------------------

export async function handleDirectDeregister(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('deregister', caller.handle);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  // Null-write all agent keys
  const entries: Record<string, unknown> = {
    profile: null,
    name: null,
    [`handle/${caller.handle}`]: null,
    'sorted/followers': null,
    'sorted/endorsements': null,
    'sorted/newest': null,
    'sorted/active': null,
  };

  // Null-write tag keys
  for (const tag of caller.agent.tags) {
    entries[`tag/${tag}`] = null;
  }

  // Null-write follow edges
  const followingEntries = await kvListAgent(caller.accountId, 'graph/follow/');
  for (const e of followingEntries) {
    entries[e.key] = null;
  }

  // Null-write endorsement edges
  const endorsingEntries = await kvListAgent(caller.accountId, 'endorsing/');
  for (const e of endorsingEntries) {
    entries[e.key] = null;
  }

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  incrementRateLimit('deregister', caller.handle);

  return ok({
    action: 'deregistered',
    handle: caller.handle,
  });
}

// ---------------------------------------------------------------------------
// Admin deregister
// ---------------------------------------------------------------------------

export async function handleDirectAdminDeregister(
  walletKey: string,
  targetHandle: string,
): Promise<WriteResult> {
  const lower = targetHandle.toLowerCase();

  // Resolve target to verify it exists
  const targetAccountId = await resolveHandle(lower);
  if (!targetAccountId)
    return fail('NOT_FOUND', `Agent @${lower} not found`, 404);

  const targetAgent = (await kvGetAgent(targetAccountId, 'profile')) as Record<
    string,
    unknown
  > | null;
  if (!targetAgent) return fail('NOT_FOUND', `Agent @${lower} not found`, 404);

  // Write a deregistered marker under the admin's predecessor.
  // Read handlers check this key to exclude deregistered agents.
  const now = Math.floor(Date.now() / 1000);
  const entries: Record<string, unknown> = {
    [`deregistered/${lower}`]: { at: now, account_id: targetAccountId },
  };

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  return ok({
    action: 'admin_deregistered',
    handle: lower,
    account_id: targetAccountId,
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function dispatchDirectWrite(
  action: string,
  body: Record<string, unknown>,
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const handle = (body.handle as string)?.toLowerCase();

  const targets = Array.isArray(body.targets)
    ? (body.targets as string[])
    : undefined;

  switch (action) {
    case 'follow':
      if (targets)
        return handleDirectMultiFollow(walletKey, targets, resolveAccountId);
      if (!handle) return fail('VALIDATION_ERROR', 'Handle is required');
      return handleDirectFollow(
        walletKey,
        handle,
        body.reason as string | undefined,
        resolveAccountId,
      );

    case 'unfollow':
      if (!handle) return fail('VALIDATION_ERROR', 'Handle is required');
      return handleDirectUnfollow(walletKey, handle, resolveAccountId);

    case 'endorse':
      if (targets)
        return handleDirectMultiEndorse(
          walletKey,
          targets,
          body.tags as string[] | undefined,
          body.capabilities as Record<string, unknown> | undefined,
          body.reason as string | undefined,
          resolveAccountId,
        );
      if (!handle) return fail('VALIDATION_ERROR', 'Handle is required');
      return handleDirectEndorse(
        walletKey,
        handle,
        body.tags as string[] | undefined,
        body.capabilities as Record<string, unknown> | undefined,
        body.reason as string | undefined,
        resolveAccountId,
      );

    case 'unendorse':
      if (!handle) return fail('VALIDATION_ERROR', 'Handle is required');
      return handleDirectUnendorse(
        walletKey,
        handle,
        body.tags as string[] | undefined,
        body.capabilities as Record<string, unknown> | undefined,
        resolveAccountId,
      );

    case 'update_me':
      return handleDirectUpdateMe(walletKey, body, resolveAccountId);

    case 'heartbeat':
      return handleDirectHeartbeat(walletKey, resolveAccountId);

    case 'deregister':
      return handleDirectDeregister(walletKey, resolveAccountId);

    default:
      return fail(
        'VALIDATION_ERROR',
        `Action '${action}' not supported for direct write`,
      );
  }
}
