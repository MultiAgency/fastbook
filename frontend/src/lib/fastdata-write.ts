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
 *   tag/{tag}                                   → true (existence index)
 */

import type { Agent } from '@/types';
import {
  EXTERNAL_URLS,
  FASTDATA_NAMESPACE,
  FUND_AMOUNT_NEAR,
  OUTLAYER_API_URL,
} from './constants';
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
  fetchProfile,
  fetchProfiles,
  liveNetworkCounts,
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
  validateCapabilities,
  validateDescription,
  validateImageUrl,
  validateName,
  validateReason,
  validateTags,
} from './validate';

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export type WriteResult =
  | {
      success: true;
      data: Record<string, unknown>;
      /** Cache action types this mutation invalidates. Null = clear all. */
      invalidates: readonly string[] | null;
    }
  | {
      success: false;
      error: string;
      code: string;
      status: number;
      retryAfter?: number;
      meta?: Record<string, unknown>;
    };

function ok(data: Record<string, unknown>): WriteResult {
  return { success: true, data, invalidates: [] };
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

function walletFundingMeta(accountId: string): Record<string, unknown> {
  return {
    wallet_address: accountId,
    fund_amount: FUND_AMOUNT_NEAR,
    fund_token: 'NEAR',
    fund_url: EXTERNAL_URLS.OUTLAYER_FUND(accountId),
  };
}

function insufficientBalance(accountId: string): WriteResult {
  return {
    success: false,
    error: `Fund your wallet with ≥${FUND_AMOUNT_NEAR} NEAR, then retry.`,
    code: 'INSUFFICIENT_BALANCE',
    status: 402,
    meta: walletFundingMeta(accountId),
  };
}

/**
 * Per-target guard shared by the four graph handlers. Returns an error
 * entry for empty or self-targeting account IDs, or null if the target
 * passes the guard and should be processed.
 */
function targetGuardError(
  targetAccountId: string,
  callerAccountId: string,
  selfCode: string,
  verb: string,
): Record<string, unknown> | null {
  if (!targetAccountId.trim()) {
    return {
      account_id: targetAccountId,
      action: 'error',
      code: 'VALIDATION_ERROR',
      error: 'empty account_id',
    };
  }
  if (targetAccountId === callerAccountId) {
    return {
      account_id: targetAccountId,
      action: 'error',
      code: selfCode,
      error: `cannot ${verb} yourself`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// FastData KV write (awaitable — primary write path, not fire-and-forget)
// ---------------------------------------------------------------------------

export type WriteOutcome = { ok: true } | { ok: false; status: number | null };

export async function writeToFastData(
  walletKey: string,
  entries: Record<string, unknown>,
): Promise<WriteOutcome> {
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
    if (res.ok) return { ok: true };
    const detail = await res.text().catch(() => '');
    console.error(
      `[fastdata-write] http ${res.status}: ${detail.slice(0, 200)}`,
    );
    return { ok: false, status: res.status };
  } catch (err) {
    console.error('[fastdata-write] network error:', err);
    return { ok: false, status: null };
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

  const agent = await fetchProfile(accountId);
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
  const agent = await fetchProfile(accountId);
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
    name: null,
    description: '',
    image: null,
    tags: [],
    capabilities: {},
    endorsements: {},
    account_id: accountId,
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

  const existing = await fetchProfile(accountId);
  if (existing) return { accountId, agent: existing };

  // First-write: create default profile. OutLayer returns 402 Payment
  // Required for underfunded wallets; any other status is a transient
  // storage error, not a funding problem.
  const agent = defaultAgent(accountId);
  const wrote = await writeToFastData(walletKey, agentEntries(agent));
  if (!wrote.ok) {
    return wrote.status === 402
      ? insufficientBalance(accountId)
      : fail('STORAGE_ERROR', 'Failed to write to FastData', 500);
  }

  return { accountId, agent };
}

// ---------------------------------------------------------------------------
// Follow / Unfollow
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 20;

export async function handleFollow(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const targets = resolveTargets(body);
  if (!Array.isArray(targets)) return targets;
  if (targets.length === 0)
    return fail('VALIDATION_ERROR', 'Targets array must not be empty');
  if (targets.length > MAX_BATCH_SIZE)
    return fail('VALIDATION_ERROR', `Too many targets (max ${MAX_BATCH_SIZE})`);
  const reason = body.reason as string | undefined;
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }

  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const budget = checkRateLimitBudget('follow', caller.accountId);
  if (!budget.ok) return rateLimited(budget.retryAfter);

  const ts = nowSecs();
  const results: Record<string, unknown>[] = [];
  let followedCount = 0;

  for (const targetAccountId of targets) {
    const guard = targetGuardError(
      targetAccountId,
      caller.accountId,
      'SELF_FOLLOW',
      'follow',
    );
    if (guard) {
      results.push(guard);
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

    const targetAgent = await fetchProfile(targetAccountId);
    if (!targetAgent) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        code: 'NOT_FOUND',
        error: 'agent not found',
      });
      continue;
    }

    if (followedCount >= budget.remaining) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        code: 'RATE_LIMITED',
        error: 'rate limit reached within batch',
      });
      continue;
    }

    const entries: Record<string, unknown> = {
      [`graph/follow/${targetAccountId}`]: { at: ts, reason: reason ?? null },
    };
    const wrote = await writeToFastData(walletKey, entries);
    if (!wrote.ok) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        code: 'STORAGE_ERROR',
        error: 'storage error',
      });
      continue;
    }

    incrementRateLimit('follow', caller.accountId);
    followedCount++;
    results.push({ account_id: targetAccountId, action: 'followed' });
  }

  const counts = await liveNetworkCounts(caller.accountId);
  return ok({
    results,
    your_network: {
      following_count: counts.following_count + followedCount,
      follower_count: counts.follower_count,
    },
  });
}

