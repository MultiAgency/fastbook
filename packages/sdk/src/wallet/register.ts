import { DEFAULT_TIMEOUT_MS } from '../constants';
import {
  encodeEd25519PublicKey,
  encodeSignatureBase58,
  parseEd25519SecretKey,
  signRegisterMessage,
} from '../ed25519';
import {
  authError,
  networkError,
  protocolError,
  validationError,
} from '../errors';
import { bytesToHex, hmacSha256, sha256 } from '../hashes';
import type { FetchLike } from '../read';
import { responseDetail } from './operations';

export interface RegisterResponse {
  walletKey: string;
  accountId: string;
  handoffUrl?: string;
  trial: {
    calls_remaining: number;
    expires_at?: string;
  };
}

interface NormalizedTrial {
  calls_remaining: number;
  expires_at?: string;
}

// Validates `{ calls_remaining: number, expires_at?: string }` shape.
// Returns undefined when trial is absent — callers that require it throw.
function parseTrial(
  trial: unknown,
  context: string,
): NormalizedTrial | undefined {
  if (trial === undefined || trial === null) return undefined;
  if (typeof trial !== 'object') {
    throw protocolError(`${context}: trial is not an object`);
  }
  const t = trial as { calls_remaining?: unknown; expires_at?: unknown };
  if (typeof t.calls_remaining !== 'number') {
    throw protocolError(`${context}: trial missing calls_remaining`);
  }
  return {
    calls_remaining: t.calls_remaining,
    ...(typeof t.expires_at === 'string' && t.expires_at
      ? { expires_at: t.expires_at }
      : {}),
  };
}

export async function createWallet(opts: {
  outlayerUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<RegisterResponse> {
  const fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.outlayerUrl}/register`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`OutLayer rejected register (${res.status})`);
    }
    throw protocolError(`register ${res.status}: ${await responseDetail(res)}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('register: malformed JSON in 2xx response');
  }

  if (!body || typeof body !== 'object') {
    throw protocolError('register: response body is not an object');
  }
  const b = body as Record<string, unknown>;
  const apiKey = b.api_key;
  const accountId = b.near_account_id;
  const trial = b.trial;
  const handoffUrl = b.handoff_url;

  if (typeof apiKey !== 'string' || !apiKey) {
    throw protocolError('register: response missing api_key');
  }
  if (typeof accountId !== 'string' || !accountId) {
    throw protocolError('register: response missing near_account_id');
  }
  const normalizedTrial = parseTrial(trial, 'register');
  if (!normalizedTrial) throw protocolError('register: response missing trial');

  return {
    walletKey: apiKey,
    accountId,
    ...(typeof handoffUrl === 'string' && handoffUrl ? { handoffUrl } : {}),
    trial: normalizedTrial,
  };
}

// nearAccountId is the derived hex64 implicit, NOT the caller's named account.
// No walletKey is issued — caller continues via Bearer near: or manages out-of-band.
export interface DeterministicRegisterResponse {
  walletId: string;
  nearAccountId: string;
  handoffUrl?: string;
  // OutLayer omits trial on the idempotent re-registration response.
  trial?: {
    calls_remaining: number;
    expires_at?: string;
  };
}

