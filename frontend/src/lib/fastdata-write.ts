/**
 * FastData KV write path for social graph mutations.
 *
 * Handles all non-registration mutations via direct FastData writes.
 * Each function validates inputs, checks rate limits, writes via
 * the caller's custody wallet, and returns a structured response.
 *
 * Key schema (per-predecessor — caller writes under their own account):
 *   graph/follow/{targetAccountId}              → {at, reason?}
 *   endorsing/{targetAccountId}/{ns}/{value}    → {at, reason?}
 *   profile                                     → full Agent record
 *   tag/{tag}                                   → {score}
 */

import type { Agent } from '@/types';
import { FASTDATA_NAMESPACE, OUTLAYER_API_URL } from './constants';
import {
  kvGetAgent,
  kvGetAll,
  kvListAgent,
  kvListAll,
  kvMultiAgent,
} from './fastdata';
import {
  agentEntries,
  buildEndorsementCounts,
  collectEndorsable,
  endorsementKey,
  endorsePrefix,
  entryAt,
  extractCapabilityPairs,
  nowSecs,
  profileCompleteness,
  profileSummary,
} from './fastdata-utils';
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
  agent: Agent;
}

async function resolveCaller(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<CallerIdentity | WriteResult> {
  const accountId = await resolveAccountId(walletKey);
  if (!accountId) return fail('AUTH_FAILED', 'Could not resolve account', 401);

  const agent = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  if (!agent) return fail('NOT_REGISTERED', 'Agent profile not found', 404);

  return { accountId, agent };
}

// ---------------------------------------------------------------------------
// Resolve target agent
// ---------------------------------------------------------------------------

interface TargetIdentity {
  accountId: string;
  agent: Agent;
}

async function resolveTargetAgent(
  accountId: string,
): Promise<TargetIdentity | WriteResult> {
  const agent = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  if (!agent) return fail('NOT_FOUND', 'Agent not found', 404);
  return { accountId, agent };
}

/**
 * Create a default agent profile for first-write (heartbeat or update_me).
 * The agent enters the index when they first write — no prior registration needed.
 */
function defaultAgent(accountId: string): Agent {
  const ts = nowSecs();
  return {
    handle: accountId,
    description: '',
    avatar_url: null,
    tags: [],
    capabilities: {},
    endorsements: {},
    platforms: [],
    near_account_id: accountId,
    follower_count: 0,
    following_count: 0,
    created_at: ts,
    last_active: ts,
  };
}

/**
 * Resolve caller, creating a default profile if none exists.
 * Used by heartbeat and update_me — the two entry points for first-write.
 */
async function resolveCallerOrInit(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<CallerIdentity | WriteResult> {
  const accountId = await resolveAccountId(walletKey);
  if (!accountId) return fail('AUTH_FAILED', 'Could not resolve account', 401);

  const existing = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  if (existing) return { accountId, agent: existing };

  // First-write: create default profile. The write itself checks funding.
  const agent = defaultAgent(accountId);
  const wrote = await writeToFastData(walletKey, agentEntries(agent));
  if (!wrote) {
    return fail(
      'WALLET_UNFUNDED',
      'Fund your wallet with ≥0.01 NEAR, then retry.',
      402,
    );
  }

  return { accountId, agent };
}

// ---------------------------------------------------------------------------
// Follow / Unfollow
// ---------------------------------------------------------------------------

export async function handleFollow(
  walletKey: string,
  targetAccountId: string,
  reason: string | undefined,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  // Validate
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }

  // Resolve caller
  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  // Self-follow
  if (caller.accountId === targetAccountId)
    return fail('SELF_FOLLOW', 'Cannot follow yourself');

  // Rate limit
  const rl = checkRateLimit('follow', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  // Target must exist
  const targetAgent = (await kvGetAgent(
    targetAccountId,
    'profile',
  )) as Agent | null;
  if (!targetAgent) return fail('NOT_FOUND', 'Agent not found', 404);

  // Idempotency: check if already following
  const existing = await kvGetAgent(
    caller.accountId,
    `graph/follow/${targetAccountId}`,
  );
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
  const ts = nowSecs();
  const entries: Record<string, unknown> = {
    [`graph/follow/${targetAccountId}`]: { at: ts, reason: reason ?? null },
  };

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  incrementRateLimit('follow', caller.accountId);

  return ok({
    action: 'followed',
    followed: { account_id: targetAccountId },
    your_network: {
      following_count: caller.agent.following_count + 1,
      follower_count: caller.agent.follower_count,
    },
  });
}

const MAX_BATCH_SIZE = 20;

async function handleMultiFollow(
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

  const budget = checkRateLimitBudget('follow', caller.accountId);
  if (!budget.ok) return rateLimited(budget.retryAfter);

  const ts = nowSecs();
  const results: Record<string, unknown>[] = [];
  let followedCount = 0;

  for (const targetAccountId of targets) {
    if (!targetAccountId.trim()) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        error: 'empty account_id',
      });
      continue;
    }
    if (targetAccountId === caller.accountId) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        error: 'cannot follow yourself',
      });
      continue;
    }

    const existing = await kvGetAgent(
      caller.accountId,
      `graph/follow/${targetAccountId}`,
    );
    if (existing) {
      results.push({
        account_id: targetAccountId,
        action: 'already_following',
      });
      continue;
    }

    const targetAgent = (await kvGetAgent(
      targetAccountId,
      'profile',
    )) as Agent | null;
    if (!targetAgent) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        error: 'agent not found',
      });
      continue;
    }

    if (followedCount >= budget.remaining) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        error: 'rate limit reached within batch',
      });
      continue;
    }

    const entries: Record<string, unknown> = {
      [`graph/follow/${targetAccountId}`]: { at: ts },
    };
    const wrote = await writeToFastData(walletKey, entries);
    if (!wrote) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        error: 'storage error',
      });
      continue;
    }

    incrementRateLimit('follow', caller.accountId);
    followedCount++;
    results.push({ account_id: targetAccountId, action: 'followed' });
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

