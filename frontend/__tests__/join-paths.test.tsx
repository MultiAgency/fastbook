import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import JoinPage from '@/app/join/page';
import * as outlayer from '@/lib/outlayer';
import { useAgentStore } from '@/store/agentStore';

// Module-level mocks shared across all three path describe blocks. The
// per-path beforeEach below scopes mock resets to the path that owns
// the mock — BYO owns verifyWallet/getBalance, External owns
// createDeterministicWallet/mintDelegateKey/setApiKey, NewWallet owns
// getBalance — so paths don't reset each other's mocks mid-suite.

// Keep `actual` so InsufficientBalanceError stays the real class —
// ByoPath's `err instanceof InsufficientBalanceError` check needs the
// same constructor identity.
jest.mock('@/lib/outlayer', () => {
  const actual = jest.requireActual('@/lib/outlayer');
  return {
    ...actual,
    verifyWallet: jest.fn(),
    getBalance: jest.fn(),
    registerOutlayer: jest.fn(),
  };
});

jest.mock('@/lib/api', () => ({
  api: { setApiKey: jest.fn(), heartbeat: jest.fn() },
  ApiError: class extends Error {
    retryAfter?: number;
  },
}));

// Handoff transitively imports next/server via platforms; trim the chain.
jest.mock('@/lib/platforms', () => ({
  PLATFORM_META: [],
}));

jest.mock('@/hooks', () => ({
  useCopyToClipboard: () => [false, jest.fn()],
  useHiddenSet: () => ({ hiddenSet: new Set(), isLoading: false }),
  useDebounce: <T,>(v: T) => v,
}));

// External path mocks the SDK's deterministic-wallet + delegate-key
// helpers. The other two paths don't reference these names, so the
// module-level mock is inert in their tests.
jest.mock('@nearly/sdk', () => {
  const actual = jest.requireActual('@nearly/sdk');
  return {
    ...actual,
    createDeterministicWallet: jest.fn(),
    mintDelegateKey: jest.fn(),
  };
});

import { createDeterministicWallet, mintDelegateKey } from '@nearly/sdk';
import { api } from '@/lib/api';

const mockVerifyWallet = outlayer.verifyWallet as jest.MockedFunction<
  typeof outlayer.verifyWallet
>;
const mockGetBalance = outlayer.getBalance as jest.MockedFunction<
  typeof outlayer.getBalance
>;
const mockCreate = createDeterministicWallet as jest.MockedFunction<
  typeof createDeterministicWallet
>;
const mockMint = mintDelegateKey as jest.MockedFunction<typeof mintDelegateKey>;
const mockSetApiKey = api.setApiKey as jest.MockedFunction<
  typeof api.setApiKey
>;

// Funding threshold is Number(FUND_AMOUNT_NEAR) * 1e24 yoctoNEAR.
// Using string arithmetic since JS Number loses precision at 1e24.
const BELOW_THRESHOLD = '1';
const ABOVE_THRESHOLD = '99999999999999999999999999'; // 100 NEAR in yocto

// Safety net for any test that flips to fake timers — unconditional
// restore is a no-op when real timers are already active.
afterEach(() => {
  jest.useRealTimers();
});

// ---------------------------------------------------------------------
// BYO path — caller pastes an existing wk_ key and we verify + fund-check.
// ---------------------------------------------------------------------

