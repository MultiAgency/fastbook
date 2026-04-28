/**
 * @jest-environment node
 */

const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: { create: (...args: unknown[]) => mockCreate(...args) },
    },
  })),
}));

import {
  type GenerateField,
  generateFollowReason,
  generateProfileField,
  getNearAiClient,
  isGenerateConfigured,
  type ReasonGenerateContext,
} from '@/lib/llm-server';

const ORIG_KEY = process.env.NEARAI_API_KEY;

function restoreKey(): void {
  if (ORIG_KEY === undefined) delete process.env.NEARAI_API_KEY;
  else process.env.NEARAI_API_KEY = ORIG_KEY;
}

function mockJsonResponse(value: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify({ value }) } }],
  };
}

describe('llm-server configuration gating', () => {
  afterEach(() => {
    restoreKey();
  });

  it('isGenerateConfigured returns false when NEARAI_API_KEY is unset', () => {
    delete process.env.NEARAI_API_KEY;
    expect(isGenerateConfigured()).toBe(false);
  });

  it('isGenerateConfigured returns true when NEARAI_API_KEY is set', () => {
    process.env.NEARAI_API_KEY = 'sk-test';
    expect(isGenerateConfigured()).toBe(true);
  });

  it('getNearAiClient returns null when NEARAI_API_KEY is unset', () => {
    delete process.env.NEARAI_API_KEY;
    expect(getNearAiClient()).toBeNull();
  });

  it('getNearAiClient returns a client instance when NEARAI_API_KEY is set', () => {
    process.env.NEARAI_API_KEY = 'sk-test';
    expect(getNearAiClient()).not.toBeNull();
  });
});

describe('generateProfileField orchestration', () => {
  beforeEach(() => {
    process.env.NEARAI_API_KEY = 'sk-test';
    mockCreate.mockReset();
  });

  afterEach(() => {
    restoreKey();
  });

  it('returns the validated value on first-call success', async () => {
    mockCreate.mockResolvedValueOnce(mockJsonResponse('Alice'));
    const result = await generateProfileField({
      field: 'name',
      current: {},
    });
    expect(result).toBe('Alice');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('retries once on validation failure and returns the second-call value', async () => {
    const tooLong = 'x'.repeat(60);
    mockCreate.mockResolvedValueOnce(mockJsonResponse(tooLong));
    mockCreate.mockResolvedValueOnce(mockJsonResponse('Bob'));
    const result = await generateProfileField({
      field: 'name',
      current: {},
    });
    expect(result).toBe('Bob');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('returns null after two validation failures (graceful nudge)', async () => {
    const tooLong = 'x'.repeat(60);
    mockCreate.mockResolvedValueOnce(mockJsonResponse(tooLong));
    mockCreate.mockResolvedValueOnce(mockJsonResponse(tooLong));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await generateProfileField({
      field: 'name',
      current: {},
    });
    expect(result).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('validation failed twice'),
    );
    warnSpy.mockRestore();
  });

  it('drops invalid context fields from the prompt before calling the model', async () => {
    mockCreate.mockResolvedValueOnce(mockJsonResponse('Alice'));
    const tooLongDesc = 'x'.repeat(600);
    const validImage = 'https://example.com/avatar.png';
    await generateProfileField({
      field: 'name',
      current: { description: tooLongDesc, image: validImage },
    });
    const prompt = mockCreate.mock.calls[0]?.[0]?.messages?.[1]?.content as
      | string
      | undefined;
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain(tooLongDesc);
    expect(prompt).toContain(validImage);
  });

  it.each([
    ['name', 'Alice'],
    ['description', 'a description'],
    ['image', 'https://example.com/img.png'],
    ['tags', ['ai', 'agents']],
    ['capabilities', { skills: ['typing'] }],
  ] as ReadonlyArray<
    readonly [GenerateField, unknown]
  >)('validates the %s field via its SDK validator', async (field, value) => {
    mockCreate.mockResolvedValueOnce(mockJsonResponse(value));
    const result = await generateProfileField({ field, current: {} });
    expect(result).not.toBeNull();
  });

  it('returns null when NEARAI_API_KEY is unset (no upstream call)', async () => {
    delete process.env.NEARAI_API_KEY;
    const result = await generateProfileField({ field: 'name', current: {} });
    expect(result).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('caps output via per-field max_tokens', async () => {
    mockCreate.mockResolvedValueOnce(mockJsonResponse('Alice'));
    await generateProfileField({ field: 'name', current: {} });
    const arg = mockCreate.mock.calls[0]?.[0] as
      | { max_tokens?: number }
      | undefined;
    expect(typeof arg?.max_tokens).toBe('number');
    expect(arg?.max_tokens).toBeGreaterThan(0);
  });
});

describe('generateFollowReason orchestration', () => {
  beforeEach(() => {
    process.env.NEARAI_API_KEY = 'sk-test';
    mockCreate.mockReset();
  });

  afterEach(() => {
    restoreKey();
  });

  const ctx: ReasonGenerateContext = {
    targetAccountId: 'bob.near',
    callerAccountId: 'alice.near',
  };

  it('returns the validated reason on first-call success', async () => {
    mockCreate.mockResolvedValueOnce(
      mockJsonResponse('we share a focus on agents'),
    );
    const result = await generateFollowReason(ctx);
    expect(result).toBe('we share a focus on agents');
  });

  it('returns null after two validation failures', async () => {
    const tooLong = 'x'.repeat(300);
    mockCreate.mockResolvedValueOnce(mockJsonResponse(tooLong));
    mockCreate.mockResolvedValueOnce(mockJsonResponse(tooLong));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await generateFollowReason(ctx);
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });
});
