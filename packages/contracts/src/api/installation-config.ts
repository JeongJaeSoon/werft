import { z } from "zod";
import { workspaceEnforceSchema } from "../shared/index.ts";

/** A week, as MAX_TURN_SECONDS allows at most; no turn waits longer. */
export const PENDING_REQUEST_TTL_SEC_MAX = 7 * 24 * 60 * 60;

/** Well inside what `sessions.cost_usd` can hold, so the limit is reachable. */
export const SESSION_COST_LIMIT_USD_MAX = 1_000_000;

/**
 * The settings of the whole installation an owner keeps in the console, by
 * key. `env` is the variable they were read from before: migrate carries it
 * in once, while the key has no saved value, and nothing reads it again.
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
  /** What a worker does when its workspace outgrows its quota. */
  workspace_enforce: {
    env: "WORKSPACE_ENFORCE",
    schema: workspaceEnforceSchema,
    default: "warn",
  },
} as const;

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

export const installationConfigSchema = z
  .object({
    pending_request_ttl_sec: entrySchema(rule("pending_request_ttl_sec")),
    queued_input_limit_per_session: entrySchema(
      rule("queued_input_limit_per_session"),
    ),
    storage_limit_bytes: entrySchema(rule("storage_limit_bytes")),
    session_cost_limit_usd: entrySchema(rule("session_cost_limit_usd")),
    session_token_limit: entrySchema(rule("session_token_limit")),
    workspace_enforce: entrySchema(rule("workspace_enforce")),
  } satisfies Record<InstallationConfigKey, z.ZodType>)
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
    workspace_enforce: rule("workspace_enforce").optional(),
  } satisfies Record<InstallationConfigKey, z.ZodType>)
  .strict();

export const updateInstallationConfigResponseSchema = installationConfigSchema
  .extend({
    /** Only when a saved value changed. */
    receipt_id: z.uuid().optional(),
  })
  .strict();

export type InstallationConfig = z.infer<typeof installationConfigSchema>;
export type UpdateInstallationConfigRequest = z.infer<
  typeof updateInstallationConfigRequestSchema
>;
export type UpdateInstallationConfigResponse = z.infer<
  typeof updateInstallationConfigResponseSchema
>;
