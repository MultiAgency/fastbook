import {
  cn,
  formatScore,
  formatRelativeTime,
  formatDate,
  truncateAccountId,
  isValidHandle,
  sanitizeHandle,
  friendlyError,
  getInitials,
} from '@/lib/utils';

describe('Utility Functions', () => {
  describe('cn', () => {
    it('merges class names', () => {
      expect(cn('a', 'b')).toBe('a b');
    });

    it('handles conditional classes', () => {
      expect(cn('a', false && 'b', 'c')).toBe('a c');
    });

    it('merges tailwind classes correctly', () => {
      expect(cn('px-2', 'px-4')).toBe('px-4');
    });
  });

  describe('formatScore', () => {
    it('formats small numbers', () => {
      expect(formatScore(42)).toBe('42');
      expect(formatScore(999)).toBe('999');
    });

    it('formats thousands', () => {
      expect(formatScore(1000)).toBe('1K');
      expect(formatScore(1500)).toBe('1.5K');
      expect(formatScore(10000)).toBe('10K');
    });

    it('formats millions', () => {
      expect(formatScore(1000000)).toBe('1M');
      expect(formatScore(2500000)).toBe('2.5M');
    });

    it('handles negative numbers', () => {
      expect(formatScore(-100)).toBe('-100');
      expect(formatScore(-1500)).toBe('-1.5K');
    });
  });

  describe('isValidHandle', () => {
    it('validates correct names', () => {
      expect(isValidHandle('agent123')).toBe(true);
      expect(isValidHandle('my_agent')).toBe(true);
      expect(isValidHandle('agent_bot')).toBe(true);
    });

    it('rejects invalid names', () => {
      expect(isValidHandle('a')).toBe(false);
      expect(isValidHandle('agent-name')).toBe(false);
      expect(isValidHandle('agent name')).toBe(false);
      expect(isValidHandle('Agent_Bot')).toBe(false);
    });
  });

  describe('getInitials', () => {
    it('gets initials from name', () => {
      expect(getInitials('John Doe')).toBe('JD');
      expect(getInitials('my_agent')).toBe('MA');
      expect(getInitials('single')).toBe('S');
    });

    it('handles edge cases', () => {
      expect(getInitials('')).toBe('');
      expect(getInitials('a')).toBe('A');
      expect(getInitials('123')).toBe('1');
    });
  });

  describe('formatRelativeTime', () => {
    it('formats seconds as just now', () => {
      const recent = new Date(Date.now() - 30 * 1000).toISOString();
      expect(formatRelativeTime(recent)).toBe('just now');
    });

    it('formats minutes accurately', () => {
      const fiveMin = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(formatRelativeTime(fiveMin)).toBe('5 minutes ago');
    });

    it('formats hours accurately', () => {
      const d = new Date(Date.now() - 2 * 60 * 60 * 1000);
      expect(formatRelativeTime(d)).toBe('2 hours ago');
    });

    it('formats single units without plural', () => {
      const oneMin = new Date(Date.now() - 1 * 60 * 1000).toISOString();
      expect(formatRelativeTime(oneMin)).toBe('1 minute ago');
      const oneHour = new Date(Date.now() - 1 * 60 * 60 * 1000);
      expect(formatRelativeTime(oneHour)).toBe('1 hour ago');
    });

    it('formats days accurately', () => {
      const threeDays = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      expect(formatRelativeTime(threeDays)).toBe('3 days ago');
    });

    it('falls back to formatted date for old dates', () => {
      const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const result = formatRelativeTime(old);
      expect(result).not.toContain('ago');
      expect(result).toMatch(/[A-Z][a-z]+ \d+, \d{4}/);
    });

    it('accepts unix timestamps', () => {
      const ts = Math.floor(Date.now() / 1000) - 120;
      expect(formatRelativeTime(ts)).toBe('2 minutes ago');
    });
  });

  describe('formatDate', () => {
    it('formats ISO string to readable date', () => {
      const result = formatDate('2025-03-15T12:00:00Z');
      expect(result).toMatch(/Mar 15, 2025/);
    });
  });

  describe('truncateAccountId', () => {
    it('returns short IDs unchanged', () => {
      expect(truncateAccountId('alice.near')).toBe('alice.near');
    });

    it('truncates long IDs with ellipsis', () => {
      const long = 'abcdefghijklmnopqrstuvwxyz1234567890.near';
      const result = truncateAccountId(long);
      expect(result).toContain('...');
      expect(result.length).toBeLessThan(long.length);
    });

    it('respects custom maxLength', () => {
      const id = 'abcdefghijklmnopqrstuvwxyz.near';
      const result = truncateAccountId(id, 15);
      expect(result).toContain('...');
      expect(result.length).toBeLessThanOrEqual(15);
    });

    it('returns ID unchanged when exactly at maxLength', () => {
      const id = 'abcdefghijklmnopqrst'; // 20 chars
      expect(truncateAccountId(id, 20)).toBe(id);
    });
  });

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
  });

  describe('friendlyError', () => {
    it('maps timeout errors', () => {
      expect(friendlyError(new Error('Request abort'))).toContain('timed out');
    });

    it('maps network errors', () => {
      expect(friendlyError(new Error('fetch failed'))).toContain('NEAR network');
    });

    it('maps conflict errors', () => {
      expect(friendlyError(new Error('Handle already taken'))).toContain('already in use');
    });

    it('maps expired errors', () => {
      expect(friendlyError(new Error('timestamp expired'))).toContain('expired');
    });

    it('maps auth errors', () => {
      expect(friendlyError(new Error('401 unauthorized'))).toContain('Authentication');
    });

    it('returns generic message for unknown errors', () => {
      expect(friendlyError(new Error('something weird'))).toContain('Something went wrong');
    });

    it('handles non-Error objects', () => {
      expect(friendlyError('string error')).toContain('Something went wrong');
    });
  });

});
