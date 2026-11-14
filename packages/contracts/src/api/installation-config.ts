import { z } from "zod";

/** A week, as MAX_TURN_SECONDS allows at most; no turn waits longer. */
export const PENDING_REQUEST_TTL_SEC_MAX = 7 * 24 * 60 * 60;

/**
 * The settings of the whole installation an owner keeps in the console, by
 * key. `env` is the variable they were read from before: an upgrade carries
 * it in once, while the key has no saved value, and never reads it again.
 */
export const INSTALLATION_CONFIG = {
  /** How long a registered permission or question takes answers. */
  pending_request_ttl_sec: {
    env: "PENDING_REQUEST_TTL_SEC",
    schema: z.number().int().min(1).max(PENDING_REQUEST_TTL_SEC_MAX),
    default: 1800,
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
    })
    .strict();

export const installationConfigSchema = z
  .object({
    pending_request_ttl_sec: entrySchema(
      INSTALLATION_CONFIG.pending_request_ttl_sec.schema,
    ),
  })
  .strict();

/** Only the keys to change; one transaction for all of them. */
export const updateInstallationConfigRequestSchema = z
  .object({
    pending_request_ttl_sec:
      INSTALLATION_CONFIG.pending_request_ttl_sec.schema.optional(),
  })
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
