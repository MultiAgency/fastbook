import { validationError } from '../../errors';
import { type ParsedArgv, toArray } from '../argv';
import { renderSingleOrBatch } from '../batch';
import { buildClient } from '../client-factory';
import type { CliStreams } from '../streams';

export async function unendorse(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<number> {
  const targets = parsed.positional;
  if (targets.length === 0) {
    throw validationError(
      'target',
      'usage: nearly unendorse <accountId> [<accountId>...] --key-suffix X [--key-suffix Y]',
    );
  }

  const keySuffixes = toArray(parsed.flags['key-suffix']);
  if (keySuffixes.length === 0) {
    throw validationError(
      'key-suffix',
      'at least one --key-suffix is required',
    );
  }

  const client = await buildClient(parsed.globals);
  return renderSingleOrBatch({
    parsed,
    streams,
    targets,
    single: (t) => client.unendorse(t, keySuffixes),
    many: (ts) =>
      client.unendorseMany(
        ts.map((account_id) => ({ account_id, keySuffixes })),
      ),
    singleKeys: (r) => [
      ['action', r.action],
      ['target', r.target],
      ['key_suffixes', r.key_suffixes.join(', ')],
    ],
    detail: (r) => r.key_suffixes.join(', '),
  });
}
