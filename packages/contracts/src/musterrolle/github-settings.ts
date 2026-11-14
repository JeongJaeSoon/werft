import { z } from "zod";

// Imports zod only: kollegium/agents.ts pins these on a release, and
// github-app.ts sits on an import cycle through workspaces.ts.

/**
 * `author` clones, pushes and opens pull requests; `reviewer` only reviews,
 * since GitHub refuses an approval from the pull request's own author. The
 * `/github-app` routes are the author's.
 */
export const GITHUB_APP_ROLE_VALUES = ["author", "reviewer"] as const;
export const githubAppRoleSchema = z.enum(GITHUB_APP_ROLE_VALUES);

/** The optional permissions an agent may be given, beyond writing a PR. */
export const githubFeaturesSchema = z
  .object({
    workflows: z.boolean(),
    actions: z.boolean(),
    checks: z.boolean(),
    issues: z.boolean(),
    review: z.boolean(),
  })
  .strict();

/**
 * What a workspace lets its agents do; no settings row reads all false.
 * `merge` is the workspace's alone: an agent row or a release pin never
 * carries it (both stay `githubFeaturesSchema`), and a stored ceiling without
 * the key reads as off.
 */
export const githubCeilingSchema = z
  .object({
    ...githubFeaturesSchema.shape,
    /** Lets an agent squash-merge the pull request its own session opened. */
    merge: z.boolean().default(false),
  })
  .strict();

export const GITHUB_FEATURES_NONE: GitHubFeatures = {
  workflows: false,
  actions: false,
  checks: false,
  issues: false,
  review: false,
};

export const GITHUB_CEILING_NONE: GitHubCeiling = {
  ...GITHUB_FEATURES_NONE,
  merge: false,
};

/**
 * How the platform lays out a pull request body (design pr-template 6).
 * `on` fills a template with the agent's fields; `off` keeps the repository's
 * and the workspace's templates out of it, so the fields land on the
 * platform's default layout.
 */
export const PULL_REQUEST_FORMATTING_VALUES = ["on", "off"] as const;
/**
 * `repository_first`: the repository's own template, the workspace's when it
 * has none. `override`: the workspace's template always (the repository's is
 * not read), the platform's default when the workspace sets none.
 */
export const PULL_REQUEST_TEMPLATE_MODE_VALUES = [
  "repository_first",
  "override",
] as const;
/**
 * What names the session in a pull request's tail and in the commit trailer:
 * its console address, or only its id (nothing of the console's host leaves).
 */
export const PULL_REQUEST_SESSION_LINK_VALUES = ["url", "id"] as const;
/** A template's size in UTF-8 bytes, a repository's and a workspace's alike. */
export const PULL_REQUEST_TEMPLATE_MAX_BYTES = 16 * 1024;

export const pullRequestTemplateTextSchema = z
  .string()
  .refine(
    (text) =>
      new TextEncoder().encode(text).length <= PULL_REQUEST_TEMPLATE_MAX_BYTES,
    { message: "The template is over 16 KiB" },
  );

export const pullRequestSettingsSchema = z
  .object({
    formatting: z.enum(PULL_REQUEST_FORMATTING_VALUES),
    /** Null: the platform's default template. */
    default_template: pullRequestTemplateTextSchema.nullable(),
    template_mode: z.enum(PULL_REQUEST_TEMPLATE_MODE_VALUES),
    session_link: z.enum(PULL_REQUEST_SESSION_LINK_VALUES),
  })
  .strict();

/** What no saved setting reads as. */
export const DEFAULT_PULL_REQUEST_SETTINGS: PullRequestSettings = {
  formatting: "on",
  default_template: null,
  template_mode: "repository_first",
  session_link: "url",
};

/** `details.reason_code` of a template the platform will not lay text around. */
export const PULL_REQUEST_TEMPLATE_REFUSAL_VALUES = [
  "template_too_large",
  "template_not_utf8",
  // A comment left open, or markup the platform cannot put text around.
  "template_unsupported",
] as const;

/** `details.reason_code` of a refused GitHub token (`GITHUB_REFUSED`). */
export const GITHUB_REFUSAL_VALUES = [
  "github_disabled",
  "repository_not_allowed",
  "feature_off",
  "over_workspace_ceiling",
  "app_permission_missing",
  "no_reviewer_app",
  "app_required",
  "workflow_not_allowed",
  "agent_ref_refused",
  "run_ref_unprovable",
  "actions_off",
  // The session's release carries GitHub settings this server cannot apply.
  "github_settings_unsupported",
  "github_host_unsupported",
  "repository_none",
  "workflow_review_need_session_repository",
  // No connection is pinned to the repository and more than one reaches it.
  "ambiguous_app",
  // The connection pinned to the repository was removed.
  "pinned_app_removed",
  "merge_off",
] as const;
export const githubRefusalSchema = z.enum(GITHUB_REFUSAL_VALUES);

