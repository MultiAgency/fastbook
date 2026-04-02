import { type NextRequest, NextResponse } from 'next/server';
import {
  getCached,
  invalidateForMutation,
  makeCacheKey,
  setCache,
} from '@/lib/cache';
import { LIMITS } from '@/lib/constants';
import { dispatchFastData } from '@/lib/fastdata-dispatch';
import {
  callOutlayer,
  getOutlayerPaymentKey,
  mintClaimForWalletKey,
  sanitizePublic,
} from '@/lib/outlayer-server';
import {
  handleRegisterPlatforms,
  PLATFORM_META,
  tryPlatformRegistrationsOnRegister,
} from '@/lib/platforms';
import {
  CACHE_BUSTING_ACTIONS,
  FASTDATA_ONLY_ACTIONS,
  PUBLIC_ACTIONS,
  type ResolvedRoute,
  resolveRoute,
} from '@/lib/routes';
import { isValidVerifiableClaim } from '@/lib/utils';

const INT_FIELDS = new Set(['limit']);
const VALID_SORTS = new Set(['followers', 'endorsements', 'newest', 'active']);
const VALID_DIRECTIONS = new Set(['incoming', 'outgoing', 'both']);
const CURSOR_RE = /^[a-z0-9_]{1,32}$|^\d{1,20}$/;
const MAX_BODY_BYTES = LIMITS.MAX_BODY_BYTES;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Payment-Key',
  'Access-Control-Max-Age': '86400',
};

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
    } else {
      params[key] = value;
    }
  }
  return params;
}

function applyHeaders(response: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    response.headers.set(k, v);
  }
  return response;
}

function tooLargeResponse(): NextResponse {
  return applyHeaders(
    NextResponse.json(
      {
        success: false,
        error: `Request body too large (max ${MAX_BODY_BYTES / 1024} KB)`,
        code: 'VALIDATION_ERROR',
      },
      { status: 413 },
    ),
  );
}

async function dispatch(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  const route = resolveRoute(request.method, path);

  if (!route) {
    return applyHeaders(
      NextResponse.json(
        { success: false, error: 'Not found', code: 'NOT_FOUND' },
        { status: 404 },
      ),
    );
  }

  const isPublic = PUBLIC_ACTIONS.has(route.action);

  const paymentKey = request.headers.get('x-payment-key');
  const bearerToken = request.headers
    .get('authorization')
    ?.match(/^Bearer\s+(wk_[A-Za-z0-9_-]+)$/)?.[1];
  const userAuthKey = paymentKey || bearerToken;

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
          return applyHeaders(
            NextResponse.json(
              {
                success: false,
                error: 'Request body must be a JSON object',
                code: 'VALIDATION_ERROR',
              },
              { status: 400 },
            ),
          );
        }
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return applyHeaders(
        NextResponse.json(
          {
            success: false,
            error: 'Invalid JSON body',
            code: 'VALIDATION_ERROR',
          },
          { status: 400 },
        ),
      );
    }
    wasmBody = { ...body, ...route.pathParams, action: route.action };
  }

  const response = isPublic
    ? await dispatchPublic(request, route, wasmBody)
    : await dispatchAuthenticated(request, route, wasmBody, userAuthKey);
  return applyHeaders(response);
}

async function dispatchPublic(
  _request: NextRequest,
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
): Promise<NextResponse> {
  if (route.action === 'list_platforms') {
    return NextResponse.json({
      success: true,
      data: { platforms: PLATFORM_META },
    });
  }

  const sanitized = sanitizePublic(wasmBody);
  const cacheKey = makeCacheKey(sanitized);
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }
  const result = await dispatchFastData(route.action, sanitized);
  if ('error' in result) {
    const status = result.status ?? 502;
    if (status >= 500 && !FASTDATA_ONLY_ACTIONS.has(route.action)) {
      console.warn(
        `[fastdata] ${route.action}: ${result.error} — falling back to WASM`,
      );
      const serverKey = getOutlayerPaymentKey();
      if (serverKey) {
        try {
          const fallback = await callOutlayer(sanitized, serverKey);
          if (fallback.ok) return fallback; // no cache — fallback responses get no TTL
        } catch (err) {
          console.error(
            `[fastdata-fallback] WASM also failed for ${route.action}:`,
            err,
          );
        }
      }
    }
    const code =
      status >= 500
        ? FASTDATA_ONLY_ACTIONS.has(route.action)
          ? 'FASTDATA_UNAVAILABLE'
          : 'FASTDATA_ERROR'
        : 'NOT_FOUND';
    return NextResponse.json(
      { success: false, error: result.error, code },
      {
        status:
          FASTDATA_ONLY_ACTIONS.has(route.action) && status >= 500
            ? 503
            : status,
      },
    );
  }
  const data = { success: true, data: result.data };
  setCache(route.action, cacheKey, data);
  return NextResponse.json(data);
}

