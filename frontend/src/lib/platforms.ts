import { NextResponse } from 'next/server';
import { clearCache } from '@/lib/cache';
import {
  FASTDATA_NAMESPACE,
  MARKET_API_URL,
  OUTLAYER_API_URL,
} from '@/lib/constants';
import { kvGetAgent } from '@/lib/fastdata';
import { agentEntries } from '@/lib/fastdata-utils';
import { fetchWithTimeout } from '@/lib/fetch';
import { resolveAccountId } from '@/lib/outlayer-server';
import type { Agent, PlatformResult } from '@/types';

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
  description?: string;
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

function buildPlatformContext(
  agent: {
    handle: string;
    near_account_id: string;
    description?: string;
    tags?: string[];
    capabilities?: Record<string, unknown>;
  },
  walletKey?: string,
  claim?: Record<string, unknown>,
): PlatformContext {
  return {
    handle: agent.handle,
    near_account_id: agent.near_account_id,
    description: agent.description,
    tags: agent.tags,
    capabilities: agent.capabilities,
    outlayer_api_key: walletKey?.startsWith('wk_') ? walletKey : undefined,
    verifiable_claim: claim,
  };
}

/** Write entries to FastData KV using the agent's own wallet key. */
async function writePlatformEntries(
  walletKey: string,
  entries: Record<string, unknown>,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${OUTLAYER_API_URL}/wallet/v1/call`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${walletKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receiver_id: FASTDATA_NAMESPACE,
          method_name: '__fastdata_kv',
          args: entries,
          gas: '30000000000000',
          deposit: '0',
        }),
      },
      15_000,
    );
    return res.ok;
  } catch {
    return false;
  }
}

/** Persist platform IDs by updating the agent profile in FastData. */
async function persistPlatformResults(
  walletKey: string,
  accountId: string,
  succeeded: string[],
  existing: string[],
): Promise<{ persisted: string[]; persistWarnings: string[] }> {
  const persistWarnings: string[] = [];
  if (succeeded.length === 0) return { persisted: existing, persistWarnings };

  // Re-read agent for lost-update protection.
  const freshAgent = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  if (!freshAgent) {
    persistWarnings.push('Could not read agent profile to persist platforms');
    return { persisted: existing, persistWarnings };
  }

  const merged = [...new Set([...(freshAgent.platforms ?? []), ...succeeded])];
  freshAgent.platforms = merged;

  const wrote = await writePlatformEntries(walletKey, agentEntries(freshAgent));
  if (wrote) {
    clearCache();
    return { persisted: merged, persistWarnings };
  }
  persistWarnings.push('Failed to persist platform registrations');
  return { persisted: existing, persistWarnings };
}

/**
 * POST /agents/me/platforms — register on external platforms.
 * Reads agent from FastData, runs external registrations,
 * then persists succeeded platform IDs back to FastData.
 */
export async function handleRegisterPlatforms(
  walletKey: string,
  wasmBody: Record<string, unknown>,
): Promise<NextResponse> {
  // 1. Load agent profile from FastData
  const accountId = await resolveAccountId(walletKey);
  if (!accountId) {
    return NextResponse.json(
      {
        success: false,
        error: 'Could not resolve account',
        code: 'AUTH_FAILED',
      },
      { status: 401 },
    );
  }
  const agent = (await kvGetAgent(accountId, 'profile')) as Agent | null;
  if (!agent) {
    return NextResponse.json(
      {
        success: false,
        error: 'Agent profile not found — call heartbeat first',
        code: 'VALIDATION_ERROR',
      },
      { status: 400 },
    );
  }

  // 2. Run platform registrations
  const requestedIds = Array.isArray(wasmBody.platforms)
    ? wasmBody.platforms.filter((p): p is string => typeof p === 'string')
    : undefined;
  const ctx = buildPlatformContext(agent, walletKey);
  const { platforms, warnings } = await tryPlatformRegistrations(
    ctx,
    requestedIds,
  );

  const succeeded = Object.entries(platforms)
    .filter(([, r]) => r.success)
    .map(([id]) => id);

  // 3. Persist — re-reads agent inside for lost-update protection.
  const { persisted, persistWarnings } = await persistPlatformResults(
    walletKey,
    accountId,
    succeeded,
    agent.platforms ?? [],
  );
  warnings.push(...persistWarnings);

  return NextResponse.json({
    success: true,
    data: { platforms, registered: persisted },
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

/**
 * Check whether the agent has unregistered platforms and a profile worth sending.
 * Used by route.ts to decide whether to fire-and-forget platform registration
 * after heartbeat/update_me.
 */
export function shouldAutoRegisterPlatforms(agent: {
  platforms?: string[];
  description?: string;
  tags?: string[];
  capabilities?: Record<string, unknown>;
}): boolean {
  const registered = new Set(agent.platforms ?? []);
  const allCovered = availablePlatformIds().every((id) => registered.has(id));
  if (allCovered) return false;

  // Don't send an empty profile to platforms.
  const hasDescription =
    typeof agent.description === 'string' && agent.description.length > 10;
  const hasTags = Array.isArray(agent.tags) && agent.tags.length > 0;
  const hasCaps =
    agent.capabilities &&
    typeof agent.capabilities === 'object' &&
    Object.keys(agent.capabilities).length > 0;
  return hasDescription || hasTags || !!hasCaps;
}

/**
 * Auto-register on platforms the agent hasn't registered on yet.
 * Fire-and-forget from route.ts after heartbeat/update_me.
 */
export async function tryAutoRegisterPlatforms(
  agent: {
    handle: string;
    near_account_id: string;
    description?: string;
    tags?: string[];
    capabilities?: Record<string, unknown>;
    platforms?: string[];
  },
  walletKey: string,
): Promise<void> {
  const registered = new Set(agent.platforms ?? []);
  const missingIds = availablePlatformIds().filter((id) => !registered.has(id));
  if (missingIds.length === 0) return;

  const ctx = buildPlatformContext(agent, walletKey);
  const { platforms } = await tryPlatformRegistrations(ctx, missingIds);

  const succeeded = Object.entries(platforms)
    .filter(([, r]) => r.success)
    .map(([id]) => id);
  await persistPlatformResults(
    walletKey,
    agent.near_account_id,
    succeeded,
    agent.platforms ?? [],
  );
}
