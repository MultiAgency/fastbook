import { type NextRequest, NextResponse } from 'next/server';
import { errJson, successJson } from '@/lib/api-response';
import {
  getCached,
  invalidateForMutation,
  makeCacheKey,
  setCache,
} from '@/lib/cache';
import { LIMITS } from '@/lib/constants';
import {
  dispatchFastData,
  type FastDataError,
  handleGetSuggested,
} from '@/lib/fastdata/reads';
import { dispatchWrite } from '@/lib/fastdata/writes';
import { isGenerateConfigured } from '@/lib/llm-server';
import {
  callOutlayer,
  getOutlayerPaymentKey,
  resolveAccountId,
  sanitizePublic,
  signClaimForWalletKey,
} from '@/lib/outlayer-server';
import { handleRegisterPlatforms, PLATFORM_META } from '@/lib/platforms';
import { checkRateLimit, incrementRateLimit } from '@/lib/rate-limit';
import {
  type ActionName,
  type ResolvedRoute,
  resolveRoute,
} from '@/lib/routes';
import { verifyClaim } from '@/lib/verify-claim';
import type { Agent, VrfProof } from '@/types';
import { agentActions } from './actions';
import { handleHideAgent, handleListHidden, handleUnhideAgent } from './admin';
import { getClientIp, NEAR_RE, resolveCallerAccountId, WK_RE } from './auth';
import { dispatchGenerate, dispatchGenerateReason } from './generate';
import { validateQueryParams } from './query';

const MAX_BODY_BYTES = LIMITS.MAX_BODY_BYTES;

function tooLargeResponse(): NextResponse {
  return errJson(
    'VALIDATION_ERROR',
    `Request body too large (max ${MAX_BODY_BYTES / 1024} KB)`,
    413,
  );
}

function errJsonFromFastData(result: {
  error: string;
  status?: number;
}): NextResponse {
  const status = result.status ?? 404;
  return errJson(
    status === 400 ? 'VALIDATION_ERROR' : 'NOT_FOUND',
    result.error,
    status,
  );
}

// Auth-gated action sets, split by dispatch path and current gate state.
// Reads (`me`, `activity`, `network`) accept `near:` tokens for
// personalization — they're auth='wk' but NOT in either set below.

// Actions dispatched via dispatchWrite — FastData KV mutations under
// the caller's predecessor. Both `wk_` and `near:` callers are
// accepted; for `near:`, OutLayer's `resolveAccountId` cryptographically
// resolves the caller and a derived hex64 implicit account (keyed by
// the named account + seed) pays its own gas and appears as the
// on-chain signer. The named account authenticates the request; the
// derived hex64 implicit account signs the FastData write — accepted
// trade-off for not requiring a fresh OutLayer wallet per caller.
export const FASTDATA_WRITE_ACTIONS = new Set<ActionName>([
  'social.follow',
  'social.unfollow',
  'social.endorse',
  'social.unendorse',
  'social.profile',
  'social.heartbeat',
  'social.delist_me',
]);

// Operator-paid LLM calls via NEAR AI Cloud (no FastData write, no
// caller gas). Accepts both `wk_` and `near:` Bearers; per-caller
// cost-runaway is bounded by `budget.ts` (per-`accountId` daily quota
// + global daily cap as Sybil backstop), applied uniformly regardless
// of bearer type. The set name persists as a *dispatch* discriminant
// — LLM calls are budgeted differently from FastData writes — even
// though it no longer gates on bearer type.
export const BUDGET_GATED_ACTIONS = new Set<ActionName>([
  'generate.profile',
  'generate.follow',
  'generate.endorse',
]);

// Authenticated mutations that don't touch FastData — they proxy an
// external registration call, so there's no cache to invalidate on success.
const PASSTHROUGH_WRITE_ACTIONS = new Set<ActionName>(['register_platforms']);

