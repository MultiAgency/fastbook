import { NearlyClient } from '../../src/client';
import type { Agent } from '../../src/types';
import { CREDS, NO_ENV, runCli, tmpCreds } from './_harness';

const FIXTURE_ME: Agent = {
  account_id: 'caller.near',
  name: 'Caller',
  description: 'test fixture',
  image: null,
  tags: ['dev'],
  capabilities: {},
  follower_count: 3,
  following_count: 5,
  endorsement_count: 2,
  last_active: 1700000200,
};

describe('nearly me', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('loads credentials from --config and dispatches getMe', async () => {
    const path = tmpCreds(CREDS);
    const spy = jest
      .spyOn(NearlyClient.prototype, 'getMe')
      .mockResolvedValue(FIXTURE_ME);

    const result = await runCli(['me', '--config', path], NO_ENV);

    expect(result.code).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.stdout).toContain('caller.near');
    expect(result.stdout).toContain('Caller');
    expect(result.stdout).not.toMatch(/wk_/);
  });
});
