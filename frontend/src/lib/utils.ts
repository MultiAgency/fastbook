import { type ClassValue, clsx } from 'clsx';
import { format, parseISO } from 'date-fns';
import { twMerge } from 'tailwind-merge';

// Class name utility
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Format score (e.g., 1.2K, 3.5M)
export function formatScore(score: number): string {
  const abs = Math.abs(score);
  const sign = score < 0 ? '-' : '';
  if (abs >= 1000000)
    return `${sign + (abs / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1000)
    return `${sign + (abs / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return score.toString();
}

/** Normalise a numeric timestamp to milliseconds (handles both seconds and ms). */
function toMs(ts: number): number {
  // Timestamps above 1e12 are already milliseconds; below that, treat as seconds
  return ts > 1e12 ? ts : ts * 1000;
}

/** Coerce a string, number, or Date into a Date object. */
function normalizeDate(date: string | Date | number): Date {
  if (typeof date === 'number') return new Date(toMs(date));
  if (typeof date === 'string') return parseISO(date);
  return date;
}

// Format absolute date
export function formatDate(date: string | Date | number): string {
  return format(normalizeDate(date), 'MMM d, yyyy');
}

// Validate handle
export function isValidHandle(handle: string): boolean {
  return /^[a-z0-9_]{2,32}$/.test(handle);
}

// Generate initials from name
export function getInitials(name: string): string {
  return name
    .split(/[\s_]+/)
    .map((part) => part[0]?.toUpperCase())
    .filter(Boolean)
    .slice(0, 2)
    .join('');
}

// Truncate a NEAR account ID for display (e.g., "abcd1234...wxyz5678")
export function truncateAccountId(accountId: string, maxLength = 20): string {
  if (accountId.length <= maxLength) return accountId;
  const side = Math.max(Math.floor((maxLength - 3) / 2), 4);
  return `${accountId.slice(0, side)}...${accountId.slice(-side)}`;
}

// Format relative time
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

// Sanitize a handle input (lowercase, alphanumeric + underscore only)
export function sanitizeHandle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

/** Safely extract an error message from an unknown thrown value. */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

// Map raw backend errors to user-friendly messages
const ERROR_PATTERNS = [
  [/abort|timeout/i, 'Request timed out. Please try again.'],
  [/rpc|network|fetch/i, "Couldn't reach the NEAR network. Please try again."],
  [
    /already taken|conflict/i,
    'This handle is already in use. Try a different one.',
  ],
  [/expired|timestamp/i, 'Your signature has expired. Please sign again.'],
  [/unauthorized|401/i, 'Authentication failed. Please restart the flow.'],
] as const;

export function friendlyError(err: unknown): string {
  const msg = toErrorMessage(err);
  for (const [pattern, message] of ERROR_PATTERNS) {
    if (pattern.test(msg)) return message;
  }
  return 'Something went wrong. Please try again.';
}
