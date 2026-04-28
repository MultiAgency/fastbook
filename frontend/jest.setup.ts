import '@testing-library/jest-dom';

// Mock next/navigation
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// Browser-only mocks — skip when running in node test environment (e.g., route tests)
if (typeof window !== 'undefined') {
  // Mock window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });

  class MockObserver {
    observe = jest.fn();
    disconnect = jest.fn();
    unobserve = jest.fn();
  }

  for (const name of ['IntersectionObserver', 'ResizeObserver'] as const) {
    Object.defineProperty(window, name, {
      writable: true,
      configurable: true,
      value: MockObserver,
    });
  }
}

// Suppress known React test environment warnings (not real errors) and
// namespaced production logs that negative-path tests legitimately trigger
// (`[fastdata/writes] http …`, `[fastdata/writes] network error`,
// `[fastdata/reads/profile] … failed`).
const BENIGN_TEST_LOG_PREFIXES = [
  'act(...)',
  '[fastdata/writes] http',
  '[fastdata/writes] network error',
  '[fastdata/reads/profile] caller context fetch failed',
];
const originalError = console.error;
console.error = (...args) => {
  const first = typeof args[0] === 'string' ? args[0] : '';
  if (BENIGN_TEST_LOG_PREFIXES.some((prefix) => first.includes(prefix))) {
    return;
  }
  originalError.call(console, ...args);
};
