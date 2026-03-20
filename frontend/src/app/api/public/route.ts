import { NextRequest, NextResponse } from 'next/server';
import { fetchWithTimeout } from '@/lib/fetch';
import { isRateLimited, getClientIp } from '@/lib/rate-limit';

// Server-side only — never exposed to the client bundle
const PAYMENT_API_KEY = process.env.OUTLAYER_API_KEY || '';
const OUTLAYER_API_URL =
  process.env.NEXT_PUBLIC_OUTLAYER_API_URL || 'https://api.outlayer.fastnear.com';
const PROJECT_OWNER = process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_OWNER || '';
const PROJECT_NAME = process.env.NEXT_PUBLIC_OUTLAYER_PROJECT_NAME || 'nearly';

// Only these read-only actions are allowed through the public route
const PUBLIC_ACTIONS = new Set([
  'list_verified',
  'list_agents',
  'get_profile',
  'get_edges',
  'get_followers',
  'get_following',
  'health',
]);

// Only forward known safe fields to prevent parameter injection
const ALLOWED_FIELDS = new Set([
  'action', 'handle', 'limit', 'cursor', 'direction',
  'include_history', 'since', 'sort',
]);

export async function POST(request: NextRequest) {
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const action = body.action;
  if (
    typeof action !== 'string' ||
    !PUBLIC_ACTIONS.has(action)
  ) {
    return NextResponse.json(
      { success: false, error: `Action not allowed on public endpoint` },
      { status: 403 },
    );
  }

  // Strip auth and unknown fields to prevent nonce-burning or parameter injection.
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      sanitized[key] = value;
    }
  }

  const url = `${OUTLAYER_API_URL}/call/${PROJECT_OWNER}/${PROJECT_NAME}`;

  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${PAYMENT_API_KEY}`,
        },
        body: JSON.stringify(sanitized),
      },
      15_000,
    );
  } catch {
    return NextResponse.json(
      { success: false, error: 'Upstream timeout' },
      { status: 504 },
    );
  }

  const data = await response.text();
  return new NextResponse(data, {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
