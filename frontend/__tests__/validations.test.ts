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
      expect(handleSchema.safeParse('A'.repeat(32)).success).toBe(true);
      expect(handleSchema.safeParse('Agent_Bot').success).toBe(true);
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
  });

  describe('loginSchema', () => {
    it('accepts valid API key', () => {
      // loginSchema only validates prefix, not full hex length (that's server-side)
      expect(loginSchema.safeParse({ apiKey: 'nearly_' + 'a'.repeat(64) }).success).toBe(true);
      expect(loginSchema.safeParse({ apiKey: 'nearly_abc123' }).success).toBe(true);
    });

    it('rejects empty key', () => {
      expect(loginSchema.safeParse({ apiKey: '' }).success).toBe(false);
    });

    it('rejects wrong prefix', () => {
      expect(loginSchema.safeParse({ apiKey: 'invalid_abc123' }).success).toBe(false);
    });
  });
});
