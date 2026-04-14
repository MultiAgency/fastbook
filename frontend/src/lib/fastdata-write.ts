/**
 * FastData KV write path for social graph mutations.
 *
 * Handles all non-registration mutations via direct FastData writes.
 * Each function validates inputs, checks rate limits, writes via
 * the caller's custody wallet, and returns a structured response.
 *
 * Key schema (per-predecessor — caller writes under their own account):
 *   graph/follow/{targetAccountId}        → {reason?}
 *   endorsing/{targetAccountId}/{key_suffix} → {reason?, content_hash?}
 *   profile                               → full Agent record
 *   tag/{tag}                             → true (existence index)
 *
 * Edge values carry no `at` — the authoritative "when" is FastData's
 * indexed `block_timestamp`, surfaced on read via `entryBlockSecs`.
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
  composeKey,
  endorsePrefix,
  entryBlockSecs,
  extractCapabilityPairs,
  fetchProfile,
  fetchProfiles,
  liveNetworkCounts,
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
  validateKeySuffix,
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
 * Fold a classified write failure into a WriteResult. `writeToFastData`
 * does the HTTP→reason classification itself; this helper is the
 * presentation-layer fold used by non-batch handlers.
 */
function classifyWriteFailure(
  wrote: Extract<WriteOutcome, { ok: false }>,
  accountId: string,
): WriteResult {
  return wrote.reason === 'insufficient_balance'
    ? insufficientBalance(accountId)
    : fail('STORAGE_ERROR', 'Failed to write to FastData', 500);
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

export type WriteOutcome =
  | { ok: true }
  | { ok: false; reason: 'insufficient_balance' | 'storage_error' };

/**
 * Probe OutLayer's balance endpoint for a wallet. Returns true iff the
 * wallet exists and reports a zero balance. Any other outcome (HTTP failure,
 * malformed body, non-zero balance) returns false — we never misclassify a
 * genuine upstream outage as an unfunded wallet.
 */
async function isWalletUnfunded(walletKey: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${OUTLAYER_API_URL}/wallet/v1/balance?chain=near`,
      { headers: { Authorization: `Bearer ${walletKey}` } },
      5_000,
    );
    if (!res.ok) return false;
    const data = (await res.json().catch(() => null)) as {
      balance?: string;
    } | null;
    return data?.balance === '0';
  } catch {
    return false;
  }
}

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
    if (res.status === 402) {
      return { ok: false, reason: 'insufficient_balance' };
    }
    // OutLayer returns HTTP 502 (Cloudflare upstream error) for writes on
    // unfunded wallets, not 402. Confirmed 2026-04-13. Probe the balance
    // endpoint to disambiguate a genuine outage from an unfunded wallet.
    if (res.status === 502 && (await isWalletUnfunded(walletKey))) {
      return { ok: false, reason: 'insufficient_balance' };
    }
    return { ok: false, reason: 'storage_error' };
  } catch (err) {
    console.error('[fastdata-write] network error:', err);
    return { ok: false, reason: 'storage_error' };
  }
}

// ---------------------------------------------------------------------------
// Resolve caller identity
// ---------------------------------------------------------------------------

interface CallerIdentity {
  accountId: string;
  agent: Agent;
}

/**
 * In-memory default for callers without a profile blob. Used as the
 * fallback for every mutation so no-profile callers can proceed without a
 * gate: heartbeat and update_me persist this default as part of their
 * normal write batch, while follow/endorse/unendorse/delist use it in
 * memory only, so edge-only callers stay invisible to `list_agents` until
 * they heartbeat or update_me. Nearly does not gate profile creation — the
 * first profile-writing mutation is the bootstrap.
 *
 * Holds no time fields — `last_active` and `created_at` are read-derived
 * from block timestamps and have no honest write-side value before the
 * first read. Handlers that need a "since when" baseline for first-
 * heartbeat delta computation use `caller.agent.last_active ?? 0`, which
 * surfaces every pre-existing edge as "new" on the first call.
 */
function defaultAgent(accountId: string): Agent {
  return {
    name: null,
    description: '',
    image: null,
    tags: [],
    capabilities: {},
    endorsements: {},
    account_id: accountId,
  };
}

/**
 * Resolve caller, defaulting to a fresh agent shape if no profile exists.
 * Used by every mutation handler (follow/unfollow/endorse/unendorse via
 * `runBatch`, plus heartbeat, update_me, and delist_me directly). There
 * is no caller-side profile gate: any authenticated `wk_` caller can
 * mutate, regardless of whether they have a `profile` blob in FastData.
 *
 * Does not write. The caller's own post-resolution write persists the
 * default merged with whatever fields that handler updates, collapsing
 * bootstrap + first mutation into a single round-trip to OutLayer — but
 * only for handlers that actually write profile entries (heartbeat,
 * update_me). Follow/endorse/unendorse/delist use the default in memory
 * and do not persist it, so edge-only callers stay invisible to
 * `list_agents` until they heartbeat or update_me.
 */
async function resolveCallerOrInit(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<CallerIdentity | WriteResult> {
  const accountId = await resolveAccountId(walletKey);
  if (!accountId) return fail('AUTH_FAILED', 'Could not resolve account', 401);

  const existing = await fetchProfile(accountId);
  return { accountId, agent: existing ?? defaultAgent(accountId) };
}

// ---------------------------------------------------------------------------
// Batch scaffolding shared by follow/unfollow/endorse/unendorse
// ---------------------------------------------------------------------------

const MAX_BATCH_SIZE = 20;

type BatchAction = 'follow' | 'unfollow' | 'endorse' | 'unendorse';

/**
 * A single target's contribution to a batch. `skip` and `fail` append a
 * per-target result without consuming rate-limit budget or issuing a write;
 * `write` issues a KV write, charges budget, then appends `onWritten()`'s
 * result. Used by runBatch — handler logic only builds these.
 */
type BatchStep =
  | { kind: 'skip'; result: Record<string, unknown> }
  | { kind: 'fail'; result: Record<string, unknown> }
  | {
      kind: 'write';
      entries: Record<string, unknown>;
      onWritten: () => Record<string, unknown>;
    };

interface BatchOptions {
  action: BatchAction;
  selfCode: string;
  verb: string;
  walletKey: string;
  body: Record<string, unknown>;
  resolveAccountId: (wk: string) => Promise<string | null>;
  step: (target: string, caller: CallerIdentity) => Promise<BatchStep>;
  finalize?: (
    results: Record<string, unknown>[],
    caller: CallerIdentity,
    processed: number,
  ) => Promise<Record<string, unknown>>;
}

/**
 * Shared scaffold for graph-mutation batch handlers. Normalizes target
 * validation, caller resolution, rate-limit gating, self-action guards,
 * per-target writes, and response shape. Per-target logic lives in the
 * handler-supplied `step`; response shape in optional `finalize`.
 *
 * A 402 on any write aborts the batch with INSUFFICIENT_BALANCE — no
 * subsequent target will succeed with an underfunded wallet, and the
 * caller needs the fund link, not N misleading STORAGE_ERROR items.
 */
async function runBatch(opts: BatchOptions): Promise<WriteResult> {
  const targets = resolveTargets(opts.body);
  if (!Array.isArray(targets)) return targets;
  if (targets.length === 0)
    return fail('VALIDATION_ERROR', 'Targets array must not be empty');
  if (targets.length > MAX_BATCH_SIZE)
    return fail('VALIDATION_ERROR', `Too many targets (max ${MAX_BATCH_SIZE})`);

  const caller = await resolveCallerOrInit(
    opts.walletKey,
    opts.resolveAccountId,
  );
  if ('success' in caller) return caller;

  const budget = checkRateLimitBudget(opts.action, caller.accountId);
  if (!budget.ok) return rateLimited(budget.retryAfter);

  const results: Record<string, unknown>[] = [];
  let processed = 0;

  for (const target of targets) {
    const guard = targetGuardError(
      target,
      caller.accountId,
      opts.selfCode,
      opts.verb,
    );
    if (guard) {
      results.push(guard);
      continue;
    }

    const step = await opts.step(target, caller);
    if (step.kind !== 'write') {
      results.push(step.result);
      continue;
    }

    if (processed >= budget.remaining) {
      results.push({
        account_id: target,
        action: 'error',
        code: 'RATE_LIMITED',
        error: 'rate limit reached within batch',
      });
      continue;
    }

    const wrote = await writeToFastData(opts.walletKey, step.entries);
    if (!wrote.ok) {
      if (wrote.reason === 'insufficient_balance') {
        return insufficientBalance(caller.accountId);
      }
      results.push({
        account_id: target,
        action: 'error',
        code: 'STORAGE_ERROR',
        error: 'storage error',
      });
      continue;
    }

    incrementRateLimit(opts.action, caller.accountId);
    processed++;
    results.push(step.onWritten());
  }

  const payload = opts.finalize
    ? await opts.finalize(results, caller, processed)
    : { results };
  return ok(payload);
}

// ---------------------------------------------------------------------------
// Follow / Unfollow
// ---------------------------------------------------------------------------

export async function handleFollow(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const reason = body.reason as string | undefined;
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }

  return runBatch({
    action: 'follow',
    selfCode: 'SELF_FOLLOW',
    verb: 'follow',
    walletKey,
    body,
    resolveAccountId,
    step: async (target, caller) => {
      const followKey = composeKey('graph/follow/', target);
      const existing = await kvGetAgent(caller.accountId, followKey);
      if (existing) {
        return {
          kind: 'skip',
          result: { account_id: target, action: 'already_following' },
        };
      }
      const targetAgent = await fetchProfile(target);
      if (!targetAgent) {
        return {
          kind: 'fail',
          result: {
            account_id: target,
            action: 'error',
            code: 'NOT_FOUND',
            error: 'agent not found',
          },
        };
      }
      // Edge value: just the reason if provided, else an empty object.
      // No `at` field — the FastData-indexed `block_timestamp` of this
      // entry is the only authoritative time, surfaced via `entryBlockSecs`
      // on the read path. Empty `{}` is a "live" entry (object, not null).
      return {
        kind: 'write',
        entries: {
          [followKey]: reason != null ? { reason } : {},
        },
        onWritten: () => ({ account_id: target, action: 'followed' }),
      };
    },
    finalize: async (results, caller, processed) => {
      const counts = await liveNetworkCounts(caller.accountId);
      return {
        results,
        your_network: {
          following_count: counts.following_count + processed,
          follower_count: counts.follower_count,
        },
      };
    },
  });
}

export async function handleUnfollow(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  return runBatch({
    action: 'unfollow',
    selfCode: 'SELF_UNFOLLOW',
    verb: 'unfollow',
    walletKey,
    body,
    resolveAccountId,
    step: async (target, caller) => {
      const followKey = composeKey('graph/follow/', target);
      const existing = await kvGetAgent(caller.accountId, followKey);
      if (!existing) {
        return {
          kind: 'skip',
          result: { account_id: target, action: 'not_following' },
        };
      }
      return {
        kind: 'write',
        entries: { [followKey]: null },
        onWritten: () => ({ account_id: target, action: 'unfollowed' }),
      };
    },
    finalize: async (results, caller, processed) => {
      const counts = await liveNetworkCounts(caller.accountId);
      return {
        results,
        your_network: {
          following_count: Math.max(0, counts.following_count - processed),
          follower_count: counts.follower_count,
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Endorse / Unendorse
// ---------------------------------------------------------------------------

/** Max key_suffixes per endorse/unendorse call, independent of targets.length. */
const MAX_KEY_SUFFIXES = 20;

function resolveKeySuffixes(
  body: Record<string, unknown>,
): { keySuffixes: string[] } | WriteResult {
  const raw = body.key_suffixes;
  if (!Array.isArray(raw) || raw.length === 0)
    return fail('VALIDATION_ERROR', 'key_suffixes array must not be empty');
  if (raw.length > MAX_KEY_SUFFIXES)
    return fail(
      'VALIDATION_ERROR',
      `Too many key_suffixes (max ${MAX_KEY_SUFFIXES})`,
    );
  // Dedupe: duplicate key_suffixes in a single call would write the same
  // KV key twice and return misleading duplicate entries in endorsed[].
  // Order-preserving: first occurrence wins.
  const seen = new Set<string>();
  const keySuffixes: string[] = [];
  for (const ks of raw) {
    if (typeof ks !== 'string')
      return fail('VALIDATION_ERROR', 'key_suffixes must be strings');
    if (seen.has(ks)) continue;
    seen.add(ks);
    keySuffixes.push(ks);
  }
  return { keySuffixes };
}

export async function handleEndorse(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const keySuffixesResult = resolveKeySuffixes(body);
  if ('success' in keySuffixesResult) return keySuffixesResult;
  const { keySuffixes } = keySuffixesResult;

  const reason = body.reason as string | undefined;
  if (reason != null) {
    const e = validateReason(reason);
    if (e) return validationFail(e);
  }
  const contentHash = body.content_hash as string | undefined;

  return runBatch({
    action: 'endorse',
    selfCode: 'SELF_ENDORSE',
    verb: 'endorse',
    walletKey,
    body,
    resolveAccountId,
    // Rate-limit unit: one per target regardless of key_suffixes count.
    // Multiple key_suffixes within a target share the charge — endorsed.length
    // === 0 means no write and no budget consumed (skip kind).
    step: async (target, caller) => {
      // Existence gate only — the fetched profile is not used beyond this
      // check, so skip the resolve-wrapper and drop the throwaway object.
      if ((await fetchProfile(target)) == null) {
        return {
          kind: 'fail',
          result: {
            account_id: target,
            action: 'error',
            code: 'NOT_FOUND',
            error: 'agent not found',
          },
        };
      }

      // Validate key_suffixes, then write all of them. On content_hash change,
      // last write wins — overwrite prior entry with no history.
      const keyPrefix = endorsePrefix(target);
      const validKeySuffixes: string[] = [];
      const skipped: { key_suffix: string; reason: string }[] = [];
      for (const ks of keySuffixes) {
        const e = validateKeySuffix(ks, keyPrefix);
        if (e) skipped.push({ key_suffix: ks, reason: e.message });
        else validKeySuffixes.push(ks);
      }

      if (validKeySuffixes.length === 0) {
        return {
          kind: 'fail',
          result: {
            account_id: target,
            action: 'error',
            code: 'VALIDATION_ERROR',
            error: 'no valid key_suffixes',
            ...(skipped.length > 0 && { skipped }),
          },
        };
      }

      const fullKeys = validKeySuffixes.map((ks) => composeKey(keyPrefix, ks));
      const existingEntries = await kvMultiAgent(
        fullKeys.map((key) => ({ accountId: caller.accountId, key })),
      );

      const entries: Record<string, unknown> = {};
      const endorsed: string[] = [];
      const alreadyEndorsed: string[] = [];

      for (let i = 0; i < validKeySuffixes.length; i++) {
        const ks = validKeySuffixes[i]!;
        const existing = existingEntries[i]?.value as
          | { content_hash?: string }
          | null
          | undefined;
        const existingHash = existing?.content_hash;
        const sameHash = contentHash
          ? existingHash === contentHash
          : existingHash == null;
        if (existing && sameHash) {
          alreadyEndorsed.push(ks);
          continue;
        }
        // Edge value: optional reason + content_hash. No `at` field —
        // FastData's indexed `block_timestamp` is the only authoritative
        // time. Empty `{}` is a "live" entry (object, not null/undefined).
        entries[fullKeys[i]!] = {
          ...(reason != null && { reason }),
          ...(contentHash != null && { content_hash: contentHash }),
        };
        endorsed.push(ks);
      }

      const buildResult = (): Record<string, unknown> => {
        const result: Record<string, unknown> = {
          account_id: target,
          action: 'endorsed',
          endorsed,
        };
        if (alreadyEndorsed.length > 0)
          result.already_endorsed = alreadyEndorsed;
        if (skipped.length > 0) result.skipped = skipped;
        return result;
      };

      if (endorsed.length === 0) {
        return { kind: 'skip', result: buildResult() };
      }
      return { kind: 'write', entries, onWritten: buildResult };
    },
  });
}

export async function handleUnendorse(
  walletKey: string,
  body: Record<string, unknown>,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<WriteResult> {
  const keySuffixesResult = resolveKeySuffixes(body);
  if ('success' in keySuffixesResult) return keySuffixesResult;
  const { keySuffixes } = keySuffixesResult;

  return runBatch({
    action: 'unendorse',
    selfCode: 'SELF_UNENDORSE',
    verb: 'unendorse',
    walletKey,
    body,
    resolveAccountId,
    step: async (target, caller) => {
      // Read only the keys the caller wants to retract. Gating on the
      // caller's own keys — not the target's current profile — means
      // retraction works even if the target mutated. Symmetric with
      // endorse's read path, and avoids the high-fanout cliff of listing
      // every endorsement the caller has on this target.
      //
      // UX note: this is a targeted retract by specific key_suffixes.
      // There is no "retract everything I endorsed on this target" path —
      // a caller who wants that must first GET /agents/{target}/endorsers,
      // filter by their own account_id, and pass the resulting key_suffixes
      // back here in one or more calls (respecting MAX_KEY_SUFFIXES).
      const keyPrefix = endorsePrefix(target);
      const fullKeys = keySuffixes.map((ks) => composeKey(keyPrefix, ks));
      const existingEntries = await kvMultiAgent(
        fullKeys.map((key) => ({ accountId: caller.accountId, key })),
      );

      const entries: Record<string, unknown> = {};
      const removed: string[] = [];

      for (let i = 0; i < keySuffixes.length; i++) {
        if (existingEntries[i] != null) {
          entries[fullKeys[i]!] = null;
          removed.push(keySuffixes[i]!);
        }
      }

      const result = { account_id: target, action: 'unendorsed', removed };
      if (removed.length === 0) {
        return { kind: 'skip', result };
      }
      return { kind: 'write', entries, onWritten: () => result };
    },
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

  // No write-side timestamp on `agent.last_active` — `agentEntries`
  // strips the field, and the read path derives it from the block
  // timestamp of this very write.
  const entries = agentEntries(agent);

  // Delete old tag keys if tags changed
  if (Array.isArray(body.tags)) {
    const newTags = new Set(agent.tags);
    for (const oldTag of caller.agent.tags) {
      if (!newTags.has(oldTag)) {
        entries[composeKey('tag/', oldTag)] = null;
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
      const capSuffix = `${ns}/${val}`;
      if (!newCapKeys.has(capSuffix)) {
        entries[composeKey('cap/', capSuffix)] = null;
      }
    }
  }

  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) return classifyWriteFailure(wrote, caller.accountId);

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

  // `previousActive` is block-authoritative — `fetchProfile` set
  // `caller.agent.last_active` from the block timestamp of the caller's
  // most recent profile write. Edge comparisons below use
  // `entryBlockSecs(e)` for the same trust source.
  //
  // First-heartbeat case: `caller.agent` is the in-memory `defaultAgent`
  // (no profile exists yet) which carries no `last_active`. The `?? 0`
  // fallback makes the delta surface every pre-existing follower edge as
  // "new since you never existed."
  //
  // Note: `responseAgent.last_active` ends up undefined for first
  // heartbeats and equal to the prior block time for subsequent ones —
  // never wall clock. Clients that need the post-write block time re-read
  // via `GET /agents/me` after the transaction lands.
  const previousActive = caller.agent.last_active ?? 0;
  const agent = { ...caller.agent };

  // Compute live counts from graph traversal (parallel)
  const [followerEntries, followingEntries, endorseEntries] = await Promise.all(
    [
      kvGetAll(`graph/follow/${caller.accountId}`),
      kvListAgent(caller.accountId, 'graph/follow/'),
      kvListAll(endorsePrefix(caller.accountId)),
    ],
  );
  agent.endorsements = buildEndorsementCounts(endorseEntries, caller.accountId);

  // New followers since last heartbeat. We filter by the FastData-indexed
  // block_timestamp of the edge write, not the follower's caller-asserted
  // `value.at`, so a follower cannot backdate their edge to hide from (or
  // forge an appearance in) this delta.
  const newFollowerAccounts: string[] = [];
  for (const e of followerEntries) {
    if (entryBlockSecs(e) >= previousActive) {
      newFollowerAccounts.push(e.predecessor_id);
    }
  }

  // New following since last heartbeat — same block-time rule applied to
  // the caller's own outbound edges for symmetry.
  const newFollowingCount = followingEntries.filter(
    (e) => entryBlockSecs(e) >= previousActive,
  ).length;

  // Batch-fetch profiles for new follower summaries. `fetchProfiles`
  // enforces the trust-boundary override so the summaries always carry
  // the authoritative account_id from the predecessor namespace.
  const newFollowers = (await fetchProfiles(newFollowerAccounts)).map(
    profileSummary,
  );

  // Write updated profile + tag/cap indexes
  const entries = agentEntries(agent);
  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok) return classifyWriteFailure(wrote, caller.accountId);

  incrementRateLimit('heartbeat', caller.accountId);

  const responseAgent: Agent = {
    ...agent,
    follower_count: followerEntries.length,
    following_count: followingEntries.length,
  };

  return ok({
    agent: responseAgent,
    profile_completeness: profileCompleteness(responseAgent),
    delta: {
      since: previousActive,
      new_followers: newFollowers,
      new_followers_count: newFollowers.length,
      new_following_count: newFollowingCount,
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
  const caller = await resolveCallerOrInit(walletKey, resolveAccountId);
  if ('success' in caller) return caller;

  const rl = checkRateLimit('delist_me', caller.accountId);
  if (!rl.ok) return rateLimited(rl.retryAfter);

  // Null-write all agent keys
  const entries: Record<string, unknown> = {
    profile: null,
  };

  // Null-write tag keys
  for (const tag of caller.agent.tags) {
    entries[composeKey('tag/', tag)] = null;
  }

  // Null-write capability keys
  for (const [ns, val] of extractCapabilityPairs(caller.agent.capabilities)) {
    entries[composeKey('cap/', `${ns}/${val}`)] = null;
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
  if (!wrote.ok) return classifyWriteFailure(wrote, caller.accountId);

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

/** Normalize single account_id or targets[] into a non-empty array.
 *  Rejects non-string items in `targets[]` at the boundary so downstream
 *  handlers never see garbage (a numeric item would crash on `.trim()`). */
function resolveTargets(body: Record<string, unknown>): string[] | WriteResult {
  if (Array.isArray(body.targets)) {
    for (const t of body.targets) {
      if (typeof t !== 'string') {
        return fail('VALIDATION_ERROR', 'targets[] items must be strings');
      }
    }
    return body.targets as string[];
  }
  const accountId = body.account_id;
  if (typeof accountId !== 'string' || !accountId) {
    return fail('VALIDATION_ERROR', 'account_id is required');
  }
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
