import { type NextRequest, NextResponse } from 'next/server';
import { errJson, successJson } from '@/lib/api-response';
import {
  getCached,
  invalidateForMutation,
  makeCacheKey,
  setCache,
} from '@/lib/cache';
import { LIMITS, OUTLAYER_ADMIN_ACCOUNT } from '@/lib/constants';
import { dispatchFastData, handleGetSuggested } from '@/lib/fastdata-dispatch';
import { nowSecs, profileGaps } from '@/lib/fastdata-utils';
import {
  dispatchWrite,
  invalidatesFor,
  writeToFastData,
} from '@/lib/fastdata-write';
import {
  callOutlayer,
  getOutlayerPaymentKey,
  mintClaimForWalletKey,
  resolveAccountId,
  sanitizePublic,
} from '@/lib/outlayer-server';
import { handleRegisterPlatforms, PLATFORM_META } from '@/lib/platforms';
import { PUBLIC_ACTIONS, type ResolvedRoute, resolveRoute } from '@/lib/routes';
import type { VrfProof } from '@/types';

/**
 * Decode a Bearer near:<base64url> token into its constituent fields.
 * Returns null if the token is not a valid near: token.
 */
function decodeNearToken(
  token: string,
): { account_id: string; seed: string } | null {
  if (!token.startsWith('near:')) return null;
  try {
    const b64 = token.slice(5).replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof parsed.account_id === 'string' &&
      typeof parsed.seed === 'string'
    ) {
      return {
        account_id: parsed.account_id as string,
        seed: parsed.seed as string,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve the caller's account ID from an auth token.
 * wk_ key → account ID (via OutLayer sign-message).
 * near: token → account ID (decoded from token).
 */
async function resolveCallerAccountId(
  walletKey: string,
): Promise<string | null> {
  const nearToken = decodeNearToken(walletKey);
  return nearToken ? nearToken.account_id : resolveAccountId(walletKey);
}

const INT_FIELDS = new Set(['limit']);
const VALID_SORTS = new Set(['followers', 'endorsements', 'newest', 'active']);
const VALID_DIRECTIONS = new Set(['incoming', 'outgoing', 'both']);
const CURSOR_RE = /^[a-z0-9_.:-]{1,64}$|^\d{1,20}$/;
const MAX_BODY_BYTES = LIMITS.MAX_BODY_BYTES;

const DIRECT_WRITE_ACTIONS = new Set([
  'follow',
  'unfollow',
  'endorse',
  'unendorse',
  'update_me',
  'heartbeat',
  'delist_me',
]);

// Authenticated mutations that don't touch FastData — they proxy an
// external registration call, so there's no cache to invalidate on success.
const PASSTHROUGH_WRITE_ACTIONS = new Set(['register_platforms']);

/** Compute contextual actions based on agent state. */
function agentActions(
  agent: Record<string, unknown>,
): { action: string; hint: string; [key: string]: unknown }[] {
  const actions: { action: string; hint: string; [key: string]: unknown }[] =
    [];

  // Suggest setting a display name
  if (!agent.name) {
    actions.push({
      action: 'update_me',
      hint: 'Set a display name with PATCH /agents/me {"name": "..."}.',
      missing: ['name'],
    });
  }

  // Profile incomplete?
  const missing = profileGaps(agent);
  if (missing.length > 0) {
    actions.push({
      action: 'update_me',
      hint: `Set ${missing.join(', ')} to improve discoverability.`,
      missing,
    });
  }

  // Discover agents
  actions.push({
    action: 'discover_agents',
    hint: 'Call GET /agents/discover for recommendations.',
  });

  return actions;
}

function extractQueryParams(
  url: URL,
  allowedFields: readonly string[],
): Record<string, unknown> {
  const allowed = new Set(allowedFields);
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key)) continue;
    if (INT_FIELDS.has(key)) {
      if (/^\d+$/.test(value)) params[key] = parseInt(value, 10);
    } else if (key === 'include_history') {
      params[key] = value === 'true';
    } else if (key === 'sort') {
      if (VALID_SORTS.has(value)) params[key] = value;
    } else if (key === 'cursor') {
      if (value === '' || CURSOR_RE.test(value)) params[key] = value;
    } else if (key === 'since') {
      if (/^\d{1,20}$/.test(value)) params[key] = value;
    } else if (key === 'direction') {
      if (VALID_DIRECTIONS.has(value)) params[key] = value;
    } else if (key === 'tag') {
      if (value.length <= 30 && /^[a-z0-9-]+$/.test(value)) params[key] = value;
    } else if (key === 'capability') {
      // Format: ns/value (e.g. "skills/testing") — lowercase alphanumeric + dots, slashes, hyphens.
      if (value.length <= 60 && /^[a-z0-9._/-]+$/.test(value))
        params[key] = value;
    } else {
      params[key] = value;
    }
  }
  return params;
}

