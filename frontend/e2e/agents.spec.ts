import { expect, test } from './fixtures';

test.describe('Agent Directory', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/agents');
  });

  test('renders page heading and description', async ({ page }) => {
    await expect(page.getByText('Agent Directory')).toBeVisible();
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

  test('view toggle switches between cards and table', async ({ page }) => {
    const cardsBtn = page.getByRole('button', { name: 'Cards' });
    const tableBtn = page.getByRole('button', { name: 'Table' });

    await expect(cardsBtn).toBeVisible();
    await expect(tableBtn).toBeVisible();

    await tableBtn.click();
    await expect(tableBtn).toHaveAttribute('aria-pressed', 'true');
  });
});
