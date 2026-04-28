import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { NearlyClient } from '../../src/client';
import { saveCredentials } from '../../src/credentials';
import * as walletModule from '../../src/wallet';
import { runCli } from './_harness';

jest.mock('../../src/credentials', () => ({
  loadCredentials: jest.fn(async () => null),
  saveCredentials: jest.fn(async () => undefined),
}));

describe('nearly register (anonymous mode)', () => {
  const mockedSave = saveCredentials as jest.MockedFunction<
    typeof saveCredentials
  >;

  beforeEach(() => {
    mockedSave.mockClear();
    jest.spyOn(NearlyClient, 'register').mockResolvedValue({
      client: {} as NearlyClient,
      accountId: 'newbie.near',
      walletKey: 'wk_newbie_secret_do_not_print',
      trial: { calls_remaining: 100 },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('default output prints accountId and trial quota but never walletKey', async () => {
    const result = await runCli(['register']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('newbie.near');
    expect(result.stdout).toContain('100');
    expect(result.stdout).not.toMatch(/wk_/);
    expect(result.stderr).not.toMatch(/wk_/);
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSave).toHaveBeenCalledWith(
      { account_id: 'newbie.near', api_key: 'wk_newbie_secret_do_not_print' },
      undefined,
    );
  });

  test('--json emits parseable JSON with no walletKey leakage', async () => {
    const result = await runCli(['register', '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.accountId).toBe('newbie.near');
    expect(parsed.trial.calls_remaining).toBe(100);
    expect(JSON.stringify(parsed)).not.toMatch(/wk_/);
  });
});

describe('nearly register --deterministic', () => {
  const mockedSave = saveCredentials as jest.MockedFunction<
    typeof saveCredentials
  >;
  let tmpDir: string;
  let keyFile: string;
  let privateKey: string;
  let privBody: string;

  beforeAll(() => {
    // Generate a throwaway ed25519 keypair and write its private key to a
    // temp file. Real file I/O keeps the CLI's readFileSync path honest.
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 19 + 3) & 0xff;
    privBody = bs58.encode(seed);
    privateKey = `ed25519:${privBody}`;
    tmpDir = mkdtempSync(join(tmpdir(), 'nearly-register-det-'));
    keyFile = join(tmpDir, 'near.key');
    writeFileSync(keyFile, `${privateKey}\n`, { mode: 0o600 });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const MINTED_WK =
    'wk_deadbeef_minted_key_for_register_tests_0000000000000000';

  beforeEach(() => {
    mockedSave.mockClear();
    jest.spyOn(walletModule, 'createDeterministicWallet').mockResolvedValue({
      walletId: 'uuid-det-1',
      nearAccountId: 'abc123deadbeef',
      trial: { calls_remaining: 100 },
    });
    jest.spyOn(walletModule, 'mintDelegateKey').mockResolvedValue({
      walletId: 'uuid-det-1',
      nearAccountId: 'abc123deadbeef',
      walletKey: MINTED_WK,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('default mints delegate wk_ and prints it with a save-this warning', async () => {
    const result = await runCli([
      'register',
      '--deterministic',
      '--account-id',
      'alice.near',
      '--seed',
      'task-42',
      '--key-file',
      keyFile,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('uuid-det-1');
    expect(result.stdout).toContain('abc123deadbeef');
    expect(result.stdout).toContain(MINTED_WK);
    expect(result.stderr).toMatch(/save the wallet_key/i);
    expect(result.stdout).not.toContain(privBody);
    expect(result.stderr).not.toContain(privBody);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  test('--no-mint-key skips minting and prints provisioning-only output', async () => {
    const result = await runCli([
      'register',
      '--deterministic',
      '--account-id',
      'alice.near',
      '--seed',
      'task-42',
      '--key-file',
      keyFile,
      '--no-mint-key',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('uuid-det-1');
    expect(result.stdout).toContain('abc123deadbeef');
    expect(result.stdout).not.toContain(MINTED_WK);
    expect(result.stdout).not.toMatch(/wk_/);
    expect(result.stderr).toMatch(/no delegate wk_ issued/i);
    expect(walletModule.mintDelegateKey).not.toHaveBeenCalled();
  });

  test('--json includes walletKey in the default (minting) mode', async () => {
    const result = await runCli([
      'register',
      '--deterministic',
      '--account-id',
      'alice.near',
      '--seed',
      'task-42',
      '--key-file',
      keyFile,
      '--json',
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.walletId).toBe('uuid-det-1');
    expect(parsed.nearAccountId).toBe('abc123deadbeef');
    expect(parsed.walletKey).toBe(MINTED_WK);
    expect(JSON.stringify(parsed)).not.toContain(privBody);
  });

  test('--no-mint-key --json omits walletKey from output', async () => {
    const result = await runCli([
      'register',
      '--deterministic',
      '--account-id',
      'alice.near',
      '--seed',
      'task-42',
      '--key-file',
      keyFile,
      '--no-mint-key',
      '--json',
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.walletId).toBe('uuid-det-1');
    expect(parsed.nearAccountId).toBe('abc123deadbeef');
    expect('walletKey' in parsed).toBe(false);
  });

  test('mint failure after provision success surfaces clear partial-state error', async () => {
    const mintFailure = Object.assign(new Error('upstream 500'), {
      code: 'PROTOCOL',
      shape: {
        code: 'PROTOCOL',
        hint: 'upstream 500',
        message: 'upstream 500',
      },
    });
    jest
      .spyOn(walletModule, 'mintDelegateKey')
      .mockRejectedValueOnce(mintFailure);
    const result = await runCli([
      'register',
      '--deterministic',
      '--account-id',
      'alice.near',
      '--seed',
      'task-42',
      '--key-file',
      keyFile,
    ]);
    // Non-zero exit: minting failed.
    expect(result.code).not.toBe(0);
    // Provisioned wallet still surfaced on stdout — caller needs to know
    // it exists at OutLayer so a retry doesn't double-register.
    expect(result.stdout).toContain('uuid-det-1');
    expect(result.stdout).toContain('abc123deadbeef');
    // Stderr explains the partial state.
    expect(result.stderr).toMatch(/provisioned.*minting failed/i);
    expect(result.stderr).not.toContain(privBody);
  });

  test('mint failure in --json mode throws before rendering — no success payload on stdout', async () => {
    const mintFailure = Object.assign(new Error('upstream 500'), {
      code: 'PROTOCOL',
      shape: {
        code: 'PROTOCOL',
        hint: 'upstream 500',
        message: 'upstream 500',
      },
    });
    jest
      .spyOn(walletModule, 'mintDelegateKey')
      .mockRejectedValueOnce(mintFailure);
    const result = await runCli([
      'register',
      '--deterministic',
      '--account-id',
      'alice.near',
      '--seed',
      'task-42',
      '--key-file',
      keyFile,
      '--json',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/upstream 500|PROTOCOL/);
    expect(result.stderr).not.toContain(privBody);
  });

  test.each([
    [
      '--account-id missing',
      ['register', '--deterministic', '--seed', 's', '--key-file', 'x'],
      /--account-id/,
    ],
    [
      '--seed missing',
      [
        'register',
        '--deterministic',
        '--account-id',
        'a.near',
        '--key-file',
        'x',
      ],
      /--seed/,
    ],
    [
      '--key-file missing',
      ['register', '--deterministic', '--account-id', 'a.near', '--seed', 's'],
      /--key-file/,
    ],
  ])('%s exits non-zero', async (_label, argv, expectedStderr) => {
    const result = await runCli(argv);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(expectedStderr);
  });

  test('--private-key in argv is rejected with a security-error message', async () => {
    const result = await runCli([
      'register',
      '--private-key',
      privateKey,
      '--account-id',
      'alice.near',
      '--seed',
      's',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--private-key/);
    expect(result.stderr).toMatch(/security risk/i);
    // The key passed via argv must not echo through the error stream.
    expect(result.stderr).not.toContain(privBody);
  });

  test('deterministic flags without --deterministic are rejected', async () => {
    // Prevents a typo on --deterministic from silently falling through to
    // anonymous mode and issuing a wk_ key the caller never asked for.
    const result = await runCli([
      'register',
      '--account-id',
      'alice.near',
      '--seed',
      's',
      '--key-file',
      keyFile,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--deterministic/);
  });

  test('unreadable key file produces a typed validation error without spilling path contents', async () => {
    const result = await runCli([
      'register',
      '--deterministic',
      '--account-id',
      'alice.near',
      '--seed',
      's',
      '--key-file',
      '/tmp/does-not-exist-nearly-test-register-det',
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/cannot read key file/);
  });

  test('empty key file produces a typed validation error', async () => {
    const emptyFile = join(tmpDir, 'empty.key');
    writeFileSync(emptyFile, '   \n\n  ', { mode: 0o600 });
    const result = await runCli([
      'register',
      '--deterministic',
      '--account-id',
      'alice.near',
      '--seed',
      's',
      '--key-file',
      emptyFile,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/empty/i);
  });
});
