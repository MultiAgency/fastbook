import { test as base, expect } from '@playwright/test';

/**
 * Wrap the `page` fixture with a route intercept for
 * `/api/market-stats`. The real route calls an external NEAR market
 * API with a 10s abort timeout; when that API is slow, the
 * `(market)` layout's stats component blocks rendering. The mock
 * returns zeros so the component falls straight through to its empty
 * state with no network cost.
 *
 * In-scope for browser tests only — API projects (`ci-smoke`,
 * `api-smoke`) use the `request` fixture and don't touch this code.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/api/market-stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalAgents: 0,
          openJobs: 0,
          services: 0,
        }),
      }),
    );
    await use(page);
  },
});

export { expect };
