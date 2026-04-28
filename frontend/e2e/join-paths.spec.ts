import { expect, test } from './fixtures';

// Throwaway ed25519 keypair for the External-NEAR path. Generated once
// (tweetnacl + bs58, SDK workspace) and frozen — the SDK's
// parseEd25519SecretKey validates format + length before any network call,
// so the key must be syntactically valid. No real signing value: all
// OutLayer endpoints are mocked in this suite.
const TEST_NEAR_PRIVATE_KEY =
  'ed25519:5Gh3VUAUxs7GMMSAxtVSidoSGzpsCZ4iVvWYFGNjMYvgTo5aL2JTYR9Cp2AVNLP1t2p3xchEbLdfpj8ZabkYnNB4';

const OUTLAYER_REGISTER_RESPONSE = {
  api_key: 'wk_smoketest_new_wallet_key_do_not_use',
  near_account_id:
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  trial: { calls_remaining: 100 },
};

const BALANCE_RESPONSE = {
  account_id: 'byo-test.near',
  balance: '5000000000000000000000000', // 5 NEAR in yoctoNEAR — well above threshold
};

const DETERMINISTIC_REGISTER_RESPONSE = {
  wallet_id: 'wallet_id_deterministic_test',
  near_account_id:
    'deadbeefcafe0123456789abcdef0123456789abcdef0123456789abcdef0000',
  trial: { calls_remaining: 50 },
};

const MINT_API_KEY_RESPONSE = {
  wallet_id: 'wallet_id_deterministic_test',
  near_account_id:
    'deadbeefcafe0123456789abcdef0123456789abcdef0123456789abcdef0000',
};

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
};

const STEP_TIMEOUT = 15_000;

test.describe('/join — path 1: new wallet', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/outlayer/register', (route) =>
      route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(OUTLAYER_REGISTER_RESPONSE),
      }),
    );
    await page.route('**/api/outlayer/wallet/v1/balance**', (route) =>
      route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          ...BALANCE_RESPONSE,
          account_id: OUTLAYER_REGISTER_RESPONSE.near_account_id,
        }),
      }),
    );
    await page.goto('/join');
  });

  test('Create Wallet → account + wk_ surface + Fund step appears', async ({
    page,
  }) => {
    await page.getByRole('button', { name: /Create Agent Wallet/ }).click();

    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await expect(
      page.getByText(OUTLAYER_REGISTER_RESPONSE.near_account_id),
    ).toBeVisible();
    // MaskedCopyField renders a bare <label> (no htmlFor) so getByText,
    // not getByLabel. The label "Wallet Key" is unique on the new-wallet
    // surface — the BYO input uses the same text but lives on a different
    // path.
    await expect(page.getByText('Wallet Key', { exact: true })).toBeVisible();
    await expect(page.getByText('Fund Your Wallet')).toBeVisible();
  });
});

test.describe('/join — path 2: BYO wk_', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/outlayer/wallet/v1/balance**', (route) =>
      route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(BALANCE_RESPONSE),
      }),
    );
    await page.goto('/join');
  });

  test('paste wk_ → Verify → shows verified account', async ({ page }) => {
    await page.getByRole('button', { name: /I Have a Wallet Key/ }).click();

    const keyInput = page.getByLabel('Wallet Key');
    await keyInput.fill('wk_byo_smoketest_key_0123456789');
    await page.getByRole('button', { name: /Verify Wallet/ }).click();

    await expect(page.getByText('Verified Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await expect(page.getByText(BALANCE_RESPONSE.account_id)).toBeVisible();
  });

  test('malformed key (no wk_ prefix) rejected client-side, no network call', async ({
    page,
  }) => {
    let balanceHit = false;
    await page.route('**/api/outlayer/wallet/v1/balance**', (route) => {
      balanceHit = true;
      return route.continue();
    });

    await page.getByRole('button', { name: /I Have a Wallet Key/ }).click();
    await page.getByLabel('Wallet Key').fill('not-a-wk-key');
    await page.getByRole('button', { name: /Verify Wallet/ }).click();

    await expect(page.getByText(/Key must start with wk_/)).toBeVisible();
    expect(balanceHit).toBe(false);
  });
});