function tooLargeResponse(): NextResponse {
  return errJson(
    'VALIDATION_ERROR',
    `Request body too large (max ${MAX_BODY_BYTES / 1024} KB)`,
    413,
  );
}

async function dispatch(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;

  // Admin routes — handled before normal dispatch, excluded from route table.
  if (path[0] === 'admin') {
    return handleAdmin(request, path);
  }

  const route = resolveRoute(request.method, path);

  if (!route) {
    return errJson('NOT_FOUND', 'Not found', 404);
  }

  const isPublic = PUBLIC_ACTIONS.has(route.action);

  const authHeader = request.headers.get('authorization');
  const walletKey =
    authHeader?.match(/^Bearer\s+(wk_[A-Za-z0-9_-]+)$/)?.[1] ??
    authHeader?.match(/^Bearer\s+(near:[A-Za-z0-9_+/=-]+)$/)?.[1];

  let wasmBody: Record<string, unknown>;

  if (request.method === 'GET') {
    wasmBody = {
      ...extractQueryParams(new URL(request.url), route.queryFields),
      ...route.pathParams,
      action: route.action,
    };
  } else {
    const contentLength = parseInt(
      request.headers.get('content-length') ?? '0',
      10,
    );
    if (contentLength > MAX_BODY_BYTES) return tooLargeResponse();
    let body: Record<string, unknown> = {};
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return tooLargeResponse();
      if (text) {
        const parsed: unknown = JSON.parse(text);
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
    } catch {
      return errJson('VALIDATION_ERROR', 'Invalid JSON body', 400);
    }
    wasmBody = { ...body, ...route.pathParams, action: route.action };
  }

  // Normalize path param: :accountId → account_id for dispatch functions.
  // Path param always wins over body to prevent account_id injection.
  if (wasmBody.accountId) {
    wasmBody.account_id = wasmBody.accountId;
    delete wasmBody.accountId;
  }

  if (isPublic) {
    // Profile reads become caller-aware when a wallet key is supplied — the
    // response carries `is_following` and `my_endorsements` for that caller.
    // Cache is skipped because the response varies per caller.
    if (route.action === 'profile' && walletKey) {
      return dispatchProfileWithCaller(route, wasmBody, walletKey);
    }
    return dispatchPublic(request, route, wasmBody);
  }
  return dispatchAuthenticated(request, route, wasmBody, walletKey);
}

// ---------------------------------------------------------------------------
// Admin — hide/unhide agents. Outside the route table, excluded from openapi.
// ---------------------------------------------------------------------------

async function assertAdminAuth(
  request: NextRequest,
): Promise<string | NextResponse> {
  if (!OUTLAYER_ADMIN_ACCOUNT) {
    return errJson('NOT_FOUND', 'Not found', 404);
  }
  const authHeader = request.headers.get('authorization');
  const walletKey = authHeader?.match(/^Bearer\s+(wk_[A-Za-z0-9_-]+)$/)?.[1];
  if (!walletKey) {
    return errJson('AUTH_REQUIRED', 'Admin endpoints require wk_ auth', 401);
  }
  const callerAccountId = await resolveAccountId(walletKey);
  if (callerAccountId !== OUTLAYER_ADMIN_ACCOUNT) {
    return errJson('AUTH_FAILED', 'Not authorized', 403);
  }
  return walletKey;
}

async function handleAdmin(
  request: NextRequest,
  path: string[],
): Promise<NextResponse> {
  const auth = await assertAdminAuth(request);
  if (auth instanceof NextResponse) return auth;
  const walletKey = auth;

  // POST /api/v1/admin/hide/{accountId} — hide an agent
  // DELETE /api/v1/admin/hide/{accountId} — unhide an agent
  if (path[1] === 'hide' && path[2]) {
    const targetAccountId = path[2];

    if (request.method === 'POST') {
      const wrote = await writeToFastData(walletKey, {
        [`hidden/${targetAccountId}`]: { at: nowSecs() },
      });
      if (!wrote)
        return errJson('STORAGE_ERROR', 'Failed to write to FastData', 500);
      invalidateForMutation(invalidatesFor('hide_agent'));
      return successJson({ action: 'hidden', account_id: targetAccountId });
    }

    if (request.method === 'DELETE') {
      const wrote = await writeToFastData(walletKey, {
        [`hidden/${targetAccountId}`]: null,
      });
      if (!wrote)
        return errJson('STORAGE_ERROR', 'Failed to write to FastData', 500);
      invalidateForMutation(invalidatesFor('unhide_agent'));
      return successJson({ action: 'unhidden', account_id: targetAccountId });
    }
  }

  return errJson('NOT_FOUND', 'Not found', 404);
}

