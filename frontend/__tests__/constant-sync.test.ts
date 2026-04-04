import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HANDLE_RE, LIMITS, RESERVED_HANDLES } from '@/lib/constants';

const rsSource = readFileSync(
  resolve(__dirname, '../../wasm/src/types.rs'),
  'utf8',
);

function rsConst(name: string): number {
  const m = rsSource.match(
    new RegExp(`const\\s+${name}[^=]*=\\s*(\\d[\\d_]*)`, 'm'),
  );
  if (!m)
    throw new Error(`Rust constant ${name} not found in wasm/src/types.rs`);
  return Number(m[1].replace(/_/g, ''));
}

function rsReservedHandles(): Set<string> {
  const block = rsSource.match(/RESERVED_HANDLES[^=]*=\s*&\[([\s\S]*?)];/);
  if (!block)
    throw new Error('RESERVED_HANDLES not found in wasm/src/types.rs');
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
}

describe('Frontend ↔ Rust constant sync', () => {
  it.each([
    ['AGENT_HANDLE_MAX', 'MAX_HANDLE_LEN'],
    ['AGENT_HANDLE_MIN', 'MIN_HANDLE_LEN'],
    ['DESCRIPTION_MAX', 'MAX_DESCRIPTION_LEN'],
    ['AVATAR_URL_MAX', 'MAX_AVATAR_URL_LEN'],
    ['CAPABILITIES_MAX', 'MAX_CAPABILITIES_LEN'],
    // DEFAULT_LIMIT and MAX_LIMIT removed: pagination now handled by FastData KV.
  ] as const)('LIMITS.%s matches Rust %s', (tsKey, rsKey) => {
    expect(LIMITS[tsKey]).toBe(rsConst(rsKey));
  });

  it.each([
    ['MAX_TAGS', 10],
    ['MAX_TAG_LEN', 30],
    ['MAX_REASON_LEN', 280],
    ['MAX_SUGGESTION_LIMIT', 50],
    ['DEREGISTER_RATE_LIMIT', 1],
    ['DEREGISTER_RATE_WINDOW_SECS', 300],
  ] as const)('Rust %s is %d', (rsKey, expected) => {
    expect(rsConst(rsKey)).toBe(expected);
  });

  it('reserved handles match Rust', () => {
    const rust = rsReservedHandles();
    const onlyInTs = [...RESERVED_HANDLES].filter((h) => !rust.has(h));
    const onlyInRust = [...rust].filter((h) => !RESERVED_HANDLES.has(h));
    expect(onlyInTs).toEqual([]);
    expect(onlyInRust).toEqual([]);
  });

  // VALID_SORTS test removed: SortKey::parse moved to FastData KV.
  // Sort validation is now a frontend-only concern.

  // VALID_DIRECTIONS test removed: get_edges handler moved to FastData KV.
  // Directions are now validated in the frontend route only.

  it('HANDLE_RE enforces LIMITS boundaries', () => {
    const min = LIMITS.AGENT_HANDLE_MIN;
    const max = LIMITS.AGENT_HANDLE_MAX;
    expect(HANDLE_RE.test('a'.repeat(min - 1))).toBe(false);
    expect(HANDLE_RE.test('a'.repeat(min))).toBe(true);
    expect(HANDLE_RE.test('a'.repeat(max))).toBe(true);
    expect(HANDLE_RE.test('a'.repeat(max + 1))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RESPONSE comment ↔ OpenAPI sync
// ---------------------------------------------------------------------------

const HANDLER_DIR = resolve(__dirname, '../../wasm/src/handlers');
const OPENAPI_PATH = resolve(__dirname, '../public/openapi.json');

// Maps WASM handler function names to action strings.
// Read-only handlers moved to FastData KV are omitted — they no longer
// have RESPONSE comments in the WASM handler files.
const HANDLER_TO_ACTION: Record<string, string> = {
  handle_register: 'register',
  handle_get_me: 'get_me',
  handle_update_me: 'update_me',
  handle_get_notifications: 'get_notifications',
  handle_read_notifications: 'read_notifications',
};

// Handlers with RESPONSE comments but intentionally excluded from openapi.json
// (admin-only actions documented in AGENTS.md only).
const EXCLUDED_HANDLERS = new Set(['handle_set_platforms']);

// Maps action strings to OpenAPI paths.
// Read-only actions served by FastData KV are still in OpenAPI (routes exist)
// but no longer have WASM handler RESPONSE comments to validate against.
const ACTION_TO_PATH: Record<string, [string, string]> = {
  register: ['post', '/agents/register'],
  get_me: ['get', '/agents/me'],
  update_me: ['patch', '/agents/me'],
  get_notifications: ['get', '/agents/me/notifications'],
  read_notifications: ['post', '/agents/me/notifications/read'],
};

function extractResponseComments(): {
  handler: string;
  file: string;
  comment: string;
}[] {
  const results: { handler: string; file: string; comment: string }[] = [];
  for (const f of readdirSync(HANDLER_DIR).filter((f) => f.endsWith('.rs'))) {
    const src = readFileSync(join(HANDLER_DIR, f), 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('// RESPONSE:')) {
        // Collect multi-line comment
        let comment = lines[i].replace(/.*\/\/ RESPONSE:\s*/, '');
        let j = i + 1;
        while (
          j < lines.length &&
          lines[j].match(/^\s*\/\/\s/) &&
          !lines[j].includes('pub fn')
        ) {
          comment += ` ${lines[j].replace(/^\s*\/\/\s*/, '')}`;
          j++;
        }
        // Find the pub fn on the next non-comment line
        while (j < lines.length && !lines[j].includes('pub fn')) j++;
        const fnMatch = lines[j]?.match(/pub(?:\(crate\))?\s+fn\s+(\w+)/);
        if (fnMatch) {
          results.push({
            handler: fnMatch[1],
            file: f,
            comment: comment.trim(),
          });
        }
      }
    }
  }
  return results;
}

describe('RESPONSE comments ↔ OpenAPI sync', () => {
  const comments = extractResponseComments();
  const openapi = JSON.parse(readFileSync(OPENAPI_PATH, 'utf8'));

  it('every handler has a RESPONSE comment', () => {
    const documented = new Set(comments.map((c) => c.handler));
    const missing = Object.keys(HANDLER_TO_ACTION).filter(
      (h) => !documented.has(h),
    );
    expect(missing).toEqual([]);
  });

  it('every RESPONSE comment maps to a known action', () => {
    const unknown = comments.filter(
      (c) => !HANDLER_TO_ACTION[c.handler] && !EXCLUDED_HANDLERS.has(c.handler),
    );
    expect(unknown.map((c) => c.handler)).toEqual([]);
  });

  it('every action has an OpenAPI endpoint with a 200 response', () => {
    const missing: string[] = [];
    for (const c of comments) {
      const action = HANDLER_TO_ACTION[c.handler];
      if (!action) continue;
      const mapping = ACTION_TO_PATH[action];
      if (!mapping) {
        missing.push(`${action} (no path mapping)`);
        continue;
      }
      const [method, path] = mapping;
      const endpoint = openapi.paths?.[path]?.[method];
      if (!endpoint) {
        missing.push(`${method.toUpperCase()} ${path}`);
        continue;
      }
      const has200 = endpoint.responses?.['200'];
      if (!has200)
        missing.push(`${method.toUpperCase()} ${path} (no 200 response)`);
    }
    expect(missing).toEqual([]);
  });
});
