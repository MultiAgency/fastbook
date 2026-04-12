import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { MS_EPOCH_THRESHOLD } from './constants';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function wasmCodeToStatus(code?: string): number {
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_FAILED':
    case 'NONCE_REPLAY':
      return 401;
    case 'NOT_FOUND':
    case 'NOT_REGISTERED':
      return 404;
    case 'RATE_LIMITED':
      return 429;
    case 'ROLLBACK_PARTIAL':
    case 'STORAGE_ERROR':
    case 'INTERNAL_ERROR':
      return 500;
    default:
      return 400;
  }
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

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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

  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n !== 1 ? 's' : ''} ago`;

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return plural(diffMins, 'minute');
  if (diffHours < 24) return plural(diffHours, 'hour');
  if (diffDays < 30) return plural(diffDays, 'day');
  return formatDate(d);
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
  // Specific upstream/status-code patterns before generic network patterns
  // so "upstream timeout" gets the server-specific message, not the generic one.
  [
    /upstream.*timeout|504/i,
    'The server took too long to respond. Please try again.',
    'network',
  ],
  [
    /upstream.*unreachable|502/i,
    'Could not reach the backend. Please try again.',
    'network',
  ],
  [
    /503|service unavailable|not configured/i,
    'The service is temporarily unavailable. Please try again later.',
    'network',
  ],
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
    /already taken|conflict/i,
    'This account is already registered. Try a different one.',
    'generic',
  ],
  [/reserved/i, 'This name is reserved. Choose a different one.', 'generic'],
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
  [/Cannot unfollow yourself/i, 'You cannot unfollow yourself.', 'generic'],
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
    /402|quota|insufficient.*funds?|payment/i,
    'Insufficient credits. Please check your account balance.',
    'generic',
  ],
  [
    /ROLLBACK_PARTIAL|partial.*rollback/i,
    'The operation partially failed. Some changes may not have been applied.',
    'generic',
  ],
  [
    /VALIDATION_ERROR|validation failed/i,
    'Invalid input. Please check your data and try again.',
    'generic',
  ],
  [
    /STORAGE_ERROR/i,
    'A storage error occurred. Please try again shortly.',
    'generic',
  ],
  [
    /INTERNAL_ERROR/i,
    'An internal error occurred. Please try again.',
    'generic',
  ],
];

export function classifyError(err: unknown): ClassifiedError {
  // Check ApiError.code first — resilient to backend message text changes
  const code =
    err != null && typeof err === 'object' && 'code' in err
      ? (err as { code?: string }).code
      : undefined;
  const msg = code ? `${code} ${toErrorMessage(err)}` : toErrorMessage(err);
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
