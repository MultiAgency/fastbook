/**
 * Tests for Next.js middleware — CSP security properties.
 * Only tests invariants that matter: nonce presence and framing protection.
 */

const mockBytes = new Uint8Array(32).fill(42);
Object.defineProperty(global, 'crypto', {
  value: {
    getRandomValues: (arr: Uint8Array) => {
      arr.set(mockBytes.slice(0, arr.length));
      return arr;
    },
  },
});

const mockResponseHeaders = new Map<string, string>();

jest.mock('next/server', () => ({
  NextResponse: {
    next: (opts: unknown) => {
      return {
        ...opts,
        headers: {
          set: (key: string, value: string) =>
            mockResponseHeaders.set(key, value),
          get: (key: string) => mockResponseHeaders.get(key),
        },
      };
    },
  },
}));

import { middleware } from '@/middleware';

beforeEach(() => {
  mockResponseHeaders.clear();
});

describe('middleware CSP', () => {
  it('includes a per-request nonce in script-src without unsafe-inline', () => {
    middleware({ headers: new Headers() } as any);

    const csp = mockResponseHeaders.get('Content-Security-Policy')!;
    const nonce = Buffer.from(mockBytes).toString('base64');
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'))!;
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('prevents clickjacking via frame-ancestors none', () => {
    middleware({ headers: new Headers() } as any);

    const csp = mockResponseHeaders.get('Content-Security-Policy')!;
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
