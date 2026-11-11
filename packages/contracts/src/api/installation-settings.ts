import { z } from "zod";
import { providerKindSchema } from "../shared/provider-kind.ts";

/**
 * The installation's settings without a secret value
 * (docs/contributing/decisions/settings-replace-file-catalog.md §6). Each
 * entry is checked on import against the catalog's own rules; this schema
 * holds only the document's outline.
 */
export const settingsDocumentSchema = z
  .object({
    version: z.literal(1),
    connections: z.record(z.string().min(1), z.record(z.string(), z.unknown())),
    repositories: z.record(
      z.string().min(1),
      z.record(z.string(), z.unknown()),
    ),
    mcp_servers: z.record(z.string().min(1), z.record(z.string(), z.unknown())),
  })
  .strict();
export type SettingsDocumentBody = z.infer<typeof settingsDocumentSchema>;

export const exportSettingsResponseSchema = z
  .object({
    document: settingsDocumentSchema,
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();
export type ExportSettingsResponse = z.infer<
  typeof exportSettingsResponseSchema
>;

export const importSettingsQuerySchema = z
  .object({ dry_run: z.enum(["true", "false"]).optional() })
  .strict();

/** Entries as `<kind>:<id>` (`connection:`, `repository:`, `mcp:`). */
const entryList = z.array(z.string().min(1));

export const importSettingsResponseSchema = z
  .object({
    outcome: z.enum(["applied", "dry_run"]),
    added: entryList,
    unchanged: entryList,
    /** Same content as a disabled or removed row, which stays so. */
    inactive: entryList,
    /** Stored entries that run once the console sets their value. */
    needs_value: entryList,
    receipt_ids: z.array(z.string().uuid()),
  })
  .strict();
export type ImportSettingsResponse = z.infer<
  typeof importSettingsResponseSchema
>;

/** Where a settings entry comes from: a settings document or the console. */
export const settingsEntryOriginSchema = z.enum(["import", "console"]);

/**
 * `needs_value`: stored, no value set yet. `unresolved`: its credential
 * did not resolve on the replica that answered (a value that does not
 * open, or a reference the deployment lacks).
 */
export const settingsEntryStateSchema = z.enum([
  "active",
  "needs_value",
  "unresolved",
  "disabled",
]);

/** A credential as the console sees it: never a value. */
export const settingsCredentialViewSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("stored"),
      /** Null until a value is set. */
      last4: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      source: z.literal("external"),
      value_env: z.string().optional(),
      secret_id: z.string().optional(),
    })
    .strict(),
  z.object({ source: z.literal("none") }).strict(),
]);

const entryTimes = {
  created_at: z.string(),
  /** Disabled, or for a repository removed; null while in use. */
  disabled_at: z.string().nullable(),
};

/** What a console-made id may be; an imported id is wider. */
export const SETTINGS_ENTRY_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
const consoleEntryId = z
  .string()
  .regex(
    new RegExp(SETTINGS_ENTRY_ID_PATTERN),
    "must be lowercase letters, digits, '.', '_' or '-', at most 64",
  );
/** A value typed into the console: sealed at once, never echoed. */
const credentialValue = z.string().min(1).max(8192);

/**
 * Whether the operator judged that the connection's models run Claude Code's
 * auto-mode classifier. Only `supported` lets the stored default, acceptEdits,
 * dontAsk and plan modes run as `auto`; anything else keeps them as stored.
 */
export const connectionAutoModeSchema = z.enum([
  "supported",
  "unsupported",
  "unknown",
]);

export const connectionModelFamiliesSchema = z.record(
  z.string().min(1).max(128),
  z
    .object({ family: z.string().min(1).max(128), rank: z.number().int() })
    .strict(),
);

export const settingsConnectionSchema = z
  .object({
    id: z.string().min(1),
    origin: settingsEntryOriginSchema,
    state: settingsEntryStateSchema,
    kind: providerKindSchema,
    endpoint: z.string(),
    billing: z.enum(["per_token", "none"]),
    auth_kind: z.enum(["api_key", "bearer"]),
    auto_mode: connectionAutoModeSchema,
    /** The models an agent may name on this connection, in order. */
    models: z.array(z.string().min(1)),
    /**
     * Which models are versions of one series, newest highest: a session on
     * a model taken off `models` moves to the next listed one of its series.
     */
    model_families: connectionModelFamiliesSchema.nullable(),
    credential: settingsCredentialViewSchema,
    ...entryTimes,
  })
  .strict();

