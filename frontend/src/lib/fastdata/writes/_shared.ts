/**
 * Shared write-path infrastructure for FastData KV mutations.
 *
 * Result/outcome types, response builders, the awaitable
 * `writeToFastData` transport, caller-identity resolution, and the
 * batch orchestrator (`runBatch`) live here so per-handler files can
 * stay focused on their action's shape.
 */

import { LIMITS, type NearlyError } from '@nearly/sdk';
import type { Agent } from '@/types';
import {
  EXTERNAL_URLS,
  FASTDATA_NAMESPACE,
  FUND_AMOUNT_NEAR,
  OUTLAYER_API_URL,
} from '../../constants';
import { fetchWithTimeout } from '../../fetch';
import { checkRateLimitBudget, incrementRateLimit } from '../../rate-limit';
import { fetchProfile } from '../utils';

const BALANCE_CHECK_TIMEOUT_MS = 5_000;

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

export type WriteOutcome =
  | { ok: true }
  | { ok: false; reason: 'insufficient_balance' | 'storage_error' };

// Batch-item errors live alongside successful result rows in a batch's
// `results[]` array — a different shape from top-level `WriteResult`
// failures, which become the response itself. `code` is deliberately a
// plain string (not a narrowed union): the batch-result code namespace
// is distinct from `NearlyErrorShape.code` in the SDK, and values like
// `SELF_FOLLOW` / `RATE_LIMITED` appear only here.
export type BatchItemError = {
  account_id: string;
  action: 'error';
  code: string;
  error: string;
};

export interface CallerIdentity {
  accountId: string;
  agent: Agent;
}

export type BatchAction =
  | 'social.follow'
  | 'social.unfollow'
  | 'social.endorse'
  | 'social.unendorse';

export type BatchStep =
  | { kind: 'skip'; result: Record<string, unknown> }
  | { kind: 'fail'; result: Record<string, unknown> }
  | {
      kind: 'write';
      entries: Record<string, unknown>;
      onWritten: () => Record<string, unknown>;
    };

export interface BatchOptions {
  action: BatchAction;
  selfCode: string;
  verb: string;
  walletKey: string;
  targets: readonly string[];
  resolveAccountId: (wk: string) => Promise<string | null>;
  step: (target: string, caller: CallerIdentity) => Promise<BatchStep>;
  finalize?: (
    results: Record<string, unknown>[],
    caller: CallerIdentity,
    processed: number,
  ) => Promise<Record<string, unknown>>;
}

export function ok(data: Record<string, unknown>): WriteResult {
  return { success: true, data, invalidates: [] };
}

export function fail(code: string, message: string, status = 400): WriteResult {
  return { success: false, error: message, code, status };
}

export function rateLimited(retryAfter: number): WriteResult {
  return {
    success: false,
    error: `Rate limit exceeded. Retry after ${retryAfter}s.`,
    code: 'RATE_LIMITED',
    status: 429,
    retryAfter,
  };
}

export function validationFail(e: NearlyError): WriteResult {
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

export function writeFailureToResult(
  wrote: Extract<WriteOutcome, { ok: false }>,
  accountId: string,
): WriteResult {
  return wrote.reason === 'insufficient_balance'
    ? insufficientBalance(accountId)
    : fail('STORAGE_ERROR', 'Failed to write to FastData', 500);
}

function batchItemError(
  accountId: string,
  code: string,
  error: string,
): BatchItemError {
  return { account_id: accountId, action: 'error', code, error };
}

function targetGuardError(
  targetAccountId: string,
  callerAccountId: string,
  selfCode: string,
  verb: string,
): BatchItemError | null {
  if (!targetAccountId.trim()) {
    return batchItemError(
      targetAccountId,
      'VALIDATION_ERROR',
      'empty account_id',
    );
  }
  if (targetAccountId === callerAccountId) {
    return batchItemError(targetAccountId, selfCode, `cannot ${verb} yourself`);
  }
  return null;
}

// Best-effort probe for `writeToFastData`'s 502 branch. Silent on error
// and fail-closed (returns false) so an upstream outage is never
// misclassified as a drained wallet — the caller logs and falls back
// to STORAGE_ERROR.
async function hasZeroNearBalance(walletKey: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${OUTLAYER_API_URL}/wallet/v1/balance?chain=near`,
      { headers: { Authorization: `Bearer ${walletKey}` } },
      BALANCE_CHECK_TIMEOUT_MS,
    );
    if (!res.ok) return false;
    const data = (await res.json().catch((e: unknown) => {
      console.error('[isUnfundedWallet] json parse failed', e);
      return null;
    })) as {
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
    console.error(`[fastdata/writes] http ${res.status}: ${detail}`);
    // Zero-balance writes return 502 + text/plain (Cloudflare upstream),
    // so probe the balance endpoint to disambiguate a genuine outage from
    // an unfunded wallet — a funded wallet hitting a real outage must
    // stay STORAGE_ERROR so the caller retries instead of prompting to fund.
    if (res.status === 502 && (await hasZeroNearBalance(walletKey))) {
      return { ok: false, reason: 'insufficient_balance' };
    }
    return { ok: false, reason: 'storage_error' };
  } catch (err) {
    console.error('[fastdata/writes] network error:', err);
    return { ok: false, reason: 'storage_error' };
  }
}

// No time fields: `last_active` / `created_at` are read-derived from
// block timestamps and have no honest write-side value before the first
// read.
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

// Nearly does not gate profile creation — any authenticated `wk_` can
// mutate, and the first profile-writing mutation (heartbeat or profile)
// bootstraps the profile blob. Edge-only callers stay invisible to
// `list_agents` until that first profile write lands.
export async function resolveCallerOrInit(
  walletKey: string,
  resolveAccountId: (wk: string) => Promise<string | null>,
): Promise<CallerIdentity | WriteResult> {
  const accountId = await resolveAccountId(walletKey);
  if (!accountId) return fail('AUTH_FAILED', 'Could not resolve account', 401);

  const existing = await fetchProfile(accountId);
  return { accountId, agent: existing ?? defaultAgent(accountId) };
}

// Reject non-string `targets[]` items at the boundary — a numeric item
// would crash downstream handlers on `.trim()`. Empty/max-size gating
// lives here too so `runBatch` can assume pre-validated input.
export function resolveTargets(
  body: Record<string, unknown>,
): string[] | WriteResult {
  if (Array.isArray(body.targets)) {
    if (body.targets.length === 0)
      return fail('VALIDATION_ERROR', 'targets array must not be empty');
    if (body.targets.length > LIMITS.MAX_BATCH_TARGETS)
      return fail(
        'VALIDATION_ERROR',
        `Too many targets (max ${LIMITS.MAX_BATCH_TARGETS})`,
      );
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

// A 402 on any write aborts the batch with INSUFFICIENT_BALANCE — no
// subsequent target would succeed with an underfunded wallet, and the
// caller needs the fund link, not N misleading STORAGE_ERROR items.
export async function runBatch(opts: BatchOptions): Promise<WriteResult> {
  const { targets } = opts;

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
      results.push(
        batchItemError(
          target,
          'RATE_LIMITED',
          'rate limit reached within batch',
        ),
      );
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

    incrementRateLimit(opts.action, caller.accountId, budget.window);
    processed++;
    results.push(step.onWritten());
  }

  const payload = opts.finalize
    ? await opts.finalize(results, caller, processed)
    : { results };
  return ok(payload);
}
