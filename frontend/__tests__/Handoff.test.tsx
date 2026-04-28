import { fireEvent, render, screen } from '@testing-library/react';
import { Handoff } from '@/app/join/Handoff';
import { ApiError, api } from '@/lib/api';
import type { Agent } from '@/types';

jest.mock('@/hooks', () => ({
  useCopyToClipboard: () => [false, jest.fn()],
}));

jest.mock('@/lib/api', () => ({
  api: {
    listTags: jest.fn().mockResolvedValue({ tags: [] }),
    updateProfile: jest.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

const TEST_AGENT: Agent = {
  account_id: 'test-account.near',
  name: null,
  description: '',
  image: null,
  tags: [],
  capabilities: {},
};

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

  it('top-up link falls back to the parameterized fund URL when handoffUrl is absent', () => {
    renderHandoff();
    const link = screen.getByRole('link', { name: /top up wallet/i });
    expect(link.getAttribute('href')).toContain('/wallet/fund?to=');
    expect(link.getAttribute('href')).toContain(TEST_ACCOUNT);
  });

  it('renders hand-off acknowledgement card when profileCompleteness is absent', () => {
    renderHandoff();
    screen.getByRole('heading', { name: /activates on first run/i });
  });

  it('renders profile completeness card instead of hand-off card when completeness is known', () => {
    render(
      <Handoff
        accountId={TEST_ACCOUNT}
        apiKey={TEST_KEY}
        agent={TEST_AGENT}
        profileCompleteness={40}
        onReset={jest.fn()}
      />,
    );
    screen.getByRole('heading', { name: /profile 40% complete/i });
    expect(
      screen.queryByRole('heading', { name: /activates on first run/i }),
    ).toBeNull();
  });

  it('top-up link uses OutLayer handoffUrl when provided', () => {
    const handoffUrl = `https://outlayer.fastnear.com/wallet?key=${TEST_KEY}`;
    render(
      <Handoff
        accountId={TEST_ACCOUNT}
        apiKey={TEST_KEY}
        handoffUrl={handoffUrl}
        onReset={jest.fn()}
      />,
    );
    const link = screen.getByRole('link', { name: /top up wallet/i });
    expect(link.getAttribute('href')).toBe(handoffUrl);
  });

  it('saves a sparse patch with only changed fields and propagates completeness from the response', async () => {
    const updated: Agent = { ...TEST_AGENT, name: 'Alice' };
    (api.updateProfile as jest.Mock).mockResolvedValueOnce({
      agent: updated,
      profile_completeness: 60,
    });
    render(
      <Handoff
        accountId={TEST_ACCOUNT}
        apiKey={TEST_KEY}
        agent={TEST_AGENT}
        profileCompleteness={40}
        onReset={jest.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: 'Alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));
    await screen.findByRole('heading', { name: /profile 60% complete/i });
    expect(api.updateProfile).toHaveBeenCalledWith({ name: 'Alice' });
  });

  it('keeps the Save button disabled when no fields have changed (isDirty gate)', () => {
    render(
      <Handoff
        accountId={TEST_ACCOUNT}
        apiKey={TEST_KEY}
        agent={TEST_AGENT}
        profileCompleteness={40}
        onReset={jest.fn()}
      />,
    );
    const save = screen.getByRole('button', {
      name: /save profile/i,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it('surfaces the rate-limit message when updateProfile rejects with an ApiError carrying retryAfter', async () => {
    const err = new ApiError({
      statusCode: 429,
      message: 'rate limited',
      code: 'RATE_LIMITED',
      retryAfter: 12,
    });
    // Mock class ignores constructor args; assign retryAfter directly.
    (err as { retryAfter?: number }).retryAfter = 12;
    (api.updateProfile as jest.Mock).mockRejectedValueOnce(err);
    render(
      <Handoff
        accountId={TEST_ACCOUNT}
        apiKey={TEST_KEY}
        agent={TEST_AGENT}
        profileCompleteness={40}
        onReset={jest.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: 'Alice' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));
    await screen.findByText(/rate limited — try again in 12s/i);
  });
});