async function dispatch(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;

  const route = resolveRoute(request.method, path);

  if (!route) {
    return errJson('NOT_FOUND', 'Not found', 404);
  }

  const isPublic = route.auth === 'public';

  const authHeader = request.headers.get('authorization');
  const walletKey =
    authHeader?.match(WK_RE)?.[1] ?? authHeader?.match(NEAR_RE)?.[1];

  let wasmBody: Record<string, unknown>;

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const queryResult = validateQueryParams(url, route.queryFields);
    if (!queryResult.ok) return queryResult.response;
    wasmBody = {
      ...queryResult.params,
      ...route.pathParams,
      action: route.action,
    };
  } else {
    // Two-stage size check: header fast-fails honest clients; post-read length catches lying clients (Content-Length:0 + 1MB body). Removing either re-opens a DoS vector.
    const contentLength = parseInt(
      request.headers.get('content-length') ?? '0',
      10,
    );
    if (contentLength > MAX_BODY_BYTES) return tooLargeResponse();
    let body: Record<string, unknown> = {};
    let text: string;
    try {
      text = await request.text();
    } catch {
      return errJson('INTERNAL_ERROR', 'Failed to read request body', 500);
    }
    if (text.length > MAX_BODY_BYTES) return tooLargeResponse();
    if (text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return errJson('VALIDATION_ERROR', 'Invalid JSON body', 400);
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return errJson(
          'VALIDATION_ERROR',
          'Request body must be a JSON object',
          400,
        );
      }
      body = parsed as Record<string, unknown>;
    }
    wasmBody = { ...body, ...route.pathParams, action: route.action };
  }

  // Normalize path param: :accountId → account_id for dispatch functions.
  // Path param always wins over body to prevent account_id injection.
  if (wasmBody.accountId) {
    wasmBody.account_id = wasmBody.accountId;
    delete wasmBody.accountId;
  }

  // Admin branch covers only the *write* admin actions. `list_hidden` is intentionally `auth: 'public'` so the frontend can poll without credentials; it routes through the public branch below, not `assertAdminAuth`.
  if (route.auth === 'admin') {
    const accountId = route.pathParams.accountId;
    if (route.action === 'hide_agent')
      return handleHideAgent(request, accountId);
    if (route.action === 'unhide_agent')
      return handleUnhideAgent(request, accountId);
    return errJson('NOT_FOUND', 'Not found', 404);
  }

  if (isPublic) {
    // verify_claim is a pure function with rate limiting — handled directly.
    if (route.action === 'verify_claim') {
      return handleVerifyClaim(request, wasmBody);
    }
    // Admin hidden-set list: rate-limited by IP, no FastData read path.
    if (route.action === 'list_hidden') {
      return handleListHidden(request);
    }
    // Caller-aware profile read: cache is skipped because the response
    // varies per caller.
    if (route.action === 'profile' && walletKey) {
      return dispatchProfileWithCaller(route, wasmBody, walletKey);
    }
    return dispatchPublic(request, route, wasmBody);
  }
  return dispatchAuthenticated(request, route, wasmBody, walletKey);
}

/**
 * Profile read enriched with caller context. Bypasses the public cache
 * because `is_following` and `my_endorsements` vary per caller. An invalid
 * bearer token returns 401 rather than silently downgrading — if a client
 * sent credentials, a failure to resolve them is a bug they should see.
 */
async function dispatchProfileWithCaller(
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
  walletKey: string,
): Promise<NextResponse> {
  const callerAccountId = await resolveCallerAccountId(walletKey);
  if (!callerAccountId) {
    return errJson('AUTH_FAILED', 'Could not resolve account', 401);
  }
  const enriched = {
    ...sanitizePublic(wasmBody),
    caller_account_id: callerAccountId,
  };
  const result = await dispatchFastData(route.action, enriched);
  if ('error' in result) return errJsonFromFastData(result);
  return successJson(result.data);
}

/**
 * POST /verify-claim — general-purpose NEP-413 verifier.
 * Public, rate-limited per client IP. Pure function, never writes. Caller
 * supplies the recipient to pin; optional `expected_domain` tightens the
 * message-layer check.
 */
