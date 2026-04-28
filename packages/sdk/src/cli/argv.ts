import { validationError } from '../errors';

export interface ParsedGlobals {
  json: boolean;
  quiet: boolean;
  yes: boolean;
  config?: string;
  account?: string;
}

export interface ParsedArgv {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
  globals: ParsedGlobals;
}

const GLOBAL_KEYS = new Set(['json', 'quiet', 'yes', 'config', 'account']);

function assignFlag(
  flags: Record<string, string | boolean | string[]>,
  key: string,
  value: string | boolean,
): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
    return;
  }
  if (typeof existing === 'boolean' || typeof value === 'boolean') {
    flags[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  flags[key] = [existing, value];
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let command = '';
  let sawDoubleDash = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (sawDoubleDash) {
      if (!command) command = token;
      else positional.push(token);
      continue;
    }

    if (token === '--') {
      sawDoubleDash = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        assignFlag(flags, body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        assignFlag(flags, body, true);
      } else {
        assignFlag(flags, body, next);
        i++;
      }
      continue;
    }

    if (!command) {
      command = token;
    } else {
      positional.push(token);
    }
  }

  const globals: ParsedGlobals = {
    json: flags.json === true,
    quiet: flags.quiet === true,
    yes: flags.yes === true,
    config: typeof flags.config === 'string' ? flags.config : undefined,
    account: typeof flags.account === 'string' ? flags.account : undefined,
  };

  for (const key of GLOBAL_KEYS) delete flags[key];

  return { command, positional, flags, globals };
}

export function toArray(
  value: string | boolean | string[] | undefined,
): string[] {
  if (value === undefined || value === true || value === false) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

export function flagString(
  value: string | boolean | string[] | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function flagNumber(
  value: string | boolean | string[] | undefined,
): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function requirePositional(
  parsed: ParsedArgv,
  index: number,
  field: string,
  usage: string,
): string {
  const value = parsed.positional[index];
  if (!value) throw validationError(field, usage);
  return value;
}