/** Refusals of policy (403); the rest name a missing setting or a ceiling (409). */
const GITHUB_POLICY_REFUSALS: ReadonlySet<GitHubRefusal> = new Set([
  "github_disabled",
  "repository_not_allowed",
  "feature_off",
  "workflow_not_allowed",
  "agent_ref_refused",
  "run_ref_unprovable",
]);

export function githubRefusalStatus(reason: unknown): 403 | 409 {
  return GITHUB_POLICY_REFUSALS.has(reason as GitHubRefusal) ? 403 : 409;
}

/** What a GitHub token is asked for; each has one row of permissions. */
export const GITHUB_PURPOSE_VALUES = [
  "clone",
  "push",
  "pull_request",
  "actions_read",
  "dispatch",
  "rerun",
  "review",
  // GA-4b: the platform reading a pull request it recorded.
  "outcome_refresh",
  "merge",
  // The agent reading the pull request of its own push request.
  "pull_request_read",
] as const;
export const githubPurposeSchema = z.enum(GITHUB_PURPOSE_VALUES);

export type GitHubPermissionLevel = "read" | "write";

/**
 * The permission table: what a purpose asks GitHub for, from which App, and
 * the optional feature it needs (null: the default work every agent has).
 * `push` adds `workflows: write` when the release turns workflows on.
 */
export function githubPermissionsFor(
  purpose: GitHubPurpose,
  features: Pick<GitHubFeatures, "workflows">,
): {
  role: GitHubAppRole;
  feature: keyof GitHubFeatures | null;
  /** A ceiling key the workspace alone sets, which no agent or release holds. */
  ceilingFeature?: "merge";
  permissions: Record<string, GitHubPermissionLevel>;
} {
  switch (purpose) {
    case "clone":
      return {
        role: "author",
        feature: null,
        permissions: { contents: "read" },
      };
    case "push":
      return {
        role: "author",
        feature: null,
        permissions: features.workflows
          ? { contents: "write", workflows: "write" }
          : { contents: "write" },
      };
    case "pull_request":
      return {
        role: "author",
        feature: null,
        permissions: { contents: "read", pull_requests: "write" },
      };
    case "actions_read":
      return {
        role: "author",
        feature: "actions",
        permissions: { actions: "read" },
      };
    case "dispatch":
    case "rerun":
      return {
        role: "author",
        feature: "actions",
        permissions: { actions: "write" },
      };
    case "review":
      return {
        role: "reviewer",
        feature: "review",
        permissions: { contents: "read", pull_requests: "write" },
      };
    case "outcome_refresh":
    case "pull_request_read":
      return {
        role: "author",
        feature: null,
        permissions: { pull_requests: "read" },
      };
    case "merge":
      // GitHub's merge endpoint wants Contents: write; the pull request is
      // read first. Widen to `pull_requests: write` only if GitHub refuses.
      return {
        role: "author",
        feature: null,
        ceilingFeature: "merge",
        permissions: { contents: "write", pull_requests: "read" },
      };
  }
}

/**
 * The ceiling policy, shared by saving a release (refused when it is over)
 * and by every token issue (a feature over it is refused then): the features
 * turned on that the workspace does not allow.
 */
export function githubFeaturesOverCeiling(
  features: GitHubFeatures,
  ceiling: GitHubCeiling,
): (keyof GitHubFeatures)[] {
  return (Object.keys(features) as (keyof GitHubFeatures)[]).filter(
    (feature) => features[feature] && !ceiling[feature],
  );
}

/** The features a release may use now: on in it and under the ceiling. */
export function githubEffectiveFeatures(
  features: GitHubFeatures,
  ceiling: GitHubCeiling,
): GitHubFeatures {
  return {
    workflows: features.workflows && ceiling.workflows,
    actions: features.actions && ceiling.actions,
    checks: features.checks && ceiling.checks,
    issues: features.issues && ceiling.issues,
    review: features.review && ceiling.review,
  };
}

/** The branches the platform pushes to; never run by a dispatch. */
export const GITHUB_AGENT_REF_PREFIX = "agent/";

/**
 * An allow-list `ref` against a branch: literal but for `*`, which matches
 * any run of characters other than `/`.
 */
