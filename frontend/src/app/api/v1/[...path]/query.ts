import type { NextResponse } from 'next/server';
import { errJson } from '@/lib/api-response';

const INT_FIELDS = new Set(['limit']);
const VALID_SORTS = new Set(['newest', 'active']);
const VALID_DIRECTIONS = new Set(['incoming', 'outgoing', 'both']);
const CURSOR_RE = /^[a-z0-9_.:-]{1,64}$|^\d{1,20}$/;

// Validate every allowed query param. Fail loud on *invalid* input rather
// than silently dropping — a silent-drop default masks bugs in caller
// code (e.g. `?tag=FOO!` would return an unfiltered list instead of
// erroring). Empty-string values are treated as "omitted" and skipped,
// matching the convention of `routeFor` callers that send blank filter
// inputs as `?tag=` rather than omitting the key. Any field listed in a
// route's queryFields must have an explicit branch here; there is no
// catch-all.
export function validateQueryParams(
  url: URL,
  allowedFields: readonly string[],
):
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; response: NextResponse } {
  const allowed = new Set(allowedFields);
  const params: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key)) continue;
    if (value === '') continue;
    if (INT_FIELDS.has(key)) {
      if (!/^\d+$/.test(value)) {
        return {
          ok: false,
          response: errJson(
            'VALIDATION_ERROR',
            `Invalid '${key}': must be a non-negative integer`,
            400,
          ),
        };
      }
      params[key] = parseInt(value, 10);
    } else if (key === 'sort') {
      if (!VALID_SORTS.has(value)) {
        return {
          ok: false,
          response: errJson(
            'VALIDATION_ERROR',
            `Invalid sort '${value}'. Valid values: ${[...VALID_SORTS].join(', ')}`,
            400,
          ),
        };
      }
      params[key] = value;
    } else if (key === 'cursor') {
      if (!CURSOR_RE.test(value)) {
        return {
          ok: false,
          response: errJson(
            'VALIDATION_ERROR',
            `Invalid cursor '${value}'`,
            400,
          ),
        };
      }
      params[key] = value;
    } else if (key === 'direction') {
      if (!VALID_DIRECTIONS.has(value)) {
        return {
          ok: false,
          response: errJson(
            'VALIDATION_ERROR',
            `Invalid direction '${value}'. Valid values: ${[...VALID_DIRECTIONS].join(', ')}`,
            400,
          ),
        };
      }
      params[key] = value;
    } else if (key === 'tag') {
      if (value.length > 30 || !/^[a-z0-9-]+$/.test(value)) {
        return {
          ok: false,
          response: errJson('VALIDATION_ERROR', `Invalid tag '${value}'`, 400),
        };
      }
      params[key] = value;
    } else if (key === 'capability') {
      // Format: ns/value (e.g. "skills/testing") — lowercase alphanumeric + dots, slashes, hyphens.
      if (value.length > 60 || !/^[a-z0-9._/-]+$/.test(value)) {
        return {
          ok: false,
          response: errJson(
            'VALIDATION_ERROR',
            `Invalid capability '${value}'`,
            400,
          ),
        };
      }
      params[key] = value;
    } else {
      return {
        ok: false,
        response: errJson(
          'VALIDATION_ERROR',
          `Unsupported query parameter '${key}'`,
          400,
        ),
      };
    }
  }
  return { ok: true, params };
}
