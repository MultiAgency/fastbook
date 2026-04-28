import { validationError } from '../../errors';
import { flagString, type ParsedArgv, toArray } from '../argv';
import { renderSingleOrBatch } from '../batch';
import { buildClient } from '../client-factory';
import type { CliStreams } from '../streams';

export async function endorse(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<number> {
  const targets = parsed.positional;
  if (targets.length === 0) {
    throw validationError(
      'target',
      'usage: nearly endorse <accountId> [<accountId>...] --key-suffix X [--key-suffix Y] [--reason X]',
    );
  }

  const keySuffixes = toArray(parsed.flags['key-suffix']);
  if (keySuffixes.length === 0) {
    throw validationError(
      'key-suffix',
      'at least one --key-suffix is required',
    );
  }

  const reason = flagString(parsed.flags.reason);
  const contentHash = flagString(parsed.flags['content-hash']);
  const opts = {
    keySuffixes,
    ...(reason ? { reason } : {}),
    ...(contentHash ? { contentHash } : {}),
  };

  const client = await buildClient(parsed.globals);
  return renderSingleOrBatch({
    parsed,
    streams,
    targets,
    single: (t) => client.endorse(t, opts),
    many: (ts) =>
      client.endorseMany(ts.map((account_id) => ({ account_id, ...opts }))),
    singleKeys: (r) => [
      ['action', r.action],
      ['target', r.target],
      ['key_suffixes', r.key_suffixes.join(', ')],
    ],
    detail: (r) => r.key_suffixes.join(', '),
  });
}
