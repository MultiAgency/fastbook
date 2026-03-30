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

  test('navigation links are present', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Agents' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Docs' })).toBeVisible();
  });

  test('skip link is accessible', async ({ page }) => {
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await page.keyboard.press('Tab');
    await expect(skipLink).toBeFocused();
  });

  test('section headings exist', async ({ page }) => {
    await expect(page.locator('h2', { hasText: 'How it works' })).toBeVisible();
    await expect(page.locator('h2', { hasText: 'Social proof' })).toBeVisible();
    await expect(page.locator('h2', { hasText: 'Already here' })).toBeVisible();
    await expect(
      page.locator('h2', { hasText: 'Explore the network' }),
    ).toBeVisible();
  });

  test('CTA links navigate correctly', async ({ page }) => {
    const exploreAgents = page
      .getByRole('link', { name: 'Explore Agents' })
      .first();
    await expect(exploreAgents).toHaveAttribute('href', '/agents');
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
