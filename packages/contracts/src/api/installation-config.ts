import { z } from "zod";
import { workspaceEnforceSchema } from "../shared/index.ts";

/** A worker's setTimeout overflows past 2^31-1 ms; a week is far inside that. */
export const MAX_TURN_SECONDS_MAX = 7 * 24 * 60 * 60;

/** Past this the engine clamps it anyway, and each retry backs off longer. */
export const PROVIDER_MAX_RETRIES_MAX = 10;

/** As long as a turn may run; no turn waits longer. */
export const PENDING_REQUEST_TTL_SEC_MAX = MAX_TURN_SECONDS_MAX;

/** Well inside what `sessions.cost_usd` can hold, so the limit is reachable. */
export const SESSION_COST_LIMIT_USD_MAX = 1_000_000;

/**
 * Tokens of unknown price a session may use while nothing is saved. A first
 * value with no usage record behind it; an owner sets the installation's own.
 */
export const UNKNOWN_PRICE_SESSION_TOKEN_LIMIT = 5_000_000;

export const SESSION_ARCHIVE_AFTER_DAYS_MIN = 30;
export const SESSION_ARCHIVE_AFTER_DAYS_MAX = 3650;

/**
 * Unmentioned Slack messages one agent holds per channel for the judgment;
 * past it the oldest go (a1, Architect Q22). Set from the shadow records.
 */
export const JUDGMENT_BUFFER_LIMIT_PER_CHANNEL = 100;

/** Ten years: past any session a person comes back to. */
export const WORKSPACE_TTL_SEC_MAX = 3650 * 24 * 60 * 60;

/**
 * The settings of the whole installation an owner keeps in the console, by
 * key. `env` is the variable they were read from before: migrate carries it
 * in once, while the key has no saved value, and nothing reads it again. A
 * key born in the console has none.
 */
export const INSTALLATION_CONFIG = {
  /** How long a registered permission or question takes answers. */
  pending_request_ttl_sec: {
    env: "PENDING_REQUEST_TTL_SEC",
    schema: z.number().int().min(1).max(PENDING_REQUEST_TTL_SEC_MAX),
    default: 1800,
  },
  /**
   * `queued` turns one session may hold; the next input answers 429.
   * Creating a session queues its first turn, so fewer than one would refuse
   * every session.
   */
  queued_input_limit_per_session: {
    env: "QUEUED_INPUT_LIMIT_PER_SESSION",
    schema: z.number().int().min(1).max(100_000),
    default: 20,
  },
  /** Retained input bytes across the installation; the next input answers 413. */
  storage_limit_bytes: {
    env: "STORAGE_LIMIT_BYTES",
    schema: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    default: 1_073_741_824,
  },
  /** A session that has spent this much is dispatched nothing further. */
  session_cost_limit_usd: {
    env: "SESSION_COST_LIMIT_USD",
    schema: z.number().positive().max(SESSION_COST_LIMIT_USD_MAX),
    default: 25,
  },
  /** Provider tokens a session may use over its lifetime; 0 sets none. */
  session_token_limit: {
    env: "SESSION_TOKEN_LIMIT",
    schema: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    default: 0,
  },
  /**
   * Provider tokens a session may use on models nothing prices, whose calls
   * are charged the highest known rate. That rate can be below the real one,
   * so this limit holds whatever the price; it cannot be switched off.
   */
  unknown_price_session_token_limit: {
    schema: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    default: UNKNOWN_PRICE_SESSION_TOKEN_LIMIT,
  },
  /** What a worker does when its workspace outgrows its quota. */
  workspace_enforce: {
    env: "WORKSPACE_ENFORCE",
    schema: workspaceEnforceSchema,
    default: "warn",
  },
  /**
   * Wall-clock budget of one turn. A worker is started with it and keeps
   * the value it was started with; a change reaches the next launch.
   */
  max_turn_seconds: {
    env: "MAX_TURN_SECONDS",
    schema: z.number().int().min(1).max(MAX_TURN_SECONDS_MAX),
    default: 3600,
  },
  /**
   * Retries of a failed provider request before the turn fails; 0 fails it
   * at the first. Fixed per worker, as the turn time is.
   */
  provider_max_retries: {
    env: "PROVIDER_MAX_RETRIES",
    schema: z.number().int().min(0).max(PROVIDER_MAX_RETRIES_MAX),
    default: 2,
  },
  /**
   * Days a session stays idle before its events move into held objects;
   * 0 archives nothing.
   */
  session_archive_after_days: {
    env: "SESSION_ARCHIVE_AFTER_DAYS",
    schema: z.union([
      z.literal(0),
      z
        .number()
        .int()
        .min(SESSION_ARCHIVE_AFTER_DAYS_MIN)
        .max(SESSION_ARCHIVE_AFTER_DAYS_MAX),
    ]),
    default: 180,
  },
  /** True only counts what archiving would move. */
  session_archive_dry_run: {
    env: "SESSION_ARCHIVE_DRY_RUN",
    schema: z.boolean(),
    default: true,
  },
  /**
   * How long a `stopped` session keeps its workspace before a scheduler
   * pass may take it; 0 takes it on the next pass. A resume after that
   * restores from the checkpoint.
   */
  workspace_stopped_ttl_sec: {
    env: "EXECUTION_WORKSPACE_STOPPED_TTL_SEC",
    schema: z.number().int().min(0).max(WORKSPACE_TTL_SEC_MAX),
    default: 86_400,
  },
  /**
   * The same from when a session paused, for one with a checkpoint to
   * resume from; a paused session without one keeps its workspace.
   */
  workspace_paused_ttl_sec: {
    env: "EXECUTION_WORKSPACE_PAUSED_TTL_SEC",
    schema: z.number().int().min(0).max(WORKSPACE_TTL_SEC_MAX),
    default: 86_400,
  },
  /** Held unmentioned Slack messages per agent and channel; the oldest go past it. */
  judgment_buffer_limit_per_channel: {
    schema: z.number().int().min(1).max(100_000),
    default: JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
  },
} as const;

