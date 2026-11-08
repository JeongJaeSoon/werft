import { z } from "zod";

import {
  agentGitHubSettingsSchema,
  pushAttachedSchema,
} from "../kollegium/agents.ts";
import { repositoryRefSchema } from "../musterrolle/github-repository.ts";
import { receiptIdSchema } from "../shared/index.ts";
import { receiptSchema } from "./receipt.ts";

/** Why an optional permission cannot be turned on in the agent's GitHub tab. */
export const AGENT_GITHUB_FEATURE_UNAVAILABLE_VALUES = [
  // The App's permissions as last read lack it (a cached value; the token
  // request decides).
  "app_permission_missing",
  "over_workspace_ceiling",
  "no_reviewer_app",
  // Every repository the settings name is on a GitHub Enterprise host.
  "github_host_unsupported",
] as const;

/** Why a catalog repository cannot be picked. */
export const AGENT_GITHUB_REPOSITORY_UNAVAILABLE_VALUES = [
  // The release's runtime profile does not allow it.
  "repository_not_allowed",
  // A PAT repository: its token cannot be narrowed.
  "app_required",
] as const;

const featureOptionSchema = z.object({
  available: z.boolean(),
  reason: z.enum(AGENT_GITHUB_FEATURE_UNAVAILABLE_VALUES).nullable(),
});

export const agentGitHubResponseSchema = z.object({
  /** `agents.github_enabled`: applies at once, not through a release. */
  enabled: z.boolean(),
  active_release_id: z.string().nullable(),
  /**
   * The agent's settings when it has any, else the active release's
   * `policy_pins.github`. The agent's may list no repository.
   */
  github: agentGitHubSettingsSchema.nullable(),
  /**
   * `agent_github_settings.revision`; null while the agent has no row. A
   * save sends it back as `expected_revision`.
   */
  settings_revision: z.number().int().nullable(),
  /**
   * `github.repositories`, in its order, read as `owner/repo`. A row the
   * catalog dropped still answers; one it never held has a null
   * `repository`. Optional so a client written before it still type-checks;
   * the server always sends it.
   */
  selected_repositories: z
    .array(
      z.object({
        id: z.string(),
        repository: z.string().min(1).nullable(),
        private: z.boolean().nullable(),
        ref: repositoryRefSchema,
      }),
    )
    .optional(),
  /** The repository a session that names none starts on. */
  start_repository_id: z.string().nullable(),
  /**
   * Whether a push to an attached repository needs a person: the row's
   * value, `ask` for a row saved before the column. While the agent has no
   * row, what a first save writes (`allow`), as `legacy_defaults` shows the
   * rest.
   */
  push_attached: pushAttachedSchema,
  /**
   * When `github` is null: what a first save starts from (no repository,
   * nothing optional). Until then the release runs as before.
   */
  legacy_defaults: agentGitHubSettingsSchema.nullable(),
  options: z.object({
    /** The catalog's GitHub repositories. */
    repositories: z.array(
      z.object({
        id: z.string(),
        url: z.string(),
        // The next four are optional only so a client written before them
        // still type-checks; the server always sends them.
        /** `owner/repo` of the catalog row. */
        repository: z.string().min(1).optional(),
        full_name: z.string().min(1).optional(),
        /** Always null here: reading this does not ask GitHub. */
        private: z.boolean().nullable().optional(),
        /** Hand it back to keep the repository; shows nothing to a person. */
        ref: repositoryRefSchema.optional(),
        available: z.boolean(),
        reason: z.enum(AGENT_GITHUB_REPOSITORY_UNAVAILABLE_VALUES).nullable(),
        /**
         * Whether each role's App is installed on the repository, as GitHub
         * answered now; null when there is no such App, it is a PAT, or
         * GitHub did not answer.
         */
        installed: z.object({
          author: z.boolean().nullable(),
          reviewer: z.boolean().nullable(),
        }),
      }),
    ),
    /**
     * The workspace has no repository ceiling yet. `repositories` is then
     * judged against the default the first save writes; reading writes
     * nothing.
     */
    repository_ceiling_unset: z.boolean(),
    features: z.object({
      workflows: featureOptionSchema,
      actions: featureOptionSchema,
      checks: featureOptionSchema,
      issues: featureOptionSchema,
      review: featureOptionSchema,
    }),
  }),
});

/**
 * The whole settings row, replaced. Never a release: a save applies to the
 * next session, and narrowing also to running ones.
 */
export const putAgentGitHubSettingsRequestSchema = z
  .object({
    /** `settings_revision` as read; null when the agent had no row. */
    expected_revision: z.number().int().nullable(),
    settings: agentGitHubSettingsSchema,
    /** Must be one of `settings.repositories`. */
    start_repository_id: z.string().min(1).max(128).nullable(),
    /**
     * Left out: a first save writes `allow`, a later one keeps the row's
     * value. A caller from before the field therefore still saves.
     */
    push_attached: pushAttachedSchema.optional(),
  })
  .strict();

/** `receipt_id` is null when a person's row already held these values. */
export const putAgentGitHubSettingsResponseSchema = z.object({
  settings_revision: z.number().int(),
  receipt_id: receiptIdSchema.nullable(),
});

export const putAgentGitHubEnabledRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();

/** `receipt_id` is null when the switch already held that value. */
export const putAgentGitHubEnabledResponseSchema = z.object({
  enabled: z.boolean(),
  receipt_id: receiptIdSchema.nullable(),
});

export const AGENT_GITHUB_ACTIVITY_LIMIT = 20;

/**
 * The agent's latest GitHub receipts, newest first: switch changes, releases
 * and activations that changed its GitHub settings, and the gate's work on
 * sessions the caller can see.
 */
export const agentGitHubActivityResponseSchema = z.object({
  items: z.array(receiptSchema).max(AGENT_GITHUB_ACTIVITY_LIMIT),
  /**
   * `owner/repo` per receipt in `items` that is about a repository: the name
   * it recorded, else the repository's name now (an older receipt only held
   * its catalog id). A receipt naming none, or a repository the catalog
   * never held, has no entry. Optional only for clients written before it;
   * the server always sends it.
   */
  receipt_repositories: z
    .array(
      z.object({
        receipt_id: receiptIdSchema,
        repository: z.string().min(1),
      }),
    )
    .optional(),
});

export type AgentGitHubResponse = z.infer<typeof agentGitHubResponseSchema>;
export type AgentGitHubFeatureUnavailable =
  (typeof AGENT_GITHUB_FEATURE_UNAVAILABLE_VALUES)[number];
export type AgentGitHubRepositoryUnavailable =
  (typeof AGENT_GITHUB_REPOSITORY_UNAVAILABLE_VALUES)[number];
export type PutAgentGitHubSettingsRequest = z.infer<
  typeof putAgentGitHubSettingsRequestSchema
>;
export type PutAgentGitHubSettingsResponse = z.infer<
  typeof putAgentGitHubSettingsResponseSchema
>;
export type PutAgentGitHubEnabledRequest = z.infer<
  typeof putAgentGitHubEnabledRequestSchema
>;
export type PutAgentGitHubEnabledResponse = z.infer<
  typeof putAgentGitHubEnabledResponseSchema
>;
export type AgentGitHubActivityResponse = z.infer<
  typeof agentGitHubActivityResponseSchema
>;
