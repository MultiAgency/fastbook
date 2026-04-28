import { readFileSync } from 'node:fs';
import { NearlyClient } from '../../client';
import { DEFAULT_OUTLAYER_URL } from '../../constants';
import { saveCredentials } from '../../credentials';
import { validationError } from '../../errors';
import { createDeterministicWallet, mintDelegateKey } from '../../wallet';
import type { ParsedArgv } from '../argv';
import { flagString } from '../argv';
import { renderJson, renderKeyValue } from '../format';
import type { CliStreams } from '../streams';

// --private-key / --key via argv are explicit errors; shell history + ps-visible args leak. Use --key-file.
export async function register(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  if (
    parsed.flags['private-key'] !== undefined ||
    parsed.flags.key !== undefined
  ) {
    throw validationError(
      'privateKey',
      '--private-key / --key via argv is a security risk (shell history, ps-visible). Use --key-file <path>.',
    );
  }

  const deterministic = parsed.flags.deterministic === true;
  if (deterministic) {
    return runDeterministic(parsed, streams);
  }

  const detFlags = [
    'account-id',
    'seed',
    'key-file',
    'outlayer-url',
    'no-mint-key',
  ] as const;
  const present = detFlags.filter((k) => parsed.flags[k] !== undefined);
  if (present.length > 0) {
    throw validationError(
      'deterministic',
      `--${present.join(', --')} requires --deterministic (anonymous mode takes no flags of its own)`,
    );
  }

  return runAnonymous(parsed, streams);
}

async function runAnonymous(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const result = await NearlyClient.register();

  await saveCredentials(
    { account_id: result.accountId, api_key: result.walletKey },
    parsed.globals.config,
  );

  if (parsed.globals.quiet) return;

  if (parsed.globals.json) {
    streams.stdout(
      renderJson({
        accountId: result.accountId,
        trial: result.trial,
        ...(result.handoffUrl ? { handoffUrl: result.handoffUrl } : {}),
      }),
    );
    return;
  }

  const rows: Array<[string, string]> = [
    ['account_id', result.accountId],
    ['trial_calls_remaining', String(result.trial.calls_remaining)],
  ];
  if (result.trial.expires_at) {
    rows.push(['trial_expires_at', result.trial.expires_at]);
  }
  if (result.handoffUrl) {
    rows.push(['wallet_management', result.handoffUrl]);
  }
  streams.stdout(renderKeyValue(rows));
  streams.stderr(
    'Credentials saved. Fund the wallet, then run `nearly heartbeat`.\n',
  );
}

async function runDeterministic(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const accountId = flagString(parsed.flags['account-id']);
  const seed = flagString(parsed.flags.seed);
  const keyFile = flagString(parsed.flags['key-file']);

  if (!accountId) {
    throw validationError('accountId', '--deterministic requires --account-id');
  }
  if (!seed) {
    throw validationError('seed', '--deterministic requires --seed');
  }
  if (!keyFile) {
    throw validationError('keyFile', '--deterministic requires --key-file');
  }

  let privateKey: string;
  try {
    privateKey = readFileSync(keyFile, 'utf8').trim();
  } catch (err) {
    throw validationError(
      'keyFile',
      `cannot read key file: ${(err as { code?: string }).code ?? 'read error'}`,
    );
  }
  if (!privateKey) {
    throw validationError(
      'keyFile',
      'key file is empty after trimming whitespace',
    );
  }

  const outlayerUrl =
    flagString(parsed.flags['outlayer-url']) ?? DEFAULT_OUTLAYER_URL;
  const skipMint = parsed.flags['no-mint-key'] === true;

  const provisioned = await createDeterministicWallet({
    outlayerUrl,
    accountId,
    seed,
    privateKey,
  });

  let minted: Awaited<ReturnType<typeof mintDelegateKey>> | null = null;
  let mintError: unknown = null;
  if (!skipMint) {
    try {
      minted = await mintDelegateKey({
        outlayerUrl,
        accountId,
        seed,
        privateKey,
      });
    } catch (err) {
      mintError = err;
    }
  }

  if (parsed.globals.quiet) {
    if (mintError) throw mintError;
    return;
  }

  if (parsed.globals.json) {
    if (mintError) throw mintError;
    streams.stdout(
      renderJson({
        walletId: provisioned.walletId,
        nearAccountId: provisioned.nearAccountId,
        trial: provisioned.trial,
        ...(provisioned.handoffUrl
          ? { handoffUrl: provisioned.handoffUrl }
          : {}),
        ...(minted ? { walletKey: minted.walletKey } : {}),
      }),
    );
    return;
  }

  const rows: Array<[string, string]> = [
    ['wallet_id', provisioned.walletId],
    ['near_account_id', provisioned.nearAccountId],
  ];
  if (provisioned.trial) {
    rows.push([
      'trial_calls_remaining',
      String(provisioned.trial.calls_remaining),
    ]);
    if (provisioned.trial.expires_at) {
      rows.push(['trial_expires_at', provisioned.trial.expires_at]);
    }
  }
  if (provisioned.handoffUrl) {
    rows.push(['wallet_management', provisioned.handoffUrl]);
  }
  if (minted) {
    rows.push(['wallet_key', minted.walletKey]);
  }
  streams.stdout(renderKeyValue(rows));
  streams.stderr(
    minted
      ? 'Deterministic wallet provisioned and delegate wk_ minted. Save the wallet_key securely — it is the only mutable credential for this derived wallet.\n'
      : mintError
        ? 'Deterministic wallet provisioned, but delegate-key minting failed. The wallet exists at OutLayer; retry `nearly register --deterministic` with the same inputs to mint.\n'
        : 'Deterministic wallet provisioned (--no-mint-key). No delegate wk_ issued — manage your NEAR key externally.\n',
  );
  if (mintError) throw mintError;
}
