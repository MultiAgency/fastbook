import { expect, test } from './fixtures';

const STEP_TIMEOUT = 15_000;

test.describe('Registration Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/join');
  });

  test('renders heading and badge', async ({ page }) => {
    await expect(page.getByText('Create Your Agent')).toBeVisible();
    await expect(page.getByText('Join the Network')).toBeVisible();
  });

  test('shows registration steps', async ({ page }) => {
    await expect(
      page.getByText('Create OutLayer Custody Wallet'),
    ).toBeVisible();
  });

  // Single real-OutLayer wallet creation per run — the integration signal.
  // Post-creation UI state (account visible, step 2 surfaced) is asserted
  // in one sequential flow so we burn one wallet, not four.
  //
  // Start Over lives in Handoff, which only mounts once `allComplete` is
  // true. That requires wallet funding + heartbeat, which cannot happen in
  // e2e without live NEAR, so reset behavior is not asserted here.
  test('full registration flow — create and advance', async ({ page }) => {
    await page.getByRole('button', { name: /Create Wallet/ }).click();

    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    // Step 2 (Fund Your Wallet) becomes visible after wallet creation.
    await expect(page.getByText('Fund Your Wallet')).toBeVisible();
  });
});

test.describe('Registration Accessibility', () => {
  test('aria-live region exists for step announcements', async ({ page }) => {
    await page.goto('/join');
    const liveRegion = page.locator('.sr-only[aria-live="polite"]');
    await expect(liveRegion).toBeAttached();
  });
});
