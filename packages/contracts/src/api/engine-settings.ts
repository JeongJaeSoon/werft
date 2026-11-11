import { z } from "zod";

import { storedEngineSettingsSchema } from "../kollegium/engine-settings-storage.ts";
import { receiptIdSchema } from "../shared/index.ts";

/**
 * `reason_code`s a save of engine settings adds to the rule parser's own
 * (`unknown_tool`, `too_many_rules`, `settings_too_large`, ...).
 */
export const ENGINE_SETTINGS_REFUSAL_VALUES = [
  // The installed tool catalogs read the same rule as different tools.
  "engine_settings_catalog_ambiguous",
  // No tool catalog is installed, so nothing can check the rules.
  "engine_settings_catalog_unavailable",
] as const;

const revisionSchema = z.number().int().positive();

/** What an agent's rules leave without effect, so the console can say so. */
export const engineSettingsAllowReachSchema = z
  .object({
    /**
     * Allow entries of the agent that the workspace does not allow too. A
     * grant needs both sides, so these do nothing.
     */
    agent_allow_without_effect: z
      .object({
        permissions: z.array(z.string()),
        auto_mode_allow: z.array(z.string()),
        auto_mode_environment: z.array(z.string()),
      })
      .strict(),
    /**
     * The workspace allows something but this agent allows nothing of that
     * kind, so the workspace's allow does not reach the agent's sessions.
     */
    workspace_allow_inactive: z.boolean(),
  })
  .strict();

export const workspaceEngineSettingsResponseSchema = z
  .object({
    settings: storedEngineSettingsSchema,
    /** The row's revision; null while the workspace has saved nothing. */
    settings_revision: revisionSchema.nullable(),
  })
  .strict();
export type WorkspaceEngineSettingsResponse = z.infer<
  typeof workspaceEngineSettingsResponseSchema
>;

export const agentEngineSettingsResponseSchema = z
  .object({
    settings: storedEngineSettingsSchema,
    settings_revision: revisionSchema.nullable(),
    /** The workspace's rules, which also apply to this agent. Read only here. */
    workspace: z
      .object({
        settings: storedEngineSettingsSchema,
        settings_revision: revisionSchema.nullable(),
      })
      .strict(),
    reach: engineSettingsAllowReachSchema,
  })
  .strict();
export type AgentEngineSettingsResponse = z.infer<
  typeof agentEngineSettingsResponseSchema
>;

/** The whole rule set of the scope, replaced. */
export const putEngineSettingsRequestSchema = z
  .object({
    /** `settings_revision` as read; null when nothing was saved yet. */
    expected_revision: revisionSchema.nullable(),
    settings: storedEngineSettingsSchema,
  })
  .strict();
export type PutEngineSettingsRequest = z.infer<
  typeof putEngineSettingsRequestSchema
>;

/** `receipt_id` is null when the scope already held these rules. */
export const putEngineSettingsResponseSchema = z
  .object({
    settings_revision: revisionSchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();
export type PutEngineSettingsResponse = z.infer<
  typeof putEngineSettingsResponseSchema
>;
