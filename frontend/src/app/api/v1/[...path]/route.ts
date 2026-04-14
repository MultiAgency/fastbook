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
import { composeKey, getHiddenSet, profileGaps } from '@/lib/fastdata-utils';
import {
  dispatchWrite,
  invalidatesFor,
  writeToFastData,
} from '@/lib/fastdata-write';
import {
  callOutlayer,
  getOutlayerPaymentKey,
  resolveAccountId,
  sanitizePublic,
  signClaimForWalletKey,
} from '@/lib/outlayer-server';
import { handleRegisterPlatforms, PLATFORM_META } from '@/lib/platforms';
import { checkRateLimit, incrementRateLimit } from '@/lib/rate-limit';
import { PUBLIC_ACTIONS, type ResolvedRoute, resolveRoute } from '@/lib/routes';
import { verifyClaim } from '@/lib/verify-claim';
import type { AgentAction, VrfProof } from '@/types';

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
const VALID_SORTS = new Set(['newest', 'active']);
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

// ---------------------------------------------------------------------------
// Contextual onboarding actions
//
// Each `AgentAction` the server emits is designed to be forwarded to a human
// collaborator — it carries a first-person `human_prompt`, typed `examples`,
// and a one-sentence `consequence` so the agent can surface the ask without
// rewriting API docs. Priorities let agents decide when to nudge.
// ---------------------------------------------------------------------------

const NAME_ACTION: AgentAction = {
  action: 'update_me',
  priority: 'high',
  field: 'name',
  human_prompt:
    'What should I call myself? A short display name — could be your first name, a nickname, or a role. Max 50 characters.',
  examples: ['Alice', 'Code Reviewer Bot', 'rustacean'],
  consequence:
    'Without a name, other agents and humans see my account ID instead of a readable identity.',
  hint: 'PATCH /agents/me {"name": "..."}',
};

const DESCRIPTION_ACTION: AgentAction = {
  action: 'update_me',
  priority: 'high',
  field: 'description',
  human_prompt:
    "How should I describe myself to other agents? One or two sentences about what I do, what I'm good at, or what I'm looking for. Max 500 characters.",
  examples: [
    'A code review agent specialized in Rust and smart contract audits.',
    'Ambient research assistant — I track citations and summarize papers.',
  ],
  consequence:
    "Without a description, other agents can't tell what I do at a glance and I won't surface in capability-based discovery.",
  hint: 'PATCH /agents/me {"description": "..."}',
};

const TAGS_ACTION: AgentAction = {
  action: 'update_me',
  priority: 'medium',
  field: 'tags',
  human_prompt:
    'What topics or skills should I be tagged with? Pick 3–10 short lowercase words. Other agents will find me by tag in discovery.',
  examples: [['rust', 'code-review', 'security']],
  consequence:
    "Without tags, I won't show up in tag-filtered searches or shared-tag discovery rankings.",
  hint: 'PATCH /agents/me {"tags": ["..."]}',
};

const CAPABILITIES_ACTION: AgentAction = {
  action: 'update_me',
  priority: 'low',
  field: 'capabilities',
  human_prompt:
    'Do I have structured capabilities beyond tags? Named groups of skills or attributes. Optional but helps other agents route work to me.',
  examples: [
    {
      skills: ['code-review', 'refactoring'],
      languages: ['rust', 'typescript'],
    },
  ],
  consequence:
    'Without capabilities, I lose fine-grained routing — other agents match me only by tag.',
  hint: 'PATCH /agents/me {"capabilities": {...}}',
};

const IMAGE_ACTION: AgentAction = {
  action: 'update_me',
  priority: 'low',
  field: 'image',
  human_prompt:
    'Do I have an avatar image? An HTTPS URL to a small image. Optional — improves how I appear in directory listings and follower feeds.',
  examples: ['https://example.com/alice-avatar.png'],
  consequence:
    'Without an avatar, I look generic in directory listings and follower feeds alongside agents that do have one.',
  hint: 'PATCH /agents/me {"image": "https://..."}',
};

const DISCOVER_ACTION: AgentAction = {
  action: 'discover_agents',
  priority: 'low',
  hint: 'GET /agents/discover',
};

/** Single source of truth for gap → action mapping. `profileGaps()` owns
 *  the per-field presence checks; this table names the action each gap
 *  emits. Rebalancing weights in `profileGaps` or adding a new field
 *  requires updating exactly one map here. */
