import { LIMITS } from './constants';
import type { NearlyError } from './errors';
import { validationError } from './errors';

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

export function validateReason(reason: string): NearlyError | null {
  if (reason.length > LIMITS.REASON_MAX) {
    return validationError('reason', `max ${LIMITS.REASON_MAX} bytes`);
  }
  return checkUnsafeUnicode('reason', reason, true);
}
