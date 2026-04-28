import { LIMITS } from '../src/constants';
import {
  validateCapabilities,
  validateDescription,
  validateImageUrl,
  validateKeySuffix,
  validateName,
  validateReason,
  validateTags,
} from '../src/validate';

describe('validateReason', () => {
  it('accepts a short reason', () => {
    expect(validateReason('good agent')).toBeNull();
  });

  it('allows newlines', () => {
    expect(validateReason('line1\nline2')).toBeNull();
  });

  it('rejects reason exceeding max length', () => {
    const long = 'a'.repeat(LIMITS.REASON_MAX + 1);
    expect(validateReason(long)?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects control characters', () => {
    expect(validateReason('bad\x00char')?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects bidi overrides', () => {
    expect(validateReason('bidi\u202Eoverride')?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects zero-width chars', () => {
    expect(validateReason('zero\u200Bwidth')?.code).toBe('VALIDATION_ERROR');
  });
});

describe('validateName', () => {
  it('accepts a valid name', () => {
    expect(validateName('Alice')).toBeNull();
  });

  it('rejects blank name', () => {
    const err = validateName('   ');
    expect(err?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects name exceeding max', () => {
    const long = 'x'.repeat(LIMITS.AGENT_NAME_MAX + 1);
    expect(validateName(long)?.code).toBe('VALIDATION_ERROR');
  });

  it('accepts newlines', () => {
    expect(validateName('Alice\nBob')).toBeNull();
  });
});

describe('validateDescription', () => {
  it('accepts a valid description', () => {
    expect(validateDescription('A helpful agent')).toBeNull();
  });

  it('allows newlines', () => {
    expect(validateDescription('line1\nline2')).toBeNull();
  });

  it('rejects description exceeding max', () => {
    const long = 'd'.repeat(LIMITS.DESCRIPTION_MAX + 1);
    expect(validateDescription(long)?.code).toBe('VALIDATION_ERROR');
  });
});

describe('validateImageUrl', () => {
  it('accepts valid https URL', () => {
    expect(validateImageUrl('https://example.com/avatar.png')).toBeNull();
  });

  it('rejects non-https URL', () => {
    expect(validateImageUrl('http://example.com/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects URL exceeding max length', () => {
    const long = `https://example.com/${'a'.repeat(LIMITS.IMAGE_URL_MAX)}`;
    expect(validateImageUrl(long)?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects URLs with credentials (@)', () => {
    expect(
      validateImageUrl('https://user:pass@example.com/img.png')?.code,
    ).toBe('VALIDATION_ERROR');
  });

  it('rejects localhost', () => {
    expect(validateImageUrl('https://localhost/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects 127.x.x.x', () => {
    expect(validateImageUrl('https://127.0.0.1/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects RFC-1918 10.x', () => {
    expect(validateImageUrl('https://10.0.0.1/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects RFC-1918 192.168.x', () => {
    expect(validateImageUrl('https://192.168.1.1/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects RFC-1918 172.16-31.x', () => {
    expect(validateImageUrl('https://172.16.0.1/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects .local domains', () => {
    expect(validateImageUrl('https://myhost.local/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects decimal IP obfuscation', () => {
    expect(validateImageUrl('https://2130706433/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects hex IP obfuscation', () => {
    expect(validateImageUrl('https://0x7f000001/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects IPv6 loopback ::1', () => {
    expect(validateImageUrl('https://::1/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects 0.0.0.0', () => {
    expect(validateImageUrl('https://0.0.0.0/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects cloud metadata IP (169.254.169.254)', () => {
    expect(validateImageUrl('https://169.254.169.254/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects octal IP obfuscation', () => {
    expect(validateImageUrl('https://0177.0.0.01/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects IPv4-mapped IPv6 for private ranges', () => {
    expect(validateImageUrl('https://[::ffff:10.0.0.1]/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(validateImageUrl('https://[::ffff:192.168.1.1]/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      validateImageUrl('https://[::ffff:169.254.169.254]/img.png')?.code,
    ).toBe('VALIDATION_ERROR');
  });

  it('rejects IPv6 private (fd00:)', () => {
    expect(validateImageUrl('https://[fd00::1]/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects .internal TLD', () => {
    expect(validateImageUrl('https://host.internal/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects URL with zero-width chars', () => {
    expect(validateImageUrl('https://exam​ple.com/img.png')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });
});

describe('validateTags', () => {
  it('accepts valid tags and deduplicates', () => {
    const result = validateTags(['rust', 'Rust', 'go']);
    expect(result.error).toBeNull();
    expect(result.validated).toEqual(['rust', 'go']);
  });

  it('rejects too many tags', () => {
    const tags = Array.from({ length: LIMITS.MAX_TAGS + 1 }, (_, i) => `t${i}`);
    expect(validateTags(tags).error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects empty tag', () => {
    expect(validateTags(['']).error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects tag exceeding max length', () => {
    const long = 'a'.repeat(LIMITS.MAX_TAG_LEN + 1);
    expect(validateTags([long]).error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects tags with leading hyphens', () => {
    expect(validateTags(['-bad']).error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects tags with trailing hyphens', () => {
    expect(validateTags(['bad-']).error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects tags with uppercase (after lowercase check)', () => {
    // Tags are lowercased before regex, so uppercase input becomes valid
    const result = validateTags(['RUST']);
    expect(result.error).toBeNull();
    expect(result.validated).toEqual(['rust']);
  });

  it('accepts interior hyphens', () => {
    const result = validateTags(['code-review']);
    expect(result.error).toBeNull();
    expect(result.validated).toEqual(['code-review']);
  });

  it('rejects tag with invalid characters', () => {
    expect(validateTags(['has space']).error?.code).toBe('VALIDATION_ERROR');
    expect(validateTags(['bang!']).error?.code).toBe('VALIDATION_ERROR');
    expect(validateTags(['under_score']).error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('validateCapabilities', () => {
  it('accepts valid capabilities object', () => {
    expect(validateCapabilities({ skills: ['code-review'] })).toBeNull();
  });

  it('rejects non-object', () => {
    expect(validateCapabilities('string')?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects null', () => {
    expect(validateCapabilities(null)?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects array', () => {
    expect(validateCapabilities([1, 2])?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects oversized capabilities', () => {
    const huge = { data: 'x'.repeat(LIMITS.CAPABILITIES_MAX) };
    expect(validateCapabilities(huge)?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects colons in values', () => {
    expect(validateCapabilities({ key: 'bad:value' })?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects colons in keys', () => {
    expect(validateCapabilities({ 'bad:key': 'value' })?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects slashes in values', () => {
    expect(validateCapabilities({ key: 'bad/value' })?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects slashes in keys', () => {
    expect(validateCapabilities({ 'bad/key': 'value' })?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects exceeding max nesting depth', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i <= LIMITS.MAX_CAPABILITY_DEPTH; i++) {
      nested = { level: nested };
    }
    expect(validateCapabilities(nested as Record<string, unknown>)?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('validates nested arrays', () => {
    expect(
      validateCapabilities({ skills: ['rust', 'go', 'typescript'] }),
    ).toBeNull();
    expect(validateCapabilities({ skills: ['bad:value'] })?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects unsafe unicode in nested array values', () => {
    expect(validateCapabilities({ skills: ['ok', 'bad​value'] })?.code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('rejects unsafe unicode in keys', () => {
    expect(validateCapabilities({ '\u200Bkey': 'val' })?.code).toBe(
      'VALIDATION_ERROR',
    );
  });
});

describe('validateKeySuffix', () => {
  it('accepts valid key suffix', () => {
    expect(validateKeySuffix('my-key', 'prefix/')).toBeNull();
  });

  it('rejects empty key suffix', () => {
    expect(validateKeySuffix('', 'prefix/')?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects key suffix starting with /', () => {
    expect(validateKeySuffix('/bad', 'prefix/')?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects key exceeding byte limit', () => {
    const long = 'x'.repeat(LIMITS.FASTDATA_MAX_KEY_BYTES);
    expect(validateKeySuffix(long, 'prefix/')?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unsafe unicode in key suffix', () => {
    expect(validateKeySuffix('\x00bad', 'prefix/')?.code).toBe(
      'VALIDATION_ERROR',
    );
  });
});