describe('ByoPath', () => {
  beforeEach(() => {
    useAgentStore.getState().reset();
    useAgentStore.getState().choosePath('byo');
    mockVerifyWallet.mockReset();
    mockGetBalance.mockReset();
  });

  function typeKey(key: string) {
    const input = screen.getByLabelText(/wallet key/i);
    fireEvent.change(input, { target: { value: key } });
  }

  async function clickVerify() {
    const button = screen.getByRole('button', { name: /verify wallet/i });
    await act(async () => {
      fireEvent.click(button);
    });
  }

  describe('pre-verify', () => {
    it('shows the input with Verify button disabled on first render', () => {
      render(<JoinPage />);
      expect(screen.getByLabelText(/wallet key/i)).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /verify wallet/i }),
      ).toBeDisabled();
    });

    it('rejects a key without the wk_ prefix without calling verifyWallet', async () => {
      render(<JoinPage />);
      typeKey('not-a-wallet-key');
      await clickVerify();
      expect(mockVerifyWallet).not.toHaveBeenCalled();
      expect(screen.getByText(/key must start with wk_/i)).toBeInTheDocument();
    });

    it('on InsufficientBalanceError, renders the fund-wallet yellow card with OutLayer dashboard link', async () => {
      mockVerifyWallet.mockRejectedValue(
        new outlayer.InsufficientBalanceError(),
      );
      render(<JoinPage />);
      typeKey('wk_abc123');
      await clickVerify();
      await waitFor(() => {
        expect(
          screen.getByText(/doesn't have enough NEAR/i),
        ).toBeInTheDocument();
      });
      const link = screen.getByRole('link', {
        name: /open outlayer dashboard/i,
      });
      expect(link).toHaveAttribute(
        'href',
        'https://outlayer.fastnear.com/wallet/manage',
      );
    });

    it('on non-InsufficientBalance error, renders the generic error (not the fund card)', async () => {
      // "rate limit" matches friendlyError's rate-limit pattern — we get a
      // recognizable user-visible message rather than the "Something went
      // wrong" fallback, so the assertion is distinctive.
      mockVerifyWallet.mockRejectedValue(new Error('rate limit exceeded'));
      render(<JoinPage />);
      typeKey('wk_abc123');
      await clickVerify();
      await waitFor(() => {
        expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
      });
      expect(screen.queryByText(/doesn't have enough NEAR/i)).toBeNull();
      expect(
        screen.queryByRole('link', { name: /open outlayer dashboard/i }),
      ).toBeNull();
    });

    it('clears the fund-wallet card on retry', async () => {
      mockVerifyWallet
        .mockRejectedValueOnce(new outlayer.InsufficientBalanceError())
        .mockResolvedValueOnce({
          account_id: 'alice.near',
          balance: ABOVE_THRESHOLD,
        });
      render(<JoinPage />);
      typeKey('wk_abc123');
      await clickVerify();
      await waitFor(() => {
        expect(
          screen.getByText(/doesn't have enough NEAR/i),
        ).toBeInTheDocument();
      });
      await clickVerify();
      await waitFor(() => {
        expect(screen.queryByText(/doesn't have enough NEAR/i)).toBeNull();
      });
    });
  });

  describe('post-verify — sufficient balance', () => {
    it('renders PostFunding choice (not the low-balance card) when balance >= threshold', async () => {
      mockVerifyWallet.mockResolvedValue({
        account_id: 'alice.near',
        balance: ABOVE_THRESHOLD,
      });
      render(<JoinPage />);
      typeKey('wk_abc123');
      await clickVerify();
      await waitFor(() => {
        expect(screen.getByText(/verified account/i)).toBeInTheDocument();
      });
      // Post-funding idle panel shows Activate Now + Hand Off to My Agent.
      expect(
        screen.getByRole('button', { name: /activate now/i }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/balance is below/i)).toBeNull();
    });
  });

  describe('post-verify — low balance', () => {
    beforeEach(async () => {
      mockVerifyWallet.mockResolvedValue({
        account_id: 'alice.near',
        balance: BELOW_THRESHOLD,
      });
      render(<JoinPage />);
      typeKey('wk_abc123');
      await clickVerify();
      await waitFor(() => {
        expect(screen.getByText(/balance is below/i)).toBeInTheDocument();
      });
    });

    it('shows the fund link and Re-check Balance button', () => {
      const fundLink = screen.getByRole('link', {
        name: /fund with .* NEAR/i,
      });
      expect(fundLink).toHaveAttribute(
        'href',
        expect.stringContaining('outlayer.fastnear.com/wallet/fund'),
      );
      expect(
        screen.getByRole('button', { name: /re-check balance/i }),
      ).toBeInTheDocument();
    });

    it('Re-check with non-InsufficientBalance error surfaces a recheckError banner', async () => {
      mockGetBalance.mockRejectedValue(new Error('rate limit exceeded'));
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /re-check balance/i }),
        );
      });
      await waitFor(() => {
        expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
      });
      // "Watching for deposit…" is suppressed while error is active.
      expect(screen.queryByText(/watching for deposit/i)).toBeNull();
    });

    it('Re-check with InsufficientBalanceError keeps the low-balance card without a new error banner', async () => {
      mockGetBalance.mockRejectedValue(new outlayer.InsufficientBalanceError());
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /re-check balance/i }),
        );
      });
      await waitFor(() => {
        // Still shows the low-balance yellow card (balance was set to '0').
        expect(screen.getByText(/balance is below/i)).toBeInTheDocument();
      });
      // No duplicate error banner from recheckError path.
      expect(screen.queryByText(/insufficient balance/i)).toBeNull();
    });

    it('Re-check success with now-sufficient balance transitions to PostFunding', async () => {
      mockGetBalance.mockResolvedValue(ABOVE_THRESHOLD);
      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /re-check balance/i }),
        );
      });
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /activate now/i }),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText(/balance is below/i)).toBeNull();
    });
  });

  describe('polling clears stale recheckError', () => {
    // Polling is set up inside useBalancePoll's useEffect at mount time —
    // to make the setInterval use fake timers, we must enable them before
    // render. `doNotFake: ['nextTick', 'setImmediate']` keeps async/await +
    // testing-library's waitFor responsive.
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    });

    it('polling clears a stale recheckError once a poll succeeds', async () => {
      mockVerifyWallet.mockResolvedValue({
        account_id: 'alice.near',
        balance: BELOW_THRESHOLD,
      });
      // First getBalance: click-triggered recheck fails → error banner set.
      // Second getBalance: poll-triggered → success clears the banner.
      mockGetBalance
        .mockRejectedValueOnce(new Error('rate limit exceeded'))
        .mockResolvedValueOnce(BELOW_THRESHOLD);

      render(<JoinPage />);
      typeKey('wk_abc123');
      await clickVerify();
      await waitFor(() => {
        expect(screen.getByText(/balance is below/i)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(
          screen.getByRole('button', { name: /re-check balance/i }),
        );
      });
      await waitFor(() => {
        expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
      });

      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      await waitFor(() => {
        expect(screen.queryByText(/too many requests/i)).toBeNull();
      });
    });
  });
});

