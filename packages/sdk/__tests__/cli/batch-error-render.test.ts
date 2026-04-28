import { NearlyClient } from '../../src/client';
import { NO_ENV, runCli, tmpCreds } from './_harness';

// Every mutation command routes its batch results through the shared
// `renderBatchMutation` helper in cli/batch.ts. Per-command test files
// cover dispatch (correct client method, correct args). This file covers
// the shared rendering contract — any drift in exit code or CODE: message
// format here fails once across all commands that use the helper.
interface Case {
  cmd: string;
  extraArgv: string[];
  mockBatch: () => void;
  errorCode: string;
  errorMessage: string;
}

const CASES: Case[] = [
  {
    cmd: 'follow',
    extraArgv: [],
    mockBatch: () => {
      jest.spyOn(NearlyClient.prototype, 'followMany').mockResolvedValue([
        { account_id: 'alice.near', action: 'followed', target: 'alice.near' },
        {
          account_id: 'target.near',
          action: 'error',
          code: 'SELF_FOLLOW',
          error: 'cannot follow yourself',
        },
      ]);
    },
    errorCode: 'SELF_FOLLOW',
    errorMessage: 'cannot follow yourself',
  },
  {
    cmd: 'endorse',
    extraArgv: ['--key-suffix', 'tags/rust'],
    mockBatch: () => {
      jest.spyOn(NearlyClient.prototype, 'endorseMany').mockResolvedValue([
        {
          account_id: 'alice.near',
          action: 'endorsed',
          target: 'alice.near',
          key_suffixes: ['tags/rust'],
        },
        {
          account_id: 'target.near',
          action: 'error',
          code: 'NOT_FOUND',
          error: 'agent not found: target.near',
        },
      ]);
    },
    errorCode: 'NOT_FOUND',
    errorMessage: 'agent not found: target.near',
  },
];

describe('renderBatchMutation — per-item error rendering (shared across commands)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each(
    CASES,
  )('$cmd: renders "error" row and "CODE: message" and exits 4', async ({
    cmd,
    extraArgv,
    mockBatch,
    errorCode,
    errorMessage,
  }) => {
    const path = tmpCreds();
    mockBatch();

    const result = await runCli(
      [cmd, 'alice.near', 'target.near', ...extraArgv, '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(4);
    expect(result.stdout).toContain('error');
    expect(result.stdout).toContain(`${errorCode}: ${errorMessage}`);
  });
});
