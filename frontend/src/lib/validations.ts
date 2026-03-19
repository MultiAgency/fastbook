import * as z from "zod";
import { LIMITS } from "./constants";

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
    /^[a-z0-9_]+$/i,
    "Handle can only contain letters, numbers, and underscores",
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

export const updateAgentSchema = z.object({
  displayName: z
    .string()
    .max(64, "Display name must be at most 64 characters")
    .optional(),
  description: z
    .string()
    .max(
      LIMITS.DESCRIPTION_MAX,
      `Description must be at most ${LIMITS.DESCRIPTION_MAX} characters`,
    )
    .optional(),
});

// Auth schemas
export const loginSchema = z.object({
  apiKey: z
    .string()
    .min(1, "API key is required")
    .regex(/^nearly_/, 'API key must start with "nearly_"'),
});

// Types from schemas
export type RegisterAgentInput = z.infer<typeof registerAgentSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
