import { fireEvent, render, screen } from '@testing-library/react';
import { Handoff } from '@/app/join/Handoff';

jest.mock('@/hooks', () => ({
  useCopyToClipboard: () => [false, jest.fn()],
}));

// platforms.ts transitively imports next/server, which needs web Request
// globals jsdom doesn't provide. The Handoff component only uses the
// PLATFORM_META data constant, so mock the module surface.
jest.mock('@/lib/platforms', () => ({
  PLATFORM_META: [
    {
      id: 'test-platform',
      displayName: 'Test Platform',
      description: 'A mock platform for testing.',
      requiresWalletKey: false,
    },
  ],
}));

const TEST_ACCOUNT = 'test-account.near';
const TEST_KEY = 'wk_test12345abcdef';

function renderHandoff(onReset: () => void = jest.fn()) {
  return render(
    <Handoff accountId={TEST_ACCOUNT} apiKey={TEST_KEY} onReset={onReset} />,
  );
}

describe('Handoff', () => {
  it('hides credentials JSON until the reveal button is clicked', () => {
    renderHandoff();
    // Before reveal: the key should not be in the DOM at all.
    expect(screen.queryByText(/wk_test12345abcdef/)).toBeNull();
    // The reveal button is visible.
    screen.getByRole('button', { name: /show credentials/i });
  });

  it('offers a download-credentials.json button alongside reveal', () => {
    renderHandoff();
    // Download is always available without needing reveal — devs who want
    // to skip ever rendering the key in DOM-visible text can click this
    // directly.
    screen.getByRole('button', { name: /download credentials\.json/i });
  });

  it('renders credentials JSON with interpolated accountId and apiKey after reveal', () => {
    renderHandoff();
    fireEvent.click(screen.getByRole('button', { name: /show credentials/i }));
    // getByText throws if no match — guards against a regression back to
    // placeholder `wk_...` / `...`.
    screen.getByText(/"api_key":\s*"wk_test12345abcdef"/);
    screen.getByText(new RegExp(`"account_id":\\s*"${TEST_ACCOUNT}"`));
  });

  it('credentials JSON carries the platforms slot from skill.md canonical shape', () => {
    renderHandoff();
    fireEvent.click(screen.getByRole('button', { name: /show credentials/i }));
    screen.getByText(/"platforms":\s*\{\}/);
  });

  it('agent prompt references credentials file and does not embed the raw API key', () => {
    renderHandoff();
    const promptAnchor = screen.getByText(
      /load from ~\/\.config\/nearly\/credentials\.json/,
    );
    const promptBlock = promptAnchor.closest('pre');
    expect(promptBlock).not.toBeNull();
    // Guards against a regression that re-embeds credentials in the agent
    // prompt (the downstream-persistence failure mode we deliberately
    // avoid — see review notes on credentials-by-reference).
    expect(promptBlock?.textContent).not.toContain(TEST_KEY);
    // Account ID is public and safe to embed in the prompt.
    expect(promptBlock?.textContent).toContain(TEST_ACCOUNT);
  });

  it('shows the save-now warning banner', () => {
    renderHandoff();
    screen.getByText(/Save now — this key cannot be recovered/);
  });

  it('calls onReset when the Start Over button is clicked', () => {
    const onReset = jest.fn();
    renderHandoff(onReset);
    screen.getByRole('button', { name: /start over/i }).click();
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
