import { expect, test } from '@playwright/test';

test.describe('Homepage', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('renders hero heading', async ({ page }) => {
    await expect(page.locator('h1')).toBeVisible();
  });

  test('hero has human/agent toggle', async ({ page }) => {
    const toggle = page.getByRole('group', { name: 'Select your role' });
    await expect(toggle).toBeVisible();

    const humanBtn = page.getByRole('button', { name: "I'm a Human" });
    const agentBtn = page.getByRole('button', { name: "I'm an Agent" });

    await expect(humanBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(agentBtn).toHaveAttribute('aria-pressed', 'false');

    // Human mode shows Explore Agents
    await expect(
      page.getByRole('link', { name: 'Explore Agents' }),
    ).toBeVisible();

    // Switch to agent mode
    await agentBtn.click();
    await expect(agentBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('curl')).toBeVisible();
  });

  test('hero shows skill file URL with copy button', async ({ page }) => {
    await expect(page.getByText('skill.md')).toBeVisible();
    const copyBtn = page.getByRole('button', {
      name: 'Copy skill file instructions',
    });
    await expect(copyBtn).toBeVisible();
  });

  test('static section headings exist', async ({ page }) => {
    await expect(page.locator('h2', { hasText: 'How it works' })).toBeVisible();
    await expect(page.locator('h2', { hasText: 'Social proof' })).toBeVisible();
    await expect(
      page.locator('h2', { hasText: 'Explore the network' }),
    ).toBeVisible();
  });

  test('skip link is accessible', async ({ page }) => {
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
  });

  test('footer renders with correct links', async ({ page }) => {
    const footer = page.locator('footer');
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

  test('Explore Agents links to agent directory', async ({ page }) => {
    await page.goto('/');
    const exploreAgents = page
      .getByRole('link', { name: 'Explore Agents' })
      .first();
    await expect(exploreAgents).toHaveAttribute('href', '/agents');
  });

  test('join page is accessible', async ({ page }) => {
    await page.goto('/join');
    await expect(page.getByText('Create Your Agent')).toBeVisible();
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

    await page.getByRole('button', { name: 'Toggle navigation menu' }).click();
    await page
      .getByRole('navigation', { name: 'Mobile navigation' })
      .getByRole('link', { name: 'Agents' })
      .click();

    await expect(page).toHaveURL('/agents');
  });
});

test.describe('Mobile Responsiveness', () => {
  test('homepage renders on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    await expect(page.locator('h1')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Toggle navigation menu' }),
    ).toBeVisible();
  });

  test('join page renders on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/join');

    await expect(page.getByText('Create Your Agent')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Create Wallet/ }),
    ).toBeVisible();
  });

  test('agents page renders on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/agents');

    await expect(page.getByText('Agent Directory')).toBeVisible();
  });
});
