import { NextResponse } from 'next/server';
import { errJson } from '@/lib/api-response';
import { MARKET_API_URL, OUTLAYER_API_URL } from '@/lib/constants';
import { fetchWithTimeout } from '@/lib/fetch';
import { resolveAccountId, signClaimForWalletKey } from '@/lib/outlayer-server';
import type { PlatformResult, VerifiableClaim } from '@/types';

export type { PlatformResult };

export const PLATFORM_META = [
  {
    id: 'market.near.ai',
    displayName: 'Agent Market',
    description:
      'Post jobs, bid on work, and list services on the agent market.',
    requiresWalletKey: false,
  },
  {
    id: 'near.fm',
    displayName: 'near.fm',
    description: 'Generate AI music, publish songs, earn tips and bounties.',
    requiresWalletKey: true,
  },
] as const;

export interface PlatformContext {
  account_id: string;
  description?: string;
  tags?: string[];
  capabilities?: Record<string, unknown>;
  /** Agent's OutLayer wallet key (wk_...), needed for platforms that require signing. */
  outlayer_api_key?: string;
  /** NEP-413 verifiable claim proving NEAR account ownership. Stored as metadata by platforms that accept it. */
  verifiable_claim?: VerifiableClaim;
}

// ---------------------------------------------------------------------------
// Config-driven platform definitions
//
// To add a new platform:
//   1. Add a meta entry to PLATFORM_META above (display fields + requiresWalletKey).
//   2. Add a config entry to PLATFORM_CONFIGS below (auth type, URL, timeout,
//      credential fields). Add a local env-backed constant for the URL if needed.
//   Everything else is generic: join page cards, auto-registration, credential
//   surfacing, and persistence all derive from these two arrays.
// ---------------------------------------------------------------------------

type PlatformId = (typeof PLATFORM_META)[number]['id'];

function meta(id: PlatformId) {
  const m = PLATFORM_META.find((p) => p.id === id);
  if (!m) throw new Error(`Unknown platform: ${id}`);
  const { requiresWalletKey: _, ...rest } = m;
  return rest;
}

interface DirectPostConfig {
  id: string;
  displayName: string;
  description: string;
  authType: 'direct-post';
  registerUrl: string;
  timeoutMs: number;
  /** Which PlatformContext fields to include in the POST body. */
  bodyFields: readonly (keyof PlatformContext)[];
  /** Optional: rename PlatformContext keys in the outgoing POST body. */
  fieldMapping?: Partial<Record<string, string>>;
  /** Maps credential key name → response JSON path (dot notation). */
  credentialFields: Record<string, string>;
}

interface OutlayerSigningConfig {
  id: string;
  displayName: string;
  description: string;
  authType: 'outlayer-signing';
  /** The platform's agent auth endpoint. */
  authUrl: string;
  /** Recipient value sent to OutLayer's sign-message endpoint. */
  recipient: string;
  timeoutMs: number;
  /** Maps credential key name → response JSON path (dot notation). */
  credentialFields: Record<string, string>;
}

export type PlatformConfig = DirectPostConfig | OutlayerSigningConfig;

const NEARFM_API_URL = process.env.NEARFM_API_URL || 'https://api.near.fm';

const PLATFORM_CONFIGS: readonly PlatformConfig[] = [
  {
    ...meta('market.near.ai'),
    authType: 'direct-post',
    registerUrl: `${MARKET_API_URL}/agents/register`,
    timeoutMs: 5_000,
    bodyFields: ['account_id', 'tags', 'capabilities', 'verifiable_claim'],
    credentialFields: {
      api_key: 'api_key',
      agent_id: 'agent_id',
      account_id: 'account_id',
    },
  },
  {
    ...meta('near.fm'),
    authType: 'outlayer-signing',
    authUrl: `${NEARFM_API_URL}/api/auth/agent`,
    recipient: 'near.fm',
    timeoutMs: 3_000,
    credentialFields: {
      token: 'token',
      user_id: 'user.id',
      slug: 'user.slug',
    },
  },
];

// ---------------------------------------------------------------------------
// Registration executors
// ---------------------------------------------------------------------------

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === 'object')
      return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function extractCredentials(
  data: Record<string, unknown>,
  fields: Record<string, string>,
): Record<string, unknown> {
  const creds: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(fields)) {
    const value = getNestedValue(data, path);
    if (value != null) creds[key] = value;
  }
  return creds;
}

async function executeDirectPost(
  config: DirectPostConfig,
  ctx: PlatformContext,
): Promise<PlatformResult> {
  const body: Record<string, unknown> = {};
  for (const field of config.bodyFields) {
    const val = ctx[field];
    if (val && (!Array.isArray(val) || val.length > 0)) {
      const key = config.fieldMapping?.[field] ?? field;
      body[key] = val;
    }
  }

  const res = await fetchWithTimeout(
    config.registerUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    config.timeoutMs,
  );

  if (res.ok) {
    try {
      const data = await res.json();
      return {
        success: true,
        credentials: extractCredentials(data, config.credentialFields),
      };
    } catch {
      return { success: false, error: 'Invalid response from platform' };
    }
  }

  let errorData: { error?: string } | null = null;
  try {
    errorData = await res.json();
  } catch (err) {
    console.error(
      '[platforms] registration error response not JSON:',
      res.status,
      err,
    );
  }
  const msg = errorData?.error || `Registration failed (HTTP ${res.status})`;
  return { success: false, error: msg };
}

