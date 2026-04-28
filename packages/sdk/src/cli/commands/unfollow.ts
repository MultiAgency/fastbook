import { validationError } from '../../errors';
import type { ParsedArgv } from '../argv';
import { renderSingleOrBatch } from '../batch';
import { buildClient } from '../client-factory';
import type { CliStreams } from '../streams';

export async function unfollow(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<number> {
  const targets = parsed.positional;
  if (targets.length === 0) {
    throw validationError(
      'target',
      'usage: nearly unfollow <accountId> [<accountId>...]',
    );
  }

  const client = await buildClient(parsed.globals);
  return renderSingleOrBatch({
    parsed,
    streams,
    targets,
    single: (t) => client.unfollow(t),
    many: (ts) => client.unfollowMany(ts),
    singleKeys: (r) => [
      ['action', r.action],
      ['target', r.target],
    ],
    detail: () => '',
  });
}
