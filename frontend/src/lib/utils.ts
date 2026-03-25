import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import {
  HANDLE_RE,
  LIMITS,
  MS_EPOCH_THRESHOLD,
  RESERVED_HANDLES,
} from './constants';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function displayName(agent: {
  display_name?: string;
  handle: string;
}): string {
  return agent.display_name || agent.handle;
}

export function formatScore(score: number): string {
  if (!Number.isFinite(score)) return '0';
  const abs = Math.abs(score);
  const sign = score < 0 ? '-' : '';
  if (abs >= 1000000)
    return `${sign + (abs / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1000)
    return `${sign + (abs / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return score.toString();
}

export function toMs(ts: number): number {
  return ts > MS_EPOCH_THRESHOLD ? ts : ts * 1000;
}

function normalizeDate(date: string | Date | number): Date {
  if (typeof date === 'number') return new Date(toMs(date));
  if (typeof date === 'string') return new Date(date);
  return date;
}

function formatDate(date: string | Date | number): string {
  return normalizeDate(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle) && !RESERVED_HANDLES.has(handle);
}

export function isValidVerifiableClaim(vc: unknown): boolean {
  if (typeof vc !== 'object' || vc === null) return false;
  const v = vc as Record<string, unknown>;
  return (
    typeof v.near_account_id === 'string' &&
    (v.near_account_id as string).length <= LIMITS.MAX_VC_ACCOUNT_ID &&
    typeof v.public_key === 'string' &&
    (v.public_key as string).length <= LIMITS.MAX_VC_PUBLIC_KEY &&
    typeof v.signature === 'string' &&
    (v.signature as string).length <= LIMITS.MAX_VC_SIGNATURE &&
    typeof v.nonce === 'string' &&
    (v.nonce as string).length <= LIMITS.MAX_VC_NONCE &&
    typeof v.message === 'string' &&
    (v.message as string).length <= LIMITS.MAX_VC_FIELD
  );
}

export function isValidCapabilities(
  caps: unknown,
): caps is import('@/types').AgentCapabilities {
  if (typeof caps !== 'object' || caps === null || Array.isArray(caps))
    return false;
  const obj = caps as Record<string, unknown>;
  if ('skills' in obj) {
    if (
      !Array.isArray(obj.skills) ||
      !obj.skills.every((s: unknown) => typeof s === 'string')
    )
      return false;
  }
  return true;
}

export function totalEndorsements(agent: {
  endorsements?: Record<string, Record<string, number>>;
}): number {
  return Object.values(agent.endorsements ?? {}).reduce(
    (sum, ns) => sum + Object.values(ns).reduce((s, v) => s + v, 0),
    0,
  );
}

export function truncateAccountId(accountId: string, maxLength = 20): string {
  if (accountId.length <= maxLength) return accountId;
  const side = Math.max(Math.floor((maxLength - 3) / 2), 4);
  return `${accountId.slice(0, side)}...${accountId.slice(-side)}`;
}

export function formatRelativeTime(date: string | Date | number): string {
  const d = normalizeDate(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60)
    return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHours < 24)
    return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  return formatDate(date);
}

export function sanitizeHandle(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_]/g, '');
  return cleaned.replace(/^[^a-z]+/, '');
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

export type ErrorKind = 'network' | 'auth' | 'generic';

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
}

const ERROR_PATTERNS: readonly [RegExp, string, ErrorKind][] = [
  [/\babort|\btimeout/i, 'Request timed out. Please try again.', 'network'],
  [
    /failed to fetch|networkerror|econnrefused|net::err_/i,
    'Could not reach the server. Make sure the backend is running.',
    'network',
  ],
  [
    /\brpc\b|network\s*error|\bfetch\b/i,
    'Could not reach the NEAR network. Please try again.',
    'network',
  ],
  [
    /already taken|Handle already taken|conflict/i,
    'This handle is already in use. Try a different one.',
    'generic',
  ],
  [
    /Handle must be|Handle is reserved/i,
    'Invalid handle. Use 3-32 lowercase letters, numbers, or underscores.',
    'generic',
  ],
  [
    /already registered/i,
    'This NEAR account is already registered.',
    'generic',
  ],
  [/Agent not found/i, 'Agent not found.', 'generic'],
  [
    /No agent registered/i,
    'You need to register before performing this action.',
    'auth',
  ],
  [/Cannot follow yourself/i, 'You cannot follow yourself.', 'generic'],
  [
    /Cannot endorse yourself|Cannot unendorse yourself/i,
    'You cannot endorse yourself.',
    'generic',
  ],
  [
    /nonce has already been used/i,
    'This signature has already been used. Please sign again.',
    'auth',
  ],
  [
    /expired|timestamp/i,
    'Your signature has expired. Please sign again.',
    'auth',
  ],
  [
    /Auth failed|Authentication required|unauthorized|\b401\b/i,
    'Authentication failed. Please restart the flow.',
    'auth',
  ],
  [/\b403\b|forbidden/i, 'Access denied.', 'auth'],
  [
    /rate.?limit|429|too many/i,
    'Too many requests. Please wait a moment.',
    'generic',
  ],
  [
    /WASM execution failed|decode.*output/i,
    'Backend execution error. Please try again.',
    'generic',
  ],
  [
    /upstream.*timeout|504/i,
    'The server took too long to respond. Please try again.',
    'network',
  ],
  [
    /402|quota|insufficient.*funds?|payment/i,
    'Insufficient credits. Please check your account balance.',
    'generic',
  ],
];

export function classifyError(err: unknown): ClassifiedError {
  const msg = toErrorMessage(err);
  for (const [pattern, message, kind] of ERROR_PATTERNS) {
    if (pattern.test(msg)) return { kind, message };
  }
  return {
    kind: 'generic',
    message: 'Something went wrong. Please try again.',
  };
}

export function friendlyError(err: unknown): string {
  return classifyError(err).message;
}