export async function handleUnfollow(
  walletKey: string,
  targetAccountId: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  if (caller.accountId === targetAccountId)
    return fail('SELF_UNFOLLOW', 'Cannot unfollow yourself');

  const rl = checkRateLimit('unfollow', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  // Check if actually following
  const existing = await kvGetAgent(
    caller.accountId,
    `graph/follow/${targetAccountId}`,
  );
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
    [`graph/follow/${targetAccountId}`]: null,
  };

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  incrementRateLimit('unfollow', caller.accountId);

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
  targetAccountId: string,
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
    `Agent ${targetAccountId} does not have '${val}'`,
  );
}

export async function handleEndorse(
  walletKey: string,
  targetAccountId: string,
  tags: string[] | undefined,
  capabilities: Record<string, unknown> | undefined,
  reason: string | undefined,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }
  if ((!tags || tags.length === 0) && !capabilities) {
    return fail('VALIDATION_ERROR', 'Tags or capabilities are required');
  }

  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  if (caller.accountId === targetAccountId)
    return fail('SELF_ENDORSE', 'Cannot endorse yourself');

  const rl = checkRateLimit('endorse', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  // Load target profile
  const targetResult = await resolveTargetAgent(targetAccountId);
  if ('success' in targetResult) return targetResult;
  const { agent: targetAgent } = targetResult;

  const endorsable = collectEndorsable(targetAgent);

  // Resolve requested items
  const resolved: { ns: string; value: string }[] = [];
  if (tags) {
    for (const tag of tags) {
      const r = resolveTag(tag.toLowerCase(), targetAccountId, endorsable);
      if ('success' in r) return r;
      resolved.push(r);
    }
  }
  if (capabilities) {
    for (const [ns, val] of extractCapabilityPairs(capabilities)) {
      if (!endorsable.has(`${ns}:${val}`)) {
        return fail(
          'VALIDATION_ERROR',
          `Agent ${targetAccountId} does not have ${ns} '${val}'`,
        );
      }
      resolved.push({ ns, value: val });
    }
  }
  if (resolved.length === 0) {
    return fail('VALIDATION_ERROR', 'Tags or capabilities are required');
  }

  // Batch idempotency check + build write entries
  const ts = nowSecs();
  const ekeys = resolved.map(({ ns, value }) =>
    endorsementKey(targetAccountId, ns, value),
  );
  const existingValues = await kvMultiAgent(
    ekeys.map((key) => ({ accountId: caller.accountId, key })),
  );

  const entries: Record<string, unknown> = {};
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
      account_id: targetAccountId,
      endorsed: {},
      already_endorsed: alreadyEndorsed,
      agent: targetAgent,
    });
  }

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  incrementRateLimit('endorse', caller.accountId);

  return ok({
    action: 'endorsed',
    account_id: targetAccountId,
    endorsed,
    already_endorsed: alreadyEndorsed,
    agent: targetAgent,
  });
}

