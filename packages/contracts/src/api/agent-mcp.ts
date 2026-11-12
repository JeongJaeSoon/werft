import { z } from "zod";

import {
  credentialRefSchema,
  mcpServerIdSchema,
  toolNameSchema,
} from "../kollegium/agents.ts";
import { receiptIdSchema } from "../shared/index.ts";

/**
 * What an agent's MCP tab holds. `allowed_tools` are full
 * `mcp__<server>__<tool>` names, and empty when `server` is null; the
 * credential names are references, never values.
 */
export const agentMcpSettingsSchema = z
  .object({
    server: mcpServerIdSchema.nullable(),
    allowed_tools: z.array(toolNameSchema),
    credential_refs: z.array(credentialRefSchema).max(32),
  })
  .strict();
export type AgentMcpSettings = z.infer<typeof agentMcpSettingsSchema>;

export const agentMcpResponseSchema = z
  .object({
    /** "agent": the saved row. "release": no row yet, the active release's values. */
    source: z.enum(["agent", "release"]),
    settings: agentMcpSettingsSchema,
    /** The row's revision; null while `source` is "release". */
    settings_revision: z.number().int().positive().nullable(),
    active_release_id: z.string().min(1).nullable(),
    /** Those of `settings.credential_refs` with a live binding on the agent. */
    bound_credential_refs: z.array(credentialRefSchema),
    /**
     * Ids of the servers a save may choose in this workspace, sorted: the
     * ids only, so a manager who cannot read the installation settings can
     * still pick one. Absent from an API that predates the field.
     */
    available_servers: z.array(mcpServerIdSchema).optional(),
  })
  .strict();
export type AgentMcpResponse = z.infer<typeof agentMcpResponseSchema>;

/** The whole row, replaced. Never a release. */
export const putAgentMcpSettingsRequestSchema = z
  .object({
    /** `settings_revision` as read; null when the agent had no row. */
    expected_revision: z.number().int().positive().nullable(),
    settings: agentMcpSettingsSchema,
  })
  .strict();
export type PutAgentMcpSettingsRequest = z.infer<
  typeof putAgentMcpSettingsRequestSchema
>;

/** `receipt_id` is null when a person's row already held these values. */
export const putAgentMcpSettingsResponseSchema = z
  .object({
    settings_revision: z.number().int().positive(),
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();
export type PutAgentMcpSettingsResponse = z.infer<
  typeof putAgentMcpSettingsResponseSchema
>;