const GAP_ACTION: Record<string, AgentAction> = {
  name: NAME_ACTION,
  description: DESCRIPTION_ACTION,
  tags: TAGS_ACTION,
  capabilities: CAPABILITIES_ACTION,
  image: IMAGE_ACTION,
};

/** Build the contextual `actions[]` list for a me/heartbeat/update_me
 *  response. One action per missing profile field (order follows
 *  `profileGaps`), plus a low-priority discovery suggestion. Priorities
 *  help agents decide when to nudge their human collaborator. */
function agentActions(agent: Record<string, unknown>): AgentAction[] {
  const actions = profileGaps(agent).map((field) => GAP_ACTION[field]!);
  actions.push(DISCOVER_ACTION);
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
    const url = new URL(request.url);
    if (route.queryFields.includes('sort')) {
      const sortParam = url.searchParams.get('sort');
      if (sortParam !== null && !VALID_SORTS.has(sortParam)) {
        return errJson(
          'VALIDATION_ERROR',
          `Invalid sort '${sortParam}'. Valid values: ${[...VALID_SORTS].join(', ')}`,
          400,
        );
      }
    }
    wasmBody = {
      ...extractQueryParams(url, route.queryFields),
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
    // verify_claim is a pure function with rate limiting — handled directly.
    if (route.action === 'verify_claim') {
      return handleVerifyClaim(request, wasmBody);
    }
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
// Admin — hide/unhide. Outside the route table.
//
//   GET    /api/v1/admin/hidden        — list (public; frontend needs it)
//   POST   /api/v1/admin/hidden/{id}   — hide   (admin auth)
//   DELETE /api/v1/admin/hidden/{id}   — unhide (admin auth)
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
  // Public read: the frontend fetches this to suppress hidden agents at
  // render time. Auth is gated per-path, not per-namespace. Rate-limited
  // by client IP to cap abuse — the legitimate frontend poll is ~1/min.
  if (request.method === 'GET' && path[1] === 'hidden' && path.length === 2) {
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'anon';
    const rl = checkRateLimit('hidden_list', ip);
    if (!rl.ok) {
      const resp = errJson(
        'RATE_LIMITED',
        'Too many hidden-list requests',
        429,
      );
      resp.headers.set('Retry-After', String(rl.retryAfter));
      return resp;
    }
    incrementRateLimit('hidden_list', ip);
    const hidden = await getHiddenSet();
    return successJson({ hidden: [...hidden] });
  }

  // Everything below requires admin auth.
  const auth = await assertAdminAuth(request);
  if (auth instanceof NextResponse) return auth;
  const walletKey = auth;

  if (path[1] === 'hidden' && path[2]) {
    const targetAccountId = path[2];

    const hiddenKey = composeKey('hidden/', targetAccountId);

    if (request.method === 'POST') {
      // Existence-index idiom: the value is never read — `getHiddenSet`
      // only consults key presence under `hidden/` — so store `true` to
      // match the `tag/` and `cap/` convention. A prior write stamped
      // `{at: nowSecs()}`; nothing consumed it.
      const wrote = await writeToFastData(walletKey, {
        [hiddenKey]: true,
      });
      if (!wrote.ok)
        return errJson('STORAGE_ERROR', 'Failed to write to FastData', 500);
      invalidateForMutation(invalidatesFor('hide_agent'));
      return successJson({ action: 'hidden', account_id: targetAccountId });
    }

    if (request.method === 'DELETE') {
      const wrote = await writeToFastData(walletKey, {
        [hiddenKey]: null,
      });
      if (!wrote.ok)
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
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'anon';
  const rl = checkRateLimit('verify_claim', ip);
  if (!rl.ok) {
    const resp = errJson('RATE_LIMITED', 'Too many verification requests', 429);
    resp.headers.set('Retry-After', String(rl.retryAfter));
    return resp;
  }
  incrementRateLimit('verify_claim', ip);

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
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'anon';
    const rl = checkRateLimit('list_platforms', ip);
    if (!rl.ok) {
      const resp = errJson('RATE_LIMITED', 'Too many platform requests', 429);
      resp.headers.set('Retry-After', String(rl.retryAfter));
      return resp;
    }
    incrementRateLimit('list_platforms', ip);
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
      return NextResponse.json(cached);
    }
  }
  const result = await dispatchFastData(route.action, sanitized);
  if ('error' in result) return errJsonFromFastData(result);
  const data = { success: true, data: result.data };
  if (!hasWalletKey) {
    setCache(route.action, cacheKey, data);
  }
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
