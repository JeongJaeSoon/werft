import { z } from "zod";

import {
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import { githubAppRoleSchema } from "./github-settings.ts";
import { displayNameSchema, workspaceParamsSchema } from "./workspaces.ts";

// The workspace's GitHub App connections, registered in the console: author
// Apps, with which catalog repositories whose `auth` is `{ kind: github_app }`
// clone, push and open pull requests, and reviewer Apps that only review. A
// private key goes in once and is never read back.

/**
 * `role` names a role (`author`, `reviewer`), served while that role has at
 * most one connection, or else a connection id.
 */
export const githubAppRoleParamsSchema = workspaceParamsSchema
  .extend({ role: z.union([githubAppRoleSchema, z.uuid()]) })
  .strict();

/** `details.reason_code` of a refused App write (409 GITHUB_APP_CONFLICT). */
export const GITHUB_APP_CONFLICT_VALUES = [
  // Another connection holds the same App: GitHub refuses an approval from
  // the App that opened the pull request.
  "same_app",
  // A reviewer App needs an author App first.
  "no_author_app",
  // Kept for clients of earlier servers: a manifest now always adds a
  // connection, so neither is answered any more.
  "author_app_exists",
  "author_app_changed",
  // A role address while the role has several connections: name one by id.
  "ambiguous_role",
  // People link their accounts with this connection and another author
  // connection exists: choose that one first.
  "in_use_for_user_link",
] as const;

/** What removing a connection takes with it (decision github-agent.md 11.5). */
export const githubAppUsageSchema = z
  .object({
    /** Catalog repositories pinned to it, for its role. */
    pinned_repository_count: z.number().int().nonnegative(),
    /**
     * Agents with GitHub on whose active release names one of them (for a
     * reviewer connection, those that turn review on). A release without
     * GitHub settings reaches every repository the workspace ceiling allows and is
     * not counted, so this is a lower bound.
     */
    agent_count: z.number().int().nonnegative(),
    /** Sessions not yet ended on one of them. */
    active_session_count: z.number().int().nonnegative(),
    /** People link their accounts with it. */
    user_link: z.boolean(),
  })
  .strict();

export const GITHUB_APP_PRIVATE_KEY_MAX_LENGTH = 16_384;

export const githubAppIdSchema = z.number().int().positive().max(2_147_483_647);

export const putGitHubAppRequestSchema = z
  .object({
    app_id: githubAppIdSchema,
    /** The PEM GitHub issued for the App ("Generate a private key"). */
    private_key: z.string().min(1).max(GITHUB_APP_PRIVATE_KEY_MAX_LENGTH),
  })
  .strict();

const updatedBySchema = z
  .object({ user_id: userIdSchema, display_name: displayNameSchema })
  .strict()
  .nullable();

export const githubAppPermissionLevelSchema = z.enum([
  "read",
  "write",
  "admin",
]);
export type GitHubAppPermissionLevel = z.infer<
  typeof githubAppPermissionLevelSchema
>;
export const githubAppPermissionsSchema = z.record(
  z.string().min(1),
  githubAppPermissionLevelSchema,
);
export type GitHubAppPermissions = z.infer<typeof githubAppPermissionsSchema>;

const RANK: Record<GitHubAppPermissionLevel, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

/** The permissions `asked` names that `granted` does not hold at that level. */
export function githubPermissionsMissing(
  granted: GitHubAppPermissions,
  asked: GitHubAppPermissions,
): string[] {
  return Object.entries(asked)
    .filter(([name, level]) => {
      const held = granted[name];
      return held === undefined || RANK[held] < RANK[level];
    })
    .map(([name]) => name)
    .sort();
}

/**
 * The most each role's App is told to hold (design github-agent.md §1):
 * the author's defaults plus its optional features, the reviewer's three.
 */
export const GITHUB_APP_PERMISSION_GUIDANCE: Record<
  "author" | "reviewer",
  GitHubAppPermissions
> = {
  author: {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
    actions: "write",
    checks: "write",
    issues: "write",
    workflows: "write",
  },
  reviewer: { contents: "read", pull_requests: "write", metadata: "read" },
};

export const githubAppWarningSchema = z
  .object({
    permission: z.string().min(1),
    level: githubAppPermissionLevelSchema,
    /** The most the guidance names; null when it names none. */
    guided: githubAppPermissionLevelSchema.nullable(),
  })
  .strict();
export type GitHubAppWarning = z.infer<typeof githubAppWarningSchema>;

/** Permissions wider than the role's guidance. Saving is not refused. */
export function githubAppWarnings(
  role: "author" | "reviewer",
  permissions: GitHubAppPermissions | null,
): GitHubAppWarning[] {
  const guidance = GITHUB_APP_PERMISSION_GUIDANCE[role];
  return Object.entries(permissions ?? {})
    .filter(([name, level]) => {
      const guided = guidance[name];
      return guided === undefined || RANK[level] > RANK[guided];
    })
    .map(([permission, level]) => ({
      permission,
      level,
      guided: guidance[permission] ?? null,
    }))
    .sort((a, b) => a.permission.localeCompare(b.permission));
}

export const githubAppSchema = z
  .object({
    /** Absent from servers before the reviewer App: the author. */
    role: githubAppRoleSchema.optional(),
    /** The connection's id; absent from servers before several Apps a role. */
    connection_id: z.uuid().optional(),
    app_id: githubAppIdSchema,
    slug: z.string().min(1),
    name: z.string().min(1),
    /** The App's page on GitHub; its `/installations/new` installs it. */
    html_url: z.string().url(),
    private_key: z
      .object({
        updated_at: timestampSchema,
        /** The console user who last set it; null once that account is gone. */
        updated_by: updatedBySchema,
      })
      .strict(),
    created_at: timestampSchema,
    updated_at: timestampSchema,
    /**
     * What the App asks for (`GET /app`), as last read; null before the
     * first read. An installation grants a raise only once it is approved.
     */
    permissions: githubAppPermissionsSchema.nullable().optional(),
    permissions_checked_at: timestampSchema.nullable().optional(),
    /** Permissions wider than the role's guidance. */
    warnings: z.array(githubAppWarningSchema).optional(),
    /**
     * The account that owns the App, as GitHub gave it on this read; its
     * permissions are set under that account. Null when GitHub did not
     * answer; absent from a write's answer.
     */
    owner: z
      .object({
        login: z.string().min(1),
        type: z.enum(["organization", "user"]),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const githubAppInstallationSchema = z
  .object({
    id: z.number().int().positive(),
    /** The user or organization login the App is installed on. */
    account: z.string().min(1),
    repository_selection: z.enum(["all", "selected"]),
    html_url: z.string().url().nullable(),
  })
  .strict();

export const githubAppRepositorySchema = z
  .object({
    /** The catalog repository id. */
    id: z.string().min(1),
    url: z.string().url(),
    /** Null while the App is not installed on the repository. */
    installation_id: z.number().int().positive().nullable(),
    /**
     * What that installation grants, as GitHub answered now. It trails the
     * App's own permissions until an owner approves a raise on GitHub.
     */
    installation_permissions: githubAppPermissionsSchema.nullable().optional(),
  })
  .strict();

export const GITHUB_APP_MANIFEST_BLOCKED_VALUES = [
  // CONSOLE_ORIGIN is unset: no redirect or account-link callback to name.
  "console_origin_unset",
] as const;

export const GITHUB_APP_CHECK_FAILURE_VALUES = [
  // GitHub did not answer, or answered with a server error.
  "github_unreachable",
  // GitHub refused the App's own token: the key was revoked or the App deleted.
  "github_rejected",
] as const;

export const getGitHubAppResponseSchema = z
  .object({
    github_app: githubAppSchema.nullable(),
    /**
     * The App as GitHub sees it now. Null with no App registered; a failed
     * check leaves `installations` empty and every `installation_id` null.
     */
    check: z
      .discriminatedUnion("state", [
        z.object({ state: z.literal("ok") }).strict(),
        z
          .object({
            state: z.literal("failed"),
            reason_code: z.enum(GITHUB_APP_CHECK_FAILURE_VALUES),
          })
          .strict(),
      ])
      .nullable(),
    installations: z.array(githubAppInstallationSchema),
    /** Catalog repositories that use the registered Apps. */
    repositories: z.array(githubAppRepositorySchema),
    /** Why a new App cannot be made from a manifest; null when it can. */
    manifest_blocked: z
      .enum(GITHUB_APP_MANIFEST_BLOCKED_VALUES)
      .nullable()
      .optional(),
    /** What removing the connection affects; null with no App. */
    usage: githubAppUsageSchema.nullable().optional(),
  })
  .strict();

/** How long a manifest's `state` can be completed; GitHub's code lasts as long. */
export const GITHUB_APP_MANIFEST_STATE_TTL_SECONDS = 3600;

// GitHub's rule for user and organization logins.
const githubLoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/);

export const startGitHubAppManifestRequestSchema = z
  .object({
    owner: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("organization"), login: githubLoginSchema })
        .strict(),
      z.object({ kind: z.literal("user") }).strict(),
    ]),
    /** A private App installs only on its owner's account. */
    public: z.boolean().default(false),
    /** Also ask for `actions` and `workflows` write. */
    actions: z.boolean().default(false),
    /**
     * Ignored: a manifest always adds another author connection, and
     * moving to it is removing the old one after.
     */
    replace: z.boolean().default(false),
  })
  .strict();

