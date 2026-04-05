import {
  formatRelativeTime,
  formatScore,
  friendlyError,
  sanitizeHandle,
  toErrorMessage,
  truncateAccountId,
} from '@/lib/utils';

describe('Utility Functions', () => {
  describe('sanitizeHandle', () => {
    it('lowercases input', () => {
      expect(sanitizeHandle('MyAgent')).toBe('myagent');
    });

    it('strips invalid characters', () => {
      expect(sanitizeHandle('my-agent!@#')).toBe('myagent');
    });

    it('allows underscores and numbers', () => {
      expect(sanitizeHandle('agent_007')).toBe('agent_007');
    });

    it('returns empty string for all-invalid input', () => {
      expect(sanitizeHandle('---!!!')).toBe('');
    });

    it('strips unicode characters', () => {
      expect(sanitizeHandle('agénté')).toBe('agnt');
    });

    it('strips leading digits and underscores', () => {
      expect(sanitizeHandle('123bot')).toBe('bot');
      expect(sanitizeHandle('_agent')).toBe('agent');
      expect(sanitizeHandle('99_agent')).toBe('agent');
    });

    it('returns empty when all chars are leading non-letters', () => {
      expect(sanitizeHandle('123')).toBe('');
      expect(sanitizeHandle('___')).toBe('');
    });
  });

  describe('friendlyError', () => {
    it('maps timeout errors', () => {
      expect(friendlyError(new Error('Request abort'))).toContain('timed out');
    });

    it('maps network errors', () => {
      expect(friendlyError(new Error('fetch failed'))).toContain(
        'NEAR network',
      );
    });

    it('maps conflict errors', () => {
      expect(friendlyError(new Error('Handle already taken'))).toContain(
        'already in use',
      );
    });

    it('maps expired errors', () => {
      expect(friendlyError(new Error('timestamp expired'))).toContain(
        'expired',
      );
    });

    it('maps auth errors', () => {
      expect(friendlyError(new Error('401 unauthorized'))).toContain(
        'Authentication',
      );
    });

    it('returns generic message for unknown errors', () => {
      expect(friendlyError(new Error('something weird'))).toContain(
        'Something went wrong',
      );
    });

    it('handles non-Error objects', () => {
      expect(friendlyError('string error')).toContain('Something went wrong');
    });

    it('maps rate limit errors', () => {
      expect(friendlyError(new Error('429 too many requests'))).toContain(
        'Too many requests',
      );
    });

    it('maps SELF_UNFOLLOW error', () => {
      expect(friendlyError(new Error('Cannot unfollow yourself'))).toContain(
        'cannot unfollow',
      );
    });

    it('maps VALIDATION_ERROR code', () => {
      expect(friendlyError(new Error('VALIDATION_ERROR'))).toContain(
        'Invalid input',
      );
    });

    it('maps STORAGE_ERROR code', () => {
      expect(friendlyError(new Error('STORAGE_ERROR'))).toContain(
        'storage error',
      );
    });

    it('maps INTERNAL_ERROR code', () => {
      expect(friendlyError(new Error('INTERNAL_ERROR'))).toContain(
        'internal error',
      );
    });

    it('maps ROLLBACK_PARTIAL code', () => {
      expect(friendlyError(new Error('ROLLBACK_PARTIAL'))).toContain(
        'partially failed',
      );
    });

    it('maps NONCE_REPLAY error', () => {
      expect(friendlyError(new Error('nonce has already been used'))).toContain(
        'already been used',
      );
    });

    it('maps 503 service unavailable', () => {
      expect(friendlyError(new Error('503 service unavailable'))).toContain(
        'temporarily unavailable',
      );
    });

    it('maps upstream unreachable', () => {
      expect(friendlyError(new Error('Upstream unreachable'))).toContain(
        'reach the backend',
      );
    });

    it('prefers ApiError.code over message text for classification', () => {
      const err = Object.assign(new Error('Something obscure'), {
        code: 'RATE_LIMITED',
      });
      expect(friendlyError(err)).toContain('Too many requests');
    });
  });

  describe('formatScore', () => {
    it('returns small numbers as-is', () => {
      expect(formatScore(0)).toBe('0');
      expect(formatScore(999)).toBe('999');
    });

    it('formats thousands with K suffix', () => {
      expect(formatScore(1000)).toBe('1K');
      expect(formatScore(1500)).toBe('1.5K');
      expect(formatScore(10000)).toBe('10K');
    });

    it('formats millions with M suffix', () => {
      expect(formatScore(1000000)).toBe('1M');
      expect(formatScore(2500000)).toBe('2.5M');
    });

    it('handles negative numbers', () => {
      expect(formatScore(-1500)).toBe('-1.5K');
      expect(formatScore(-1000000)).toBe('-1M');
    });
  });

  describe('truncateAccountId', () => {
    it('returns short IDs unchanged', () => {
      expect(truncateAccountId('alice.near')).toBe('alice.near');
    });

    it('truncates long IDs with ellipsis', () => {
      const long = 'abcdefghijklmnopqrstuvwxyz1234567890.near';
      expect(truncateAccountId(long)).toBe('abcdefgh...890.near');
    });

    it('respects custom maxLength', () => {
      const id = 'abcdefghij.near';
      expect(truncateAccountId(id, 10)).toBe('abcd...near');
    });
  });

  describe('formatRelativeTime', () => {
    it('returns "just now" for recent timestamps', () => {
      expect(formatRelativeTime(new Date())).toBe('just now');
    });

    it('formats minutes ago', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      expect(formatRelativeTime(fiveMinAgo)).toBe('5 minutes ago');
    });

    it('formats singular minute', () => {
      const oneMinAgo = new Date(Date.now() - 61 * 1000);
      expect(formatRelativeTime(oneMinAgo)).toBe('1 minute ago');
    });

    it('formats hours ago', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      expect(formatRelativeTime(twoHoursAgo)).toBe('2 hours ago');
    });

    it('formats days ago', () => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
    });

    it('returns formatted date for older than 30 days', () => {
      const old = new Date('2020-06-15T12:00:00Z');
      const result = formatRelativeTime(old);
      expect(result).toMatch(/^Jun 1[45], 2020$/);
    });

    it('handles unix timestamps in seconds', () => {
      const nowSecs = Math.floor(Date.now() / 1000);
      expect(formatRelativeTime(nowSecs)).toBe('just now');
    });
  });

  describe('toErrorMessage', () => {
    it('extracts message from Error instances', () => {
      expect(toErrorMessage(new Error('test error'))).toBe('test error');
    });

    it('returns strings as-is', () => {
      expect(toErrorMessage('raw string')).toBe('raw string');
    });

    it('converts null to string', () => {
      expect(toErrorMessage(null)).toBe('null');
    });

    it('converts undefined to string', () => {
      expect(toErrorMessage(undefined)).toBe('undefined');
    });

    it('converts numbers to string', () => {
      expect(toErrorMessage(42)).toBe('42');
    });
  });
});
