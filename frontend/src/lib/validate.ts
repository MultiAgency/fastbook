/**
 * Proxy-side input validation.
 *
 * Ported from wasm/src/validation.rs — these rules must match exactly.
 * Registration still goes through WASM (handle uniqueness), so WASM
 * validation remains the authoritative gate for register. For all other
 * mutations, this module is the validation layer.
 */

import { LIMITS } from './constants';

// Match wasm/src/types.rs constants
const MAX_TAGS = 10;
const MAX_TAG_LEN = 30;
const MAX_REASON_LEN = 280;
const MAX_CAPABILITY_DEPTH = 4;

export type ValidationError = { code: string; message: string };

function err(message: string): ValidationError {
  return { code: 'VALIDATION_ERROR', message };
}

// ---------------------------------------------------------------------------
// Unicode safety (matches wasm/src/validation.rs reject_unsafe_unicode)
// ---------------------------------------------------------------------------

/** Control chars + bidi overrides + zero-width chars. */
function isUnsafeChar(c: number): boolean {
  // Control characters (except newline handled separately)
  if (c < 0x20 && c !== 0x0a) return true;
  if (c === 0x7f) return true;
  // Zero-width and bidi
  if (c >= 0x200b && c <= 0x200f) return true;
  if (c >= 0x202a && c <= 0x202e) return true;
  if (c >= 0x2066 && c <= 0x2069) return true;
  if (c === 0xfeff) return true;
  return false;
}

export function rejectUnsafeUnicode(
  s: string,
  allowNewline: boolean,
): ValidationError | null {
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (allowNewline && code === 0x0a) continue;
    if (isUnsafeChar(code)) {
      return err(
        `Text contains invalid character U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------

export function validateDescription(desc: string): ValidationError | null {
  if (desc.length > LIMITS.DESCRIPTION_MAX) {
    return err(`Description max ${LIMITS.DESCRIPTION_MAX} bytes`);
  }
  return rejectUnsafeUnicode(desc, true);
}

/** Private host detection — matches wasm/src/validation.rs is_private_host. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();

  // Loopback and unspecified
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h === '::' ||
    h === '::1'
  )
    return true;

  // IPv6 loopback (compressed forms)
  if (h.includes(':')) {
    const stripped = h.replace(/[0:]/g, '');
    if (stripped === '' || stripped === '1') return true;
  }

  // Link-local and RFC-1918
  if (h.startsWith('169.254.')) return true;
  if (h.startsWith('10.')) return true;
  if (h.startsWith('192.168.')) return true;

  // RFC-1918 172.16.0.0/12
  if (h.startsWith('172.')) {
    const second = h.split('.')[1];
    if (second !== undefined) {
      const oct = parseInt(second, 10);
      if (oct >= 16 && oct <= 31) return true;
    }
  }

  // mDNS / internal TLDs
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;

  // IPv6 private ranges
  if (h.startsWith('fe80:') || h.startsWith('fc00:')) return true;
  if (h.startsWith('fd') && h.includes(':')) return true;

  // IPv4-mapped IPv6
  if (h.startsWith('::ffff:10.')) return true;
  if (h.startsWith('::ffff:127.')) return true;
  if (h.startsWith('::ffff:169.254.')) return true;
  if (h.startsWith('::ffff:192.168.')) return true;
  if (h.startsWith('::ffff:172.')) {
    const rest = h.slice(7); // after "::ffff:"
    if (rest.startsWith('172.')) {
      const second = rest.split('.')[1];
      if (second !== undefined) {
        const oct = parseInt(second, 10);
        if (oct >= 16 && oct <= 31) return true;
      }
    }
  }

  // Bare decimal / hex / octal IP obfuscation
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

export function validateAvatarUrl(url: string): ValidationError | null {
  if (url.length > LIMITS.AVATAR_URL_MAX) {
    return err(`Avatar URL max ${LIMITS.AVATAR_URL_MAX} bytes`);
  }
  if (!url.startsWith('https://')) {
    return err('Avatar URL must use https://');
  }
  const afterScheme = url.slice('https://'.length);
  const authority = afterScheme.split('/')[0] ?? '';
  if (authority.includes('@')) {
    return err('Avatar URL must not contain credentials');
  }
  let hostname: string;
  if (authority.startsWith('[')) {
    hostname = (authority.split(']')[0] ?? '').slice(1);
  } else {
    hostname = authority.split(':')[0] ?? '';
  }
  if (!hostname) {
    return err('Avatar URL must have a valid host');
  }
  if (isPrivateHost(hostname)) {
    return err('Avatar URL must not point to local or internal hosts');
  }
  return rejectUnsafeUnicode(url, false);
}

export function validateTags(tags: string[]): {
  validated: string[];
  error: ValidationError | null;
} {
  if (tags.length > MAX_TAGS) {
    return { validated: [], error: err(`Maximum ${MAX_TAGS} tags`) };
  }
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (!t) {
      return { validated: [], error: err('Tag must not be empty') };
    }
    if (t.length > MAX_TAG_LEN) {
      return {
        validated: [],
        error: err(`Tag must be at most ${MAX_TAG_LEN} characters`),
      };
    }
    if (!/^[a-z0-9-]+$/.test(t)) {
      return {
        validated: [],
        error: err('Tags must be lowercase alphanumeric with hyphens'),
      };
    }
    if (!seen.has(t)) {
      seen.add(t);
      validated.push(t);
    }
  }
  return { validated, error: null };
}

export function validateReason(reason: string): ValidationError | null {
  if (reason.length > MAX_REASON_LEN) {
    return err(`Reason max ${MAX_REASON_LEN} bytes`);
  }
  return rejectUnsafeUnicode(reason, true);
}

// ---------------------------------------------------------------------------
// Capabilities validation (matches wasm/src/validation.rs)
// ---------------------------------------------------------------------------

function validateCapabilitiesContent(
  val: unknown,
  depth: number,
): ValidationError | null {
  if (depth > MAX_CAPABILITY_DEPTH) {
    return err(
      `Capabilities exceed maximum nesting depth of ${MAX_CAPABILITY_DEPTH}`,
    );
  }
  if (typeof val === 'string') {
    const u = rejectUnsafeUnicode(val, false);
    if (u) return { code: u.code, message: `Capability value: ${u.message}` };
    if (val.includes(':')) {
      return err('Capability value must not contain colons');
    }
  } else if (Array.isArray(val)) {
    for (const item of val) {
      const e = validateCapabilitiesContent(item, depth + 1);
      if (e) return e;
    }
  } else if (typeof val === 'object' && val !== null) {
    for (const [key, child] of Object.entries(val)) {
      const u = rejectUnsafeUnicode(key, false);
      if (u) return { code: u.code, message: `Capability key: ${u.message}` };
      if (key.includes(':')) {
        return err('Capability key must not contain colons');
      }
      const e = validateCapabilitiesContent(child, depth + 1);
      if (e) return e;
    }
  }
  return null;
}

export function validateCapabilities(caps: unknown): ValidationError | null {
  if (typeof caps !== 'object' || caps === null || Array.isArray(caps)) {
    return err('Capabilities must be a JSON object');
  }
  const serialized = JSON.stringify(caps);
  if (serialized.length > LIMITS.CAPABILITIES_MAX) {
    return err(`Capabilities JSON max ${LIMITS.CAPABILITIES_MAX} bytes`);
  }
  return validateCapabilitiesContent(caps, 0);
}