async function handleVerifyClaim(
  request: NextRequest,
  wasmBody: Record<string, unknown>,
): Promise<NextResponse> {
  const ip = getClientIp(request);
  const rl = checkRateLimit('verify_claim', ip);
  if (!rl.ok) {
    return errJson('RATE_LIMITED', 'Too many verification requests', 429, {
      retryAfter: rl.retryAfter,
    });
  }
  incrementRateLimit('verify_claim', ip, rl.window);

  // `dispatch` injects `action: 'verify_claim'` into wasmBody — drop it, plus
  // the `recipient` / `expected_domain` hints which are inputs to the verifier
  // but not part of the claim shape.
  const {
    action: _action,
    recipient,
    expected_domain,
    ...claimInput
  } = wasmBody;

  if (
    typeof recipient !== 'string' ||
    recipient.length < 1 ||
    recipient.length > 128
  ) {
    return errJson(
      'VALIDATION_ERROR',
      '`recipient` must be a string, 1–128 characters',
      400,
    );
  }
  if (expected_domain !== undefined && typeof expected_domain !== 'string') {
    return errJson(
      'VALIDATION_ERROR',
      '`expected_domain` must be a string',
      400,
    );
  }

  const result = await verifyClaim(claimInput, recipient, expected_domain);
  const status = !result.valid && result.reason === 'rpc_error' ? 502 : 200;
  return NextResponse.json(result, { status });
}

async function dispatchPublic(
  request: NextRequest,
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
): Promise<NextResponse> {
  if (route.action === 'list_platforms') {
    const ip = getClientIp(request);
    const rl = checkRateLimit('list_platforms', ip);
    if (!rl.ok) {
      return errJson('RATE_LIMITED', 'Too many platform requests', 429, {
        retryAfter: rl.retryAfter,
      });
    }
    incrementRateLimit('list_platforms', ip, rl.window);
    return successJson({ platforms: PLATFORM_META });
  }

  // Authenticated callers bypass the public cache: they're typically reading
  // their own writes, and the in-memory cache is per-instance so cross-instance
  // stale reads can last up to TTL after a mutation. The cache exists to absorb
  // anonymous scrape load, not to degrade UX for wallet holders.
  const hasWalletKey = request.headers
    .get('authorization')
    ?.match(/^Bearer\s+wk_/);

  const sanitized = sanitizePublic(wasmBody);
  const cacheKey = makeCacheKey(sanitized);
  if (!hasWalletKey) {
    const cached = getCached(cacheKey);
    if (cached) {
      return successJson(cached);
    }
  }
  const result = await dispatchFastData(route.action, sanitized);
  if ('error' in result) return errJsonFromFastData(result);
  if (!hasWalletKey) {
    setCache(route.action, cacheKey, result.data);
  }
  return successJson(result.data);
}

async function handleAuthenticatedGet(
  walletKey: string,
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
): Promise<NextResponse> {
  const callerAccountId = await resolveCallerAccountId(walletKey);
  if (!callerAccountId) {
    return errJson('AUTH_FAILED', 'Could not resolve account', 401);
  }

  // discover_agents: fetch VRF seed from WASM TEE, then rank deterministically.
  if (route.action === 'discover_agents') {
    let vrfProof: VrfProof | null = null;
    const claim = await signClaimForWalletKey(walletKey, 'get_vrf_seed');
    if (claim) {
      const serverKey = getOutlayerPaymentKey();
      const { decoded } = await callOutlayer(
        {
          action: 'get_vrf_seed',
          verifiable_claim: {
            account_id: claim.account_id,
            public_key: claim.public_key,
            signature: claim.signature,
            nonce: claim.nonce,
            message: claim.message,
          },
        },
        serverKey || walletKey,
      );
      if (decoded?.success) {
        const d = decoded.data as Record<string, string>;
        vrfProof = {
          output_hex: d.output_hex,
          signature_hex: d.signature_hex,
          alpha: d.alpha,
          vrf_public_key: d.vrf_public_key,
        };
      }
    }
    const fdResult = await handleGetSuggested(
      { ...wasmBody, account_id: callerAccountId },
      vrfProof,
    );
    if ('error' in fdResult) return errJsonFromFastData(fdResult);
    return successJson(fdResult.data);
  }

  const fdResult = await dispatchFastData(route.action, {
    ...wasmBody,
    account_id: callerAccountId,
  });
  if ('error' in fdResult)
    return errJsonFromFastData(fdResult as FastDataError);

  if (route.action === 'me' && fdResult.data) {
    const d = fdResult.data as Record<string, unknown>;
    if (d.agent) {
      const actions = agentActions(d.agent as Agent);
      if (actions.length > 0) d.actions = actions;
      d.features = serverFeatures(walletKey);
    }
  }

  // Authenticated reads are per-caller and the caller typically mutates
  // between reads, so caching them is a net loss — don't.
  return successJson(fdResult.data);
}