/** Soft tag resolution for multi-target: collects skipped instead of failing. */
function resolveTagSoft(
  val: string,
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

async function handleMultiEndorse(
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

  const budget = checkRateLimitBudget('endorse', caller.accountId);
  if (!budget.ok) return rateLimited(budget.retryAfter);

  const ts = nowSecs();
  const results: Record<string, unknown>[] = [];
  let endorsedCount = 0;

  for (const targetAccountId of targets) {
    if (!targetAccountId.trim() || targetAccountId === caller.accountId) {
      const reason_ =
        targetAccountId === caller.accountId
          ? 'cannot endorse yourself'
          : 'empty account_id';
      results.push({
        account_id: targetAccountId,
        action: 'error',
        error: reason_,
      });
      continue;
    }

    const targetResult = await resolveTargetAgent(targetAccountId);
    if ('success' in targetResult) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        error: 'agent not found',
      });
      continue;
    }
    const { agent: targetAgent } = targetResult;

    if (endorsedCount >= budget.remaining) {
      results.push({
        account_id: targetAccountId,
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
        const r = resolveTagSoft(tag.toLowerCase(), endorsable);
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
        account_id: targetAccountId,
        action: 'error',
        error: 'no endorsable items match',
        requested,
        available,
      });
      continue;
    }

    // Batch idempotency check + build write entries
    const ekeys = resolved.map(({ ns, value }) =>
      endorsementKey(targetAccountId, ns, value),
    );
    const existingValues = await kvMultiAgent(
      ekeys.map((key) => ({ accountId: caller.accountId, key })),
    );

    const entries: Record<string, unknown> = {};
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
          account_id: targetAccountId,
          action: 'error',
          error: 'storage error',
        });
        continue;
      }
      incrementRateLimit('endorse', caller.accountId);
      endorsedCount++;
    }

    const result: Record<string, unknown> = {
      account_id: targetAccountId,
      action: 'endorsed',
      endorsed,
    };
    if (skipped.length > 0) result.skipped = skipped;
    results.push(result);
  }

  return ok({ action: 'batch_endorsed', results });
}