test.describe('/join — path 3: External NEAR (deterministic)', () => {
  test.beforeEach(async ({ page }) => {
    // The SDK's createDeterministicWallet + mintDelegateKey fetch the
    // OutLayer base URL directly (NEXT_PUBLIC_OUTLAYER_API_URL or default
    // https://api.outlayer.fastnear.com), not via the Nearly proxy.
    // Intercept both the default and any localhost override to stay robust.
    const registerPattern = /\/register(\?.*)?$/;
    const mintPattern = /\/wallet\/v1\/api-key(\?.*)?$/;

    await page.route(registerPattern, (route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: JSON_HEADERS, body: '' });
      }
      return route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(DETERMINISTIC_REGISTER_RESPONSE),
      });
    });

    await page.route(mintPattern, (route) => {
      if (route.request().method() === 'OPTIONS') {
        return route.fulfill({ status: 204, headers: JSON_HEADERS, body: '' });
      }
      return route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(MINT_API_KEY_RESPONSE),
      });
    });

    await page.goto('/join');
    await page.getByRole('button', { name: /I Have a NEAR Account/ }).click();
  });

  test('3a: mint-key checked (default) → Delegate Wallet Key surfaces + fund link', async ({
    page,
  }) => {
    await page.getByLabel('NEAR Account ID').fill('alice.near');
    await page.getByLabel('Seed').fill('smoketest-seed-3a');
    await page.getByLabel('NEAR Private Key').fill(TEST_NEAR_PRIVATE_KEY);

    // Default: mint-key checkbox is checked, button reads "Provision + Activate Wallet"
    await page
      .getByRole('button', { name: /Provision \+ Activate Wallet/ })
      .click();

    await expect(page.getByText('Derived NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await expect(
      page.getByText(DETERMINISTIC_REGISTER_RESPONSE.near_account_id),
    ).toBeVisible();
    await expect(
      page.getByText('Delegate Wallet Key', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Active for this session/)).toBeVisible();
    await expect(page.getByText(/Fund with .* NEAR/)).toBeVisible();

    // The "No wk_ was issued" banner must NOT be shown on the mint path
    await expect(page.getByText(/No.*wk_.*was issued/)).not.toBeVisible();
  });

  test('3b: mint-key unchecked → provisioning-only yellow banner, no Delegate Wallet Key', async ({
    page,
  }) => {
    await page.getByLabel('NEAR Account ID').fill('alice.near');
    await page.getByLabel('Seed').fill('smoketest-seed-3b');
    await page.getByLabel('NEAR Private Key').fill(TEST_NEAR_PRIVATE_KEY);
    await page.getByRole('checkbox').uncheck();

    await page
      .getByRole('button', { name: /Provision Derived Wallet/ })
      .click();

    await expect(page.getByText('Derived NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
    await expect(
      page.getByText(DETERMINISTIC_REGISTER_RESPONSE.near_account_id),
    ).toBeVisible();
    await expect(page.getByText(/Provisioning only/)).toBeVisible();
    await expect(page.getByText(/Fund with .* NEAR/)).toBeVisible();

    // Delegate Wallet Key field must NOT appear on the opt-out path
    await expect(
      page.getByText('Delegate Wallet Key', { exact: true }),
    ).not.toBeVisible();
  });

  test('malformed private key rejected client-side, no OutLayer call', async ({
    page,
  }) => {
    let registerHit = false;
    await page.route(/\/register(\?.*)?$/, (route) => {
      if (route.request().method() !== 'OPTIONS') registerHit = true;
      return route.continue();
    });

    await page.getByLabel('NEAR Account ID').fill('alice.near');
    await page.getByLabel('Seed').fill('bad-key-seed');
    await page.getByLabel('NEAR Private Key').fill('not-ed25519-format');
    await page
      .getByRole('button', { name: /Provision \+ Activate Wallet/ })
      .click();

    await expect(
      page.getByText(/Private key must start with "ed25519:"/),
    ).toBeVisible();
    expect(registerHit).toBe(false);
  });
});

test.describe('/join — storage hygiene (cross-path)', () => {
  // The ExternalNearPath.test.tsx unit coverage already pins that no key
  // material lands in localStorage/sessionStorage. This end-to-end sweep
  // runs each mutating path and confirms the same invariant holds against
  // the live browser runtime, not the jsdom approximation.
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/outlayer/register', (route) =>
      route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(OUTLAYER_REGISTER_RESPONSE),
      }),
    );
    await page.route('**/api/outlayer/wallet/v1/balance**', (route) =>
      route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(BALANCE_RESPONSE),
      }),
    );
    await page.route(/\/register(\?.*)?$/, (route) => {
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers: JSON_HEADERS, body: '' });
      return route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(DETERMINISTIC_REGISTER_RESPONSE),
      });
    });
    await page.route(/\/wallet\/v1\/api-key(\?.*)?$/, (route) => {
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers: JSON_HEADERS, body: '' });
      return route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(MINT_API_KEY_RESPONSE),
      });
    });
  });

  test('no wk_ or ed25519 key material in localStorage/sessionStorage after all three paths', async ({
    page,
  }) => {
    // Path 1
    await page.goto('/join');
    await page.getByRole('button', { name: /Create Agent Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    // Path 2
    await page.goto('/join');
    await page.getByRole('button', { name: /I Have a Wallet Key/ }).click();
    await page.getByLabel('Wallet Key').fill('wk_byo_smoketest_key_0123456789');
    await page.getByRole('button', { name: /Verify Wallet/ }).click();
    await expect(page.getByText('Verified Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    // Path 3 (mint-key default)
    await page.goto('/join');
    await page.getByRole('button', { name: /I Have a NEAR Account/ }).click();
    await page.getByLabel('NEAR Account ID').fill('alice.near');
    await page.getByLabel('Seed').fill('storage-sweep-seed');
    await page.getByLabel('NEAR Private Key').fill(TEST_NEAR_PRIVATE_KEY);
    await page
      .getByRole('button', { name: /Provision \+ Activate Wallet/ })
      .click();
    await expect(page.getByText('Derived NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    const dump = await page.evaluate(() => {
      const collect = (store: Storage) => {
        const out: Record<string, string | null> = {};
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k) out[k] = store.getItem(k);
        }
        return out;
      };
      return { local: collect(localStorage), session: collect(sessionStorage) };
    });

    const serialized = JSON.stringify(dump);
    expect(serialized).not.toMatch(/wk_[A-Za-z0-9_]+/);
    expect(serialized).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{30,}/);
  });
});
