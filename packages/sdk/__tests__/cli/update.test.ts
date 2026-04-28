import { NearlyClient } from '../../src/client';
import type { Agent } from '../../src/types';
import { CREDS, NO_ENV, runCli, tmpCreds } from './_harness';

const FIXTURE_AGENT: Agent = {
  account_id: 'caller.near',
  name: 'Caller',
  description: 'fixture description is long enough',
  image: null,
  tags: [],
  capabilities: { skills: ['audit'], languages: ['rust'] },
  follower_count: 0,
  following_count: 0,
  endorsement_count: 0,
  last_active: 1700000000,
};

describe('nearly update', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('--cap ns/value pairs parse into structured capabilities', async () => {
    const path = tmpCreds(CREDS);
    const spy = jest
      .spyOn(NearlyClient.prototype, 'updateProfile')
      .mockResolvedValue({ agent: FIXTURE_AGENT });

    const result = await runCli(
      [
        'update',
        '--cap',
        'skills/audit',
        '--cap',
        'languages/rust',
        '--config',
        path,
      ],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({
      capabilities: {
        skills: ['audit'],
        languages: ['rust'],
      },
    });
  });

  test('--cap none clears capabilities', async () => {
    const path = tmpCreds(CREDS);
    const spy = jest
      .spyOn(NearlyClient.prototype, 'updateProfile')
      .mockResolvedValue({ agent: { ...FIXTURE_AGENT, capabilities: {} } });

    const result = await runCli(
      ['update', '--cap', 'none', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual({ capabilities: {} });
  });

  test('malformed --cap (no slash) exits with validation error and no update call', async () => {
    const path = tmpCreds(CREDS);
    const spy = jest
      .spyOn(NearlyClient.prototype, 'updateProfile')
      .mockResolvedValue({ agent: FIXTURE_AGENT });

    const result = await runCli(
      ['update', '--cap', 'noslash', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('invalid capability');
    expect(spy).not.toHaveBeenCalled();
  });

  test('stdout renders capabilities as ns/value pairs', async () => {
    const path = tmpCreds(CREDS);
    jest
      .spyOn(NearlyClient.prototype, 'updateProfile')
      .mockResolvedValue({ agent: FIXTURE_AGENT });

    const result = await runCli(
      ['update', '--cap', 'skills/audit', '--config', path],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('skills/audit');
    expect(result.stdout).toContain('languages/rust');
    expect(result.stdout).not.toMatch(/wk_/);
  });
});