/** The env variable a key was read from before, if it ever was. */
export function installationConfigEnvOf(
  key: InstallationConfigKey,
): string | undefined {
  const entry = INSTALLATION_CONFIG[key];
  return "env" in entry ? entry.env : undefined;
}

export type InstallationConfigKey = keyof typeof INSTALLATION_CONFIG;

export const INSTALLATION_CONFIG_KEYS = Object.keys(
  INSTALLATION_CONFIG,
) as InstallationConfigKey[];

export type InstallationConfigValues = {
  [K in InstallationConfigKey]: z.infer<
    (typeof INSTALLATION_CONFIG)[K]["schema"]
  >;
};

const entrySchema = <S extends z.ZodType>(schema: S) =>
  z
    .object({
      /** What applies now: the saved value, else the default. */
      value: schema,
      default: schema,
      /** False while nothing was saved or carried in. */
      saved: z.boolean(),
      /**
       * True while the old env value could not be carried in and nothing is
       * saved: what the key sets is refused until a value is saved.
       */
      blocked: z.boolean(),
    })
    .strict();

const rule = <K extends InstallationConfigKey>(
  key: K,
): (typeof INSTALLATION_CONFIG)[K]["schema"] => INSTALLATION_CONFIG[key].schema;

/**
 * Whether archiving can run, as the API's object store settings say; the
 * archive job reads its own and may be switched off apart.
 */
export const sessionArchiveStatusSchema = z
  .object({
    available: z.boolean(),
    reason: z.enum(["object_store_disabled", "unversioned"]).nullable(),
  })
  .strict();

/** Every key's entry, as the settings source reads them. */
export const installationConfigEntriesSchema = z
  .object({
    pending_request_ttl_sec: entrySchema(rule("pending_request_ttl_sec")),
    queued_input_limit_per_session: entrySchema(
      rule("queued_input_limit_per_session"),
    ),
    storage_limit_bytes: entrySchema(rule("storage_limit_bytes")),
    session_cost_limit_usd: entrySchema(rule("session_cost_limit_usd")),
    session_token_limit: entrySchema(rule("session_token_limit")),
    unknown_price_session_token_limit: entrySchema(
      rule("unknown_price_session_token_limit"),
    ),
    workspace_enforce: entrySchema(rule("workspace_enforce")),
    max_turn_seconds: entrySchema(rule("max_turn_seconds")),
    provider_max_retries: entrySchema(rule("provider_max_retries")),
    session_archive_after_days: entrySchema(rule("session_archive_after_days")),
    session_archive_dry_run: entrySchema(rule("session_archive_dry_run")),
    workspace_stopped_ttl_sec: entrySchema(rule("workspace_stopped_ttl_sec")),
    workspace_paused_ttl_sec: entrySchema(rule("workspace_paused_ttl_sec")),
    judgment_buffer_limit_per_channel: entrySchema(
      rule("judgment_buffer_limit_per_channel"),
    ),
  } satisfies Record<InstallationConfigKey, z.ZodType>)
  .strict();

export const installationConfigSchema = installationConfigEntriesSchema
  .extend({ session_archive: sessionArchiveStatusSchema })
  .strict();

/** Only the keys to change; one transaction for all of them. */
export const updateInstallationConfigRequestSchema = z
  .object({
    pending_request_ttl_sec: rule("pending_request_ttl_sec").optional(),
    queued_input_limit_per_session: rule(
      "queued_input_limit_per_session",
    ).optional(),
    storage_limit_bytes: rule("storage_limit_bytes").optional(),
    session_cost_limit_usd: rule("session_cost_limit_usd").optional(),
    session_token_limit: rule("session_token_limit").optional(),
    unknown_price_session_token_limit: rule(
      "unknown_price_session_token_limit",
    ).optional(),
    workspace_enforce: rule("workspace_enforce").optional(),
    max_turn_seconds: rule("max_turn_seconds").optional(),
    provider_max_retries: rule("provider_max_retries").optional(),
    session_archive_after_days: rule("session_archive_after_days").optional(),
    session_archive_dry_run: rule("session_archive_dry_run").optional(),
    workspace_stopped_ttl_sec: rule("workspace_stopped_ttl_sec").optional(),
    workspace_paused_ttl_sec: rule("workspace_paused_ttl_sec").optional(),
    judgment_buffer_limit_per_channel: rule(
      "judgment_buffer_limit_per_channel",
    ).optional(),
  } satisfies Record<InstallationConfigKey, z.ZodType>)
  .strict();

export const updateInstallationConfigResponseSchema = installationConfigSchema
  .extend({
    /** Only when a saved value changed. */
    receipt_id: z.uuid().optional(),
  })
  .strict();

export type InstallationConfigEntries = z.infer<
  typeof installationConfigEntriesSchema
>;
export type SessionArchiveStatus = z.infer<typeof sessionArchiveStatusSchema>;
export type InstallationConfig = z.infer<typeof installationConfigSchema>;
export type UpdateInstallationConfigRequest = z.infer<
  typeof updateInstallationConfigRequestSchema
>;
export type UpdateInstallationConfigResponse = z.infer<
  typeof updateInstallationConfigResponseSchema
>;
