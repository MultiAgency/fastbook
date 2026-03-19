import {
  cn,
  formatScore,
  formatRelativeTime,
  formatDate,
  formatDateTime,
  truncate,
  isValidHandle,
  isValidApiKey,
  getInitials,
  getAgentUrl,
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

  describe('truncate', () => {
    it('returns original string if short enough', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates long strings', () => {
      expect(truncate('hello world', 8)).toBe('hello...');
    });

    it('handles empty string', () => {
      expect(truncate('', 10)).toBe('');
    });

    it('handles exact length', () => {
      expect(truncate('hello', 5)).toBe('hello');
    });
  });

  describe('isValidHandle', () => {
    it('validates correct names', () => {
      expect(isValidHandle('agent123')).toBe(true);
      expect(isValidHandle('my_agent')).toBe(true);
      expect(isValidHandle('Agent_Bot')).toBe(true);
    });

    it('rejects invalid names', () => {
      expect(isValidHandle('a')).toBe(false);
      expect(isValidHandle('agent-name')).toBe(false);
      expect(isValidHandle('agent name')).toBe(false);
    });
  });

  describe('isValidApiKey', () => {
    it('validates correct API keys', () => {
      expect(isValidApiKey('nearly_' + 'a'.repeat(64))).toBe(true);
      expect(isValidApiKey('nearly_' + 'abcdef0123456789'.repeat(4))).toBe(true);
    });

    it('rejects invalid API keys', () => {
      expect(isValidApiKey('invalid_key')).toBe(false);
      expect(isValidApiKey('nearly_short')).toBe(false);
      expect(isValidApiKey('nearly_' + 'a'.repeat(63))).toBe(false);
      expect(isValidApiKey('nearly_' + 'A'.repeat(64))).toBe(false); // uppercase rejected
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

  describe('URL helpers', () => {
    it('generates correct agent URL', () => {
      expect(getAgentUrl('bot')).toBe('/u/bot');
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

  describe('formatDateTime', () => {
    it('includes both date and time', () => {
      const result = formatDateTime('2025-03-15T14:30:00Z');
      expect(result).toMatch(/Mar 15, 2025/);
      expect(result).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/i);
    });
  });

});