async function dispatchAuthenticated(
  request: NextRequest,
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
  userAuthKey: string | undefined,
): Promise<NextResponse> {
  let authKey = userAuthKey;

  // Auto-sign for trial wallet keys: when a wk_ key is provided without a
  // verifiable_claim, mint one by calling OutLayer's free sign-message
  // endpoint, inject it into the WASM body, and switch to the server payment
  // key so the WASM falls through to NEP-413 verification for correct
  // identity resolution.  This is transparent to the caller.
  if (
    authKey?.startsWith('wk_') &&
    !wasmBody.verifiable_claim &&
    route.action !== 'register_platforms'
  ) {
    const claim = await mintClaimForWalletKey(authKey, route.action);
    if (claim) {
      wasmBody.verifiable_claim = {
        near_account_id: claim.near_account_id,
        public_key: claim.public_key,
        signature: claim.signature,
        nonce: claim.nonce,
        message: claim.message,
      };
      const serverKey = getOutlayerPaymentKey();
      if (serverKey) authKey = serverKey;
    }
    // If minting fails, fall through with the original wk_ key —
    // the WASM will resolve "trial" and return NOT_REGISTERED, which
    // is a clearer signal than a proxy error.
  }

  if (!authKey && wasmBody.verifiable_claim) {
    if (!isValidVerifiableClaim(wasmBody.verifiable_claim)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid verifiable_claim structure',
          code: 'VALIDATION_ERROR',
        },
        { status: 400 },
      );
    }
    const serverKey = getOutlayerPaymentKey();
    if (!serverKey) {
      return NextResponse.json(
        {
          success: false,
          error: 'API not configured',
          code: 'INTERNAL_ERROR',
        },
        { status: 503 },
      );
    }
    authKey = serverKey;
  }

  if (authKey) {
    // Platform registration is handled entirely by the proxy and requires
    // multiple WASM calls (get_me → external APIs → set_platforms).  A
    // verifiable_claim is single-use (nonce replay protection), so it cannot
    // authenticate the additional calls.  Require a reusable credential.
    if (route.action === 'register_platforms') {
      if (!userAuthKey) {
        return NextResponse.json(
          {
            success: false,
            error:
              'Platform registration requires a wallet key (Authorization: Bearer wk_...) or payment key (X-Payment-Key). Verifiable claims cannot be used for this multi-step endpoint.',
            code: 'AUTH_REQUIRED',
          },
          { status: 401 },
        );
      }
      return handleRegisterPlatforms(authKey, wasmBody, userAuthKey);
    }

    const result = await callOutlayer(wasmBody, authKey);

    if (CACHE_BUSTING_ACTIONS.has(route.action) && result.status === 200) {
      invalidateForMutation(route.action);
    }

    if (route.action === 'register' && result.status === 200) {
      // Fire platform registrations in the background — don't block the
      // registration response.  Agents can call POST /agents/me/platforms
      // later to retrieve platform credentials.
      tryPlatformRegistrationsOnRegister(
        wasmBody,
        new NextResponse(result.clone().body, result),
        userAuthKey,
      ).catch((err) => console.error('[platforms] auto-register failed:', err));
    }

    return result;
  }

  console.warn(`[auth] 401 ${request.method} ${route.action}`);
  return NextResponse.json(
    {
      success: false,
      error:
        'Authentication required. Provide Authorization: Bearer wk_... or X-Payment-Key header, or verifiable_claim in body.',
      code: 'AUTH_REQUIRED',
    },
    { status: 401 },
  );
}

function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export {
  dispatch as GET,
  dispatch as POST,
  dispatch as PATCH,
  dispatch as DELETE,
  OPTIONS,
};