// Returned nearAccountId is a hex64 implicit derived from (accountId, seed) — same inputs, same wallet.
// SDK never persists opts.privateKey; lives in memory for the call only, never logged or surfaced.
export async function createDeterministicWallet(opts: {
  outlayerUrl: string;
  accountId: string;
  seed: string;
  privateKey: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}): Promise<DeterministicRegisterResponse> {
  if (typeof opts.accountId !== 'string' || !opts.accountId) {
    throw validationError('accountId', 'accountId is required');
  }
  if (typeof opts.seed !== 'string' || !opts.seed) {
    throw validationError('seed', 'seed is required');
  }

  const parsed = parseEd25519SecretKey(opts.privateKey);
  const unixSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
  const message = `register:${opts.seed}:${unixSeconds}`;
  const signature = signRegisterMessage(message, parsed.secretKey);

  const fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.outlayerUrl}/register`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: opts.accountId,
        seed: opts.seed,
        pubkey: encodeEd25519PublicKey(parsed.publicKey),
        message,
        signature: encodeSignatureBase58(signature),
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(
        `OutLayer rejected deterministic register (${res.status})`,
      );
    }
    throw protocolError(
      `deterministic register ${res.status}: ${await responseDetail(res)}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError(
      'deterministic register: malformed JSON in 2xx response',
    );
  }
  if (!body || typeof body !== 'object') {
    throw protocolError(
      'deterministic register: response body is not an object',
    );
  }
  const b = body as Record<string, unknown>;
  const walletId = b.wallet_id;
  const nearAccountId = b.near_account_id;
  const trial = b.trial;
  const handoffUrl = b.handoff_url;

  if (typeof walletId !== 'string' || !walletId) {
    throw protocolError('deterministic register: response missing wallet_id');
  }
  if (typeof nearAccountId !== 'string' || !nearAccountId) {
    throw protocolError(
      'deterministic register: response missing near_account_id',
    );
  }
  const normalizedTrial = parseTrial(trial, 'deterministic register');

  return {
    walletId,
    nearAccountId,
    ...(typeof handoffUrl === 'string' && handoffUrl ? { handoffUrl } : {}),
    ...(normalizedTrial ? { trial: normalizedTrial } : {}),
  };
}

export interface MintDelegateKeyResponse {
  walletId: string;
  nearAccountId: string;
  // Client-derived; OutLayer only learns sha256(walletKey).
  walletKey: string;
}

// wk_ = "wk_" + hex(HMAC-SHA256(seed_bytes, "<seed>:<keyIndex>")). Idempotent — same inputs, same wk_.
export async function mintDelegateKey(opts: {
  outlayerUrl: string;
  accountId: string;
  seed: string;
  privateKey: string;
  keyIndex?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}): Promise<MintDelegateKeyResponse> {
  if (typeof opts.accountId !== 'string' || !opts.accountId) {
    throw validationError('accountId', 'accountId is required');
  }
  if (typeof opts.seed !== 'string' || !opts.seed) {
    throw validationError('seed', 'seed is required');
  }

  const parsed = parseEd25519SecretKey(opts.privateKey);
  const seedBytes = parsed.secretKey.slice(0, 32);
  const keyIndex = opts.keyIndex ?? 0;
  const derivationInput = new TextEncoder().encode(`${opts.seed}:${keyIndex}`);
  const derivedHmac = await hmacSha256(seedBytes, derivationInput);
  const walletKey = `wk_${bytesToHex(derivedHmac)}`;
  const keyHashBytes = await sha256(new TextEncoder().encode(walletKey));
  const keyHash = bytesToHex(keyHashBytes);

  const unixSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
  const message = `api-key:${opts.seed}:${unixSeconds}`;
  const signature = signRegisterMessage(message, parsed.secretKey);

  const fetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.outlayerUrl}/wallet/v1/api-key`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_id: opts.accountId,
        seed: opts.seed,
        key_hash: keyHash,
        pubkey: encodeEd25519PublicKey(parsed.publicKey),
        message,
        signature: encodeSignatureBase58(signature),
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw authError(`OutLayer rejected mint-delegate-key (${res.status})`);
    }
    throw protocolError(
      `mint-delegate-key ${res.status}: ${await responseDetail(res)}`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('mint-delegate-key: malformed JSON in 2xx response');
  }
  if (!body || typeof body !== 'object') {
    throw protocolError('mint-delegate-key: response body is not an object');
  }
  const b = body as Record<string, unknown>;
  const walletId = b.wallet_id;
  const nearAccountId = b.near_account_id;

  if (typeof walletId !== 'string' || !walletId) {
    throw protocolError('mint-delegate-key: response missing wallet_id');
  }
  if (typeof nearAccountId !== 'string' || !nearAccountId) {
    throw protocolError('mint-delegate-key: response missing near_account_id');
  }

  return { walletId, nearAccountId, walletKey };
}