export async function handleUnendorse(
  walletKey: string,
  targetAccountId: string,
  tags: string[] | undefined,
  capabilities: Record<string, unknown> | undefined,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  if ((!tags || tags.length === 0) && !capabilities) {
    return fail('VALIDATION_ERROR', 'Tags or capabilities are required');
  }

  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  if (caller.accountId === targetAccountId)
    return fail('SELF_UNENDORSE', 'Cannot unendorse yourself');

  const rl = checkRateLimit('unendorse', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  const targetResult = await resolveTargetAgent(targetAccountId);
  if ('success' in targetResult) return targetResult;
  const { agent: targetAgent } = targetResult;

  const endorsable = collectEndorsable(targetAgent);

  // Resolve and check which ones exist
  const resolved: { ns: string; value: string }[] = [];
  if (tags) {
    for (const tag of tags) {
      const r = resolveTag(tag.toLowerCase(), targetAccountId, endorsable);
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

  const ekeys = resolved.map(({ ns, value }) =>
    endorsementKey(targetAccountId, ns, value),
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
    incrementRateLimit('unendorse', caller.accountId);
  }

  return ok({
    action: 'unendorsed',
    account_id: targetAccountId,
    removed,
    agent: targetAgent,
  });
}

// ---------------------------------------------------------------------------
// Update Me
// ---------------------------------------------------------------------------

export async function handleUpdateMe(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  // First-write: creates default profile if none exists (agent-paid).
  const caller = await resolveCallerOrInit(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('update_me', caller.accountId);
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

  const ts = nowSecs();
  agent.last_active = ts;

  // Build entries: profile + tag/cap indexes
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

  incrementRateLimit('update_me', caller.accountId);

  const completeness = profileCompleteness(agent);
  return ok({ agent, profile_completeness: completeness });
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export async function handleHeartbeat(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  // First-write: creates default profile if none exists (agent-paid).
  const caller = await resolveCallerOrInit(walletKey, resolveAccountId);
  if (!('accountId' in caller)) return caller;

  const rl = checkRateLimit('heartbeat', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  const previousActive = caller.agent.last_active;
  const ts = nowSecs();
  const agent = { ...caller.agent, last_active: ts };

  // Compute live counts from graph traversal (parallel)
  const [followerEntries, followingEntries, endorseEntries] = await Promise.all(
    [
      kvGetAll(`graph/follow/${caller.accountId}`),
      kvListAgent(caller.accountId, 'graph/follow/'),
      kvListAll(endorsePrefix(caller.accountId)),
    ],
  );
  agent.follower_count = followerEntries.length;
  agent.following_count = followingEntries.length;
  agent.endorsements = buildEndorsementCounts(endorseEntries, caller.accountId);

  // New followers since last heartbeat
  const newFollowerAccounts: string[] = [];
  for (const e of followerEntries) {
    const at = entryAt(e.value);
    if (at >= previousActive) newFollowerAccounts.push(e.predecessor_id);
  }

  // New following since last heartbeat
  const newFollowingCount = followingEntries.filter((e) => {
    const at = entryAt(e.value);
    return at >= previousActive;
  }).length;

  // Batch-fetch profiles for new follower summaries
  const followerProfiles =
    newFollowerAccounts.length > 0
      ? await kvMultiAgent(
          newFollowerAccounts.map((a) => ({ accountId: a, key: 'profile' })),
        )
      : [];
  const newFollowers = followerProfiles
    .filter((a): a is Agent => a !== null)
    .map(profileSummary);

  // Write updated profile + tag/cap indexes
  const entries = agentEntries(agent);
  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote) return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);

  incrementRateLimit('heartbeat', caller.accountId);

  return ok({
    agent,
    delta: {
      since: previousActive,
      new_followers: newFollowers,
      new_followers_count: newFollowers.length,
      new_following_count: newFollowingCount,
      profile_completeness: profileCompleteness(agent),
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

export async function handleDeregister(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('deregister', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  // Null-write all agent keys
  const entries: Record<string, unknown> = {
    profile: null,
  };

  // Null-write tag keys
  for (const tag of caller.agent.tags) {
    entries[`tag/${tag}`] = null;
  }

  // Null-write capability keys
  for (const [ns, val] of extractCapabilityPairs(caller.agent.capabilities)) {
    entries[`cap/${ns}/${val}`] = null;
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

  incrementRateLimit('deregister', caller.accountId);

  return ok({
    action: 'deregistered',
    account_id: caller.accountId,
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function dispatchWrite(
  action: string,
  body: Record<string, unknown>,
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const accountId = body.account_id as string | undefined;

  const targets = Array.isArray(body.targets)
    ? (body.targets as string[])
    : undefined;

  switch (action) {
    case 'follow':
      if (targets)
        return handleMultiFollow(walletKey, targets, resolveAccountId);
      if (!accountId) return fail('VALIDATION_ERROR', 'account_id is required');
      return handleFollow(
        walletKey,
        accountId,
        body.reason as string | undefined,
        resolveAccountId,
      );

    case 'unfollow':
      if (!accountId) return fail('VALIDATION_ERROR', 'account_id is required');
      return handleUnfollow(walletKey, accountId, resolveAccountId);

    case 'endorse':
      if (targets)
        return handleMultiEndorse(
          walletKey,
          targets,
          body.tags as string[] | undefined,
          body.capabilities as Record<string, unknown> | undefined,
          body.reason as string | undefined,
          resolveAccountId,
        );
      if (!accountId) return fail('VALIDATION_ERROR', 'account_id is required');
      return handleEndorse(
        walletKey,
        accountId,
        body.tags as string[] | undefined,
        body.capabilities as Record<string, unknown> | undefined,
        body.reason as string | undefined,
        resolveAccountId,
      );

    case 'unendorse':
      if (!accountId) return fail('VALIDATION_ERROR', 'account_id is required');
      return handleUnendorse(
        walletKey,
        accountId,
        body.tags as string[] | undefined,
        body.capabilities as Record<string, unknown> | undefined,
        resolveAccountId,
      );

    case 'update_me':
      return handleUpdateMe(walletKey, body, resolveAccountId);

    case 'heartbeat':
      return handleHeartbeat(walletKey, resolveAccountId);

    case 'deregister':
      return handleDeregister(walletKey, resolveAccountId);

    default:
      return fail(
        'VALIDATION_ERROR',
        `Action '${action}' not supported for direct write`,
      );
  }
}