function serverFeatures(walletKey: string | undefined): { generate: boolean } {
  return {
    generate:
      isGenerateConfigured() &&
      (walletKey?.startsWith('wk_') || walletKey?.startsWith('near:') || false),
  };
}

async function dispatchAuthenticated(
  request: NextRequest,
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
  walletKey: string | undefined,
): Promise<NextResponse> {
  const isAnyBearer =
    walletKey?.startsWith('wk_') || walletKey?.startsWith('near:');

  // Operator-paid LLM calls — both bearer types accepted; budgeted in
  // generate.ts via `checkGenerateBudget` (per-caller daily + global cap).
  if (isAnyBearer && walletKey && route.action === 'generate.profile') {
    return await dispatchGenerate(walletKey, wasmBody);
  }
  if (isAnyBearer && walletKey && route.action === 'generate.follow') {
    return await dispatchGenerateReason(
      walletKey,
      wasmBody,
      route.pathParams.accountId,
      'follow',
    );
  }
  if (isAnyBearer && walletKey && route.action === 'generate.endorse') {
    return await dispatchGenerateReason(
      walletKey,
      wasmBody,
      route.pathParams.accountId,
      'endorse',
    );
  }

  // Direct write path — bypasses WASM, writes to FastData via custody
  // wallet. Accepts both `wk_` and `near:` Bearers; `resolveAccountId`
  // cryptographically resolves either via OutLayer's /sign-message.
  if (
    (walletKey?.startsWith('wk_') || walletKey?.startsWith('near:')) &&
    FASTDATA_WRITE_ACTIONS.has(route.action)
  ) {
    const result = await dispatchWrite(
      route.action,
      wasmBody,
      walletKey,
      resolveAccountId,
    );
    if (result.success) {
      invalidateForMutation(result.invalidates);

      if (
        (route.action === 'social.heartbeat' ||
          route.action === 'social.profile') &&
        result.data?.agent
      ) {
        const actions = agentActions(result.data.agent as Agent);
        if (actions.length > 0) result.data.actions = actions;
        result.data.features = serverFeatures(walletKey);
      }

      return successJson(result.data);
    }
    const errBody: Record<string, unknown> = {
      success: false,
      error: result.error,
      code: result.code,
    };
    if (result.retryAfter) errBody.retry_after = result.retryAfter;
    if (result.meta) Object.assign(errBody, result.meta);
    const resp = NextResponse.json(errBody, { status: result.status });
    if (result.retryAfter) {
      resp.headers.set('Retry-After', String(result.retryAfter));
    }
    return resp;
  }

  if (!walletKey) {
    return errJson(
      'AUTH_REQUIRED',
      'Authentication required. Provide Authorization: Bearer wk_... or Bearer near:<token>',
      401,
    );
  }

  if (request.method === 'GET') {
    return handleAuthenticatedGet(walletKey, route, wasmBody);
  }

  // Passthrough writes: authenticated but don't touch FastData, so no
  // cache invalidation.
  if (PASSTHROUGH_WRITE_ACTIONS.has(route.action)) {
    return handleRegisterPlatforms(walletKey, wasmBody);
  }

  return errJson('NOT_FOUND', `Unknown action: ${route.action}`, 404);
}

export {
  dispatch as GET,
  dispatch as POST,
  dispatch as PATCH,
  dispatch as DELETE,
};
