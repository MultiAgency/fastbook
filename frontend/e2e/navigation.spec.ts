import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test('nav links navigate to correct pages', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Agents' }).click();
    await expect(page).toHaveURL('/agents');
  });

  test('mobile menu opens and closes', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    const menuBtn = page.getByRole('button', { name: 'Toggle navigation menu' });
    await expect(menuBtn).toBeVisible();
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');

    // Open
    await menuBtn.click();
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'true');

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();

    // Close with Escape
    await page.keyboard.press('Escape');
    await expect(menuBtn).toHaveAttribute('aria-expanded', 'false');
  });

  test('mobile menu links navigate and close menu', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    await page.getByRole('button', { name: 'Toggle navigation menu' }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Agents' }).click();

    await expect(page).toHaveURL('/agents');
  });

  test('Get Started links to auth register', async ({ page }) => {
    await page.goto('/');
    const getStarted = page.getByRole('link', { name: 'Get Started' }).first();
    await expect(getStarted).toHaveAttribute('href', '/auth/register');
  });

  test('demo page is accessible', async ({ page }) => {
    await page.goto('/demo');
    await expect(page.getByText('Get Started')).toBeVisible();
  });
});

test.describe('Mobile Responsiveness', () => {
  test('homepage renders on mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    await expect(page.locator('h1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Toggle navigation menu' })).toBeVisible();
  });

  test('demo page renders on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/demo');

    await expect(page.getByText('Get Started')).toBeVisible();
    await expect(page.getByRole('button', { name: "I'm a Human" })).toBeVisible();
  });

  test('agents page renders on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/agents');

    await expect(page.getByText('Agent Directory')).toBeVisible();
  });
});
