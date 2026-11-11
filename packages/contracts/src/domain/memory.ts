import { z } from "zod";

import {
  agentIdSchema,
  memoryIdSchema,
  opaqueIdSchema,
  revisionSchema,
  sessionIdSchema,
  surfaceBindingIdSchema,
  timestampSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

export const MEMORY_TYPE_VALUES = ["semantic", "episodic"] as const;
export const memoryTypeSchema = z.enum(MEMORY_TYPE_VALUES);

/**
 * Who may read a record. Ported from Kollegium v1's
 * `kollege|channel|user` with `kollege` renamed to `agent`: the widest scope
 * an agent can write is its own working set, and promotion to `workspace`
 * ("Team shared") is a human decision, never automatic.
 */
export const MEMORY_VISIBILITY_VALUES = [
  "session",
  "agent",
  "workspace",
  "channel",
  "user",
] as const;
export const memoryVisibilitySchema = z.enum(MEMORY_VISIBILITY_VALUES);

export const MEMORY_STATUS_VALUES = [
  "candidate",
  "active",
  "superseded",
  "deleted",
] as const;
export const memoryStatusSchema = z.enum(MEMORY_STATUS_VALUES);

export const MEMORY_SENSITIVITY_VALUES = ["normal", "sensitive"] as const;
export const memorySensitivitySchema = z.enum(MEMORY_SENSITIVITY_VALUES);

const memoryRecordShape = {
  id: memoryIdSchema,
  workspace_id: workspaceIdSchema,
  agent_id: agentIdSchema,
  type: memoryTypeSchema,
  content: z.string().min(1).max(10_000),
  source_session_id: sessionIdSchema.nullable(),
  source_binding_id: surfaceBindingIdSchema.nullable(),
  source_message_ref: z.string().min(1).max(256).nullable(),
  sensitivity: memorySensitivitySchema,
  confidence: z.number().min(0).max(1),
  valid_until: timestampSchema.nullable(),
  status: memoryStatusSchema,
  /** Soft delete plus revision: a record is superseded, never overwritten. */
  revision: revisionSchema,
  created_by: opaqueIdSchema,
  created_at: timestampSchema,
};

function scopedMemory<K extends MemoryVisibility, R extends z.ZodType>(
  visibility: K,
  ref: R,
) {
  return z
    .object({
      ...memoryRecordShape,
      visibility: z.literal(visibility),
      visibility_ref: ref,
    })
    .strict();
}

/**
 * The visibility decides what `visibility_ref` even is, so each variant names
 * its own id schema: `channel` points at a surface binding rather than a raw
 * channel id (revoking the binding revokes its memory), `user` at a scoped
 * actor id, and the agent- and workspace-wide variants have no ref at all.
 * One generic opaque id for all five would let a surface binding id stand in
 * for a session and still parse.
 */
export const memoryRecordSchema = z.discriminatedUnion("visibility", [
  scopedMemory("session", sessionIdSchema),
  scopedMemory("channel", surfaceBindingIdSchema),
  scopedMemory("user", opaqueIdSchema),
  scopedMemory("agent", z.null()),
  scopedMemory("workspace", z.null()),
]);

/** What a reader must present before any row is selected. */
// TODO(94S-155): Apply this predicate through the chat-interface policy.
export const memoryVisibilityQuerySchema = z
  .object({
    workspace_id: workspaceIdSchema,
    agent_id: agentIdSchema,
    session_id: sessionIdSchema.nullable(),
    surface_binding_id: surfaceBindingIdSchema.nullable(),
    actor_id: opaqueIdSchema.nullable(),
    at: timestampSchema,
  })
  .strict();

export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryVisibility = z.infer<typeof memoryVisibilitySchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;
export type MemorySensitivity = z.infer<typeof memorySensitivitySchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type MemoryVisibilityQuery = z.infer<typeof memoryVisibilityQuerySchema>;
