import {
  rejectUnsafeUnicode,
  validateCapabilities,
  validateDescription,
  validateImageUrl,
  validateName,
  validateReason,
  validateTags,
} from '@/lib/validate';

// ---------------------------------------------------------------------------
// rejectUnsafeUnicode
// ---------------------------------------------------------------------------

describe('rejectUnsafeUnicode', () => {
  it('accepts plain ASCII', () => {
    expect(rejectUnsafeUnicode('hello world', false)).toBeNull();
  });

  it('accepts standard Unicode (emoji, CJK)', () => {
    expect(rejectUnsafeUnicode('hello 🤖 世界', false)).toBeNull();
  });

  it('rejects control characters', () => {
    // U+0000 null
    expect(rejectUnsafeUnicode('ab\x00cd', false)).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    // U+0008 backspace
    expect(rejectUnsafeUnicode('ab\x08cd', false)).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects U+007F delete', () => {
    expect(rejectUnsafeUnicode('ab\x7Fcd', false)).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects bidi override U+202E (right-to-left)', () => {
    expect(rejectUnsafeUnicode('abc\u202Edef', false)).toMatchObject({
      message: expect.stringContaining('U+202E'),
    });
  });

  it('rejects zero-width chars (U+200B ZWSP, U+FEFF BOM)', () => {
    expect(rejectUnsafeUnicode('a\u200Bb', false)).toMatchObject({
      message: expect.stringContaining('U+200B'),
    });
    expect(rejectUnsafeUnicode('a\uFEFFb', false)).toMatchObject({
      message: expect.stringContaining('U+FEFF'),
    });
  });

  it('rejects bidi isolates (U+2066–U+2069)', () => {
    expect(rejectUnsafeUnicode('a\u2066b', false)).toMatchObject({
      message: expect.stringContaining('U+2066'),
    });
    expect(rejectUnsafeUnicode('a\u2069b', false)).toMatchObject({
      message: expect.stringContaining('U+2069'),
    });
  });

  it('allows newline regardless of allowNewline flag', () => {
    // isUnsafeChar exempts 0x0A unconditionally; allowNewline=true adds
    // an early continue but the result is the same either way.
    expect(rejectUnsafeUnicode('line1\nline2', false)).toBeNull();
    expect(rejectUnsafeUnicode('line1\nline2', true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateName
// ---------------------------------------------------------------------------

describe('validateName', () => {
  it('accepts valid name', () => {
    expect(validateName('Agent Smith')).toBeNull();
  });

  it('rejects name exceeding max length', () => {
    expect(validateName('a'.repeat(51))).toMatchObject({
      message: expect.stringContaining('50'),
    });
  });

  it('accepts name at max length', () => {
    expect(validateName('a'.repeat(50))).toBeNull();
  });

  it('rejects blank name', () => {
    expect(validateName('   ')).toMatchObject({
      message: expect.stringContaining('blank'),
    });
  });

  it('rejects name with bidi override', () => {
    expect(validateName('agent\u202E')).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// validateDescription
// ---------------------------------------------------------------------------

describe('validateDescription', () => {
  it('accepts valid description', () => {
    expect(validateDescription('A helpful agent')).toBeNull();
  });

  it('rejects description exceeding max length', () => {
    expect(validateDescription('x'.repeat(501))).toMatchObject({
      message: expect.stringContaining('500'),
    });
  });

  it('allows newlines in description', () => {
    expect(validateDescription('line1\nline2')).toBeNull();
  });

  it('rejects description with zero-width chars', () => {
    expect(validateDescription('nice\u200Bdescription')).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// validateImageUrl — SSRF prevention
// ---------------------------------------------------------------------------

describe('validateImageUrl', () => {
  it('accepts valid https URL', () => {
    expect(validateImageUrl('https://example.com/avatar.png')).toBeNull();
  });

  it('rejects non-https URL', () => {
    expect(validateImageUrl('http://example.com/img.png')).toMatchObject({
      message: expect.stringContaining('https'),
    });
  });

  it('rejects URL exceeding max length', () => {
    expect(
      validateImageUrl(`https://example.com/${'a'.repeat(500)}`),
    ).toMatchObject({
      message: expect.stringContaining('512'),
    });
  });

  it('rejects URL with credentials', () => {
    expect(
      validateImageUrl('https://user:pass@example.com/img.png'),
    ).toMatchObject({
      message: expect.stringContaining('credentials'),
    });
  });

  // -- SSRF: private/internal hosts --

  it('rejects localhost', () => {
    expect(validateImageUrl('https://localhost/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects 127.0.0.1', () => {
    expect(validateImageUrl('https://127.0.0.1/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects all of 127.0.0.0/8', () => {
    expect(validateImageUrl('https://127.1.2.3/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
    expect(validateImageUrl('https://127.255.255.254/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects 0.0.0.0', () => {
    expect(validateImageUrl('https://0.0.0.0/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects cloud metadata IP (169.254.169.254)', () => {
    expect(
      validateImageUrl('https://169.254.169.254/latest/meta-data/'),
    ).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects RFC-1918 10.x', () => {
    expect(validateImageUrl('https://10.0.0.1/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects RFC-1918 192.168.x', () => {
    expect(validateImageUrl('https://192.168.1.1/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects RFC-1918 172.16-31.x', () => {
    expect(validateImageUrl('https://172.16.0.1/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
    expect(validateImageUrl('https://172.31.255.1/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('allows 172.15.x and 172.32.x (outside RFC-1918)', () => {
    expect(validateImageUrl('https://172.15.0.1/img.png')).toBeNull();
    expect(validateImageUrl('https://172.32.0.1/img.png')).toBeNull();
  });

  it('rejects .local and .internal TLDs', () => {
    expect(validateImageUrl('https://myhost.local/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
    expect(validateImageUrl('https://corp.internal/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects IPv6 loopback', () => {
    expect(validateImageUrl('https://[::1]/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects IPv6 link-local (fe80:)', () => {
    expect(validateImageUrl('https://[fe80::1]/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects full IPv6 link-local range fe80::/10 (fe80–febf)', () => {
    expect(validateImageUrl('https://[fea0::1]/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
    expect(validateImageUrl('https://[febf::1]/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects IPv6 private (fd00:)', () => {
    expect(validateImageUrl('https://[fd12::1]/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects IPv4-mapped IPv6 for private ranges', () => {
    expect(
      validateImageUrl('https://[::ffff:127.0.0.1]/img.png'),
    ).toMatchObject({
      message: expect.stringContaining('local'),
    });
    expect(
      validateImageUrl('https://[::ffff:169.254.1.1]/img.png'),
    ).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects bare decimal IP obfuscation', () => {
    // 2130706433 = 127.0.0.1
    expect(validateImageUrl('https://2130706433/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects hex IP obfuscation', () => {
    expect(validateImageUrl('https://0x7f000001/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects octal IP obfuscation', () => {
    // 0177.0.0.01 = 127.0.0.1 in octal
    expect(validateImageUrl('https://0177.0.0.01/img.png')).toMatchObject({
      message: expect.stringContaining('local'),
    });
  });

  it('rejects URL with zero-width chars', () => {
    expect(validateImageUrl('https://example.com/\u200Bimg.png')).toMatchObject(
      {
        code: 'VALIDATION_ERROR',
      },
    );
  });
});

// ---------------------------------------------------------------------------
// validateTags
// ---------------------------------------------------------------------------

describe('validateTags', () => {
  it('accepts valid tags', () => {
    const { validated, error } = validateTags(['ai', 'defi', 'web3']);
    expect(error).toBeNull();
    expect(validated).toEqual(['ai', 'defi', 'web3']);
  });

  it('lowercases tags', () => {
    const { validated, error } = validateTags(['AI', 'DeFi']);
    expect(error).toBeNull();
    expect(validated).toEqual(['ai', 'defi']);
  });

  it('deduplicates tags (case-insensitive)', () => {
    const { validated, error } = validateTags(['ai', 'AI', 'Ai']);
    expect(error).toBeNull();
    expect(validated).toEqual(['ai']);
  });

  it('rejects more than 10 tags', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
    const { error } = validateTags(tags);
    expect(error).toMatchObject({ message: expect.stringContaining('10') });
  });

  it('rejects empty tag', () => {
    const { error } = validateTags(['ai', '', 'defi']);
    expect(error).toMatchObject({ message: expect.stringContaining('empty') });
  });

  it('rejects tag exceeding max length', () => {
    const { error } = validateTags(['a'.repeat(31)]);
    expect(error).toMatchObject({ message: expect.stringContaining('30') });
  });

  it('rejects tag with invalid characters', () => {
    const { error } = validateTags(['valid', 'no spaces']);
    expect(error).toMatchObject({
      message: expect.stringContaining('alphanumeric'),
    });
  });

  it('accepts tag with hyphens', () => {
    const { validated, error } = validateTags(['machine-learning']);
    expect(error).toBeNull();
    expect(validated).toEqual(['machine-learning']);
  });

  it('accepts single-character tag', () => {
    const { validated, error } = validateTags(['a', '1']);
    expect(error).toBeNull();
    expect(validated).toEqual(['a', '1']);
  });

  it('rejects boundary and all-hyphen tags', () => {
    for (const bad of ['-', '--', '-foo', 'foo-', '-foo-', '---']) {
      const { error } = validateTags([bad]);
      expect(error).toMatchObject({
        message: expect.stringContaining('hyphens'),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// validateReason
// ---------------------------------------------------------------------------

describe('validateReason', () => {
  it('accepts valid reason', () => {
    expect(validateReason('Great AI agent')).toBeNull();
  });

  it('rejects reason exceeding max length', () => {
    expect(validateReason('x'.repeat(281))).toMatchObject({
      message: expect.stringContaining('280'),
    });
  });

  it('allows newlines in reason', () => {
    expect(validateReason('line1\nline2')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateCapabilities
// ---------------------------------------------------------------------------

describe('validateCapabilities', () => {
  it('accepts valid capabilities object', () => {
    expect(validateCapabilities({ skills: ['testing', 'coding'] })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(validateCapabilities('string')).toMatchObject({
      message: expect.stringContaining('JSON object'),
    });
    expect(validateCapabilities([1, 2])).toMatchObject({
      message: expect.stringContaining('JSON object'),
    });
    expect(validateCapabilities(null)).toMatchObject({
      message: expect.stringContaining('JSON object'),
    });
  });

  it('rejects capabilities exceeding size limit', () => {
    const big = { data: 'x'.repeat(4097) };
    expect(validateCapabilities(big)).toMatchObject({
      message: expect.stringContaining('4096'),
    });
  });

  it('rejects nesting beyond max depth', () => {
    // depth 0: { a: { b: { c: { d: { e: "too deep" } } } } }
    const deep = { a: { b: { c: { d: { e: 'too deep' } } } } };
    expect(validateCapabilities(deep)).toMatchObject({
      message: expect.stringContaining('depth'),
    });
  });

  it('accepts nesting at max depth', () => {
    // depth 0→1→2→3→4 = exactly 4 levels of nesting, value is a string
    const ok = { a: { b: { c: { d: 'leaf' } } } };
    expect(validateCapabilities(ok)).toBeNull();
  });

  it('rejects colons in capability keys', () => {
    expect(validateCapabilities({ 'bad:key': 'value' })).toMatchObject({
      message: expect.stringContaining('colons'),
    });
  });

  it('rejects colons in capability values', () => {
    expect(validateCapabilities({ key: 'bad:value' })).toMatchObject({
      message: expect.stringContaining('colons'),
    });
  });

  it('rejects unsafe unicode in capability keys', () => {
    expect(validateCapabilities({ 'key\u202E': 'value' })).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('validates nested arrays', () => {
    expect(
      validateCapabilities({ skills: ['valid', 'also-valid'] }),
    ).toBeNull();
  });

  it('rejects unsafe unicode in nested array values', () => {
    expect(
      validateCapabilities({ skills: ['valid', 'bad\u200B'] }),
    ).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
