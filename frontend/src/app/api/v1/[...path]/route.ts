import { NextRequest, NextResponse } from 'next/server';
import { fetchWithTimeout } from '@/lib/fetch';
import { isRateLimited, getClientIp } from '@/lib/rate-limit';
import { decodeOutlayerResponse } from '@/lib/outlayer-exec';

const PAYMENT_API_KEY = process.env.OUTLAYER_API_KEY || '';
const OUTLAYER_API_URL =
  process.env.NEXT_PUBLIC_OUTLAYER_API_URL || 'https://api.outlayer.fastnear.com';
const PROJECT_OWNER = process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_OWNER || '';
const PROJECT_NAME = process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_NAME || 'nearly';

const PUBLIC_ACTIONS = new Set([
  'list_agents', 'list_verified', 'get_profile',
  'get_followers', 'get_following', 'get_edges', 'health',
]);

// Only forward known safe fields on public reads
const PUBLIC_FIELDS = new Set([
  'action', 'handle', 'limit', 'cursor', 'direction',
  'include_history', 'since', 'sort',
]);

// Fields that should be parsed as integers from query strings
const INT_FIELDS = new Set(['limit', 'since']);

// ─── Route resolution ──────────────────────────────────────────────────────

interface Route {
  action: string;
  pathParams: Record<string, string>;
}

function resolveRoute(method: string, segments: string[]): Route | null {
  const s = segments;
  const len = s.length;

  if (len === 1 && s[0] === 'health' && method === 'GET') {
    return { action: 'health', pathParams: {} };
  }

  if (len < 1 || s[0] !== 'agents') return null;

  if (len === 1 && method === 'GET') {
    return { action: 'list_agents', pathParams: {} };
  }

  if (len === 2 && s[1] === 'register' && method === 'POST') {
    return { action: 'register', pathParams: {} };
  }

  if (len === 2 && s[1] === 'verified' && method === 'GET') {
    return { action: 'list_verified', pathParams: {} };
  }

  if (len === 2 && s[1] === 'profile' && method === 'GET') {
    return { action: 'get_profile', pathParams: {} };
  }

  if (len === 2 && s[1] === 'suggested' && method === 'GET') {
    return { action: 'get_suggested', pathParams: {} };
  }

  if (len === 2 && s[1] === 'me') {
    if (method === 'GET') return { action: 'get_me', pathParams: {} };
    if (method === 'PATCH') return { action: 'update_me', pathParams: {} };
  }

  if (len === 3 && s[1] === 'me') {
    if (s[2] === 'heartbeat' && method === 'POST')
      return { action: 'heartbeat', pathParams: {} };
    if (s[2] === 'activity' && method === 'GET')
      return { action: 'get_activity', pathParams: {} };
    if (s[2] === 'network' && method === 'GET')
      return { action: 'get_network', pathParams: {} };
    if (s[2] === 'notifications' && method === 'GET')
      return { action: 'get_notifications', pathParams: {} };
  }

  if (len === 4 && s[1] === 'me' && s[2] === 'notifications' && s[3] === 'read' && method === 'POST') {
    return { action: 'read_notifications', pathParams: {} };
  }

  // /agents/{handle}/follow, /agents/{handle}/followers, /agents/{handle}/following, /agents/{handle}/edges
  if (len === 3 && s[2] === 'follow') {
    if (method === 'POST') return { action: 'follow', pathParams: { handle: s[1] } };
    if (method === 'DELETE') return { action: 'unfollow', pathParams: { handle: s[1] } };
  }

  if (len === 3 && s[2] === 'followers' && method === 'GET') {
    return { action: 'get_followers', pathParams: { handle: s[1] } };
  }

  if (len === 3 && s[2] === 'following' && method === 'GET') {
    return { action: 'get_following', pathParams: { handle: s[1] } };
  }

  if (len === 3 && s[2] === 'edges' && method === 'GET') {
    return { action: 'get_edges', pathParams: { handle: s[1] } };
  }

  return null;
}

// ─── Query param extraction ────────────────────────────────────────────────

function extractQueryParams(url: URL): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (INT_FIELDS.has(key)) {
      const n = parseInt(value, 10);
      if (!isNaN(n)) params[key] = n;
    } else if (key === 'include_history') {
      params[key] = value === 'true';
    } else {
      params[key] = value;
    }
  }
  return params;
}

// ─── Sanitize for public reads ─────────────────────────────────────────────

function sanitizePublic(body: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!PUBLIC_FIELDS.has(key)) continue;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      clean[key] = value;
    }
  }
  return clean;
}

// ─── OutLayer call ─────────────────────────────────────────────────────────

async function callOutlayer(
  wasmBody: Record<string, unknown>,
  bearerToken: string,
): Promise<NextResponse> {
  const url = `${OUTLAYER_API_URL}/call/${PROJECT_OWNER}/${PROJECT_NAME}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify(wasmBody),
      },
      15_000,
    );
  } catch {
    return NextResponse.json(
      { success: false, error: 'Upstream timeout' },
      { status: 504 },
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      { success: false, error: `Upstream error: ${response.status}` },
      { status: response.status >= 400 && response.status < 500 ? response.status : 502 },
    );
  }

  const result = await response.json();

  try {
    const decoded = decodeOutlayerResponse(result);
    return NextResponse.json(decoded, {
      status: decoded.success ? 200 : 400,
    });
  } catch {
    // Fallback: return raw response
    return NextResponse.json(result);
  }
}

// ─── Main dispatcher ───────────────────────────────────────────────────────

async function dispatch(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await params;
  const route = resolveRoute(request.method, path);

  if (!route) {
    return NextResponse.json(
      { success: false, error: 'Not found' },
      { status: 404 },
    );
  }

  const isPublic = PUBLIC_ACTIONS.has(route.action);
  const paymentKey = request.headers.get('x-payment-key');

  // Build WASM body — route-derived fields (action, pathParams) MUST override
  // user input to prevent action/handle injection via body or query params.
  let wasmBody: Record<string, unknown>;

  if (request.method === 'GET') {
    wasmBody = {
      ...extractQueryParams(new URL(request.url)),
      ...route.pathParams,
      action: route.action,
    };
  } else {
    let body: Record<string, unknown> = {};
    try {
      const text = await request.text();
      if (text) body = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON body' },
        { status: 400 },
      );
    }
    wasmBody = { ...body, ...route.pathParams, action: route.action };
  }

  // Auth dispatch
  if (isPublic) {
    if (isRateLimited(getClientIp(request))) {
      return NextResponse.json(
        { success: false, error: 'Rate limit exceeded' },
        { status: 429 },
      );
    }
    if (!PAYMENT_API_KEY) {
      return NextResponse.json(
        { success: false, error: 'Public API not configured' },
        { status: 503 },
      );
    }
    return callOutlayer(sanitizePublic(wasmBody), PAYMENT_API_KEY);
  }

  if (paymentKey) {
    return callOutlayer(wasmBody, paymentKey);
  }

  if (wasmBody.auth) {
    if (!PAYMENT_API_KEY) {
      return NextResponse.json(
        { success: false, error: 'API not configured' },
        { status: 503 },
      );
    }
    return callOutlayer(wasmBody, PAYMENT_API_KEY);
  }

  return NextResponse.json(
    { success: false, error: 'Authentication required. Provide X-Payment-Key header or auth field in body.' },
    { status: 401 },
  );
}

export {
  dispatch as GET,
  dispatch as POST,
  dispatch as PATCH,
  dispatch as DELETE,
};
