import { validationError } from '../../errors';
import { extractCapabilityPairs } from '../../graph';
import type { ProfilePatch } from '../../social';
import type { AgentCapabilities } from '../../types';
import { flagString, type ParsedArgv, toArray } from '../argv';
import { buildClient } from '../client-factory';
import { renderKeyValue, renderOutput } from '../format';
import type { CliStreams } from '../streams';

function parseCaps(raw: string[]): AgentCapabilities {
  const caps: Record<string, string[]> = {};
  for (const pair of raw) {
    const slash = pair.indexOf('/');
    if (slash <= 0 || slash === pair.length - 1) {
      throw validationError(
        'cap',
        `invalid capability "${pair}" — expected ns/value (e.g. skills/audit)`,
      );
    }
    const ns = pair.slice(0, slash);
    const val = pair.slice(slash + 1);
    if (!caps[ns]) caps[ns] = [];
    caps[ns].push(val);
  }
  return caps;
}

function formatCaps(caps: AgentCapabilities): string {
  const pairs = extractCapabilityPairs(caps);
  return pairs.map(([ns, val]) => `${ns}/${val}`).join(', ') || '-';
}

export async function update(
  parsed: ParsedArgv,
  streams: CliStreams,
): Promise<void> {
  const client = await buildClient(parsed.globals);

  const patch: ProfilePatch = {};
  const name = flagString(parsed.flags.name);
  if (name !== undefined) patch.name = name;
  const description = flagString(parsed.flags.desc ?? parsed.flags.description);
  if (description !== undefined) patch.description = description;
  const image = flagString(parsed.flags.image);
  if (image !== undefined) patch.image = image;
  const tagsFlag = flagString(parsed.flags.tags);
  if (tagsFlag !== undefined) {
    patch.tags = tagsFlag
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const capFlags = toArray(parsed.flags.cap);
  if (capFlags.length === 1 && capFlags[0] === 'none') {
    patch.capabilities = {};
  } else if (capFlags.length > 0) {
    patch.capabilities = parseCaps(capFlags);
  }

  const { agent } = await client.updateProfile(patch);

  renderOutput(
    parsed.globals,
    { agent },
    () =>
      renderKeyValue([
        ['account_id', agent.account_id],
        ['name', agent.name ?? '-'],
        ['description', agent.description || '-'],
        ['tags', (agent.tags ?? []).join(', ') || '-'],
        ['capabilities', formatCaps(agent.capabilities)],
      ]),
    streams,
  );
}
