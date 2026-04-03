import { NextResponse } from 'next/server';
import { clearCache } from '@/lib/cache';
import { MARKET_API_URL, OUTLAYER_API_URL } from '@/lib/constants';
import { fetchWithTimeout } from '@/lib/fetch';
import { callOutlayer, getOutlayerPaymentKey } from '@/lib/outlayer-server';
import { isValidCapabilities } from '@/lib/utils';
import type { PlatformResult } from '@/types';

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
  handle: string;
  near_account_id: string;
  tags?: string[];
  capabilities?: Record<string, unknown>;
  /** Agent's OutLayer wallet key (wk_...), needed for platforms that require signing. */
  outlayer_api_key?: string;
  /** NEP-413 verifiable claim proving NEAR account ownership. Stored as metadata by platforms that accept it. */
  verifiable_claim?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Config-driven platform definitions
//
// To add a new platform:
//   1. Add a meta entry to PLATFORM_META above (display fields + requiresWalletKey).
//   2. Add a config entry to PLATFORM_CONFIGS below (auth type, URL, timeout,
//      credential fields). Add a local env-backed constant for the URL if needed.
//   Everything else is generic: demo page cards, auto-registration, credential
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

export const PLATFORM_CONFIGS: readonly PlatformConfig[] = [
  {
    ...meta('market.near.ai'),
    authType: 'direct-post',
    registerUrl: `${MARKET_API_URL}/agents/register`,
    timeoutMs: 5_000,
    bodyFields: [
      'handle',
      'near_account_id',
      'tags',
      'capabilities',
      'verifiable_claim',
    ],
    credentialFields: {
      api_key: 'api_key',
      agent_id: 'agent_id',
      near_account_id: 'near_account_id',
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
      body[field] = val;
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

  const errorData = await res.json().catch(() => null);
  const msg = errorData?.error || 'Registration failed';
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

/** Extract the nested `.data.agent` object from an OutLayer JSON response. */
function extractAgentFromJson(json: Record<string, unknown>): {
  data?: Record<string, unknown>;
  agent?: Record<string, unknown>;
} {
  const data =
    typeof json.data === 'object' && json.data !== null
      ? (json.data as Record<string, unknown>)
      : undefined;
  const rawAgent = data?.agent;
  const agent =
    typeof rawAgent === 'object' && rawAgent !== null
      ? (rawAgent as Record<string, unknown>)
      : undefined;
  return { data, agent };
}

function buildPlatformContext(
  agent: {
    handle: string;
    near_account_id: string;
    tags?: string[];
    capabilities?: Record<string, unknown>;
  },
  walletKey?: string,
  claim?: Record<string, unknown>,
): PlatformContext {
  return {
    handle: agent.handle,
    near_account_id: agent.near_account_id,
    tags: agent.tags,
    capabilities: agent.capabilities,
    outlayer_api_key: walletKey?.startsWith('wk_') ? walletKey : undefined,
    verifiable_claim: claim,
  };
}

/** Persist succeeded platform IDs via the admin-only set_platforms action. */
async function persistPlatformResults(
  handle: string,
  succeeded: string[],
  existing: string[],
): Promise<{ persisted: string[]; persistWarnings: string[] }> {
  const persistWarnings: string[] = [];
  const merged = [...new Set([...existing, ...succeeded])];
  let persisted = existing;
  if (succeeded.length > 0) {
    const adminKey = getOutlayerPaymentKey();
    if (adminKey) {
      const { response: updateResult } = await callOutlayer(
        { action: 'set_platforms', handle, platforms: merged },
        adminKey,
      );
      if (updateResult.status === 200) {
        persisted = merged;
        clearCache();
      } else {
        persistWarnings.push('Failed to persist platform registrations');
      }
    }
  }
  return { persisted, persistWarnings };
}

/**
 * POST /agents/me/platforms — register on external platforms.
 * Proxy-only: fetches agent via WASM get_me, runs external registrations,
 * then persists succeeded platform IDs via the admin-only set_platforms action.
 */
export async function handleRegisterPlatforms(
  authKey: string,
  wasmBody: Record<string, unknown>,
  userAuthKey: string | undefined,
): Promise<NextResponse> {
  // 1. Load agent profile
  const { response: meResult } = await callOutlayer(
    { action: 'get_me' },
    authKey,
  );
  if (meResult.status !== 200) {
    return NextResponse.json(
      {
        success: false,
        error: 'Could not load agent profile',
        code: 'INTERNAL_ERROR',
      },
      { status: 502 },
    );
  }
  const meData: Record<string, unknown> = await meResult.json();
  const { agent } = extractAgentFromJson(meData);
  if (
    !agent ||
    typeof agent.handle !== 'string' ||
    typeof agent.near_account_id !== 'string'
  ) {
    return NextResponse.json(
      {
        success: false,
        error: 'Agent profile incomplete',
        code: 'VALIDATION_ERROR',
      },
      { status: 400 },
    );
  }

  // 2. Run platform registrations
  const requestedIds = Array.isArray(wasmBody.platforms)
    ? wasmBody.platforms.filter((p): p is string => typeof p === 'string')
    : undefined;
  const ctx = buildPlatformContext(
    {
      handle: agent.handle,
      near_account_id: agent.near_account_id,
      tags: Array.isArray(agent.tags) ? agent.tags : undefined,
      capabilities: isValidCapabilities(agent.capabilities)
        ? agent.capabilities
        : undefined,
    },
    userAuthKey,
  );
  const { platforms, warnings } = await tryPlatformRegistrations(
    ctx,
    requestedIds,
  );

  const succeeded = Object.entries(platforms)
    .filter(([, r]) => r.success)
    .map(([id]) => id);

  // 3. Re-read agent to get the freshest platforms list before merging.
  // Without this, two concurrent register_platforms calls would each merge
  // with the snapshot from step 1, and the last writer would overwrite the
  // first writer's newly-registered platforms (classic lost-update race).
  let bestAgent: Record<string, unknown> = agent;
  if (succeeded.length > 0 && userAuthKey) {
    const { response: freshResult } = await callOutlayer(
      { action: 'get_me' },
      authKey,
    );
    if (freshResult.status === 200) {
      const freshData: Record<string, unknown> = await freshResult.json();
      bestAgent = extractAgentFromJson(freshData).agent ?? agent;
    }
  }
  const existing: string[] = Array.isArray(bestAgent.platforms)
    ? bestAgent.platforms.filter((p): p is string => typeof p === 'string')
    : [];

  const { persisted, persistWarnings } = await persistPlatformResults(
    agent.handle as string,
    succeeded,
    existing,
  );
  warnings.push(...persistWarnings);

  return NextResponse.json({
    success: true,
    data: { platforms, registered: persisted },
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

/**
 * After initial agent registration, auto-attempt all platform registrations
 * and persist succeeded platform IDs on the agent record.
 */
export async function tryPlatformRegistrationsOnRegister(
  wasmBody: Record<string, unknown>,
  result: NextResponse,
  userAuthKey: string | undefined,
): Promise<NextResponse> {
  const nearlyData: Record<string, unknown> = await result.json();
  const { data, agent } = extractAgentFromJson(nearlyData);
  if (!agent?.handle || typeof agent.handle !== 'string') {
    return NextResponse.json(nearlyData);
  }

  const rawAccountId = data?.near_account_id ?? agent.near_account_id;
  const nearAccountId = typeof rawAccountId === 'string' ? rawAccountId : '';

  const claim =
    typeof wasmBody.verifiable_claim === 'object' &&
    wasmBody.verifiable_claim !== null
      ? (wasmBody.verifiable_claim as Record<string, unknown>)
      : undefined;
  const ctx = buildPlatformContext(
    {
      handle: agent.handle,
      near_account_id: nearAccountId,
      tags: Array.isArray(wasmBody.tags)
        ? wasmBody.tags.filter((t): t is string => typeof t === 'string')
        : undefined,
      capabilities: isValidCapabilities(wasmBody.capabilities)
        ? wasmBody.capabilities
        : undefined,
    },
    userAuthKey,
    claim,
  );

  const { platforms, warnings } = await tryPlatformRegistrations(ctx);

  // Surface all successful platform credentials in the registration response
  const platformCredentials: Record<string, Record<string, unknown>> = {};
  for (const [id, result] of Object.entries(platforms)) {
    if (result.success && result.credentials) {
      platformCredentials[id] = result.credentials;
    }
  }
  if (data && Object.keys(platformCredentials).length > 0) {
    data.platform_credentials = platformCredentials;
  }

  const succeeded = Object.entries(platforms)
    .filter(([, r]) => r.success)
    .map(([id]) => id);
  const { persisted, persistWarnings } = await persistPlatformResults(
    agent.handle,
    succeeded,
    [],
  );
  if (persisted.length > 0) {
    agent.platforms = persisted;
  }
  warnings.push(...persistWarnings);

  const existing = Array.isArray(nearlyData.warnings)
    ? nearlyData.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  nearlyData.warnings = [...existing, ...warnings];

  return NextResponse.json(nearlyData);
}
