import { z } from "zod";

import {
  agentIdSchema,
  pageSchema,
  paginationQuerySchema,
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";
import { sessionScopeSchema } from "./authorization.ts";

// API keys issued from the web or the API. A personal key acts
// as the person who made it; an agent key belongs to one agent and reaches
// that agent's sessions only. No key reaches a whole workspace.

export const API_KEY_KIND_VALUES = ["personal", "agent"] as const;
export const apiKeyKindSchema = z.enum(API_KEY_KIND_VALUES);

export const API_KEY_NAME_MAX = 64;
export const apiKeyNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(API_KEY_NAME_MAX)
  .meta({
    description:
      "A label the issuer gives the key, so a list tells one integration's key from another's.",
  });

export const apiKeyIdSchema = z.uuid();
export const apiKeyIdParamsSchema = z.object({ id: apiKeyIdSchema }).strict();

/**
 * The key behind an approval, in that receipt's result: an agent key's
 * receipt actor names no person, so the issuer is only found here (GA-8).
 */
export const deciderKeySchema = z.object({
  id: apiKeyIdSchema,
  /** `operator`: a key CLI key, which no person issues through the API. */
  kind: z.enum([...API_KEY_KIND_VALUES, "operator"]),
  /** Null on a key issued before keys recorded who issued them. */
  issued_by_user_id: userIdSchema.nullable(),
});
export type DeciderKey = z.infer<typeof deciderKeySchema>;

export const apiKeyViewSchema = z
  .object({
    id: apiKeyIdSchema,
    kind: apiKeyKindSchema,
    /** Null on a key issued without one. */
    name: z.string().nullable(),
    workspace_id: workspaceIdSchema,
    agent_id: agentIdSchema.nullable(),
    /** Null on a key issued before keys recorded who issued them. */
    created_by: userIdSchema.nullable(),
    created_by_user: z
      .object({ id: userIdSchema, display_name: z.string() })
      .strict()
      .nullable()
      .meta({
        description:
          "Who issued the key, with their display name as it is now. It stays after the issuer leaves the workspace or their account is disabled. Null on a key issued before keys recorded who issued them.",
      }),
    scopes: z.array(sessionScopeSchema),
    created_at: timestampSchema,
    expires_at: timestampSchema.nullable(),
    revoked_at: timestampSchema.nullable(),
    last_used_at: timestampSchema.nullable().meta({
      description:
        "When the key last authenticated a request, recorded at most once a minute. A use made while another request is writing a session with the key is recorded on the next use instead, so it can lag by more. Null means no use has been recorded since last-use recording began, not that the key was never used.",
    }),
  })
  .strict();

export const createApiKeyRequestSchema = z
  .object({
    kind: apiKeyKindSchema,
    name: apiKeyNameSchema.optional(),
    // Never more than the issuer holds now.
    scopes: z.array(sessionScopeSchema).min(1),
    /** Required for an agent key, refused on a personal key. */
    agent_id: agentIdSchema.optional(),
    expires_at: timestampSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.kind === "personal" && request.agent_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["agent_id"],
        message: "a personal key acts as its creator, never as an agent",
      });
    }
    if (request.kind === "agent" && request.agent_id === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["agent_id"],
        message: "an agent key names the agent it belongs to",
      });
    }
  });

/** The only place a key's secret ever appears: once, to whoever issued it. */
export const createApiKeyResponseSchema = z
  .object({
    key: apiKeyViewSchema,
    secret: z.string().min(32).max(256),
    receipt_id: receiptIdSchema,
  })
  .strict();

export const listApiKeysQuerySchema = paginationQuerySchema;
/**
 * The caller's own personal keys, plus the agent keys they may revoke:
 * every one for an owner or admin, their agents' for an agent's admin.
 * Newest first.
 */
export const listApiKeysResponseSchema = pageSchema(apiKeyViewSchema);

export const revokeApiKeyResponseSchema = z
  .object({
    key: apiKeyViewSchema,
    /** Null when the key was already revoked and nothing was written. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export type ApiKeyView = z.infer<typeof apiKeyViewSchema>;
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;
export type ListApiKeysQuery = z.infer<typeof listApiKeysQuerySchema>;
export type ListApiKeysResponse = z.infer<typeof listApiKeysResponseSchema>;
export type RevokeApiKeyResponse = z.infer<typeof revokeApiKeyResponseSchema>;
