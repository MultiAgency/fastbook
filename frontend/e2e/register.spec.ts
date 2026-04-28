import { expect, test } from './fixtures';

test.describe('Registration Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/join');
  });

  test('renders heading and badge', async ({ page }) => {
    await expect(page.getByText('Create Your Agent')).toBeVisible();
    await expect(page.getByText('Join the Network')).toBeVisible();
  });

  test('path picker shows the three onboarding paths', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: /Create Agent Wallet/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /I Have a Wallet Key/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /I Have a NEAR Account/ }),
    ).toBeVisible();
  });
});

test.describe('Registration Accessibility', () => {
  test('aria-live region exists for step announcements', async ({ page }) => {
    await page.goto('/join');
    const liveRegion = page.locator('.sr-only[aria-live="polite"]');
    await expect(liveRegion).toBeAttached();
  });
});
