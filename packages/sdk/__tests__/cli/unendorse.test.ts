import { NearlyClient } from '../../src/client';
import { CREDS, NO_ENV, runCli, tmpCreds } from './_harness';

describe('nearly unendorse', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('multi target applies homogeneous key-suffix list via unendorseMany', async () => {
    const path = tmpCreds(CREDS);
    const batchSpy = jest
      .spyOn(NearlyClient.prototype, 'unendorseMany')
      .mockResolvedValue([
        {
          account_id: 'alice.near',
          action: 'unendorsed',
          target: 'alice.near',
          key_suffixes: ['tags/rust'],
        },
        {
          account_id: 'bob.near',
          action: 'unendorsed',
          target: 'bob.near',
          key_suffixes: ['tags/rust'],
        },
      ]);

    const result = await runCli(
      [
        'unendorse',
        'alice.near',
        'bob.near',
        '--key-suffix',
        'tags/rust',
        '--config',
        path,
      ],
      NO_ENV,
    );

    expect(result.code).toBe(0);
    expect(batchSpy).toHaveBeenCalledWith([
      { account_id: 'alice.near', keySuffixes: ['tags/rust'] },
      { account_id: 'bob.near', keySuffixes: ['tags/rust'] },
    ]);
  });
});
