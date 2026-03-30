import { type NextRequest, NextResponse } from 'next/server';
import {
  clearByAction,
  clearCache,
  currentGeneration,
  getCached,
  makeCacheKey,
  setCache,
} from '@/lib/cache';
import { LIMITS } from '@/lib/constants';
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

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_IP = 120;
const REGISTER_RATE_LIMIT_PER_IP = 5;
const REGISTER_PLATFORMS_RATE_LIMIT_PER_IP = 5;
const MAX_IP_ENTRIES = 10_000;
// Per-IP rate tracking.  Action-specific counters (registerCount, etc.) are
// inlined for the current small set.  If more per-action limits are added,
// generalize to a Map<string, number> keyed by action name.
const ipCounts = new Map<
  string,
  {
    count: number;
    registerCount: number;
    registerPlatformsCount: number;
    resetAt: number;
  }
>();

function checkProxyRateLimit(ip: string, action?: string): boolean {
  const now = Date.now();
  const entry = ipCounts.get(ip);
  if (!entry || now >= entry.resetAt) {
    ipCounts.set(ip, {
      count: 1,
      registerCount: action === 'register' ? 1 : 0,
      registerPlatformsCount: action === 'register_platforms' ? 1 : 0,
      resetAt: now + RATE_WINDOW_MS,
    });
    evictStaleEntries(now);
    return true;
  }
  entry.count += 1;
  if (action === 'register') {
    entry.registerCount += 1;
    if (entry.registerCount > REGISTER_RATE_LIMIT_PER_IP) return false;
  }
  if (action === 'register_platforms') {
    entry.registerPlatformsCount += 1;
    if (entry.registerPlatformsCount > REGISTER_PLATFORMS_RATE_LIMIT_PER_IP)
      return false;
  }
  return entry.count <= RATE_LIMIT_PER_IP;
}

function evictStaleEntries(now: number): void {
  if (ipCounts.size <= MAX_IP_ENTRIES) return;
  for (const [k, v] of ipCounts) {
    if (now >= v.resetAt) ipCounts.delete(k);
  }
  // Hard cap: if still over limit after expiry sweep, drop oldest entries
  if (ipCounts.size > MAX_IP_ENTRIES) {
    const excess = ipCounts.size - MAX_IP_ENTRIES;
    let dropped = 0;
    for (const k of ipCounts.keys()) {
      if (dropped >= excess) break;
      ipCounts.delete(k);
      dropped++;
    }
  }
}

function clientIp(request: NextRequest): string {
  // Prefer the rightmost x-forwarded-for entry (set by our edge proxy) over
  // the leftmost (client-supplied and trivially spoofable).  Fall back to the
  // leftmost entry when only one hop is present (direct proxy → origin).
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length > 1 ? parts[parts.length - 1] : (parts[0] ?? 'unknown');
  }
  // x-real-ip is set by many reverse proxies (nginx, Vercel, Cloudflare).
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

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
  request: NextRequest,
  route: ResolvedRoute,
  wasmBody: Record<string, unknown>,
): Promise<NextResponse> {
  if (route.action === 'list_platforms') {
    return NextResponse.json({
      success: true,
      data: { platforms: PLATFORM_META },
    });
  }

  const paymentKey = getOutlayerPaymentKey();
  if (!paymentKey) {
    return NextResponse.json(
      {
        success: false,
        error: 'Public API not configured',
        code: 'INTERNAL_ERROR',
      },
      { status: 503 },
    );
  }
  const sanitized = sanitizePublic(wasmBody);
  const cacheKey = makeCacheKey(sanitized);
  const cached = getCached(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }
  if (!checkProxyRateLimit(clientIp(request), route.action)) {
    return NextResponse.json(
      {
        success: false,
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
        retry_after: 60,
      },
      { status: 429 },
    );
  }
  const gen = currentGeneration();
  const result = await callOutlayer(sanitized, paymentKey);
  if (result.status === 200) {
    const data = await result.json();
    setCache(route.action, cacheKey, data, gen);
    return NextResponse.json(data);
  }
  return result;
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

  if (!checkProxyRateLimit(clientIp(request), route.action)) {
    return NextResponse.json(
      {
        success: false,
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
        retry_after: 60,
      },
      { status: 429 },
    );
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
      clearCache();
    } else if (route.action === 'heartbeat' && result.status === 200) {
      clearByAction('list_agents');
    }

    if (route.action === 'register' && result.status === 200) {
      // Fire platform registrations in the background — don't block the
      // registration response.  Agents can call POST /agents/me/platforms
      // later to retrieve platform credentials.
      void tryPlatformRegistrationsOnRegister(
        wasmBody,
        new NextResponse(result.clone().body, result),
        userAuthKey,
      );
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

/** @internal — test-only helper to reset the in-memory rate-limit state */
function resetRateLimiter(): void {
  ipCounts.clear();
}

export {
  dispatch as GET,
  dispatch as POST,
  dispatch as PATCH,
  dispatch as DELETE,
  OPTIONS,
  RATE_LIMIT_PER_IP,
  resetRateLimiter,
};