// ---------------------------------------------------------------------
// External NEAR path — caller has a NEAR account + private key already
// and provisions a derived wallet via createDeterministicWallet.
// ---------------------------------------------------------------------

const FIXTURE_PRIVATE_KEY =
  'ed25519:4jt4Rz3i9xLFD1A9NfZCLFa3g4cSxu12N4pX8YVvZABCdefGHIJKLmnop';
const FIXTURE_ACCOUNT = 'alice.near';
const FIXTURE_SEED = 'task-42';
const FIXTURE_WALLET_ID = 'uuid-deadbeef';
const FIXTURE_NEAR_ACCOUNT =
  '36842e2f73d0b7b2f2af6e0d94a7a997398c2c09d9cf09ca3fa23b5426fccf88';
const FIXTURE_MINTED_WK =
  'wk_minted_session_scoped_key_for_tests_000000000000000000000000';

describe('ExternalNearPath', () => {
  beforeEach(() => {
    useAgentStore.getState().reset();
    useAgentStore.getState().choosePath('external-near');
    mockCreate.mockReset();
    mockMint.mockReset();
    mockSetApiKey.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  function fillForm({
    accountId = FIXTURE_ACCOUNT,
    seed = FIXTURE_SEED,
    privateKey = FIXTURE_PRIVATE_KEY,
  }: {
    accountId?: string;
    seed?: string;
    privateKey?: string;
  } = {}) {
    fireEvent.change(screen.getByLabelText(/near account id/i), {
      target: { value: accountId },
    });
    fireEvent.change(screen.getByLabelText(/^seed/i), {
      target: { value: seed },
    });
    fireEvent.change(screen.getByLabelText(/near private key/i), {
      target: { value: privateKey },
    });
  }

  async function toggleMintCheckbox() {
    const checkbox = screen.getByRole('checkbox', { name: /also mint/i });
    await act(async () => {
      fireEvent.click(checkbox);
    });
  }

  async function clickSubmit() {
    const button = screen.getByRole('button', {
      name: /provision (derived|\+ activate)/i,
    });
    await act(async () => {
      fireEvent.click(button);
    });
  }

  describe('default mint flow', () => {
    beforeEach(() => {
      mockCreate.mockResolvedValueOnce({
        walletId: FIXTURE_WALLET_ID,
        nearAccountId: FIXTURE_NEAR_ACCOUNT,
        trial: { calls_remaining: 100 },
      });
      mockMint.mockResolvedValueOnce({
        walletId: FIXTURE_WALLET_ID,
        nearAccountId: FIXTURE_NEAR_ACCOUNT,
        walletKey: FIXTURE_MINTED_WK,
      });
    });

    test('submits both calls, activates wk_ via ApiClient, renders PostFunding', async () => {
      render(<JoinPage />);
      fillForm();
      await clickSubmit();

      await waitFor(() => {
        expect(screen.getByText(FIXTURE_NEAR_ACCOUNT)).toBeInTheDocument();
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockMint).toHaveBeenCalledTimes(1);
      // ApiClient activation — session-scoped.
      expect(mockSetApiKey).toHaveBeenCalledWith(FIXTURE_MINTED_WK);
      // PostFunding renders its "Activate Now" button since heartbeat is idle.
      expect(
        screen.getByRole('button', { name: /activate now/i }),
      ).toBeInTheDocument();
    });

    test('success screen shows the minted wk_ via MaskedCopyField, not the old "provisioning only" copy', async () => {
      render(<JoinPage />);
      fillForm();
      await clickSubmit();

      await waitFor(() => {
        expect(screen.getByText(/delegate wallet key/i)).toBeInTheDocument();
      });
      // No "provisioning only" copy on the mint-successful branch.
      expect(
        screen.queryByText(/provisioning only\. no .* was issued/i),
      ).toBeNull();
    });
  });

  describe('opt-out (--no-mint-key)', () => {
    beforeEach(() => {
      mockCreate.mockResolvedValueOnce({
        walletId: FIXTURE_WALLET_ID,
        nearAccountId: FIXTURE_NEAR_ACCOUNT,
        trial: { calls_remaining: 100 },
      });
    });

    test('unchecking the mint checkbox skips mintDelegateKey and renders provisioning-only copy', async () => {
      render(<JoinPage />);
      fillForm();
      await toggleMintCheckbox();
      await clickSubmit();

      await waitFor(() => {
        expect(screen.getByText(FIXTURE_NEAR_ACCOUNT)).toBeInTheDocument();
      });
      expect(mockMint).not.toHaveBeenCalled();
      expect(mockSetApiKey).not.toHaveBeenCalled();
      expect(screen.getByText(/provisioning only/i)).toBeInTheDocument();
      expect(screen.queryByText(/delegate wallet key/i)).toBeNull();
    });
  });

  describe('failure paths', () => {
    test('rejects missing prefix on the private key before any SDK call', async () => {
      render(<JoinPage />);
      fillForm({ privateKey: 'not-an-ed25519-key' });
      await clickSubmit();

      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockMint).not.toHaveBeenCalled();
      expect(
        screen.getByText(/must start with "ed25519:"/i),
      ).toBeInTheDocument();
    });

    test('mint failure after provision success surfaces partial-state error without leaking key', async () => {
      mockCreate.mockResolvedValueOnce({
        walletId: FIXTURE_WALLET_ID,
        nearAccountId: FIXTURE_NEAR_ACCOUNT,
        trial: { calls_remaining: 100 },
      });
      mockMint.mockRejectedValueOnce(
        Object.assign(new Error('mint upstream 500'), {
          code: 'PROTOCOL',
          shape: { code: 'PROTOCOL', hint: 'mint upstream 500' },
        }),
      );

      render(<JoinPage />);
      fillForm();
      await clickSubmit();

      await waitFor(() => {
        expect(useAgentStore.getState().externalNearStatus).toBe('error');
      });
      const { externalNearError } = useAgentStore.getState();
      expect(externalNearError).toMatch(/provisioned/i);
      expect(externalNearError).toMatch(/minting failed/i);
      expect(externalNearError).toMatch(/re-enter your NEAR key/i);
      const privBody = FIXTURE_PRIVATE_KEY.slice('ed25519:'.length);
      expect(externalNearError ?? '').not.toContain(privBody);
      expect(mockSetApiKey).not.toHaveBeenCalled();
      const privateKeyInput = screen.getByLabelText(
        /near private key/i,
      ) as HTMLInputElement;
      expect(privateKeyInput.value).toBe('');
    });
  });

  describe('key-leak safety', () => {
    beforeEach(() => {
      mockCreate.mockResolvedValueOnce({
        walletId: FIXTURE_WALLET_ID,
        nearAccountId: FIXTURE_NEAR_ACCOUNT,
        trial: { calls_remaining: 100 },
      });
      mockMint.mockResolvedValueOnce({
        walletId: FIXTURE_WALLET_ID,
        nearAccountId: FIXTURE_NEAR_ACCOUNT,
        walletKey: FIXTURE_MINTED_WK,
      });
    });

    test('never persists the private key to browser storage', async () => {
      render(<JoinPage />);
      fillForm();
      await clickSubmit();

      await waitFor(() => {
        expect(screen.getByText(FIXTURE_NEAR_ACCOUNT)).toBeInTheDocument();
      });

      const privBody = FIXTURE_PRIVATE_KEY.slice('ed25519:'.length);
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)!;
        const value = window.localStorage.getItem(key);
        expect(value ?? '').not.toContain(privBody);
      }
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i)!;
        const value = window.sessionStorage.getItem(key);
        expect(value ?? '').not.toContain(privBody);
      }
    });

    test('minted wk_ is NOT persisted to browser storage — session-scoped only', async () => {
      render(<JoinPage />);
      fillForm();
      await clickSubmit();

      await waitFor(() => {
        expect(screen.getByText(FIXTURE_NEAR_ACCOUNT)).toBeInTheDocument();
      });

      // The wk_ is activated via ApiClient.setApiKey (in-memory singleton),
      // NOT written to localStorage / sessionStorage. Durability is the
      // user's responsibility via the copy button.
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)!;
        const value = window.localStorage.getItem(key);
        expect(value ?? '').not.toContain(FIXTURE_MINTED_WK);
      }
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i)!;
        const value = window.sessionStorage.getItem(key);
        expect(value ?? '').not.toContain(FIXTURE_MINTED_WK);
      }
    });
  });
});