export function githubRefMatches(pattern: string, ref: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`).test(ref);
}

/**
 * The allow-list entry that lets `workflow` run on branch `ref`, or null.
 * An entry without `ref` means the repository's default branch only.
 */
export function githubAllowedBy<
  Entry extends { workflow: string; ref?: string | undefined },
>(
  allow: readonly Entry[],
  workflow: string,
  ref: string,
  defaultBranch: string,
): Entry | null {
  return (
    allow.find(
      (entry) =>
        entry.workflow === workflow &&
        (entry.ref === undefined
          ? ref === defaultBranch
          : githubRefMatches(entry.ref, ref)),
    ) ?? null
  );
}

const githubAppPermissionsSchema = z.record(
  z.string(),
  z.enum(["read", "write", "admin"]),
);

/**
 * Linking people's GitHub accounts, through the author App's user
 * authorization. The client secret is never read back.
 */
export const githubOAuthSchema = z.object({
  /**
   * The author connection people link their accounts with: the one chosen,
   * or the only author connection. Null with none, or with several and none
   * chosen. Absent from servers before several Apps a role.
   */
  connection_id: z.uuid().nullable().optional(),
  /** That connection's, as GitHub last gave it; null without one or a read. */
  client_id: z.string().nullable(),
  client_secret_set: z.boolean(),
  /** What the App's Callback URL must be; null when the console has no origin. */
  callback_url: z.url().nullable(),
});

/**
 * An installation's state, in this order: `suspended` whatever it approved;
 * `approval_pending` when it has not approved every permission the App asks
 * for; `unknown` when the App's permissions were never read to compare, or
 * when GitHub did not answer and the installation is from the last list read.
 */
export const GITHUB_INSTALLATION_STATUS_VALUES = [
  "active",
  "approval_pending",
  "suspended",
  "unknown",
] as const;

/** What only owners and admins read of an installation. */
export const githubInstallationDetailSchema = z
  .object({
    connection_id: z.string().min(1),
    role: githubAppRoleSchema,
    /** GitHub's id of the account; its login can change. Null when GitHub gave none. */
    account_id: z.number().int().positive().nullable(),
    /** What the account approved for this installation. */
    permissions: githubAppPermissionsSchema,
    /** Against what the App asks for; `unknown` before the App is read. */
    approval: z.enum(["approved", "pending", "unknown"]),
    /** GitHub's count; null when it was not read. */
    repository_count: z.number().int().min(0).nullable(),
    repository_selection: z.enum(["all", "selected"]),
    /** The installation's settings page on GitHub. */
    html_url: z.string().url().nullable(),
    created_at: z.iso.datetime().nullable(),
    suspended_at: z.iso.datetime().nullable(),
    /**
     * Who finished installing it from the console, and when; null for an
     * installation made on GitHub directly, or before the console kept it.
     * `by` is null once that person's account is gone. Shown, never used
     * to decide access: GitHub's setup URL can be forged.
     */
    connected: z
      .object({
        by: z
          .object({ user_id: z.uuid(), display_name: z.string().min(1) })
          .strict()
          .nullable(),
        at: z.iso.datetime(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

/** An installation of a connection's App, as every member reads it. */
export const githubSettingsInstallationSchema = z
  .object({
    id: z.number().int().positive(),
    /** The organization or user login it is installed on. */
    account: z.string().min(1),
    account_type: z.enum(["organization", "user"]),
    status: z.enum(GITHUB_INSTALLATION_STATUS_VALUES),
    /** Null for a member who does not manage the workspace. */
    detail: githubInstallationDetailSchema.nullable(),
  })
  .strict();

/**
 * Why GitHub gave no answer for an App: `github_unavailable` is no answer,
 * a server error or a rate limit; `github_app_auth_failed` is GitHub
 * refusing the App's JWT (a revoked key or a deleted App).
 */
export const GITHUB_UNAVAILABLE_VALUES = [
  "github_unavailable",
  "github_app_auth_failed",
] as const;

/** This request's read of one connection's installations. */
export const githubConnectionCheckSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ok"),
      checked_at: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      reason_code: z.enum(GITHUB_UNAVAILABLE_VALUES),
      checked_at: z.iso.datetime(),
    })
    .strict(),
]);

/** One registered App (a `github_apps` row) and where it is installed. */
export const githubSettingsConnectionSchema = z
  .object({
    connection_id: z.string().min(1),
    role: githubAppRoleSchema,
    name: z.string().min(1),
    app_id: z.number().int().positive(),
    /** The App's page on GitHub; its `/installations/new` installs it. */
    html_url: z.string().url(),
    /**
     * The account that owns the App, as GitHub gave it on this read; null
     * when GitHub did not answer. Its permissions are set under that account.
     */
    owner: z
      .object({
        login: z.string().min(1),
        type: z.enum(["organization", "user"]),
      })
      .strict()
      .nullable(),
    /** What the App asks for, as last read; null before a read. */
    permissions: githubAppPermissionsSchema.nullable(),
    /**
     * `ok` when GitHub took the App's key on this read, `rejected` when it
     * refused it, `unknown` when GitHub did not answer.
     */
    key_status: z.enum(["ok", "rejected", "unknown"]),
    /**
     * Where the App is installed, as of `installations_read_at`. When this
     * read failed, the last list GitHub gave, each `status: unknown`.
     */
    installations: z.array(githubSettingsInstallationSchema),
    /**
     * When `installations` was read from GitHub: this read, or the last one
     * that answered; null when none did.
     */
    installations_read_at: z.iso.datetime().nullable(),
    check: githubConnectionCheckSchema,
  })
  .strict();

export const githubSettingsResponseSchema = z.object({
  ceiling: githubCeilingSchema,
  /** 0 until the ceiling is first saved. */
  revision: z.number().int().nonnegative(),
  /**
   * Per feature: agents with GitHub on whose active release turns it on.
   * Sessions of earlier releases are not counted.
   */
  agents_using: z.object({
    workflows: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
    checks: z.number().int().nonnegative(),
    issues: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
  }),
  oauth: githubOAuthSchema,
  /** The pull request layout; the defaults until first saved. */
  pull_request: pullRequestSettingsSchema,
  /** Its own revision, 0 until first saved: saving it never moves `revision`. */
  pull_request_revision: z.number().int().nonnegative(),
  /** Every registered App, author ones first; several may share a role. */
  connections: z.array(githubSettingsConnectionSchema),
  /**
   * The App's permissions as last read from GitHub; null before a read.
   * A role with several connections reads null: use `connections`.
   */
  apps: z.object({
    author: z
      .object({ permissions: githubAppPermissionsSchema.nullable() })
      .nullable(),
    reviewer: z
      .object({ permissions: githubAppPermissionsSchema.nullable() })
      .nullable(),
  }),
});

/** CAS on `revision`: a stale one answers 409 REVISION_CONFLICT. */
export const putGitHubSettingsRequestSchema = z
  .object({
    ceiling: githubCeilingSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();

/**
 * CAS on `pull_request_revision`: a stale one answers 409 REVISION_CONFLICT.
 * A template the platform will not use is 400 with a `reason_code` from
 * PULL_REQUEST_TEMPLATE_REFUSAL_VALUES.
 */
export const putGitHubPullRequestSettingsRequestSchema = z
  .object({
    pull_request: pullRequestSettingsSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const putGitHubPullRequestSettingsResponseSchema = z.object({
  pull_request: pullRequestSettingsSchema,
  pull_request_revision: z.number().int().positive(),
  /** Null when the values already held: nothing changed. */
  receipt_id: z.uuid().nullable(),
});

/** `inherit`: the workspace's `formatting` applies. */
export const AGENT_PULL_REQUEST_FORMATTING_VALUES = [
  "inherit",
  "on",
  "off",
] as const;

/**
 * A file name in `.github/PULL_REQUEST_TEMPLATE/`, compared to the names found
 * there and never used as a path, so any printable text is harmless; the
 * bound only keeps the row small.
 */
export const pullRequestTemplateNameSchema = z
  .string()
  .min(1)
  .max(100)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  .regex(/^[^\u0000-\u001f\u007f]+$/)
  // A lone surrogate cannot be written to the receipt's jsonb.
  .refine((name) => !/\p{Cs}/u.test(name), "not valid Unicode");

/**
 * What an agent sets over the workspace's: `formatting` (`inherit` follows
 * the workspace), its own `template` (null: the workspace's), and which file
 * of a repository's `PULL_REQUEST_TEMPLATE/` directory to use when it holds
 * several. Kept apart from the GitHub policy row: saving it never makes a
 * session follow the agent's GitHub settings instead of its release.
 */
export const agentPullRequestSettingsSchema = z
  .object({
    formatting: z.enum(AGENT_PULL_REQUEST_FORMATTING_VALUES),
    template: pullRequestTemplateTextSchema.nullable(),
    template_name: pullRequestTemplateNameSchema.nullable(),
  })
  .strict();

export const DEFAULT_AGENT_PULL_REQUEST_SETTINGS: AgentPullRequestSettings = {
  formatting: "inherit",
  template: null,
  template_name: null,
};

export const agentPullRequestResponseSchema = z.object({
  pull_request: agentPullRequestSettingsSchema,
  /** 0 while the agent has saved none. A save sends it back as `revision`. */
  pull_request_revision: z.number().int().nonnegative(),
});

/** CAS on `pull_request_revision`; refusals as for the workspace's. */
export const putAgentPullRequestSettingsRequestSchema = z
  .object({
    pull_request: agentPullRequestSettingsSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const putAgentPullRequestSettingsResponseSchema = z.object({
  pull_request: agentPullRequestSettingsSchema,
  pull_request_revision: z.number().int().positive(),
  /** Null when the values already held: nothing changed. */
  receipt_id: z.uuid().nullable(),
});

// Printable ASCII without spaces, as GitHub hands it out; a pasted space or
// newline is refused rather than kept. The same rule as the Slack secrets
// (secretValueSchema), restated here to keep this file on zod alone.
export const putGitHubOAuthClientSecretRequestSchema = z
  .object({
    /**
     * The author App's client id the secret belongs to, as `oauth.client_id`
     * showed it: another App's now is 409 REVISION_CONFLICT.
     */
    client_id: z.string().min(1).max(255),
    client_secret: z
      .string()
      .min(8)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces"),
  })
  .strict();

export const putGitHubOAuthClientSecretResponseSchema = z.object({
  receipt_id: z.uuid(),
  oauth: githubOAuthSchema,
});

/** Another author connection for linking accounts; its client secret is entered again. */
export const putGitHubUserLinkAppRequestSchema = z
  .object({ connection_id: z.uuid() })
  .strict();

export const putGitHubUserLinkAppResponseSchema = z.object({
  /** Null when the connection was already the one: nothing changed. */
  receipt_id: z.uuid().nullable(),
  oauth: githubOAuthSchema,
});

export type PutGitHubUserLinkAppRequest = z.infer<
  typeof putGitHubUserLinkAppRequestSchema
>;
export type PutGitHubUserLinkAppResponse = z.infer<
  typeof putGitHubUserLinkAppResponseSchema
>;

export type GitHubOAuth = z.infer<typeof githubOAuthSchema>;
export type PutGitHubOAuthClientSecretRequest = z.infer<
  typeof putGitHubOAuthClientSecretRequestSchema
>;
export type PutGitHubOAuthClientSecretResponse = z.infer<
  typeof putGitHubOAuthClientSecretResponseSchema
>;
export type GitHubSettingsConnection = z.infer<
  typeof githubSettingsConnectionSchema
>;
export type GitHubSettingsInstallation = z.infer<
  typeof githubSettingsInstallationSchema
>;
export type GitHubInstallationDetail = z.infer<
  typeof githubInstallationDetailSchema
>;
export type GitHubUnavailable = (typeof GITHUB_UNAVAILABLE_VALUES)[number];
export type GitHubSettingsResponse = z.infer<
  typeof githubSettingsResponseSchema
>;
export type PutGitHubSettingsRequest = z.infer<
  typeof putGitHubSettingsRequestSchema
>;
export type PullRequestSettings = z.infer<typeof pullRequestSettingsSchema>;
export type AgentPullRequestSettings = z.infer<
  typeof agentPullRequestSettingsSchema
>;
export type AgentPullRequestResponse = z.infer<
  typeof agentPullRequestResponseSchema
>;
export type PutAgentPullRequestSettingsRequest = z.infer<
  typeof putAgentPullRequestSettingsRequestSchema
>;
export type PutAgentPullRequestSettingsResponse = z.infer<
  typeof putAgentPullRequestSettingsResponseSchema
>;
export type PutGitHubPullRequestSettingsRequest = z.infer<
  typeof putGitHubPullRequestSettingsRequestSchema
>;
export type PutGitHubPullRequestSettingsResponse = z.infer<
  typeof putGitHubPullRequestSettingsResponseSchema
>;
export type GitHubPurpose = z.infer<typeof githubPurposeSchema>;
export type GitHubAppRole = z.infer<typeof githubAppRoleSchema>;
export type GitHubFeatures = z.infer<typeof githubFeaturesSchema>;
export type GitHubCeiling = z.infer<typeof githubCeilingSchema>;
export type GitHubRefusal = (typeof GITHUB_REFUSAL_VALUES)[number];