export const startGitHubAppManifestResponseSchema = z
  .object({
    /** Where the browser form-POSTs `manifest`; carries the single-use state. */
    action_url: z.url(),
    /** The JSON the form sends as its `manifest` field. */
    manifest: z.string().min(2),
    expires_at: timestampSchema,
  })
  .strict();

export const completeGitHubAppManifestRequestSchema = z
  .object({
    code: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    state: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
  })
  .strict();

export const completeGitHubAppManifestResponseSchema = z
  .object({
    github_app: githubAppSchema,
    /** Where the App is installed next. */
    install_url: z.url(),
    receipt_id: receiptIdSchema,
  })
  .strict();

/** How long an installation started in the console can be finished. */
export const GITHUB_INSTALLATION_STATE_TTL_SECONDS = 3600;

export const githubConnectionParamsSchema = workspaceParamsSchema
  .extend({ connectionId: z.uuid() })
  .strict();

export const startGitHubInstallationResponseSchema = z
  .object({
    /** The App's `/installations/new` with the single-use `state`. */
    install_url: z.url(),
    expires_at: timestampSchema,
  })
  .strict();

/** What GitHub's setup URL redirect carried back. */
export const completeGitHubInstallationRequestSchema = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    installation_id: z.number().int().positive(),
  })
  .strict();