export const listSettingsConnectionsResponseSchema = z
  .object({
    items: z.array(settingsConnectionSchema),
    /**
     * The egress proxy's credential allowlist (`host:port`) when the API
     * was given it, else null: an endpoint outside it is warned about,
     * not refused.
     */
    credential_hosts: z.array(z.string()).nullable(),
    /** The endpoint a kind takes when it is left empty, by kind. */
    endpoint_defaults: z.record(z.string(), z.string()),
  })
  .strict();

export const settingsMcpServerSchema = z
  .object({
    id: z.string().min(1),
    origin: settingsEntryOriginSchema,
    state: settingsEntryStateSchema,
    url: z.string(),
    credential_ref: z.string(),
    workspaces: z.array(z.string()),
    credential: settingsCredentialViewSchema,
    ...entryTimes,
  })
  .strict();

export const listSettingsMcpServersResponseSchema = z
  .object({ items: z.array(settingsMcpServerSchema) })
  .strict();

export const createSettingsConnectionRequestSchema = z
  .object({
    id: consoleEntryId,
    kind: providerKindSchema,
    /** Empty takes the kind's default; a kind with none is refused. */
    endpoint: z.string().optional(),
    billing: z.enum(["per_token", "none"]).optional(),
    /** `bearer` only for litellm. */
    auth_kind: z.enum(["api_key", "bearer"]),
    value: credentialValue,
  })
  .strict();

export const createSettingsMcpServerRequestSchema = z
  .object({
    id: consoleEntryId,
    url: z.string().min(1),
    credential_ref: z.string().min(1),
    workspaces: z.array(z.string().min(1)).min(1),
    value: credentialValue,
  })
  .strict();

export const settingsIdParamsSchema = z
  .object({ id: z.string().min(1) })
  .strict();

export const setSettingsCredentialRequestSchema = z
  .object({ value: credentialValue })
  .strict();

export const setConnectionAutoModeRequestSchema = z
  .object({ auto_mode: connectionAutoModeSchema })
  .strict();

/** PUT /v1/settings/connections/{id}/models: the whole list, replaced. */
export const setConnectionModelsRequestSchema = z
  .object({
    models: z.array(z.string().trim().min(1).max(128)).max(64),
    model_families: connectionModelFamiliesSchema.nullable().optional(),
  })
  .strict();

export const setSettingsMcpServerRequestSchema = z
  .object({ workspaces: z.array(z.string().min(1)).min(1) })
  .strict();

export const settingsChangeResponseSchema = z
  .object({ id: z.string().min(1), receipt_id: z.string().uuid() })
  .strict();

/**
 * What disabling one connection would leave without a model, counted by the
 * server when a person opens the confirmation. Counts only: no name or id of
 * another workspace's agent is ever in it.
 */
export const settingsConnectionImpactResponseSchema = z
  .object({
    id: z.string().min(1),
    /** Active agents whose active release runs on this connection. */
    agent_count: z.number().int().nonnegative(),
    /** Sessions not yet failed or stopped that run on it. */
    session_count: z.number().int().nonnegative(),
    /** A workspace's achievement judge setting names this connection. */
    judge_used: z.boolean(),
  })
  .strict();

export type SettingsConnectionImpactResponse = z.infer<
  typeof settingsConnectionImpactResponseSchema
>;
export type SettingsEntryOrigin = z.infer<typeof settingsEntryOriginSchema>;
export type SettingsEntryState = z.infer<typeof settingsEntryStateSchema>;
export type SettingsCredentialView = z.infer<
  typeof settingsCredentialViewSchema
>;
export type SettingsConnection = z.infer<typeof settingsConnectionSchema>;
export type ConnectionAutoMode = z.infer<typeof connectionAutoModeSchema>;
export type SettingsMcpServer = z.infer<typeof settingsMcpServerSchema>;
export type ListSettingsConnectionsResponse = z.infer<
  typeof listSettingsConnectionsResponseSchema
>;
export type ListSettingsMcpServersResponse = z.infer<
  typeof listSettingsMcpServersResponseSchema
>;
export type CreateSettingsConnectionRequest = z.infer<
  typeof createSettingsConnectionRequestSchema
>;
export type CreateSettingsMcpServerRequest = z.infer<
  typeof createSettingsMcpServerRequestSchema
>;
export type SettingsChangeResponse = z.infer<
  typeof settingsChangeResponseSchema
>;
export type SetConnectionModelsRequest = z.infer<
  typeof setConnectionModelsRequestSchema
>;
