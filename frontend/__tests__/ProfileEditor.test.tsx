import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileEditor } from '@/components/register/ProfileEditor';
import { ApiError, api } from '@/lib/api';
import type { Agent } from '@/types';

jest.mock('@/lib/api', () => ({
  api: {
    listTags: jest.fn().mockResolvedValue({ tags: [] }),
    updateProfile: jest.fn(),
    generateProfile: jest.fn(),
  },
  ApiError: class ApiError extends Error {
    statusCode: number;
    code?: string;
    hint?: string;
    retryAfter?: number;
    constructor(opts: {
      statusCode: number;
      message: string;
      code?: string;
      hint?: string;
      retryAfter?: number;
    }) {
      super(opts.message);
      this.statusCode = opts.statusCode;
      this.code = opts.code;
      this.hint = opts.hint;
      this.retryAfter = opts.retryAfter;
    }
  },
}));

const TEST_AGENT: Agent = {
  account_id: 'test.near',
  name: null,
  description: '',
  image: null,
  tags: [],
  capabilities: {},
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ProfileEditor generate buttons', () => {
  it('hides generate buttons when generateEnabled is false', () => {
    render(
      <ProfileEditor
        initial={TEST_AGENT}
        onSaved={jest.fn()}
        generateEnabled={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /generate name/i })).toBeNull();
    expect(
      screen.queryByRole('button', { name: /generate description/i }),
    ).toBeNull();
  });

  it('shows generate buttons when generateEnabled is true', () => {
    render(
      <ProfileEditor
        initial={TEST_AGENT}
        onSaved={jest.fn()}
        generateEnabled={true}
      />,
    );
    screen.getByRole('button', { name: /generate name/i });
    screen.getByRole('button', { name: /generate description/i });
  });

  it('disables generate buttons when no fields have content', () => {
    render(
      <ProfileEditor
        initial={TEST_AGENT}
        onSaved={jest.fn()}
        generateEnabled={true}
      />,
    );
    const btn = screen.getByRole('button', {
      name: /generate name/i,
    }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('enables generate buttons once any field has content', () => {
    render(
      <ProfileEditor
        initial={TEST_AGENT}
        onSaved={jest.fn()}
        generateEnabled={true}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: 'Alice' },
    });
    const desc = screen.getByRole('button', {
      name: /generate description/i,
    }) as HTMLButtonElement;
    expect(desc.disabled).toBe(false);
  });

  it('populates the field with the generated value on success', async () => {
    (api.generateProfile as jest.Mock).mockResolvedValueOnce({
      field: 'description',
      value: 'A generated description.',
    });
    render(
      <ProfileEditor
        initial={TEST_AGENT}
        onSaved={jest.fn()}
        generateEnabled={true}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: 'Alice' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /generate description/i }),
    );
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/^description$/i) as HTMLTextAreaElement).value,
      ).toBe('A generated description.');
    });
  });

  it('surfaces a graceful-nudge message when the server returns null value', async () => {
    (api.generateProfile as jest.Mock).mockResolvedValueOnce({
      field: 'name',
      value: null,
    });
    render(
      <ProfileEditor
        initial={TEST_AGENT}
        onSaved={jest.fn()}
        generateEnabled={true}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^description$/i), {
      target: { value: 'Some description' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate name/i }));
    await screen.findByText(/Couldn't generate a suggestion for this field/i);
  });

  it('surfaces a rate-limit message when the server rejects with retryAfter', async () => {
    const err = new ApiError({
      statusCode: 429,
      message: 'rate limited',
      code: 'RATE_LIMITED',
      retryAfter: 42,
    });
    (api.generateProfile as jest.Mock).mockRejectedValueOnce(err);
    render(
      <ProfileEditor
        initial={TEST_AGENT}
        onSaved={jest.fn()}
        generateEnabled={true}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^description$/i), {
      target: { value: 'Some description' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate name/i }));
    await screen.findByText(/Rate limited — try again in 42s/i);
  });

  it('surfaces a friendly message when generate rejects with a non-ApiError', async () => {
    (api.generateProfile as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    render(
      <ProfileEditor
        initial={TEST_AGENT}
        onSaved={jest.fn()}
        generateEnabled={true}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^description$/i), {
      target: { value: 'Some description' },
    });
    fireEvent.click(screen.getByRole('button', { name: /generate name/i }));
    await screen.findByText(/Something went wrong\. Please try again\./i);
  });
});
