import { CREDS, NO_ENV, runCli, tmpCreds } from './_harness';

describe('nearly unfollow', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('no target exits 1 with usage', async () => {
    const path = tmpCreds(CREDS);
    const result = await runCli(['unfollow', '--config', path], NO_ENV);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/usage: nearly unfollow/);
  });
});
