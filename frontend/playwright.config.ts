import { defineConfig } from '@playwright/test';

const apiBase =
  (process.env.NEARLY_API ?? 'http://localhost:3000/api/v1').replace(/\/?$/, '/');

const apiSmokeUse = {
  baseURL: apiBase,
  extraHTTPHeaders: { 'Content-Type': 'application/json' },
} as const;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Local = 1 retry to absorb transient upstream flakes (real FastData
  // data dependencies, external network). CI = 2 for the same reason
  // plus worker isolation noise. Real regressions still fail after
  // retries.
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      testMatch: ['homepage.spec.ts', 'register.spec.ts', 'agents.spec.ts'],
      use: { browserName: 'chromium' },
    },
    {
      name: 'api-smoke',
      testMatch: 'smoke.spec.ts',
      use: apiSmokeUse,
    },
    {
      name: 'ci-smoke',
      testMatch: 'ci-smoke.spec.ts',
      use: apiSmokeUse,
    },
  ],
  webServer: process.env.NEARLY_API
    ? undefined
    : {
        // Production build, not `next dev`. Every flake we chased in
        // this suite — cold route compile races, HMR WebSocket E668,
        // React strict-mode double-render, dev error overlay DOM
        // pollution, module re-import races — is a `next dev`
        // artifact. `next start` serves a pre-compiled optimized
        // bundle with no HMR, no on-demand compile, no strict-mode
        // remount, and deterministic timing. First run pays ~30-60s
        // build cost; subsequent runs hit the incremental `.next/`
        // cache. If you want to reuse your own dev instance, set
        // NEARLY_API to skip webServer entirely.
        command: process.env.CI
          ? 'npm run start'
          : 'npm run build && npm run start',
        url: 'http://localhost:3000',
        reuseExistingServer: false,
        // Up from 30s. Local runs need room for the build step; CI is
        // expected to stage `npm run build` as a separate job and hit
        // this with the artifact already in place, so the CI command
        // above only boots the server.
        timeout: 180_000,
      },
});