// ---------------------------------------------------------------------
// New Wallet path — Step 1 already created a wk_ + NEAR account;
// Step 2 watches for funding and transitions to PostFunding.
// ---------------------------------------------------------------------

const NEW_WALLET_TEST_ACCOUNT = 'alice.near';
const NEW_WALLET_TEST_KEY = 'wk_test_abcdef';

describe('NewWalletPath', () => {
  function seedCompletedStep1() {
    useAgentStore.getState().reset();
    useAgentStore.getState().completeStep1({
      api_key: NEW_WALLET_TEST_KEY,
      near_account_id: NEW_WALLET_TEST_ACCOUNT,
      trial: { calls_remaining: 100 },
    });
    useAgentStore.getState().choosePath('new');
  }

  beforeEach(() => {
    mockGetBalance.mockReset();
  });

  describe('step 1 success card', () => {
    it('renders the NEAR account and security warning', () => {
      seedCompletedStep1();
      render(<JoinPage />);
      expect(screen.getByText(NEW_WALLET_TEST_ACCOUNT)).toBeInTheDocument();
      expect(screen.getByText(/shown only once/i)).toBeInTheDocument();
      // MaskedCopyField renders the "Wallet Key" label.
      expect(screen.getByText(/wallet key/i)).toBeInTheDocument();
    });
  });

  describe('step 2 initial state', () => {
    beforeEach(() => {
      seedCompletedStep1();
      render(<JoinPage />);
    });

    it('shows the fund link pointing at OutLayer with the account id', () => {
      const link = screen.getByRole('link', { name: /fund with .* NEAR/i });
      const href = link.getAttribute('href') ?? '';
      expect(href).toContain('outlayer.fastnear.com/wallet/fund');
      expect(href).toContain(encodeURIComponent(NEW_WALLET_TEST_ACCOUNT));
    });

    it('shows the Check Balance button and deposit-watch hint', () => {
      expect(
        screen.getByRole('button', { name: /check balance/i }),
      ).toBeInTheDocument();
      expect(screen.getByText(/watching for deposit/i)).toBeInTheDocument();
    });
  });

  describe('step 2 manual check', () => {
    beforeEach(() => {
      seedCompletedStep1();
    });

    it('sufficient balance transitions to PostFunding', async () => {
      mockGetBalance.mockResolvedValue(ABOVE_THRESHOLD);
      render(<JoinPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /check balance/i }));
      });
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /activate now/i }),
        ).toBeInTheDocument();
      });
    });

    it('low balance surfaces step error and renames button to Re-check Balance', async () => {
      mockGetBalance.mockResolvedValue(BELOW_THRESHOLD);
      render(<JoinPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /check balance/i }));
      });
      await waitFor(() => {
        // stepErrors[2] text includes "need ≥" and "Fund your wallet".
        expect(screen.getByText(/need ≥/i)).toBeInTheDocument();
      });
      expect(
        screen.getByRole('button', { name: /re-check balance/i }),
      ).toBeInTheDocument();
    });

    it('InsufficientBalanceError from getBalance surfaces a step 2 error without crashing', async () => {
      mockGetBalance.mockRejectedValue(new outlayer.InsufficientBalanceError());
      render(<JoinPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /check balance/i }));
      });
      // NewWalletPath routes errors through stepErrorMessage → friendlyError,
      // which has no pattern for InsufficientBalanceError and falls through
      // to the generic "Something went wrong" message. The button-label
      // rename is the clearer signal that the error path ran.
      //
      // ByoPath catches InsufficientBalanceError specifically and renders
      // the yellow fund-wallet card — NewWalletPath currently doesn't
      // (asymmetric UX, deliberate test pin). If friendlyError ever gets
      // an /insufficient balance/i pattern OR NewWalletPath gains its own
      // typed catch, update the /something went wrong/i assertion below
      // to match the new specific message.
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /re-check balance/i }),
        ).toBeInTheDocument();
      });
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });

    it('non-InsufficientBalance getBalance error surfaces a step 2 error', async () => {
      mockGetBalance.mockRejectedValue(new Error('rate limit exceeded'));
      render(<JoinPage />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /check balance/i }));
      });
      await waitFor(() => {
        expect(screen.getByText(/too many requests/i)).toBeInTheDocument();
      });
    });
  });

  describe('polling auto-advances step 2', () => {
    beforeEach(() => {
      // Enable fake timers BEFORE render so useBalancePoll's setInterval
      // picks up the fake clock. See ByoPath polling note.
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    });

    it('auto-advances to PostFunding when a poll sees balance >= threshold', async () => {
      seedCompletedStep1();
      mockGetBalance.mockResolvedValue(ABOVE_THRESHOLD);
      render(<JoinPage />);

      // Before the first poll, the Check Balance button (manual trigger) is
      // visible and PostFunding is not.
      expect(
        screen.getByRole('button', { name: /check balance/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /activate now/i }),
      ).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /activate now/i }),
        ).toBeInTheDocument();
      });
    });

    it('poll skips a tick while a manual Check Balance is in-flight (shouldSkipTick guard)', async () => {
      seedCompletedStep1();

      // Hold the manual getBalance unresolved. While handleStep2 is suspended
      // on the await, stepStatus[2] === 'loading' — shouldSkipTick must return
      // true, and the poll tick must not fire a second getBalance (which
      // would race the manual completion to call completeStep2).
      let resolveManual: (balance: string) => void = () => {};
      const manualPromise = new Promise<string>((r) => {
        resolveManual = r;
      });
      mockGetBalance.mockImplementationOnce(() => manualPromise);

      render(<JoinPage />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /check balance/i }));
      });

      // Manual call started, promise held, stepStatus[2] = 'loading'.
      expect(mockGetBalance).toHaveBeenCalledTimes(1);

      await act(async () => {
        jest.advanceTimersByTime(5000);
      });

      // Poll tick saw 'loading' and skipped — getBalance still at one call.
      expect(mockGetBalance).toHaveBeenCalledTimes(1);

      // Release the held promise so handleStep2 can finish cleanly.
      await act(async () => {
        resolveManual(ABOVE_THRESHOLD);
      });
      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /activate now/i }),
        ).toBeInTheDocument();
      });
    });
  });
});
