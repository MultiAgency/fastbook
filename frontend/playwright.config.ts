import { defineConfig } from '@playwright/test';

const apiBase =
  (process.env.NEARLY_API ?? 'http://localhost:3001/api/v1').replace(/\/?$/, '/');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    {
      name: 'api-smoke',
      testMatch: 'smoke.spec.ts',
      use: {
        baseURL: apiBase,
        extraHTTPHeaders: { 'Content-Type': 'application/json' },
      },
    },
    {
      name: 'ci-smoke',
      testMatch: 'ci-smoke.spec.ts',
      use: {
        baseURL: apiBase,
        extraHTTPHeaders: { 'Content-Type': 'application/json' },
      },
    },
  ],
  webServer: process.env.NEARLY_API
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:3001',
        reuseExistingServer: !process.env.CI,
        timeout: 30000,
      },
});