export async function handleUnfollow(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const targets = resolveTargets(body);
  if (!Array.isArray(targets)) return targets;
  if (targets.length === 0)
    return fail('VALIDATION_ERROR', 'Targets array must not be empty');
  if (targets.length > MAX_BATCH_SIZE)
    return fail('VALIDATION_ERROR', `Too many targets (max ${MAX_BATCH_SIZE})`);

  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const budget = checkRateLimitBudget('unfollow', caller.accountId);
  if (!budget.ok) return rateLimited(budget.retryAfter);

  const results: Record<string, unknown>[] = [];
  let unfollowedCount = 0;

  for (const targetAccountId of targets) {
    const guard = targetGuardError(
      targetAccountId,
      caller.accountId,
      'SELF_UNFOLLOW',
      'unfollow',
    );
    if (guard) {
      results.push(guard);
      continue;
    }

    const existing = await kvGetAgent(
      caller.accountId,
      `graph/follow/${targetAccountId}`,
    );
    if (!existing) {
      results.push({ account_id: targetAccountId, action: 'not_following' });
      continue;
    }

    if (unfollowedCount >= budget.remaining) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        code: 'RATE_LIMITED',
        error: 'rate limit reached within batch',
      });
      continue;
    }

    const entries: Record<string, unknown> = {
      [`graph/follow/${targetAccountId}`]: null,
    };
    const wrote = await writeToFastData(walletKey, entries);
    if (!wrote.ok) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        code: 'STORAGE_ERROR',
        error: 'storage error',
      });
      continue;
    }

    incrementRateLimit('unfollow', caller.accountId);
    unfollowedCount++;
    results.push({ account_id: targetAccountId, action: 'unfollowed' });
  }

  const counts = await liveNetworkCounts(caller.accountId);
  return ok({
    results,
    your_network: {
      following_count: Math.max(0, counts.following_count - unfollowedCount),
      follower_count: counts.follower_count,
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

export async function handleEndorse(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const targets = resolveTargets(body);
  if (!Array.isArray(targets)) return targets;
  if (targets.length === 0)
    return fail('VALIDATION_ERROR', 'Targets array must not be empty');
  if (targets.length > MAX_BATCH_SIZE)
    return fail('VALIDATION_ERROR', `Too many targets (max ${MAX_BATCH_SIZE})`);
  const tags = body.tags as string[] | undefined;
  const capabilities = body.capabilities as Record<string, unknown> | undefined;
  const reason = body.reason as string | undefined;
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
    const guard = targetGuardError(
      targetAccountId,
      caller.accountId,
      'SELF_ENDORSE',
      'endorse',
    );
    if (guard) {
      results.push(guard);
      continue;
    }

    const targetResult = await resolveTargetAgent(targetAccountId);
    if ('success' in targetResult) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        code: 'NOT_FOUND',
        error: 'agent not found',
      });
      continue;
    }
    const { agent: targetAgent } = targetResult;

    if (endorsedCount >= budget.remaining) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        code: 'RATE_LIMITED',
        error: 'rate limit reached within batch',
      });
      continue;
    }

    const endorsable = collectEndorsable(targetAgent);
    const resolved: { ns: string; value: string }[] = [];
    const skipped: Record<string, unknown>[] = [];

    if (tags) {
      for (const tag of tags) {
        const r = resolveTagCore(tag.toLowerCase(), endorsable);
        if (r.kind === 'resolved') resolved.push({ ns: r.ns, value: r.value });
        else
          skipped.push({
            value: tag.toLowerCase(),
            reason: r.kind === 'ambiguous' ? 'ambiguous' : 'not_found',
          });
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
        code: 'VALIDATION_ERROR',
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

    if (Object.keys(endorsed).length > 0) {
      const wrote = await writeToFastData(walletKey, entries);
      if (!wrote.ok) {
        results.push({
          account_id: targetAccountId,
          action: 'error',
          code: 'STORAGE_ERROR',
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
    if (Object.keys(alreadyEndorsed).length > 0)
      result.already_endorsed = alreadyEndorsed;
    if (skipped.length > 0) result.skipped = skipped;
    results.push(result);
  }

  return ok({ results });
}

export async function handleUnendorse(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const targets = resolveTargets(body);
  if (!Array.isArray(targets)) return targets;
  if (targets.length === 0)
    return fail('VALIDATION_ERROR', 'Targets array must not be empty');
  if (targets.length > MAX_BATCH_SIZE)
    return fail('VALIDATION_ERROR', `Too many targets (max ${MAX_BATCH_SIZE})`);
  const tags = body.tags as string[] | undefined;
  const capabilities = body.capabilities as Record<string, unknown> | undefined;
  if ((!tags || tags.length === 0) && !capabilities)
    return fail('VALIDATION_ERROR', 'Tags or capabilities are required');

  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const budget = checkRateLimitBudget('unendorse', caller.accountId);
  if (!budget.ok) return rateLimited(budget.retryAfter);

  const results: Record<string, unknown>[] = [];
  let unendorsedCount = 0;

  for (const targetAccountId of targets) {
    const guard = targetGuardError(
      targetAccountId,
      caller.accountId,
      'SELF_UNENDORSE',
      'unendorse',
    );
    if (guard) {
      results.push(guard);
      continue;
    }

    if (unendorsedCount >= budget.remaining) {
      results.push({
        account_id: targetAccountId,
        action: 'error',
        code: 'RATE_LIMITED',
        error: 'rate limit reached within batch',
      });
      continue;
    }

    // Scan the caller's actual endorsement keys for this target. This avoids
    // gating on the target's current profile — if the target removed a tag or
    // capability after being endorsed, the caller can still retract.
    const prefix = endorsePrefix(targetAccountId);
    const existingKeys = await kvListAgent(caller.accountId, prefix);

    // Build a lookup: "ns/value" → full key
    const keyMap = new Map<string, string>();
    for (const e of existingKeys) {
      const suffix = e.key.startsWith(prefix)
        ? e.key.slice(prefix.length)
        : e.key;
      keyMap.set(suffix, e.key);
    }

    const entries: Record<string, unknown> = {};
    const removed: Record<string, string[]> = {};

    if (tags) {
      for (const tag of tags) {
        const lower = tag.toLowerCase();
        const suffix = `tags/${lower}`;
        if (keyMap.has(suffix)) {
          entries[keyMap.get(suffix)!] = null;
          if (!removed.tags) removed.tags = [];
          removed.tags.push(lower);
        }
      }
    }
    if (capabilities) {
      for (const [ns, val] of extractCapabilityPairs(capabilities)) {
        const suffix = `${ns}/${val}`;
        if (keyMap.has(suffix)) {
          entries[keyMap.get(suffix)!] = null;
          if (!removed[ns]) removed[ns] = [];
          removed[ns].push(val);
        }
      }
    }

    if (Object.keys(removed).length > 0) {
      const wrote = await writeToFastData(walletKey, entries);
      if (!wrote.ok) {
        results.push({
          account_id: targetAccountId,
          action: 'error',
          code: 'STORAGE_ERROR',
          error: 'storage error',
        });
        continue;
      }
      incrementRateLimit('unendorse', caller.accountId);
      unendorsedCount++;
    }

    results.push({
      account_id: targetAccountId,
      action: 'unendorsed',
      removed,
    });
  }

  return ok({ results });
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
  if ('name' in body) {
    const name = body.name as string | null;
    if (name != null) {
      const e = validateName(name);
      if (e) return validationFail(e);
    }
    agent.name = name;
    changed = true;
  }
  if (typeof body.description === 'string') {
    const e = validateDescription(body.description);
    if (e) return validationFail(e);
    agent.description = body.description;
    changed = true;
  }
  if ('image' in body) {
    const url = body.image as string | null;
    if (url != null) {
      const e = validateImageUrl(url);
      if (e) return validationFail(e);
    }
    agent.image = url;
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
      'No valid fields to update (supported: name, description, image, tags, capabilities)',
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

  // Delete old capability keys if capabilities changed — otherwise a
  // dropped cap/{ns}/{value} existence index ghosts into list_capabilities.
  if (body.capabilities !== undefined) {
    const newCapKeys = new Set(
      extractCapabilityPairs(agent.capabilities).map(
        ([ns, val]) => `${ns}/${val}`,
      ),
    );
    for (const [ns, val] of extractCapabilityPairs(caller.agent.capabilities)) {
      const key = `${ns}/${val}`;
      if (!newCapKeys.has(key)) {
        entries[`cap/${key}`] = null;
      }
    }
  }

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) {
    return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);
  }

  incrementRateLimit('update_me', caller.accountId);

  // Overlay live counts on the response so clients receive the same agent
  // shape as heartbeat returns (stored profiles don't carry count fields).
  const counts = await liveNetworkCounts(caller.accountId);
  const responseAgent: Agent = { ...agent, ...counts };
  return ok({
    agent: responseAgent,
    profile_completeness: profileCompleteness(responseAgent),
  });
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
  if ('success' in caller) return caller;

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

  // Batch-fetch profiles for new follower summaries. `fetchProfiles`
  // enforces the trust-boundary override so the summaries always carry
  // the authoritative account_id from the predecessor namespace.
  const newFollowers = (await fetchProfiles(newFollowerAccounts)).map(
    profileSummary,
  );

  // Write updated profile + tag/cap indexes
  const entries = agentEntries(agent);
  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) {
    return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);
  }

  incrementRateLimit('heartbeat', caller.accountId);

  const responseAgent: Agent = {
    ...agent,
    follower_count: followerEntries.length,
    following_count: followingEntries.length,
  };

  return ok({
    agent: responseAgent,
    delta: {
      since: previousActive,
      new_followers: newFollowers,
      new_followers_count: newFollowers.length,
      new_following_count: newFollowingCount,
      profile_completeness: profileCompleteness(responseAgent),
    },
  });
}

// ---------------------------------------------------------------------------
// Delist Me
// ---------------------------------------------------------------------------

export async function handleDelistMe(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const caller = await resolveCaller(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('delist_me', caller.accountId);
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

  // Null-write follow + endorsement edges
  const [followingEntries, endorsingEntries] = await Promise.all([
    kvListAgent(caller.accountId, 'graph/follow/'),
    kvListAgent(caller.accountId, 'endorsing/'),
  ]);
  for (const e of followingEntries) {
    entries[e.key] = null;
  }
  for (const e of endorsingEntries) {
    entries[e.key] = null;
  }

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) {
    return fail('STORAGE_ERROR', 'Failed to write to FastData', 500);
  }

  incrementRateLimit('delist_me', caller.accountId);

  return ok({
    action: 'delisted',
    account_id: caller.accountId,
  });
}

// ---------------------------------------------------------------------------
// Invalidation map — co-located with mutations so new actions can't forget it.
// Unmapped actions invalidate all cached action types (safe default).
// ---------------------------------------------------------------------------

const INVALIDATION_MAP: Record<string, readonly string[]> = {
  update_me: ['list_agents', 'list_tags', 'list_capabilities', 'profile'],
  follow: ['profile', 'followers', 'following', 'edges'],
  unfollow: ['profile', 'followers', 'following', 'edges'],
  endorse: ['profile', 'endorsers'],
  unendorse: ['profile', 'endorsers'],
  heartbeat: [
    'list_agents',
    'profile',
    'health',
    'list_tags',
    'list_capabilities',
  ],
  delist_me: [
    'list_agents',
    'list_tags',
    'list_capabilities',
    'health',
    'profile',
    'followers',
    'following',
    'edges',
    'endorsers',
  ],
  hide_agent: ['hidden'],
  unhide_agent: ['hidden'],
};

/** Cached reads that a given mutation stales. Null means "clear everything". */
export function invalidatesFor(action: string): readonly string[] | null {
  return INVALIDATION_MAP[action] ?? null;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Normalize single account_id or targets[] into a non-empty array. */
function resolveTargets(body: Record<string, unknown>): string[] | WriteResult {
  if (Array.isArray(body.targets)) return body.targets as string[];
  const accountId = body.account_id as string | undefined;
  if (!accountId) return fail('VALIDATION_ERROR', 'account_id is required');
  return [accountId];
}

export async function dispatchWrite(
  action: string,
  body: Record<string, unknown>,
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  let result: WriteResult;

  switch (action) {
    case 'follow':
      result = await handleFollow(walletKey, body, resolveAccountId);
      break;
    case 'unfollow':
      result = await handleUnfollow(walletKey, body, resolveAccountId);
      break;
    case 'endorse':
      result = await handleEndorse(walletKey, body, resolveAccountId);
      break;
    case 'unendorse':
      result = await handleUnendorse(walletKey, body, resolveAccountId);
      break;
    case 'update_me':
      result = await handleUpdateMe(walletKey, body, resolveAccountId);
      break;
    case 'heartbeat':
      result = await handleHeartbeat(walletKey, resolveAccountId);
      break;
    case 'delist_me':
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
