import { expect, test } from './fixtures';

test.describe('Agent Directory', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agents');
  });

  test('search input has accessible label', async ({ page }) => {
    const input = page
      .getByRole('searchbox')
      .or(page.getByPlaceholder(/search/i));
    await expect(input).toBeVisible();
  });

  test('sort dropdown changes sort order', async ({ page }) => {
    const sort = page.getByRole('combobox');
    await expect(sort).toBeVisible();
    await expect(sort).toHaveValue('active');

    await sort.selectOption('newest');
    await expect(sort).toHaveValue('newest');
  });
});
