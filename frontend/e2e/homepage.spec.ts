import { expect, test } from './fixtures';

test.describe('Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  // Historical note: a test here previously watched for the dev-mode
  // "Router action dispatched before initialization" (E668) error that
  // fired intermittently from Next.js 16's HMR client. That error is a
  // `next dev` artifact — it cannot occur under `next start` because
  // there is no HMR infrastructure in production. Switching the
  // webServer to `npm run build && npm run start` (see
  // playwright.config.ts) removed the entire class. No canary needed.

  test('static section headings exist', async ({ page }) => {
    await expect(page.locator('h2', { hasText: 'How it works' })).toBeVisible();
    await expect(page.locator('h2', { hasText: 'Social proof' })).toBeVisible();
    await expect(
      page.locator('h2', { hasText: 'Explore the network' }),
    ).toBeVisible();
  });

  test('skip link is accessible', async ({ page }) => {
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await page.waitForLoadState('networkidle');
    await page.locator('body').focus();
    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
  });

  test('footer renders with correct links', async ({ page }) => {
    // Use the ARIA `contentinfo` role instead of the raw `footer` tag.
    // Next's dev error overlay also renders a <footer> element when an
    // unhandled error fires, which causes `locator('footer')` to hit a
    // strict-mode violation. The real MarketingFooter has the implicit
    // `contentinfo` role; the overlay's footer lives inside a dialog
    // and does not.
    const footer = page.getByRole('contentinfo');
    await expect(footer).toBeVisible();
    await expect(
      footer.getByRole('link', { name: 'Documentation' }),
    ).toBeVisible();
    await expect(
      footer.getByRole('link', { name: 'API Reference' }),
    ).toBeVisible();
  });
});

test.describe('Navigation', () => {
  test('nav links navigate to correct pages', async ({ page }) => {
    await page.goto('/');

    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Agents' })
      .click();
    await expect(page).toHaveURL('/agents', { timeout: 10_000 });
  });

  test('mobile menu opens and closes', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const menuBtn = page.getByRole('button', {
      name: 'Toggle navigation menu',
    });
    await expect(menuBtn).toBeVisible();
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');

    // Open
    await menuBtn.click();
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'true');

    const mobileNav = page.getByRole('navigation', {
      name: 'Mobile navigation',
    });
    await expect(mobileNav).toBeVisible();

    // Close with Escape
    await page.keyboard.press('Escape');
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
  });

  test('mobile menu links navigate and close menu', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const menuBtn = page.getByRole('button', {
      name: 'Toggle navigation menu',
    });
    await menuBtn.click();
    await page
      .getByRole('navigation', { name: 'Mobile navigation' })
      .getByRole('link', { name: 'Agents' })
      .click();

    await expect(page).toHaveURL('/agents');
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
  });
});
