import { type NextRequest, NextResponse } from 'next/server';
import { clearCache, getCached, makeCacheKey, setCache } from '@/lib/cache';
import { LIMITS, MARKET_API_URL } from '@/lib/constants';
import {
  callOutlayer,
  getOutlayerPaymentKey,
  sanitizePublic,
} from '@/lib/outlayer-route';
import {
  CACHE_BUSTING_ACTIONS,
  PUBLIC_ACTIONS,
  type ResolvedRoute,
  resolveRoute,
} from '@/lib/routes';
import { isValidCapabilities, isValidVerifiableClaim } from '@/lib/utils';

const INT_FIELDS = new Set(['limit']);
const VALID_SORTS = new Set(['followers', 'endorsements', 'newest', 'active']);
const VALID_DIRECTIONS = new Set(['incoming', 'outgoing', 'both']);
const CURSOR_RE = /^[a-z0-9_]{1,32}$|^\d{1,20}$/;
const MAX_BODY_BYTES = LIMITS.MAX_BODY_BYTES;

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_IP = 120;
const REGISTER_RATE_LIMIT_PER_IP = 5;
const MAX_IP_ENTRIES = 10_000;
const ipCounts = new Map<
  string,
  { count: number; registerCount: number; resetAt: number }
>();

function checkProxyRateLimit(ip: string, action?: string): boolean {
  const now = Date.now();
  const entry = ipCounts.get(ip);
  if (!entry || now >= entry.resetAt) {
    ipCounts.set(ip, {
      count: 1,
      registerCount: action === 'register' ? 1 : 0,
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
    } else if (key === 'direction') {
      if (VALID_DIRECTIONS.has(value)) params[key] = value;
    } else if (key === 'since') {
      if (/^\d{1,20}$/.test(value)) params[key] = value;
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
        { success: false, error: 'Not found' },
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
      if (text) body = JSON.parse(text);
    } catch {
      return applyHeaders(
        NextResponse.json(
          { success: false, error: 'Invalid JSON body' },
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
  const paymentKey = getOutlayerPaymentKey();
  if (!paymentKey) {
    return NextResponse.json(
      { success: false, error: 'Public API not configured' },
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
      { success: false, error: 'Rate limit exceeded' },
      { status: 429 },
    );
  }
  const result = await callOutlayer(sanitized, paymentKey);
  if (result.status === 200) {
    const data = await result.json();
    setCache(route.action, cacheKey, data);
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
  if (!authKey && wasmBody.verifiable_claim) {
    if (!isValidVerifiableClaim(wasmBody.verifiable_claim)) {
      return NextResponse.json(
        { success: false, error: 'Invalid verifiable_claim structure' },
        { status: 400 },
      );
    }
    const serverKey = getOutlayerPaymentKey();
    if (!serverKey) {
      return NextResponse.json(
        { success: false, error: 'API not configured' },
        { status: 503 },
      );
    }
    authKey = serverKey;
  }

  if (!checkProxyRateLimit(clientIp(request), route.action)) {
    return NextResponse.json(
      { success: false, error: 'Rate limit exceeded' },
      { status: 429 },
    );
  }

  if (authKey) {
    const result = await callOutlayer(wasmBody, authKey);

    if (CACHE_BUSTING_ACTIONS.has(route.action) && result.status === 200) {
      clearCache();
    }

    if (route.action === 'register' && result.status === 200) {
      return tryMarketRegistration(wasmBody, result);
    }

    return result;
  }

  console.warn(`[auth] 401 ${request.method} ${route.action}`);
  return NextResponse.json(
    {
      success: false,
      error:
        'Authentication required. Provide Authorization: Bearer wk_... or X-Payment-Key header, or verifiable_claim in body.',
    },
    { status: 401 },
  );
}

async function tryMarketRegistration(
  wasmBody: Record<string, unknown>,
  result: NextResponse,
): Promise<NextResponse> {
  const handle =
    typeof wasmBody.handle === 'string' ? wasmBody.handle : undefined;
  if (!handle) return result;

  const nearlyData = await result.json();
  const tags = Array.isArray(wasmBody.tags)
    ? wasmBody.tags.filter((t): t is string => typeof t === 'string')
    : undefined;
  const rawCaps = wasmBody.capabilities;
  const capabilities = isValidCapabilities(rawCaps) ? rawCaps : undefined;

  try {
    const marketRes = await fetch(`${MARKET_API_URL}/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle,
        ...(nearlyData?.data?.near_account_id
          ? { near_account_id: nearlyData.data.near_account_id }
          : {}),
        ...(tags?.length ? { tags } : {}),
        ...(capabilities ? { capabilities } : {}),
      }),
      signal: AbortSignal.timeout(1_500),
    });
    if (marketRes.ok) {
      const marketData = await marketRes.json();
      if (nearlyData?.data && marketData && typeof marketData === 'object') {
        nearlyData.data.market = {
          api_key: marketData.api_key ?? undefined,
          agent_id: marketData.agent_id ?? undefined,
          near_account_id: marketData.near_account_id ?? undefined,
        };
      }
    } else {
      const errorData = await marketRes.json().catch(() => null);
      const msg = errorData?.error || 'Handle may already be taken';
      console.error(`[market] registration failed for ${handle}: ${msg}`);
      nearlyData.warnings = [
        ...(nearlyData.warnings || []),
        `market.near.ai: ${msg}`,
      ];
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[market] registration failed for ${handle}: ${msg}`);
    nearlyData.warnings = [
      ...(nearlyData.warnings || []),
      'market.near.ai: could not reserve handle (service unreachable)',
    ];
  }
  return NextResponse.json(nearlyData);
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
