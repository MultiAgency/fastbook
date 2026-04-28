import { validateReason } from '@nearly/sdk';
import type { NextResponse } from 'next/server';
import { errJson, successJson } from '@/lib/api-response';
import {
  type BudgetScope,
  checkGenerateBudget,
  incrementGenerateBudget,
} from '@/lib/budget';
import { fetchProfile } from '@/lib/fastdata/utils';
import {
  GENERATE_FIELDS,
  type GenerateField,
  generateEndorseReason,
  generateFollowReason,
  generateProfileField,
  isGenerateConfigured,
  type ReasonGenerateContext,
} from '@/lib/llm-server';
import { resolveAccountId } from '@/lib/outlayer-server';
import { checkRateLimit, incrementRateLimit } from '@/lib/rate-limit';

function budgetExhaustedResponse(
  scope: BudgetScope,
  retryAfter: number,
): NextResponse {
  return errJson(
    'BUDGET_EXHAUSTED',
    scope === 'caller'
      ? 'Daily generate quota exhausted for this account.'
      : 'Daily generate budget exhausted for this deployment.',
    429,
    { retryAfter },
  );
}

export async function dispatchGenerate(
  walletKey: string,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  if (!isGenerateConfigured()) {
    return errJson(
      'NOT_CONFIGURED',
      'NEAR AI generate is not configured for this deployment.',
      503,
    );
  }
  const field = body.field;
  if (
    typeof field !== 'string' ||
    !GENERATE_FIELDS.includes(field as GenerateField)
  ) {
    return errJson(
      'VALIDATION_ERROR',
      'field must be one of name, description, tags, capabilities, image',
      400,
    );
  }
  const current =
    body.current &&
    typeof body.current === 'object' &&
    !Array.isArray(body.current)
      ? (body.current as Record<string, unknown>)
      : {};

  const accountId = await resolveAccountId(walletKey);
  if (!accountId) {
    return errJson('AUTH_FAILED', 'Could not resolve caller account', 401);
  }
  const rl = checkRateLimit('generate.profile', accountId);
  if (!rl.ok) {
    return errJson('RATE_LIMITED', 'Too many profile-draft requests', 429, {
      retryAfter: rl.retryAfter,
    });
  }
  const budget = checkGenerateBudget(accountId);
  if (!budget.ok) {
    return budgetExhaustedResponse(budget.scope, budget.retryAfter);
  }
  // Increment before the call — a thrown LLM failure still incurred the
  // outbound NEAR AI request and must count against the caller's budget,
  // otherwise an upstream flake becomes a free spam loop.
  incrementRateLimit('generate.profile', accountId, rl.window);
  incrementGenerateBudget(accountId, budget.window);
  try {
    const value = await generateProfileField({
      field: field as GenerateField,
      current,
    });
    return successJson({ field, value });
  } catch (err) {
    // Convert throws into the same `value: null` graceful-nudge shape
    // promised by `llm-server.generateProfileField`'s contract — the
    // dispatch boundary is where exceptions get translated into
    // structured results, matching the convention in `fastdata/writes/`.
    console.warn(`[generate] upstream call threw for field=${field}`, err);
    return successJson({ field, value: null });
  }
}

export async function dispatchGenerateReason(
  walletKey: string,
  body: Record<string, unknown>,
  targetAccountId: string | undefined,
  kind: 'follow' | 'endorse',
): Promise<NextResponse> {
  if (!isGenerateConfigured()) {
    return errJson(
      'NOT_CONFIGURED',
      'NEAR AI generate is not configured for this deployment.',
      503,
    );
  }
  if (!targetAccountId) {
    return errJson('VALIDATION_ERROR', 'target accountId required', 400);
  }
  // Optional draft. validateReason rejects unicode-unsafe / overlong text;
  // garbage in would only confuse the model and burn the rate-limit slot.
  const draft =
    typeof body.reason === 'string' && body.reason ? body.reason : undefined;
  if (draft !== undefined) {
    const e = validateReason(draft);
    if (e) {
      return errJson(
        'VALIDATION_ERROR',
        e.message ?? 'invalid reason draft',
        400,
      );
    }
  }
  const callerAccountId = await resolveAccountId(walletKey);
  if (!callerAccountId) {
    return errJson('AUTH_FAILED', 'Could not resolve caller account', 401);
  }
  // Self-check runs after caller resolution (needs the resolved id) and before rate-limit/budget checks (don't burn a quota slot for a request bound for 400).
  if (callerAccountId === targetAccountId) {
    return errJson(
      'VALIDATION_ERROR',
      `Cannot generate ${kind} reason for self`,
      400,
    );
  }
  const action = `generate.${kind}` as const;
  const rl = checkRateLimit(action, callerAccountId);
  if (!rl.ok) {
    return errJson('RATE_LIMITED', `Too many ${kind}-reason requests`, 429, {
      retryAfter: rl.retryAfter,
    });
  }
  const budget = checkGenerateBudget(callerAccountId);
  if (!budget.ok) {
    return budgetExhaustedResponse(budget.scope, budget.retryAfter);
  }
  // Increment before the call — same reasoning as profile generate.
  incrementRateLimit(action, callerAccountId, rl.window);
  incrementGenerateBudget(callerAccountId, budget.window);
  const [targetProfile, callerProfile] = await Promise.all([
    fetchProfile(targetAccountId),
    fetchProfile(callerAccountId),
  ]);
  // Suffix-agnostic for endorse: the prompt conditions on profile overlap
  // (target and caller name/description/tags), not on the specific
  // `key_suffixes` the caller intends to apply the reason to. Profile
  // overlap is the real ground-truth context; suffix-tailoring would add
  // prompt complexity for a quality delta that may not materialize.
  // Backwards-compatible to add later as an optional body field if real
  // UI feedback shows it matters.
  const ctx: ReasonGenerateContext = {
    targetAccountId,
    targetName: targetProfile?.name ?? null,
    targetDescription: targetProfile?.description ?? '',
    targetTags: targetProfile?.tags ?? [],
    callerAccountId,
    callerName: callerProfile?.name ?? null,
    callerDescription: callerProfile?.description ?? '',
    callerTags: callerProfile?.tags ?? [],
    reason: draft,
  };
  try {
    const value =
      kind === 'follow'
        ? await generateFollowReason(ctx)
        : await generateEndorseReason(ctx);
    return successJson({ reason: value });
  } catch (err) {
    console.warn(
      `[generate] upstream call threw for ${kind}:${targetAccountId}`,
      err,
    );
    return successJson({ reason: null });
  }
}
