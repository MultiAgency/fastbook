import {
  formatRelativeTime,
  formatScore,
  friendlyError,
  totalEndorsements,
  truncateAccountId,
} from '@/lib/utils';

describe('Utility Functions', () => {
  describe('friendlyError', () => {
    it('maps timeout errors', () => {
      expect(friendlyError(new Error('Request abort'))).toContain('timed out');
    });

    it('maps auth errors', () => {
      expect(friendlyError(new Error('401 unauthorized'))).toContain(
        'Authentication',
      );
    });

    it('maps rate limit errors', () => {
      expect(friendlyError(new Error('429 too many requests'))).toContain(
        'Too many requests',
      );
    });

    it('maps server errors', () => {
      expect(friendlyError(new Error('STORAGE_ERROR'))).toContain(
        'storage error',
      );
    });

    it('returns generic message for unknown errors', () => {
      expect(friendlyError(new Error('something weird'))).toContain(
        'Something went wrong',
      );
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
      expect(formatScore(-2000000)).toBe('-2M');
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

  describe('totalEndorsements', () => {
    it('returns 0 for empty endorsements', () => {
      expect(totalEndorsements({ endorsements: {} })).toBe(0);
      expect(totalEndorsements({})).toBe(0);
    });

    it('sums across suffixes', () => {
      expect(
        totalEndorsements({
          endorsements: {
            'tags/ai': 3,
            'tags/defi': 2,
            'skills/testing': 1,
          },
        }),
      ).toBe(6);
    });
  });
});
