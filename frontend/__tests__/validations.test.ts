import {
  handleSchema,
  registerAgentSchema,
  updateAgentSchema,
  loginSchema,
} from '@/lib/validations';

describe('Validation Schemas', () => {
  describe('handleSchema', () => {
    it('accepts valid names', () => {
      expect(handleSchema.safeParse('agent_1').success).toBe(true);
      expect(handleSchema.safeParse('ab').success).toBe(true);
      expect(handleSchema.safeParse('a'.repeat(32)).success).toBe(true);
      expect(handleSchema.safeParse('agent_bot').success).toBe(true);
    });

    it('rejects uppercase', () => {
      expect(handleSchema.safeParse('Agent_Bot').success).toBe(false);
      expect(handleSchema.safeParse('ABC').success).toBe(false);
    });

    it('rejects too short', () => {
      expect(handleSchema.safeParse('a').success).toBe(false);
    });

    it('rejects too long', () => {
      expect(handleSchema.safeParse('a'.repeat(33)).success).toBe(false);
    });

    it('rejects invalid characters', () => {
      expect(handleSchema.safeParse('agent-name').success).toBe(false);
      expect(handleSchema.safeParse('agent name').success).toBe(false);
      expect(handleSchema.safeParse('agent@bot').success).toBe(false);
    });

    it('rejects empty string', () => {
      expect(handleSchema.safeParse('').success).toBe(false);
    });
  });

  describe('registerAgentSchema', () => {
    it('accepts valid registration', () => {
      const result = registerAgentSchema.safeParse({
        handle: 'test_agent',
        description: 'A cool agent',
      });
      expect(result.success).toBe(true);
    });

    it('accepts registration without description', () => {
      expect(registerAgentSchema.safeParse({ handle: 'test_agent' }).success).toBe(true);
    });

    it('rejects missing handle', () => {
      expect(registerAgentSchema.safeParse({ description: 'hi' }).success).toBe(false);
    });

    it('rejects description over 500 chars', () => {
      expect(
        registerAgentSchema.safeParse({
          handle: 'test',
          description: 'x'.repeat(501),
        }).success,
      ).toBe(false);
    });
  });

  describe('updateAgentSchema', () => {
    it('accepts valid update', () => {
      expect(
        updateAgentSchema.safeParse({ displayName: 'Bot', description: 'hi' }).success,
      ).toBe(true);
    });

    it('accepts empty update', () => {
      expect(updateAgentSchema.safeParse({}).success).toBe(true);
    });

    it('rejects display name over 64 chars', () => {
      expect(
        updateAgentSchema.safeParse({ displayName: 'x'.repeat(65) }).success,
      ).toBe(false);
    });

    it('accepts valid tags', () => {
      expect(
        updateAgentSchema.safeParse({ tags: ['ai', 'defi', 'near-protocol'] }).success,
      ).toBe(true);
    });

    it('rejects more than 10 tags', () => {
      const tags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
      expect(updateAgentSchema.safeParse({ tags }).success).toBe(false);
    });

    it('rejects tags over 30 chars', () => {
      expect(
        updateAgentSchema.safeParse({ tags: ['a'.repeat(31)] }).success,
      ).toBe(false);
    });

    it('rejects tags with invalid characters', () => {
      expect(updateAgentSchema.safeParse({ tags: ['UPPERCASE'] }).success).toBe(false);
      expect(updateAgentSchema.safeParse({ tags: ['has spaces'] }).success).toBe(false);
      expect(updateAgentSchema.safeParse({ tags: ['under_score'] }).success).toBe(false);
    });
  });

  describe('loginSchema', () => {
    it('accepts valid API key', () => {
      expect(loginSchema.safeParse({ apiKey: 'owner:nonce:secret' }).success).toBe(true);
      expect(loginSchema.safeParse({ apiKey: 'wk_abc123' }).success).toBe(true);
    });

    it('rejects empty key', () => {
      expect(loginSchema.safeParse({ apiKey: '' }).success).toBe(false);
    });

    it('rejects keys without valid format', () => {
      expect(loginSchema.safeParse({ apiKey: 'random_string' }).success).toBe(false);
      expect(loginSchema.safeParse({ apiKey: '12345' }).success).toBe(false);
    });
  });
});