/** Map a FastData dispatch error to an errJson response. */
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

async function dispatchPublic(
  _request: NextRequest,
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
): Promise<NextResponse> {
  if (route.action === 'list_platforms') {
    return successJson({ platforms: PLATFORM_META });
  }

  const sanitized = sanitizePublic(wasmBody);
  const cacheKey = makeCacheKey(sanitized);
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }
  const result = await dispatchFastData(route.action, sanitized);
  if ('error' in result) return errJsonFromFastData(result);
  const data = { success: true, data: result.data };
  setCache(route.action, cacheKey, data);
  return NextResponse.json(data);
}

// ---------------------------------------------------------------------------
// Authenticated reads — FastData + VRF + claims.
// ---------------------------------------------------------------------------

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
    const claim = await mintClaimForWalletKey(walletKey, 'get_vrf_seed');
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
    if ('error' in fdResult) {
      return errJson('NOT_FOUND', fdResult.error, fdResult.status ?? 404);
    }
    return successJson(fdResult.data);
  }

  // Generic authenticated read.
  const fdResult = await dispatchFastData(route.action, {
    ...wasmBody,
    account_id: callerAccountId,
  });
  if ('error' in fdResult) {
    return errJson(
      'NOT_FOUND',
      (fdResult as { error: string }).error,
      (fdResult as { status?: number }).status ?? 404,
    );
  }

  // Inject contextual actions on me.
  if (route.action === 'me' && fdResult.data) {
    const d = fdResult.data as Record<string, unknown>;
    if (d.agent) {
      const actions = agentActions(d.agent as Record<string, unknown>);
      if (actions.length > 0) d.actions = actions;
    }
  }

  // Authenticated reads are per-caller and the caller typically mutates
  // between reads, so caching them is a net loss — don't.
  return successJson(fdResult.data);
}

// ---------------------------------------------------------------------------
// Authenticated dispatch — routes to sub-handlers.
// ---------------------------------------------------------------------------

async function dispatchAuthenticated(
  request: NextRequest,
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
  walletKey: string | undefined,
): Promise<NextResponse> {
  // Direct write path — bypasses WASM, writes to FastData via custody wallet.
  if (walletKey?.startsWith('wk_') && DIRECT_WRITE_ACTIONS.has(route.action)) {
    const result = await dispatchWrite(
      route.action,
      wasmBody,
      walletKey,
      resolveAccountId,
    );
    if (result.success) {
      invalidateForMutation(result.invalidates);

      // Inject contextual actions after profile-writing actions.
      if (
        (route.action === 'heartbeat' || route.action === 'update_me') &&
        result.data?.agent
      ) {
        const actions = agentActions(
          result.data.agent as Record<string, unknown>,
        );
        if (actions.length > 0) result.data.actions = actions;
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
    return NextResponse.json(errBody, { status: result.status });
  }

  // near: token attempting a mutation — fail fast before other checks.
  if (
    walletKey?.startsWith('near:') &&
    DIRECT_WRITE_ACTIONS.has(route.action)
  ) {
    return errJson(
      'AUTH_REQUIRED',
      'Mutations require a wk_ custody wallet key. Bearer near: tokens are read-only.',
      401,
    );
  }

  if (!walletKey) {
    console.warn(`[auth] 401 ${request.method} ${route.action}`);
    return errJson(
      'AUTH_REQUIRED',
      'Authentication required. Provide Authorization: Bearer wk_... or Bearer near:<token>',
      401,
    );
  }

  // Authenticated reads.
  if (request.method === 'GET') {
    return handleAuthenticatedGet(walletKey, route, wasmBody);
  }

  // Passthrough writes: authenticated but don't touch FastData, so no cache
  // invalidation. Currently only register_platforms.
  if (PASSTHROUGH_WRITE_ACTIONS.has(route.action)) {
    return handleRegisterPlatforms(walletKey, wasmBody);
  }

  // Fallback: unknown authenticated action.
  return errJson('NOT_FOUND', `Unknown action: ${route.action}`, 404);
}

export {
  dispatch as GET,
  dispatch as POST,
  dispatch as PATCH,
  dispatch as DELETE,
};
