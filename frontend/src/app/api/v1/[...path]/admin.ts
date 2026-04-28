import { buildKvDelete, buildKvPut } from '@nearly/sdk';
import { type NextRequest, NextResponse } from 'next/server';
import {
  buildAdminNearToken,
  resolveAdminWriterAccount,
} from '@/lib/admin-near-token';
import { errJson, successJson } from '@/lib/api-response';
import { invalidateForMutation } from '@/lib/cache';
import { OUTLAYER_ADMIN_ACCOUNT } from '@/lib/constants';
import { composeKey, getHiddenSet } from '@/lib/fastdata/utils';
import { INVALIDATION_MAP, writeToFastData } from '@/lib/fastdata/writes';
import { resolveAccountId } from '@/lib/outlayer-server';
import { checkRateLimit, incrementRateLimit } from '@/lib/rate-limit';
import { getClientIp, NEAR_RE, WK_RE } from './auth';

// Round-trip both auth types through OutLayer so the claimed identity
// is actually verified upstream. `resolveAccountId` uses balance for
// `wk_` and sign-message for `near:`. OutLayer enforces the Bearer
// auth contract on `near:` tokens — ±30s signed-timestamp window
// (documented as `timestamp_expired` in the agent-custody skill) over
// `auth:<seed>:<ts>` — so a token failing its checks surfaces as null
// here rather than resolving to the claimed account_id. Decoding the
// payload locally (no verification) would accept any forgery naming
// OUTLAYER_ADMIN_ACCOUNT, since we'd then fall through to
// `buildAdminNearToken()` and execute the write with Nearly's own
// admin key — a confused-deputy bypass.
async function assertAdminAuth(
  request: NextRequest,
): Promise<string | NextResponse> {
  if (!OUTLAYER_ADMIN_ACCOUNT) {
    return errJson('NOT_FOUND', 'Not found', 404);
  }
  const authHeader = request.headers.get('authorization');
  const wkMatch = authHeader?.match(WK_RE)?.[1];
  const nearMatch = !wkMatch ? authHeader?.match(NEAR_RE)?.[1] : undefined;
  if (!wkMatch && !nearMatch) {
    return errJson(
      'AUTH_REQUIRED',
      'Admin endpoints require wk_ or near: auth',
      401,
    );
  }
  // Two valid resolutions: `wk_` tokens whose balance returns the named
  // admin account directly, or `near:` tokens whose `/sign-message`
  // round-trip returns the derived hex64 (the named account
  // authenticates, the derived hex64 implicit account pays gas and
  // signs the FastData write). Accept either; both are the admin
  // acting via different transports. Hard-coding the named-account
  // check would silently 403 every near: admin token even when
  // correctly signed.
  const callerAccountId = await resolveAccountId(wkMatch ?? nearMatch!);
  if (callerAccountId !== OUTLAYER_ADMIN_ACCOUNT) {
    const derivedAdminAccount = await resolveAdminWriterAccount();
    if (callerAccountId !== derivedAdminAccount) {
      return errJson('AUTH_FAILED', 'Not authorized', 403);
    }
  }
  if (wkMatch) return wkMatch;
  const adminToken = buildAdminNearToken();
  if (!adminToken) {
    return errJson(
      'NOT_CONFIGURED',
      'Admin near: auth recognized but OUTLAYER_ADMIN_NEAR_KEY is not set',
      503,
    );
  }
  return adminToken;
}

// Public read: the frontend fetches this to suppress hidden agents at
// render time. Rate-limited by client IP to cap abuse — the legitimate
// frontend poll is ~1/min. Reaches `list_hidden` via `resolveRoute`'s
// auth='public' branch in main dispatch; not gated through `assertAdminAuth`.
export async function handleListHidden(
  request: NextRequest,
): Promise<NextResponse> {
  const ip = getClientIp(request);
  const rl = checkRateLimit('list_hidden', ip);
  if (!rl.ok) {
    return errJson('RATE_LIMITED', 'Too many hidden-list requests', 429, {
      retryAfter: rl.retryAfter,
    });
  }
  incrementRateLimit('list_hidden', ip, rl.window);
  const hasAdminKey = request.headers
    .get('authorization')
    ?.match(/^Bearer\s+(wk_|near:)/);
  const hidden = await getHiddenSet(!!hasAdminKey);
  return successJson({ hidden: [...hidden] });
}

// Shared write+invalidate path for hide/unhide. Both branches share the
// `writeToFastData` → check `.ok` → invalidate → success-response shape;
// only the envelope (kvPut vs kvDelete) and the response action label
// differ. Centralizing prevents the two paths from drifting on
// invalidation keys or response shape.
async function runAdminWrite(
  walletKey: string,
  entries: Record<string, unknown>,
  action: 'hidden' | 'unhidden',
  accountId: string,
  invalidationKey: 'hide_agent' | 'unhide_agent',
): Promise<NextResponse> {
  const wrote = await writeToFastData(walletKey, entries);
  if (!wrote.ok)
    return errJson('STORAGE_ERROR', 'Failed to write to FastData', 500);
  invalidateForMutation(INVALIDATION_MAP[invalidationKey]);
  return successJson({ action, account_id: accountId });
}

export async function handleHideAgent(
  request: NextRequest,
  accountId: string,
): Promise<NextResponse> {
  const auth = await assertAdminAuth(request);
  if (auth instanceof NextResponse) return auth;
  const hiddenKey = composeKey('hidden/', accountId);
  // Existence-index idiom: `getHiddenSet` only consults key presence
  // under `hidden/`, so store `true` to match the `tag/` and `cap/`
  // convention. Envelope owned by `buildKvPut` in `@nearly/sdk/kv`.
  const { entries } = buildKvPut(OUTLAYER_ADMIN_ACCOUNT, hiddenKey, true);
  return runAdminWrite(auth, entries, 'hidden', accountId, 'hide_agent');
}

export async function handleUnhideAgent(
  request: NextRequest,
  accountId: string,
): Promise<NextResponse> {
  const auth = await assertAdminAuth(request);
  if (auth instanceof NextResponse) return auth;
  const hiddenKey = composeKey('hidden/', accountId);
  const { entries } = buildKvDelete(OUTLAYER_ADMIN_ACCOUNT, hiddenKey);
  return runAdminWrite(auth, entries, 'unhidden', accountId, 'unhide_agent');
}
