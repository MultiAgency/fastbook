import {
  checkRateLimit,
  checkRateLimitBudget,
  incrementRateLimit,
} from '@/lib/rate-limit';

beforeEach(() => {
  jest.useFakeTimers();
  // Set clock to a round window boundary (divisible by 60)
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('checkRateLimit', () => {
  it('allows requests within limit', () => {
    // follow limit is 10 per 60s
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit('follow', 'alice.near')).toEqual({ ok: true });
      incrementRateLimit('follow', 'alice.near');
    }
  });

  it('rejects requests exceeding limit', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('follow', 'alice.near');
    }
    const result = checkRateLimit('follow', 'alice.near');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(60);
    }
  });

  it('resets after window expires', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('follow', 'alice.near');
    }
    expect(checkRateLimit('follow', 'alice.near').ok).toBe(false);

    // Advance past the 60s window
    jest.advanceTimersByTime(61_000);

    expect(checkRateLimit('follow', 'alice.near')).toEqual({ ok: true });
  });

  it('isolates by caller', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('follow', 'alice.near');
    }
    expect(checkRateLimit('follow', 'alice.near').ok).toBe(false);
    expect(checkRateLimit('follow', 'bob.near')).toEqual({ ok: true });
  });

  it('isolates by action', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('follow', 'alice.near');
    }
    expect(checkRateLimit('follow', 'alice.near').ok).toBe(false);
    // endorse has its own limit (20), not exhausted
    expect(checkRateLimit('endorse', 'alice.near')).toEqual({ ok: true });
  });

  it('allows unknown actions (no rate limit configured)', () => {
    expect(checkRateLimit('unknown_action', 'alice.near')).toEqual({
      ok: true,
    });
  });
});

describe('incrementRateLimit', () => {
  it('starts a new window when none exists', () => {
    incrementRateLimit('follow', 'alice.near');
    // Should have counted 1, so 9 more are allowed
    for (let i = 0; i < 9; i++) {
      incrementRateLimit('follow', 'alice.near');
    }
    expect(checkRateLimit('follow', 'alice.near').ok).toBe(false);
  });

  it('ignores unknown actions', () => {
    // Should not throw or create entries
    incrementRateLimit('unknown_action', 'alice.near');
    expect(checkRateLimit('unknown_action', 'alice.near')).toEqual({
      ok: true,
    });
  });
});

describe('checkRateLimitBudget', () => {
  beforeEach(() => {
    // Advance to a fresh window so prior test state doesn't leak
    jest.advanceTimersByTime(301_000);
  });

  it('returns full budget when no requests made', () => {
    const result = checkRateLimitBudget('follow', 'alice.near');
    expect(result).toEqual({ ok: true, remaining: 10 });
  });

  it('returns remaining budget after some requests', () => {
    for (let i = 0; i < 3; i++) {
      incrementRateLimit('follow', 'alice.near');
    }
    const result = checkRateLimitBudget('follow', 'alice.near');
    expect(result).toEqual({ ok: true, remaining: 7 });
  });

  it('returns error when budget exhausted', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('follow', 'alice.near');
    }
    const result = checkRateLimitBudget('follow', 'alice.near');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfter).toBeGreaterThan(0);
    }
  });

  it('returns Infinity remaining for unknown actions', () => {
    const result = checkRateLimitBudget('unknown_action', 'alice.near');
    expect(result).toEqual({ ok: true, remaining: Infinity });
  });

  it('resets budget after window expires', () => {
    for (let i = 0; i < 10; i++) {
      incrementRateLimit('follow', 'alice.near');
    }
    expect(checkRateLimitBudget('follow', 'alice.near').ok).toBe(false);

    jest.advanceTimersByTime(61_000);

    const result = checkRateLimitBudget('follow', 'alice.near');
    expect(result).toEqual({ ok: true, remaining: 10 });
  });

  it('respects action-specific limits (delist_me = 1 per 300s)', () => {
    expect(checkRateLimitBudget('delist_me', 'alice.near')).toEqual({
      ok: true,
      remaining: 1,
    });

    incrementRateLimit('delist_me', 'alice.near');

    const result = checkRateLimitBudget('delist_me', 'alice.near');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(300);
    }
  });
});
