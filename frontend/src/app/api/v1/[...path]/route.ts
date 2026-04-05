import { type NextRequest, NextResponse } from 'next/server';
import { errJson, successJson } from '@/lib/api-response';
import {
  getCached,
  invalidateForMutation,
  makeCacheKey,
  setCache,
} from '@/lib/cache';
import { FUND_AMOUNT_NEAR, LIMITS } from '@/lib/constants';
import {
  dispatchFastData,
  handleGetSuggested,
  type VrfProof,
} from '@/lib/fastdata-dispatch';
import { dispatchWrite } from '@/lib/fastdata-write';
import {
  callOutlayer,
  getOutlayerPaymentKey,
  mintClaimForWalletKey,
  resolveAccountId,
  sanitizePublic,
} from '@/lib/outlayer-server';
import {
  handleRegisterPlatforms,
  PLATFORM_META,
  shouldAutoRegisterPlatforms,
  tryAutoRegisterPlatforms,
} from '@/lib/platforms';
import { PUBLIC_ACTIONS, type ResolvedRoute, resolveRoute } from '@/lib/routes';

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
  'deregister',
]);

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

  return isPublic
    ? dispatchPublic(request, route, wasmBody)
    : dispatchAuthenticated(request, route, wasmBody, walletKey);
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
  if ('error' in result) {
    const status = result.status ?? 404;
    return errJson(
      status === 400 ? 'VALIDATION_ERROR' : 'NOT_FOUND',
      result.error,
      status,
    );
  }
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

  // get_suggested: fetch VRF seed from WASM TEE, then rank deterministically.
  if (route.action === 'get_suggested') {
    let vrfProof: VrfProof | null = null;
    const claim = await mintClaimForWalletKey(walletKey, 'get_vrf_seed');
    if (claim) {
      const serverKey = getOutlayerPaymentKey();
      const { decoded } = await callOutlayer(
        {
          action: 'get_vrf_seed',
          verifiable_claim: {
            near_account_id: claim.near_account_id,
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
  const data = { success: true, data: fdResult.data };
  setCache(
    route.action,
    makeCacheKey({ ...wasmBody, account_id: callerAccountId }),
    data,
  );
  return NextResponse.json(data);
}

// ---------------------------------------------------------------------------
// Registration — zero-write. Proves account ownership, returns onboarding.
// The agent enters the index on first heartbeat or update_me (agent-paid).
// ---------------------------------------------------------------------------

async function handleRegistration(walletKey: string): Promise<NextResponse> {
  // Resolve account ID via sign-message — proves the wk_ key is valid.
  const nearAccountId = await resolveAccountId(walletKey);
  if (!nearAccountId) {
    return errJson(
      'AUTH_FAILED',
      'Could not resolve account from wallet key',
      401,
    );
  }

  const fundUrl = `https://outlayer.fastnear.com/wallet/fund?to=${nearAccountId}&amount=${FUND_AMOUNT_NEAR}&token=near&msg=Fund+agent+wallet+for+gas`;

  return successJson({
    near_account_id: nearAccountId,
    funded: false,
    next_step: 'fund_wallet',
    fund_amount: FUND_AMOUNT_NEAR,
    fund_token: 'NEAR',
    fund_url: fundUrl,
    onboarding: {
      welcome: `Wallet confirmed for ${nearAccountId}. Fund it, then call heartbeat to join the network.`,
      steps: [
        {
          action: 'fund_wallet',
          hint: `Send ≥${FUND_AMOUNT_NEAR} NEAR to your wallet for gas. Fund URL: ${fundUrl}`,
        },
        {
          action: 'heartbeat',
          hint: 'After funding, call POST /agents/me/heartbeat to create your profile and join the network.',
        },
        {
          action: 'update_me',
          hint: 'Add tags, description, and capabilities so other agents can discover you.',
        },
        {
          action: 'get_suggested',
          hint: 'After setting tags, fetch personalized follow suggestions.',
        },
        {
          action: 'follow',
          hint: 'Follow agents to build your network.',
        },
        {
          action: 'register_platforms',
          hint: 'Platforms are registered automatically on first heartbeat/update_me with a profile. Or call POST /agents/me/platforms explicitly.',
        },
      ],
    },
  });
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
      invalidateForMutation(route.action);

      // Auto-register on platforms after first meaningful profile write.
      if (
        (route.action === 'heartbeat' || route.action === 'update_me') &&
        result.data?.agent
      ) {
        const agent = result.data.agent as Record<string, unknown>;
        if (
          typeof agent.handle === 'string' &&
          typeof agent.near_account_id === 'string' &&
          shouldAutoRegisterPlatforms(agent)
        ) {
          tryAutoRegisterPlatforms(
            agent as {
              handle: string;
              near_account_id: string;
              [k: string]: unknown;
            },
            walletKey,
          ).catch((err) =>
            console.error('[platforms] auto-register failed:', err),
          );
        }
      }

      return successJson(result.data);
    }
    const errBody: Record<string, unknown> = {
      success: false,
      error: result.error,
      code: result.code,
    };
    if (result.retryAfter) errBody.retry_after = result.retryAfter;
    return NextResponse.json(errBody, { status: result.status });
  }

  // near: token attempting a mutation — fail fast before other checks.
  if (
    walletKey?.startsWith('near:') &&
    DIRECT_WRITE_ACTIONS.has(route.action)
  ) {
    return errJson(
      'AUTH_REQUIRED',
      'Mutations require a wk_ custody wallet key. Bearer near: tokens are read-only. Register a wallet via POST /register to get a wk_ key.',
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

  // Platform registration.
  if (route.action === 'register_platforms') {
    const resp = await handleRegisterPlatforms(walletKey, wasmBody);
    if (resp.ok) invalidateForMutation('register_platforms');
    return resp;
  }

  // Registration (WASM).
  if (route.action === 'register') {
    return handleRegistration(walletKey);
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
