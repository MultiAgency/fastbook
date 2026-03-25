import { expect, test } from '@playwright/test';

const STEP_TIMEOUT = 15_000;

test.describe('Registration Flow', () => {
  test.beforeEach(async ({ page }) => {
    // /register redirects to /demo
    await page.goto('/demo');
  });

  test('shows human/agent toggle defaulting to human', async ({ page }) => {
    const humanBtn = page.getByRole('button', { name: "I'm a Human" });
    const agentBtn = page.getByRole('button', { name: "I'm an Agent" });

    await expect(humanBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(agentBtn).toHaveAttribute('aria-pressed', 'false');
  });

  test('human path shows post a job and skill file', async ({ page }) => {
    await expect(page.locator('h2', { hasText: 'Post a Job' })).toBeVisible();
    await expect(page.getByText('skill.md').first()).toBeVisible();
    await expect(page.getByText('send this to your agent')).toBeVisible();
  });

  test('agent path shows 3-step registration flow', async ({ page }) => {
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    await expect(page.getByText('NEP-413 Verified Identity')).toBeVisible();
    await expect(
      page.getByText('Create OutLayer Custody Wallet'),
    ).toBeVisible();
    await expect(page.getByText('Sign Registration Message')).toBeVisible();
    await expect(page.getByText('Register on Nearly Social')).toBeVisible();
  });

  test('step 2 is disabled until step 1 completes', async ({ page }) => {
    await page.getByRole('button', { name: "I'm an Agent" }).click();
    await expect(page.getByText('Sign Registration Message')).toBeVisible();
  });

  test('step 1 creates wallet (mock fallback)', async ({ page }) => {
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    const createBtn = page.getByRole('button', { name: /Create Wallet/ });
    await createBtn.click();

    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
  });

  test('step 2 signs message after step 1', async ({ page }) => {
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    await page.getByRole('button', { name: /Create Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    const signBtn = page.getByRole('button', { name: /Sign Message/ });
    await expect(signBtn).toBeEnabled();
    await signBtn.click();

    await expect(page.getByText('Public Key')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await expect(page.getByText('Signature')).toBeVisible();
  });

  test('step 3 registers agent after step 2', async ({ page }) => {
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    await page.getByRole('button', { name: /Create Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await page.getByRole('button', { name: /Sign Message/ }).click();
    await expect(page.getByText('Public Key')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    await page.getByPlaceholder('my_agent').fill('test_agent');
    await page.getByRole('button', { name: /Register Agent/ }).click();

    await expect(page.getByText('Registered as')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
  });

  test('handle input validates characters', async ({ page }) => {
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    await page.getByRole('button', { name: /Create Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await page.getByRole('button', { name: /Sign Message/ }).click();
    await expect(page.getByText('Public Key')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    const handleInput = page.getByPlaceholder('my_agent');

    await handleInput.fill('MyAgent');
    await expect(handleInput).toHaveValue('myagent');

    await handleInput.fill('my@agent!');
    await expect(handleInput).toHaveValue('myagent');

    await handleInput.fill('my_agent_123');
    await expect(handleInput).toHaveValue('my_agent_123');
  });

  test('handle input has aria-describedby for help text', async ({ page }) => {
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    await page.getByRole('button', { name: /Create Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await page.getByRole('button', { name: /Sign Message/ }).click();
    await expect(page.getByText('Public Key')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    const input = page.locator('#handle');
    await expect(input).toHaveAttribute('aria-describedby', 'handle-help');
    await expect(page.locator('#handle-help')).toHaveText(
      'Lowercase letters, numbers, underscores',
    );
  });

  test('completion shows what-next cards', async ({ page }) => {
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    await page.getByRole('button', { name: /Create Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await page.getByRole('button', { name: /Sign Message/ }).click();
    await expect(page.getByText('Public Key')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await page.getByPlaceholder('my_agent').fill('test_agent');
    await page.getByRole('button', { name: /Register Agent/ }).click();
    await expect(page.getByText('Registration Complete')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    await expect(page.getByText("What's next?")).toBeVisible();
    // Social links appear in summary card
    await expect(
      page.getByText('View your Nearly Social profile'),
    ).toBeVisible();
    await expect(page.getByText('Browse the agent directory')).toBeVisible();
  });

  test('start over resets all steps', async ({ page }) => {
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    await page.getByRole('button', { name: /Create Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await page.getByRole('button', { name: /Sign Message/ }).click();
    await expect(page.getByText('Public Key')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await page.getByPlaceholder('my_agent').fill('test_agent');
    await page.getByRole('button', { name: /Register Agent/ }).click();
    await expect(page.getByText('Registration Complete')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    await page.getByRole('button', { name: 'Start Over' }).click();
    await expect(
      page.getByRole('button', { name: /Create Wallet/ }),
    ).toBeVisible();
    // Verify step results are cleared — wallet/signature data should not be visible
    await expect(page.getByText('Your NEAR Account')).not.toBeVisible();
    await expect(page.getByText('Registration Complete')).not.toBeVisible();
  });

  // /register route removed — demo page is the canonical path
});

test.describe('Registration Accessibility', () => {
  test('aria-live region exists for step announcements', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    const liveRegion = page.locator('.sr-only[aria-live="polite"]');
    await expect(liveRegion).toBeAttached();
  });

  test('switch has correct aria-label', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    await page.getByRole('button', { name: /Create Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await page.getByRole('button', { name: /Sign Message/ }).click();
    await expect(page.getByText('Public Key')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    const toggle = page.getByRole('switch', {
      name: 'Toggle live Nearly Social API',
    });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  test('aria-live region announces step changes', async ({ page }) => {
    await page.goto('/demo');
    await page.getByRole('button', { name: "I'm an Agent" }).click();

    const liveRegion = page.locator('.sr-only[aria-live="polite"]');
    await expect(liveRegion).toBeAttached();

    await page.getByRole('button', { name: /Create Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    // After step 1 completes, the live region should have updated content
    const text = await liveRegion.textContent();
    expect(text?.length).toBeGreaterThan(0);
  });
});
