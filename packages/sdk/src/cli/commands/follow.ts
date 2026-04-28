import { validationError } from '../../errors';
import { flagString, type ParsedArgv } from '../argv';
import { renderSingleOrBatch } from '../batch';
import { buildClient } from '../client-factory';
import type { CliStreams } from '../streams';

export async function follow(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<number> {
  const targets = parsed.positional;
  if (targets.length === 0) {
    throw validationError(
      'target',
      'usage: nearly follow <accountId> [<accountId>...] [--reason X]',
    );
  }

  const client = await buildClient(parsed.globals);
  const reason = flagString(parsed.flags.reason);
  const opts = reason ? { reason } : {};

  return renderSingleOrBatch({
    parsed,
    streams,
    targets,
    single: (t) => client.follow(t, opts),
    many: (ts) => client.followMany(ts, opts),
    singleKeys: (r) => [
      ['action', r.action],
      ['target', r.target],
    ],
    detail: () => '',
  });
}
