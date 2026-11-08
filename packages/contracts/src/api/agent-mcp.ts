import { z } from "zod";

import {
  credentialRefSchema,
  mcpServerIdSchema,
  toolNameSchema,
} from "../kollegium/agents.ts";
import { receiptIdSchema } from "../shared/index.ts";

/** Why a save of an agent's MCP settings is refused (`reason_code`). */
export const AGENT_MCP_REFUSAL_VALUES = [
  "server_unknown",
  // The built-in server's tools follow the agent's GitHub settings.
  "server_builtin",
  "server_required",
  "tool_outside_server",
  "server_credential_missing",
  "duplicate",
] as const;

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