export const completeGitHubInstallationResponseSchema = z
  .object({
    connection_id: z.uuid(),
    installation_id: z.number().int().positive(),
    /**
     * False when the installation existed before the state, or someone was
     * already recorded for it: nothing is written over.
     */
    recorded: z.boolean(),
  })
  .strict();

export const putGitHubAppResponseSchema = z
  .object({
    github_app: githubAppSchema,
    receipt_id: receiptIdSchema,
    /** Repository pins a replacement by another App dropped. */
    pins_cleared: z.number().int().nonnegative().optional(),
    /** Pins of this App, left empty when it was removed, filled again. */
    pins_restored: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Adds a connection; any number may share a role. */
export const postGitHubAppRequestSchema = putGitHubAppRequestSchema
  .extend({ role: githubAppRoleSchema })
  .strict();

export const listGitHubAppsResponseSchema = z
  .object({
    /** Every connection, author ones first, each with its `connection_id`. */
    github_apps: z.array(githubAppSchema),
  })
  .strict();

export const deleteGitHubAppResponseSchema = z
  .object({ receipt_id: receiptIdSchema })
  .strict();

export type GitHubAppConflict = (typeof GITHUB_APP_CONFLICT_VALUES)[number];
export type PutGitHubAppRequest = z.infer<typeof putGitHubAppRequestSchema>;
export type PostGitHubAppRequest = z.infer<typeof postGitHubAppRequestSchema>;
export type ListGitHubAppsResponse = z.infer<
  typeof listGitHubAppsResponseSchema
>;
export type GitHubAppUsage = z.infer<typeof githubAppUsageSchema>;
export type GitHubApp = z.infer<typeof githubAppSchema>;
export type GitHubAppInstallation = z.infer<typeof githubAppInstallationSchema>;
export type GitHubAppRepository = z.infer<typeof githubAppRepositorySchema>;
export type GitHubAppCheckFailure =
  (typeof GITHUB_APP_CHECK_FAILURE_VALUES)[number];
export type GetGitHubAppResponse = z.infer<typeof getGitHubAppResponseSchema>;
export type GitHubAppManifestBlocked =
  (typeof GITHUB_APP_MANIFEST_BLOCKED_VALUES)[number];
export type StartGitHubAppManifestRequest = z.infer<
  typeof startGitHubAppManifestRequestSchema
>;
export type StartGitHubAppManifestResponse = z.infer<
  typeof startGitHubAppManifestResponseSchema
>;
export type CompleteGitHubAppManifestRequest = z.infer<
  typeof completeGitHubAppManifestRequestSchema
>;
export type CompleteGitHubAppManifestResponse = z.infer<
  typeof completeGitHubAppManifestResponseSchema
>;
export type StartGitHubInstallationResponse = z.infer<
  typeof startGitHubInstallationResponseSchema
>;
export type CompleteGitHubInstallationRequest = z.infer<
  typeof completeGitHubInstallationRequestSchema
>;
export type CompleteGitHubInstallationResponse = z.infer<
  typeof completeGitHubInstallationResponseSchema
>;
export type PutGitHubAppResponse = z.infer<typeof putGitHubAppResponseSchema>;
export type DeleteGitHubAppResponse = z.infer<
  typeof deleteGitHubAppResponseSchema
>;
