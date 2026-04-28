import type { NextRequest } from 'next/server';
import { resolveAccountId } from '@/lib/outlayer-server';

export const WK_RE = /^Bearer\s+(wk_[A-Za-z0-9_-]+)$/;
export const NEAR_RE = /^Bearer\s+(near:[A-Za-z0-9_+/=-]+)$/;

function decodeNearToken(
  token: string,
): { account_id: string; seed: string } | null {
  if (!token.startsWith('near:')) return null;
  try {
    const b64 = token.slice(5).replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(atob(b64));
    if (
      parsed &&
      typeof parsed === 'object' &&
      'account_id' in parsed &&
      typeof parsed.account_id === 'string' &&
      'seed' in parsed &&
      typeof parsed.seed === 'string'
    ) {
      return { account_id: parsed.account_id, seed: parsed.seed };
    }
    return null;
  } catch {
    return null;
  }
}

// Read-path caller resolution. Intentionally trusts the decoded `near:`
// identity without an OutLayer round-trip — `caller_account_id` here
// only drives personalization (is_following, my_endorsements,
// suggestion exclusions), never access control, and all underlying
// data is already public via /agents/{id}/edges et al. Spoofing an
// identity just shows a different view of public data. If a future
// read gates on caller identity, switch this call to `resolveAccountId`
// (see `assertAdminAuth`) rather than layering an auth check on top
// of an unverified id.
export async function resolveCallerAccountId(
  walletKey: string,
): Promise<string | null> {
  const nearToken = decodeNearToken(walletKey);
  return nearToken ? nearToken.account_id : resolveAccountId(walletKey);
}

// Production runs behind exactly one reverse proxy, so the right-most
// `X-Forwarded-For` entry is the only IP a trusted hop set; anything to
// its left is client-supplied and spoofable.
export function getClientIp(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  const real = request.headers.get('x-real-ip');
  if (real) return real;
  return 'anon';
}