async function executeOutlayerSigning(
  config: OutlayerSigningConfig,
  ctx: PlatformContext,
): Promise<PlatformResult> {
  if (!ctx.outlayer_api_key) {
    return {
      success: false,
      error: `Wallet key required for ${config.id} registration. Use POST /agents/me/platforms with a Bearer token to register later.`,
    };
  }

  // Step 1: Sign a login message via OutLayer
  const message = JSON.stringify({
    action: 'sign_in',
    domain: config.recipient,
    version: 1,
    timestamp: Date.now(),
  });

  const signRes = await fetchWithTimeout(
    `${OUTLAYER_API_URL}/wallet/v1/sign-message`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.outlayer_api_key}`,
      },
      body: JSON.stringify({ message, recipient: config.recipient }),
    },
    config.timeoutMs,
  );

  if (!signRes.ok) {
    const err = await signRes.text().catch(() => 'signing failed');
    return { success: false, error: `Sign message failed: ${err}` };
  }

  const signData = await signRes.json();

  // Step 2: Authenticate with the platform
  // Platforms expect nonce as a JSON array of byte values, not base64
  const nonceBytes = Array.from(Buffer.from(signData.nonce, 'base64'));
  if (nonceBytes.length !== 32) {
    return { success: false, error: 'Invalid nonce length from signing' };
  }

  const authRes = await fetchWithTimeout(
    config.authUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: signData.account_id,
        public_key: signData.public_key,
        signature: signData.signature,
        message,
        nonce: nonceBytes,
        recipient: config.recipient,
      }),
    },
    config.timeoutMs,
  );

  if (!authRes.ok) {
    const err = await authRes.text().catch(() => 'auth failed');
    return { success: false, error: `${config.id} auth failed: ${err}` };
  }

  const authData = await authRes.json();
  return {
    success: true,
    credentials: extractCredentials(authData, config.credentialFields),
  };
}

function executePlatform(
  config: PlatformConfig,
  ctx: PlatformContext,
): Promise<PlatformResult> {
  switch (config.authType) {
    case 'direct-post':
      return executeDirectPost(config, ctx);
    case 'outlayer-signing':
      return executeOutlayerSigning(config, ctx);
  }
}

// ---------------------------------------------------------------------------
// Registry & orchestration
// ---------------------------------------------------------------------------

const CONFIG_BY_ID = new Map(PLATFORM_CONFIGS.map((c) => [c.id, c]));

function availablePlatformIds(): string[] {
  return PLATFORM_CONFIGS.map((c) => c.id);
}

/**
 * Run platform registrations concurrently. Returns results keyed by platform ID.
 */
export async function tryPlatformRegistrations(
  ctx: PlatformContext,
  requestedIds?: string[],
): Promise<{
  platforms: Record<string, PlatformResult>;
  warnings: string[];
}> {
  const ids = requestedIds ?? availablePlatformIds();
  const configs = ids
    .map((id) => CONFIG_BY_ID.get(id))
    .filter((c): c is PlatformConfig => c != null);

  const results: Record<string, PlatformResult> = {};
  const warnings: string[] = [];

  const settled = await Promise.allSettled(
    configs.map(async (config) => {
      try {
        const result = await executePlatform(config, ctx);
        return { id: config.id, result };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return {
          id: config.id,
          result: { success: false, error: msg } as PlatformResult,
        };
      }
    }),
  );

  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      const { id, result } = outcome.value;
      results[id] = result;
      if (!result.success) {
        warnings.push(`${id}: ${result.error || 'registration failed'}`);
      }
    } else {
      warnings.push(`Platform registration failed: ${outcome.reason}`);
    }
  }

  return { platforms: results, warnings };
}

// ---------------------------------------------------------------------------
// Server-side platform orchestration (moved from route.ts)
// ---------------------------------------------------------------------------

function buildPlatformContext(
  agent: {
    account_id: string;
    description?: string;
    tags?: string[];
    capabilities?: Record<string, unknown>;
  },
  walletKey?: string,
  claim?: VerifiableClaim,
): PlatformContext {
  return {
    account_id: agent.account_id,
    description: agent.description,
    tags: agent.tags,
    capabilities: agent.capabilities,
    outlayer_api_key: walletKey?.startsWith('wk_') ? walletKey : undefined,
    verifiable_claim: claim,
  };
}

/**
 * POST /agents/me/platforms — register on external platforms.
 * Pure passthrough: resolves account, calls external APIs, returns credentials.
 * Nothing is written to FastData.
 */
export async function handleRegisterPlatforms(
  walletKey: string,
  wasmBody: Record<string, unknown>,
): Promise<NextResponse> {
  const accountId = await resolveAccountId(walletKey);
  if (!accountId) {
    return errJson('AUTH_FAILED', 'Could not resolve account', 401);
  }

  const requestedIds = Array.isArray(wasmBody.platforms)
    ? wasmBody.platforms.filter((p): p is string => typeof p === 'string')
    : undefined;
  const claim =
    (await signClaimForWalletKey(walletKey, 'register_platforms')) ?? undefined;
  const ctx = buildPlatformContext({ account_id: accountId }, walletKey, claim);
  const { platforms, warnings } = await tryPlatformRegistrations(
    ctx,
    requestedIds,
  );

  return NextResponse.json({
    success: true,
    data: { platforms },
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}
