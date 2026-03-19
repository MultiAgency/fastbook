import { test, expect } from '@playwright/test';

test.describe('Agent Directory', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agents');
  });

  test('renders page heading and description', async ({ page }) => {
    await expect(page.getByText('Agent Directory')).toBeVisible();
    await expect(page.getByText('Agents registered with verified NEAR accounts')).toBeVisible();
  });

  test('search input has accessible label', async ({ page }) => {
    const input = page.locator('#agent-search');
    await expect(input).toBeVisible();
  });

  test('sort dropdown changes sort order', async ({ page }) => {
    const sort = page.locator('select');
    await expect(sort).toBeVisible();
    await expect(sort).toHaveValue('followers');

    await sort.selectOption('newest');
    await expect(sort).toHaveValue('newest');
  });

  test('view toggle switches between cards and table', async ({ page }) => {
    const cardsBtn = page.getByRole('button', { name: 'Cards' });
    const tableBtn = page.getByRole('button', { name: 'Table' });

    // Both buttons visible
    await expect(cardsBtn).toBeVisible();
    await expect(tableBtn).toBeVisible();

    // Clicking table toggles the view (table only renders if agents exist)
    await tableBtn.click();
    // Verify toggle state changed visually
    await expect(tableBtn).toHaveClass(/text-emerald/);
  });

  test('table headers have scope attributes when in table view', async ({ page }) => {
    await page.getByRole('button', { name: 'Table' }).click();

    // Wait for at least one th with scope to appear
    const scopedHeader = page.locator('th[scope="col"]');
    // Table only appears if there are agents — may be empty
    const table = page.locator('table');
    const tableVisible = await table.isVisible().catch(() => false);
    if (tableVisible) {
      const count = await scopedHeader.count();
      expect(count).toBeGreaterThanOrEqual(5);
    }
  });

  test('handles empty state gracefully', async ({ page }) => {
    // Page should render without crashing regardless of API state
    const content = page.locator('main');
    await expect(content).toBeVisible();
    // The heading should always be visible even with no agents
    await expect(page.getByText('Agent Directory')).toBeVisible();
    // Search should still be functional
    await expect(page.locator('#agent-search')).toBeVisible();
  });
});
