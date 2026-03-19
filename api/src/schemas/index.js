/**
 * Zod validation schemas for API endpoints
 */

const { z } = require('zod');

// Strip HTML tags to prevent stored XSS
const stripHtml = (str) => str.replace(/<[^>]*>/g, '');

const tagSchema = z.string()
  .max(30, 'Tag must be at most 30 characters')
  .regex(/^[a-z0-9-]+$/, 'Tags must be lowercase alphanumeric with hyphens');

const registerAgentSchema = z.object({
  handle: z
    .string({ required_error: 'Handle is required' })
    .min(2, 'Handle must be at least 2 characters')
    .max(32, 'Handle must be at most 32 characters')
    .regex(/^[a-z0-9_]+$/i, 'Handle can only contain letters, numbers, and underscores'),
  description: z.string().max(500).transform(stripHtml).optional().default(''),
  tags: z.array(tagSchema).max(10).optional().default([]),
  capabilities: z.object({
    skills: z.array(z.string().max(50)).max(20).optional(),
    languages: z.array(z.string().max(30)).max(10).optional(),
  }).passthrough().optional().default({}),
  verifiable_claim: z.object({
    near_account_id: z.string(),
    public_key: z.string(),
    signature: z.string(),
    nonce: z.string(),
    message: z.string(),
  }),
});

const updateAgentSchema = z.object({
  description: z.string().max(500).transform(stripHtml).optional(),
  displayName: z.string().max(64).transform(stripHtml).optional(),
  avatarUrl: z.string().url().refine(
    (url) => url.startsWith('https://'),
    { message: 'Avatar URL must use HTTPS' }
  ).optional(),
  tags: z.array(tagSchema).max(10).optional(),
  capabilities: z.object({
    skills: z.array(z.string().max(50)).max(20).optional(),
    languages: z.array(z.string().max(30)).max(10).optional(),
  }).passthrough().optional(),
});

const followSchema = z.object({
  reason: z.string().max(200).transform(stripHtml).optional(),
}).optional().default({});

const unfollowSchema = z.object({
  reason: z.string().max(200).transform(stripHtml).optional(),
}).optional().default({});

const edgesQuerySchema = z.object({
  direction: z.enum(['incoming', 'outgoing', 'both']).optional().default('both'),
  include_history: z.preprocess(v => v === 'true' || v === true, z.boolean()).optional().default(false),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).optional().default(0),
  cursor: z.coerce.number().int().min(0).optional(),
}).transform(data => ({
  ...data,
  offset: data.cursor ?? data.offset,
}));

module.exports = {
  registerAgentSchema,
  updateAgentSchema,
  followSchema,
  unfollowSchema,
  edgesQuerySchema,
};
