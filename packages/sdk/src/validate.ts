import { z } from 'zod';
import { LIMITS } from './constants';
import type { NearlyError } from './errors';
import { validationError } from './errors';

// All `validate*` functions in this file return `NearlyError | null` —
// `null` means valid, a returned `NearlyError` means invalid. The polarity
// is unintuitive (truthy result = failure, not success); guard against
// inverting it when calling. `validateTags` is the exception: it returns
// `{ validated, error }` because it normalizes input.

/**
 * Reject control chars, bidi overrides, and zero-width chars.
 * `allowNewline` permits U+000A for multi-line fields like reason text.
 */
function isUnsafeChar(c: number): boolean {
  if (c < 0x20 && c !== 0x0a) return true;
  if (c === 0x7f) return true;
  if (c >= 0x200b && c <= 0x200f) return true;
  if (c >= 0x202a && c <= 0x202e) return true;
  if (c >= 0x2066 && c <= 0x2069) return true;
  if (c === 0xfeff) return true;
  return false;
}

function checkUnsafeUnicode(
  field: string,
  s: string,
  allowNewline: boolean,
): NearlyError | null {
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (allowNewline && code === 0x0a) continue;
    if (isUnsafeChar(code)) {
      return validationError(
        field,
        `invalid character U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
      );
    }
  }
  return null;
}

const ReasonSchema = z
  .string()
  .max(LIMITS.REASON_MAX, `max ${LIMITS.REASON_MAX} bytes`);

export function validateReason(reason: string): NearlyError | null {
  const result = ReasonSchema.safeParse(reason);
  if (!result.success) {
    return validationError(
      'reason',
      result.error.issues[0]?.message ?? 'invalid',
    );
  }
  return checkUnsafeUnicode('reason', reason, true);
}

const NameSchema = z
  .string()
  .max(LIMITS.AGENT_NAME_MAX, `max ${LIMITS.AGENT_NAME_MAX} characters`)
  .refine((s) => s.trim().length > 0, 'must not be blank');

export function validateName(name: string): NearlyError | null {
  const result = NameSchema.safeParse(name);
  if (!result.success) {
    return validationError(
      'name',
      result.error.issues[0]?.message ?? 'invalid',
    );
  }
  return checkUnsafeUnicode('name', name, false);
}

const DescriptionSchema = z
  .string()
  .max(LIMITS.DESCRIPTION_MAX, `max ${LIMITS.DESCRIPTION_MAX} bytes`);

export function validateDescription(desc: string): NearlyError | null {
  const result = DescriptionSchema.safeParse(desc);
  if (!result.success) {
    return validationError(
      'description',
      result.error.issues[0]?.message ?? 'invalid',
    );
  }
  return checkUnsafeUnicode('description', desc, true);
}

/** Private-host detection — refuses localhost, RFC-1918, link-local, IPv6
 *  private ranges, and common decimal/octal/hex IP obfuscations. Ported
 *  from the frontend's `isPrivateHost` to keep the SSRF guard identical
 *  between the HTTP proxy path and the SDK's direct-OutLayer path. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();

  if (h === 'localhost' || h === '0.0.0.0' || h === '::' || h === '::1')
    return true;

  if (h.includes(':')) {
    const stripped = h.replace(/[0:]/g, '');
    if (stripped === '' || stripped === '1') return true;
  }

  if (h.startsWith('127.')) return true;
  if (h.startsWith('169.254.')) return true;
  if (h.startsWith('10.')) return true;
  if (h.startsWith('192.168.')) return true;

  if (h.startsWith('172.')) {
    const second = h.split('.')[1];
    if (second !== undefined) {
      const oct = parseInt(second, 10);
      if (oct >= 16 && oct <= 31) return true;
    }
  }

  if (h.endsWith('.local') || h.endsWith('.internal')) return true;

  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  if (h.startsWith('fc00:')) return true;
  if (h.startsWith('fd') && h.includes(':')) return true;

  if (h.startsWith('::ffff:10.')) return true;
  if (h.startsWith('::ffff:127.')) return true;
  if (h.startsWith('::ffff:169.254.')) return true;
  if (h.startsWith('::ffff:192.168.')) return true;
  if (h.startsWith('::ffff:172.')) {
    const rest = h.slice(7);
    if (rest.startsWith('172.')) {
      const second = rest.split('.')[1];
      if (second !== undefined) {
        const oct = parseInt(second, 10);
        if (oct >= 16 && oct <= 31) return true;
      }
    }
  }

  if (/^\d+$/.test(h)) return true;
  if (/^0x[0-9a-f]+$/i.test(h)) return true;
  if (h.includes('.')) {
    const segs = h.split('.');
    if (
      segs.every((s) => s.length > 0 && /^[0-7]+$/.test(s)) &&
      segs.some((s) => s.length > 1 && s.startsWith('0'))
    )
      return true;
  }

  return false;
}

function extractHostname(url: string): string {
  const afterScheme = url.slice('https://'.length);
  const authority = afterScheme.split('/')[0] ?? '';
  if (authority.startsWith('[')) {
    return (authority.split(']')[0] ?? '').slice(1);
  }
  return authority.split(':')[0] ?? '';
}

const ImageUrlSchema = z
  .string()
  .max(LIMITS.IMAGE_URL_MAX, `max ${LIMITS.IMAGE_URL_MAX} bytes`)
  .superRefine((url, ctx) => {
    if (!url.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', message: 'must use https://' });
      return;
    }
    const authority = url.slice('https://'.length).split('/')[0] ?? '';
    if (authority.includes('@')) {
      ctx.addIssue({ code: 'custom', message: 'must not contain credentials' });
      return;
    }
    const hostname = extractHostname(url);
    if (!hostname) {
      ctx.addIssue({ code: 'custom', message: 'must have a valid host' });
      return;
    }
    if (isPrivateHost(hostname)) {
      ctx.addIssue({
        code: 'custom',
        message: 'must not point to local or internal hosts',
      });
    }
  });

export function validateImageUrl(url: string): NearlyError | null {
  const result = ImageUrlSchema.safeParse(url);
  if (!result.success) {
    return validationError(
      'image',
      result.error.issues[0]?.message ?? 'invalid',
    );
  }
  return checkUnsafeUnicode('image', url, false);
}

const TagsArraySchema = z
  .array(z.string())
  .max(LIMITS.MAX_TAGS, `max ${LIMITS.MAX_TAGS} tags`);

const SingleTagSchema = z
  .string()
  .min(1, 'tag must not be empty')
  .max(
    LIMITS.MAX_TAG_LEN,
    `tag must be at most ${LIMITS.MAX_TAG_LEN} characters`,
  )
  .refine(
    (t) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(t),
    'tags must be lowercase alphanumeric with interior hyphens (no leading or trailing hyphens)',
  );

/**
 * Matches the frontend's `validateTags` wire shape exactly — round-trip
 * tag storage is identical whether written via proxy or SDK.
 */
export function validateTags(
  tags: readonly string[],
):
  | { validated: string[]; error: null }
  | { validated: string[]; error: NearlyError } {
  const arrResult = TagsArraySchema.safeParse(tags);
  if (!arrResult.success) {
    return {
      validated: [],
      error: validationError(
        'tags',
        arrResult.error.issues[0]?.message ?? 'invalid',
      ),
    };
  }
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const tag of tags) {
    const t = tag.toLowerCase();
    const tagResult = SingleTagSchema.safeParse(t);
    if (!tagResult.success) {
      return {
        validated: [],
        error: validationError(
          'tags',
          tagResult.error.issues[0]?.message ?? 'invalid',
        ),
      };
    }
    if (!seen.has(t)) {
      seen.add(t);
      validated.push(t);
    }
  }
  return { validated, error: null };
}

function validateCapabilitiesContent(
  val: unknown,
  depth: number,
): NearlyError | null {
  if (depth > LIMITS.MAX_CAPABILITY_DEPTH) {
    return validationError(
      'capabilities',
      `exceed maximum nesting depth of ${LIMITS.MAX_CAPABILITY_DEPTH}`,
    );
  }
  if (typeof val === 'string') {
    const u = checkUnsafeUnicode('capabilities', val, false);
    if (u) return u;
    if (val.includes(':') || val.includes('/')) {
      return validationError(
        'capabilities',
        'value must not contain colons or slashes',
      );
    }
  } else if (Array.isArray(val)) {
    for (const item of val) {
      const e = validateCapabilitiesContent(item, depth + 1);
      if (e) return e;
    }
  } else if (typeof val === 'object' && val !== null) {
    for (const [key, child] of Object.entries(val)) {
      const u = checkUnsafeUnicode('capabilities', key, false);
      if (u) return u;
      if (key.includes(':') || key.includes('/')) {
        return validationError(
          'capabilities',
          'key must not contain colons or slashes',
        );
      }
      const e = validateCapabilitiesContent(child, depth + 1);
      if (e) return e;
    }
  }
  return null;
}

const CapabilitiesSchema = z
  .record(z.string(), z.unknown())
  .superRefine((caps, ctx) => {
    if (JSON.stringify(caps).length > LIMITS.CAPABILITIES_MAX) {
      ctx.addIssue({
        code: 'custom',
        message: `max ${LIMITS.CAPABILITIES_MAX} bytes`,
      });
    }
  });

export function validateCapabilities(caps: unknown): NearlyError | null {
  const result = CapabilitiesSchema.safeParse(caps);
  if (!result.success) {
    const issue = result.error.issues[0];
    const message =
      issue?.code === 'custom'
        ? (issue.message ?? 'invalid')
        : 'must be a JSON object';
    return validationError('capabilities', message);
  }
  return validateCapabilitiesContent(caps, 0);
}

const KeySuffixSchema = z
  .string()
  .min(1, 'must not be empty')
  .refine((s) => !s.startsWith('/'), 'must not start with /');

/**
 * Generic — any handler composing a FastData key from a convention
 * prefix plus a caller-supplied tail uses this.
 */
export function validateKeySuffix(
  keySuffix: string,
  keyPrefix: string,
): NearlyError | null {
  const result = KeySuffixSchema.safeParse(keySuffix);
  if (!result.success) {
    return validationError(
      'key_suffix',
      result.error.issues[0]?.message ?? 'invalid',
    );
  }
  const u = checkUnsafeUnicode('key_suffix', keySuffix, false);
  if (u) return u;
  const fullKey = `${keyPrefix}${keySuffix}`;
  if (fullKey.includes('\0')) {
    return validationError('key_suffix', 'key must not contain null bytes');
  }
  // TextEncoder is browser+Node native; avoids Node-only Buffer.
  const byteLen = new TextEncoder().encode(fullKey).length;
  if (byteLen > LIMITS.FASTDATA_MAX_KEY_BYTES) {
    return validationError(
      'key_suffix',
      `key_prefix + key_suffix exceeds ${LIMITS.FASTDATA_MAX_KEY_BYTES}-byte limit`,
    );
  }
  return null;
}
