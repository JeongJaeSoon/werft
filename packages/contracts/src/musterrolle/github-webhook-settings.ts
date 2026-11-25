import { z } from "zod";

/** The longest webhook address kept, as for Slack's events address. */
export const GITHUB_WEBHOOK_PUBLIC_URL_MAX = 2048;

/** How many Apps one retry names at most. */
export const GITHUB_WEBHOOK_RETRY_MAX = 100;

/**
 * Why GitHub did not take an App's new webhook URL. `github_rejected`: GitHub
 * refused the App's own token (key revoked, App deleted). `url_refused`:
 * GitHub refused the URL itself (422). `github_unreachable`: GitHub did not
 * answer, or answered with a server error or a 403. `key_unreadable`: no
 * stored key of the App opens under this server's master key. `not_found`
 * (retry only): the App is no longer one whose webhook this server keeps.
 */
export const GITHUB_WEBHOOK_UPDATE_FAILURE_VALUES = [
  "github_rejected",
  "url_refused",
  "github_unreachable",
  "key_unreadable",
  "not_found",
] as const;

/**
 * An App whose webhook points at this installation: one a connection in
 * some workspace holds a webhook secret for. `other_workspaces` counts the
 * workspaces besides the caller's that hold it.
 */
export const githubWebhookAppSchema = z
  .object({
    app_id: z.number().int().positive(),
    name: z.string(),
    other_workspaces: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Where GitHub's App webhooks enter, for the whole installation.
 * `webhook_public_url` is the https base an owner saved, null when GitHub
 * reaches no address of this server; `webhook_url` is what the Apps are set
 * to, from it. `apps` are the Apps a save sets.
 */
export const githubWebhookSettingsSchema = z
  .object({
    webhook_public_url: z.string().nullable(),
    webhook_url: z.string().nullable(),
    apps: z.array(githubWebhookAppSchema),
  })
  .strict();

/**
 * An absolute https URL without a query, fragment or credentials; a path
 * prefix is kept. Null clears it.
 */
export const updateGitHubWebhookSettingsRequestSchema = z
  .object({
    webhook_public_url: z
      .string()
      .max(GITHUB_WEBHOOK_PUBLIC_URL_MAX)
      .nullable(),
  })
  .strict();

/** What GitHub said to one App's new webhook URL. */
export const githubWebhookUpdateSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      app_id: z.number().int().positive(),
      name: z.string(),
      outcome: z.literal("updated"),
    })
    .strict(),
  z
    .object({
      app_id: z.number().int().positive(),
      /** Null with `not_found`. */
      name: z.string().nullable(),
      outcome: z.literal("failed"),
      reason_code: z.enum(GITHUB_WEBHOOK_UPDATE_FAILURE_VALUES),
    })
    .strict(),
]);

export const updateGitHubWebhookSettingsResponseSchema =
  githubWebhookSettingsSchema
    .extend({
      /** Only when the saved address changed. */
      receipt_id: z.uuid().optional(),
      /** One per App, after the address committed; empty when nothing was sent. */
      updates: z.array(githubWebhookUpdateSchema),
    })
    .strict();

/** The Apps to set to the saved address again, by App id. */
export const retryGitHubWebhookUpdatesRequestSchema = z
  .object({
    app_ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(GITHUB_WEBHOOK_RETRY_MAX),
  })
  .strict();

export const retryGitHubWebhookUpdatesResponseSchema = z
  .object({ updates: z.array(githubWebhookUpdateSchema) })
  .strict();

export type GitHubWebhookUpdateFailure =
  (typeof GITHUB_WEBHOOK_UPDATE_FAILURE_VALUES)[number];
export type GitHubWebhookApp = z.infer<typeof githubWebhookAppSchema>;
export type GitHubWebhookSettings = z.infer<typeof githubWebhookSettingsSchema>;
export type GitHubWebhookUpdate = z.infer<typeof githubWebhookUpdateSchema>;
export type UpdateGitHubWebhookSettingsRequest = z.infer<
  typeof updateGitHubWebhookSettingsRequestSchema
>;
export type UpdateGitHubWebhookSettingsResponse = z.infer<
  typeof updateGitHubWebhookSettingsResponseSchema
>;
export type RetryGitHubWebhookUpdatesRequest = z.infer<
  typeof retryGitHubWebhookUpdatesRequestSchema
>;
export type RetryGitHubWebhookUpdatesResponse = z.infer<
  typeof retryGitHubWebhookUpdatesResponseSchema
>;
