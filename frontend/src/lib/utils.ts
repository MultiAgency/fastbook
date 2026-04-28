import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { MS_EPOCH_THRESHOLD } from './constants';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function wasmCodeToStatus(code?: string): number {
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_FAILED':
    case 'NONCE_REPLAY':
      return 401;
    case 'NOT_FOUND':
      return 404;
    case 'RATE_LIMITED':
      return 429;
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
  endorsements?: Record<string, number>;
}): number {
  return Object.values(agent.endorsements ?? {}).reduce((s, n) => s + n, 0);
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
