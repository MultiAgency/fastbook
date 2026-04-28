import {
  _resetBudgetForTesting,
  checkGenerateBudget,
  globalDailyLimit,
  incrementGenerateBudget,
  perCallerDailyLimit,
} from '@/lib/budget';

const SECONDS_PER_DAY = 86400;

const ORIG_PER_CALLER = process.env.NEARLY_GENERATE_PER_CALLER_DAILY;
const ORIG_GLOBAL = process.env.NEARLY_GENERATE_DAILY_CAP;

function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

function fillCaller(account: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const r = checkGenerateBudget(account);
    if (!r.ok) throw new Error(`unexpected exhaustion at i=${i}`);
    incrementGenerateBudget(account, r.window);
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  _resetBudgetForTesting();
  process.env.NEARLY_GENERATE_PER_CALLER_DAILY = '5';
  process.env.NEARLY_GENERATE_DAILY_CAP = '12';
});

afterEach(() => {
  jest.useRealTimers();
  restoreEnv('NEARLY_GENERATE_PER_CALLER_DAILY', ORIG_PER_CALLER);
  restoreEnv('NEARLY_GENERATE_DAILY_CAP', ORIG_GLOBAL);
});

describe('checkGenerateBudget', () => {
  it('allows requests up to the per-caller limit', () => {
    for (let i = 0; i < 5; i++) {
      const r = checkGenerateBudget('alice.near');
      expect(r.ok).toBe(true);
      if (r.ok) incrementGenerateBudget('alice.near', r.window);
    }
  });

  it('rejects with scope=caller when per-caller limit is exceeded', () => {
    fillCaller('alice.near', 5);
    const r = checkGenerateBudget('alice.near');
    expect(r).toMatchObject({ ok: false, scope: 'caller' });
  });

  it('keeps a separate counter per caller until the global cap', () => {
    fillCaller('alice.near', 5);
    expect(checkGenerateBudget('alice.near').ok).toBe(false);
    const r = checkGenerateBudget('bob.near');
    expect(r.ok).toBe(true);
  });

  it('rejects with scope=global when global cap is exceeded', () => {
    // Per-caller=5, global=12. Three callers at 5 each = 15 attempts; the
    // 13th increment trips the global cap regardless of bearer.
    fillCaller('alice.near', 5);
    fillCaller('bob.near', 5);
    fillCaller('carol.near', 2);
    const r = checkGenerateBudget('dave.near');
    expect(r).toMatchObject({ ok: false, scope: 'global' });
  });

  it('returns retryAfter equal to seconds until UTC midnight', () => {
    jest.setSystemTime(new Date('2026-01-01T22:00:00Z'));
    fillCaller('alice.near', 5);
    const r = checkGenerateBudget('alice.near');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // From 22:00 UTC to next 00:00 UTC = 7200 seconds.
      expect(r.retryAfter).toBe(7200);
    }
  });

  it('resets per-caller counter after UTC rollover', () => {
    fillCaller('alice.near', 5);
    expect(checkGenerateBudget('alice.near').ok).toBe(false);
    jest.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(checkGenerateBudget('alice.near').ok).toBe(true);
  });

  it('resets global counter after UTC rollover', () => {
    fillCaller('alice.near', 5);
    fillCaller('bob.near', 5);
    fillCaller('carol.near', 2);
    expect(checkGenerateBudget('dave.near').ok).toBe(false);
    jest.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(checkGenerateBudget('dave.near').ok).toBe(true);
  });
});

describe('incrementGenerateBudget window threading', () => {
  it('discards an increment pinned to a stale window', () => {
    // Authorize check at day N, then jump to day N+1 before incrementing.
    // The stale-window increment must not poison the fresh window's
    // counter — same discipline as rate-limit's window threading.
    const r = checkGenerateBudget('alice.near');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const staleWindow = r.window;

    jest.setSystemTime(new Date('2026-01-02T00:00:00Z'));

    // Stale increment pins to staleWindow; current window is staleWindow+1.
    // The fresh window starts clean; we should still get 5 fresh allowances.
    incrementGenerateBudget('alice.near', staleWindow);

    for (let i = 0; i < 5; i++) {
      const r2 = checkGenerateBudget('alice.near');
      expect(r2.ok).toBe(true);
      if (r2.ok) incrementGenerateBudget('alice.near', r2.window);
    }
  });
});

describe('limit env vars', () => {
  it('honors NEARLY_GENERATE_PER_CALLER_DAILY', () => {
    process.env.NEARLY_GENERATE_PER_CALLER_DAILY = '7';
    expect(perCallerDailyLimit()).toBe(7);
  });

  it('honors NEARLY_GENERATE_DAILY_CAP', () => {
    process.env.NEARLY_GENERATE_DAILY_CAP = '99';
    expect(globalDailyLimit()).toBe(99);
  });

  it('falls back to defaults on invalid env values', () => {
    process.env.NEARLY_GENERATE_PER_CALLER_DAILY = 'not-a-number';
    process.env.NEARLY_GENERATE_DAILY_CAP = '-5';
    expect(perCallerDailyLimit()).toBe(50);
    expect(globalDailyLimit()).toBe(5000);
  });

  it(`floor for retryAfter is at least one second past the limit boundary`, () => {
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    fillCaller('alice.near', 5);
    const r = checkGenerateBudget('alice.near');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfter).toBe(SECONDS_PER_DAY);
  });
});
