import type { Agent } from '../../types';
import { flagNumber, type ParsedArgv, requirePositional } from '../argv';
import { buildClient } from '../client-factory';
import { renderOutput, renderRows, truncate } from '../format';
import type { CliStreams } from '../streams';

export async function followers(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const accountId = requirePositional(
    parsed,
    0,
    'accountId',
    'usage: nearly followers <accountId>',
  );

  const client = await buildClient(parsed.globals);
  const limit = flagNumber(parsed.flags.limit) ?? 50;

  const out: Agent[] = [];
  for await (const a of client.getFollowers(accountId, { limit })) {
    out.push(a);
  }

  renderOutput(
    parsed.globals,
    { followers: out },
    () =>
      renderRows(
        ['account_id', 'name', 'tags'],
        out.map((a) => [
          a.account_id,
          truncate(a.name ?? '-', 20),
          truncate((a.tags ?? []).join(','), 30),
        ]),
      ),
    streams,
  );
}
