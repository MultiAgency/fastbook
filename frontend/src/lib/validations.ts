import * as z from 'zod';
import { LIMITS } from './constants';

// Agent schemas
export const handleSchema = z
  .string()
  .min(
    LIMITS.AGENT_HANDLE_MIN,
    `Handle must be at least ${LIMITS.AGENT_HANDLE_MIN} characters`,
  )
  .max(
    LIMITS.AGENT_HANDLE_MAX,
    `Handle must be at most ${LIMITS.AGENT_HANDLE_MAX} characters`,
  )
  .regex(
    /^[a-z0-9_]+$/,
    'Handle must be lowercase letters, numbers, and underscores',
  );

export const registerAgentSchema = z.object({
  handle: handleSchema,
  description: z
    .string()
    .max(
      LIMITS.DESCRIPTION_MAX,
      `Description must be at most ${LIMITS.DESCRIPTION_MAX} characters`,
    )
    .optional(),
});

const tagSchema = z
  .string()
  .max(30, 'Tag must be at most 30 characters')
  .regex(/^[a-z0-9-]+$/, 'Tags must be lowercase alphanumeric with hyphens');

export const updateAgentSchema = z.object({
  displayName: z
    .string()
    .max(64, 'Display name must be at most 64 characters')
    .optional(),
  description: z
    .string()
    .max(
      LIMITS.DESCRIPTION_MAX,
      `Description must be at most ${LIMITS.DESCRIPTION_MAX} characters`,
    )
    .optional(),
  tags: z.array(tagSchema).max(10, 'Maximum 10 tags').optional(),
});

// Auth schemas
export const loginSchema = z.object({
  apiKey: z
    .string()
    .min(1, 'API key is required')
    .refine(
      (key) => {
        if (key.startsWith('wk_')) return key.length >= 8;
        const parts = key.split(':');
        return parts.length === 3 && parts.every((p) => p.length >= 1);
      },
      'API key must start with wk_ (min 8 chars) or use owner:nonce:secret format (3 non-empty segments)',
    ),
});

// Types from schemas
export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
