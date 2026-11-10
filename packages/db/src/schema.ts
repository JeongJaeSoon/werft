import {
  ACHIEVEMENT_EVIDENCE_KIND_VALUES,
  ACHIEVEMENT_JUDGE_BACKEND_VALUES,
  ACHIEVEMENT_JUDGMENT_ERROR_VALUES,
  ACHIEVEMENT_JUDGMENT_STATUS_VALUES,
  ACHIEVEMENT_JUDGMENT_TRIGGER_VALUES,
  ACHIEVEMENT_REVIEW_STATE_VALUES,
  ACHIEVEMENT_RULE_JUDGE_VALUES,
  ADMISSION_STATE_VALUES,
  AGENT_DESCRIPTION_MAX_LENGTH,
  AGENT_IDENTITY_PROVIDER_VALUES,
  AGENT_IDENTITY_STATUS_VALUES,
  AGENT_STATUS_VALUES,
  BINDING_MODE_VALUES,
  ENV_VARIABLE_KIND_VALUES,
  ENV_VARIABLE_NAME_PATTERN,
  ENV_VARIABLE_VALUE_MAX_BYTES,
  GITHUB_POLICY_SOURCE_VALUES,
  GITHUB_PULL_REQUEST_OUTCOME_STATE_VALUES,
  GITHUB_REVIEW_OUTCOME_STATE_VALUES,
  type GitHubAppRole,
  type GitHubCeiling,
  type GitHubFeatures,
  type GitHubPackagesAllowEntry,
  MEMORY_WRITE_POLICY_VALUES,
  OPEN_PUSH_REQUEST_STATES,
  PERMISSION_MODE_VALUES,
  type PlatformPrompt,
  PULL_REQUEST_STAGE_VALUES,
  PUSH_APPROVAL_BASIS_VALUES,
  PUSH_INTENT_REFUSAL_VALUES,
  PUSH_INTENT_STATUS_VALUES,
  PUSH_REQUEST_FLOW_VALUES,
  PUSH_REQUEST_ORIGIN_VALUES,
  PUSH_REQUEST_STATE_VALUES,
  RECEIPT_STATUS_VALUES,
  REPOSITORY_SCOPE_VALUES,
  SESSION_OUTCOME_CHECK_ERROR_VALUES,
  SESSION_OUTCOME_TYPE_VALUES,
  SESSION_STATUS_VALUES,
  type SessionOutcome,
  type SessionOutcomeCheckError,
  type SessionOutcomeType,
  SLACK_APP_KIND_VALUES,
  SLACK_APP_STATE_VALUES,
  SLACK_INBOUND_DROP_REASON_VALUES,
  SLACK_INBOUND_EVENT_STATUS_VALUES,
  SLACK_SURFACE_ACTION_VALUES,
  type SlackAppKind,
  type SlackAppState,
  type SlackInboundDropReason,
  type SlackInboundEventStatus,
  type SlackMessageRef,
  SURFACE_BINDING_STATUS_VALUES,
  SURFACE_CHANNEL_KIND_VALUES,
  SURFACE_DISCLOSURE_VALUES,
  SURFACE_KIND_VALUES,
  SURFACE_MEMBERSHIP_STATE_VALUES,
  type SurfaceKind,
  type SurfaceMembershipState,
  TEAM_MEMBER_ROLE_VALUES,
  USER_LOCALE_VALUES,
  type UserLocale,
} from "@werft-ai/contracts";
import type {
  SecretOwnerRef,
  SlackOutboxBody,
  SlackOutboxKind,
  SlackOutboxStatus,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

/** The largest `sessions.cost_usd` numeric(14, 6) holds; sums saturate here. */
export const MAX_SESSION_COST_USD = 99_999_999.999999;

export const sessionStatus = pgEnum("session_status", SESSION_STATUS_VALUES);
export const admissionState = pgEnum("admission_state", ADMISSION_STATE_VALUES);
export const receiptStatus = pgEnum("receipt_status", RECEIPT_STATUS_VALUES);

// Vocabularies the CHECK constraints below pin. They mirror
// SESSION_SCOPE_VALUES and AUTHORIZATION_ACTION_VALUES; schema.test.ts
// asserts the two lists are equal, the way
// it already does for sessionStatus.
export const SESSION_SCOPE_VALUES = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
  "sessions:recover",
] as const;
export const AUTHORIZATION_ACTION_VALUES = [
  "workspace.read",
  "workspace.manage",
  "agent.manage",
  "binding.manage",
  "binding.approve",
  "routine.manage",
  "session.read",
  "session.submit",
  "session.approve",
  "session.control",
  "session.recover",
  "memory.read",
  "memory.write",
  "artifact.read",
  "delivery.send",
] as const;
export const RESOURCE_KIND_VALUES = [
  "workspace",
  "session",
  "invite",
  "agent",
  "agent_release",
  "surface_binding",
  "session_link",
  "dispatch",
  "memory",
  "routine",
  "artifact",
] as const;
export const AUDIENCE_KIND_VALUES = [
  "workspace",
  "surface_binding",
  "session_link",
  "session",
] as const;
// Which resource kinds each action may be granted on: `session.read` on a
// workspace would be a workspace-wide read smuggled in through the resource.
const ACTION_RESOURCE_KINDS: Record<
  (typeof AUTHORIZATION_ACTION_VALUES)[number],
  readonly (typeof RESOURCE_KIND_VALUES)[number][]
> = {
  "workspace.read": ["workspace"],
  "workspace.manage": ["workspace"],
  "agent.manage": ["workspace", "agent"],
  "binding.manage": ["workspace", "agent", "surface_binding"],
  "binding.approve": ["workspace", "agent", "surface_binding"],
  "routine.manage": ["workspace", "agent", "routine"],
  "session.read": ["session", "session_link"],
  "session.submit": ["session", "session_link", "surface_binding"],
  "session.approve": ["session", "session_link"],
  "session.control": ["session", "session_link"],
  "session.recover": ["session"],
  "memory.read": ["workspace", "agent", "memory"],
  "memory.write": ["workspace", "agent", "memory"],
  "artifact.read": ["artifact", "session"],
  "delivery.send": ["session", "session_link", "surface_binding"],
};
const sqlList = (values: readonly string[]) =>
  values.map((value) => `'${value}'`).join(",");
const textArrayLiteral = (values: readonly string[]) =>
  sql.raw(`ARRAY[${sqlList(values)}]::text[]`);
const SESSION_SCOPES_SQL = textArrayLiteral(SESSION_SCOPE_VALUES);
const AUTHORIZATION_ACTIONS_SQL = textArrayLiteral(AUTHORIZATION_ACTION_VALUES);
const RESOURCE_KINDS_SQL = sql.raw(sqlList(RESOURCE_KIND_VALUES));
const AUDIENCE_KINDS_SQL = sql.raw(sqlList(AUDIENCE_KIND_VALUES));
// `actions` must be a subset of what the row's resource kind admits.
const ACTIONS_FOR_RESOURCE_SQL = sql.raw(
  `CASE "resource_kind" ${RESOURCE_KIND_VALUES.map((kind) => {
    const allowed = AUTHORIZATION_ACTION_VALUES.filter((action) =>
      ACTION_RESOURCE_KINDS[action].includes(kind),
    );
    return `WHEN '${kind}' THEN ARRAY[${sqlList(allowed)}]::text[]`;
  }).join(" ")} ELSE ARRAY[]::text[] END`,
);
// `<@` ignores dimensions, so a nested array would pass containment and come
// back where TypeScript expects string[]. Empty arrays have no dimensions.
const oneDimensional = (column: unknown) =>
  sql`coalesce(array_ndims(${column}), 1) = 1`;

// Identity (I0-2, 03 §3.1). One workspace per installation for now; every
// row added by the interface track carries a workspace_id. Vocabularies are
// CHECK constraints rather than pg enums so that widening one is a plain
// additive migration, and rather than contracts imports so that the schema
// does not depend on a package that is still landing.
export const workspaces = pgTable("workspaces", {
  id: uuid().primaryKey(),
  slug: text().notNull().unique(),
  name: text().notNull(),
  settings: jsonb().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey(),
    email: text().notNull().unique(),
    /** argon2id; null for an account that only signs in externally. */
    passwordHash: text("password_hash"),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Account suspension. Losing one workspace is memberships.disabled_at, a
    // different thing.
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    // Null until the console saves one; Slack then tells them in English.
    locale: text().$type<UserLocale>(),
  },
  (table) => [
    // The unique above is case-sensitive, so lower-casing has to be a fact of
    // the row rather than a promise of the caller (contracts normalizeEmail).
    check(
      "users_email_lower_check",
      sql`${table.email} = lower(${table.email})`,
    ),
    check(
      "users_locale_check",
      sql`${table.locale} IN (${sql.raw(sqlList(USER_LOCALE_VALUES))})`,
    ),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    // Login resolves a user's workspaces; the PK leads with workspace_id.
    index("memberships_user_idx").on(table.userId),
    check(
      "memberships_role_check",
      sql`${table.role} IN ('owner', 'admin', 'member')`,
    ),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text().notNull(),
    role: text().notNull(),
    /** sha256 of the one-time token; the token itself is never stored. */
    tokenHash: bytea("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One redeemable invite per address and workspace: re-inviting revokes
    // the old row first, and two owners cannot each hand out a live token.
    // An expired-but-unrevoked row still counts here, on purpose.
    uniqueIndex("invites_live_email_uniq")
      .on(table.workspaceId, table.email)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    check(
      "invites_role_check",
      sql`${table.role} IN ('owner', 'admin', 'member')`,
    ),
    // Same rule as users.email, or the live-invite unique above would let
    // two spellings of one address stay redeemable at once.
    check(
      "invites_email_lower_check",
      sql`${table.email} = lower(${table.email})`,
    ),
    // An invite is consumed once: accepted or revoked, never both.
    check(
      "invites_single_outcome_check",
      sql`${table.acceptedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
  ],
);

export const loginMethods = pgTable(
  "login_methods",
  {
    id: uuid().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text().$type<"password" | "google">().notNull(),
    issuer: text(),
    subject: text(),
    /** The address the provider vouched for when the account was linked. */
    emailAtLink: text("email_at_link"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("login_methods_external_uniq").on(
      table.kind,
      table.issuer,
      table.subject,
    ),
    uniqueIndex("login_methods_password_user_uniq")
      .on(table.userId)
      .where(sql`${table.kind} = 'password'`),
    check(
      "login_methods_kind_check",
      sql`${table.kind} IN ('password', 'google')`,
    ),
    check(
      "login_methods_external_check",
      sql`CASE WHEN ${table.kind} = 'password' THEN ${table.issuer} IS NULL AND ${table.subject} IS NULL ELSE ${table.issuer} IS NOT NULL AND ${table.subject} IS NOT NULL END`,
    ),
  ],
);

export const webSessions = pgTable(
  "web_sessions",
  {
    id: uuid().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** sha256 of the cookie value. */
    tokenHash: bytea("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    userAgent: text("user_agent"),
  },
  (table) => [
    // Logout-everywhere and the login lockout both walk a user's live sessions.
    index("web_sessions_user_live_idx")
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
    // The reconciler deletes rows 30 days past expiry.
    index("web_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const passwordResets = pgTable(
  "password_resets",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** sha256 of the one-time token; the token itself is never stored. */
    tokenHash: bytea("token_hash").notNull().unique(),
    issuedBy: uuid("issued_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Issuing a new link revokes the user's open one, so at most one link
    // per user can set a password.
    uniqueIndex("password_resets_live_user_uniq")
      .on(table.userId)
      .where(sql`${table.usedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    check(
      "password_resets_single_outcome_check",
      sql`${table.usedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
  ],
);

// A BOOTSTRAP_TOKEN works once per installation, not once per process: a
// value left in the environment after an install must not reopen recovery
// the next time no live owner remains.
export const bootstrapTokenUses = pgTable("bootstrap_token_uses", {
  tokenHash: bytea("token_hash").primaryKey(),
  usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
});

// The shared Slack app installed in one Slack team, owned by one workspace.
// A row is registered `pending` from config, turns `verified` once
// `auth.test` confirms the app, team and bot user, and is `revoked` rather
// than deleted so that rows pointing at it keep their target. No secret is
// stored here; credentials stay in the config's references.
export const slackInstallations = pgTable(
  "slack_installations",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    appId: text("app_id").notNull(),
    teamId: text("team_id").notNull(),
    /** Known only once `auth.test` has answered. */
    botUserId: text("bot_user_id"),
    status: text()
      .$type<"pending" | "verified" | "revoked">()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    unique("slack_installations_app_team_uniq").on(table.appId, table.teamId),
    // What agent_identities references, so an identity cannot pin another
    // workspace's install.
    unique("slack_installations_workspace_id_key").on(
      table.workspaceId,
      table.id,
    ),
    check(
      "slack_installations_status_check",
      sql`${table.status} IN ('pending', 'verified', 'revoked')`,
    ),
    check(
      "slack_installations_verified_check",
      sql`${table.status} <> 'verified' OR (${table.botUserId} IS NOT NULL AND ${table.verifiedAt} IS NOT NULL)`,
    ),
    check(
      "slack_installations_revoked_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)`,
    ),
  ],
);

// Runtime secrets (Slack config token, app secrets), AES-256-GCM under the
// API's master key.
export const secretValues = pgTable(
  "secret_values",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerRef: text("owner_ref").$type<SecretOwnerRef>().notNull(),
    purpose: text().notNull(),
    secretVersion: integer("secret_version").notNull(),
    keyVersion: integer("key_version").notNull(),
    nonce: bytea().notNull(),
    ciphertext: bytea().notNull(),
    last4: text().notNull(),
    /** No foreign key: the row outlives the account; null for a server write. */
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("secret_values_slot_uniq").on(
      table.workspaceId,
      table.ownerRef,
      table.purpose,
    ),
    check(
      "secret_values_versions_check",
      sql`${table.secretVersion} > 0 AND ${table.keyVersion} > 0`,
    ),
    check("secret_values_last4_check", sql`length(${table.last4}) = 4`),
  ],
);

// What the console and the rotator know about a workspace's App
// Configuration Token without opening it; the token pair itself is the
// workspace's `slack_config_token` secret.
export const slackConfigTokens = pgTable(
  "slack_config_tokens",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id),
    state: text().$type<"active" | "needs_reentry">().notNull(),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    issuerUserId: text("issuer_user_id"),
    issuerTeamId: text("issuer_team_id"),
    previousIssuerUserId: text("previous_issuer_user_id"),
    issuerChangedAt: timestamp("issuer_changed_at", { withTimezone: true }),
    leaseId: uuid("lease_id"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "slack_config_tokens_state_check",
      sql`${table.state} IN ('active', 'needs_reentry')`,
    ),
    check(
      "slack_config_tokens_lease_check",
      sql`(${table.leaseId} IS NULL) = (${table.leaseUntil} IS NULL)`,
    ),
  ],
);

// A GitHub App connection registered in the console. Its private key is a
// secret_values row owned by `github_app:<id>`.
export const githubApps = pgTable(
  "github_apps",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    appId: bigint("app_id", { mode: "number" }).notNull(),
    slug: text().notNull(),
    name: text().notNull(),
    htmlUrl: text("html_url").notNull(),
    apiBase: text("api_base").notNull(),
    role: text().$type<GitHubAppRole>().notNull().default("author"),
    /** `GET /app`'s permissions as last read; null until the first read. */
    permissions: jsonb().$type<Record<string, string>>(),
    permissionsCheckedAt: timestamp("permissions_checked_at", {
      withTimezone: true,
    }),
    /** `GET /app`'s `client_id`, for linking users; null until it is read. */
    clientId: text("client_id"),
    /** No foreign key: the row outlives the account. */
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("github_apps_workspace_app_uniq").on(table.workspaceId, table.appId),
    check("github_apps_app_id_check", sql`${table.appId} > 0`),
    check(
      "github_apps_role_check",
      sql`${table.role} IN ('author', 'reviewer')`,
    ),
    check(
      "github_apps_permissions_check",
      sql`(${table.permissions} IS NULL) = (${table.permissionsCheckedAt} IS NULL)`,
    ),
  ],
);

// A GitHub App manifest's single-use state, stored as its SHA-256 (design
// github-app-manifest.md §3).
export const githubAppManifestStates = pgTable(
  "github_app_manifest_states",
  {
    stateHash: bytea("state_hash").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    actorUserId: uuid("actor_user_id").notNull(),
    role: text().$type<GitHubAppRole>().notNull(),
    /** Null: the actor's own account. */
    ownerLogin: text("owner_login"),
    public: boolean().notNull(),
    replacesAppId: bigint("replaces_app_id", { mode: "number" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("github_app_manifest_states_expires_idx").on(table.expiresAt),
    check(
      "github_app_manifest_states_role_check",
      sql`${table.role} IN ('author', 'reviewer')`,
    ),
  ],
);

export const githubInstallationSnapshots = pgTable(
  "github_installation_snapshots",
  {
    connectionId: uuid("connection_id")
      .primaryKey()
      .references(() => githubApps.id, { onDelete: "cascade" }),
    appId: bigint("app_id", { mode: "number" }).notNull(),
    installations: jsonb().$type<unknown[]>().notNull(),
    readAt: timestamp("read_at", { withTimezone: true }).notNull(),
  },
);

export const githubInstallationStates = pgTable(
  "github_installation_states",
  {
    stateHash: bytea("state_hash").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => githubApps.id, { onDelete: "cascade" }),
    appId: bigint("app_id", { mode: "number" }).notNull(),
    actorUserId: uuid("actor_user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("github_installation_states_expires_idx").on(table.expiresAt),
  ],
);

// Who finished an installation started in the console. Display only: the
// setup URL GitHub returns to can be forged, so nothing decides on it.
export const githubInstallationLinks = pgTable(
  "github_installation_links",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => githubApps.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    appId: bigint("app_id", { mode: "number" }).notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    /** No foreign key: the row outlives the account. */
    connectedBy: uuid("connected_by").notNull(),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.installationId] }),
    check(
      "github_installation_links_installation_id_check",
      sql`${table.installationId} > 0`,
    ),
  ],
);

// What the workspace lets its agents' GitHub settings reach. No row reads as
// every ceiling off and no OAuth client secret.
export const githubWorkspaceSettings = pgTable("github_workspace_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  ceiling: jsonb().$type<GitHubCeiling>().notNull(),
  // The repositories agent sessions and `repository_scope = workspace`
  // profiles may reach. Null allows none. `revision` covers it.
  repositoryCeiling: jsonb("repository_ceiling").$type<unknown>(),
  // How pull request bodies are laid out. Null reads as the defaults. Its
  // own revision keeps a save here from conflicting with one of the ceiling.
  pullRequest: jsonb("pull_request").$type<unknown>(),
  pullRequestRevision: integer("pull_request_revision").notNull().default(0),
  oauthClientSecretSet: boolean("oauth_client_secret_set")
    .notNull()
    .default(false),
  /**
   * The author connection people link their accounts with. Null with one
   * author connection reads as that one: an earlier image registers the
   * first without setting it.
   */
  userLinkConnectionId: uuid("user_link_connection_id").references(
    () => githubApps.id,
    { onDelete: "restrict" },
  ),
  revision: integer().notNull().default(1),
  /** No foreign key: the row outlives the account. */
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The connection each catalog repository's work uses, per role (decision
 * github-agent.md 11). A row is not deleted when its connection is: the
 * connection id goes null and the gate refuses until an admin re-pins it or
 * the same App is added back.
 */
export const catalogRepositoryGitHubApps = pgTable(
  "catalog_repository_github_apps",
  {
    repositoryId: text("repository_id").notNull(),
    role: text().$type<GitHubAppRole>().notNull(),
    connectionId: uuid("connection_id").references(() => githubApps.id, {
      onDelete: "set null",
    }),
    appId: bigint("app_id", { mode: "number" }).notNull(),
    /** `claim`: made by a claim for its commit author (decision D11). */
    pinnedBy: text("pinned_by")
      .$type<"selection" | "first_mint" | "admin" | "claim">()
      .notNull(),
    /** No foreign key: the row outlives the account. */
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.repositoryId, table.role] }),
    index("catalog_repository_github_apps_connection_idx").on(
      table.connectionId,
    ),
    check(
      "catalog_repository_github_apps_role_check",
      sql`${table.role} IN ('author', 'reviewer')`,
    ),
    check(
      "catalog_repository_github_apps_pinned_by_check",
      sql`${table.pinnedBy} IN ('selection', 'first_mint', 'admin', 'claim')`,
    ),
  ],
);

// The GitHub Packages bot token's facts (the value is in `secret_values`)
// and the packages sessions may fetch with it. No row reads as no token and
// an empty allowlist.
export const githubPackagesSettings = pgTable("github_packages_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  allowlist: jsonb().$type<GitHubPackagesAllowEntry[]>().notNull(),
  tokenLogin: text("token_login"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  revision: integer().notNull().default(1),
  /** No foreign key: the row outlives the account. */
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The runs the platform dispatched itself, on a branch: the only runs a
 * session may rerun, since GitHub's run alone cannot prove its ref was a
 * branch and not a tag of the same name.
 */
export const githubWorkflowDispatches = pgTable(
  "github_workflow_dispatches",
  {
    runId: bigint("run_id", { mode: "number" }).notNull(),
    repositoryId: text("repository_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references((): AnyPgColumn => sessions.id),
    agentReleaseId: text("agent_release_id"),
    workflow: text().notNull(),
    /** A branch, without `refs/heads/`. */
    ref: text().notNull(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references((): AnyPgColumn => receipts.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "github_workflow_dispatches_pkey",
      columns: [table.repositoryId, table.runId],
    }),
  ],
);

export const slackApps = pgTable(
  "slack_apps",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: text().$type<SlackAppKind>().notNull(),
    agentId: uuid("agent_id"),
    state: text().$type<SlackAppState>().notNull(),
    appId: text("app_id"),
    clientId: text("client_id"),
    redirectUrl: text("redirect_url").notNull(),
    eventsState: text("events_state")
      .$type<"pending" | "verified" | "failed">()
      .notNull()
      .default("pending"),
    eventsCheckedAt: timestamp("events_checked_at", { withTimezone: true }),
    eventsError: text("events_error"),
    /** The Request URL last sent to Slack; null until one is. */
    eventsUrl: text("events_url"),
    createdByTokenUser: text("created_by_token_user"),
    /** No foreign key: the row outlives the account; null for the CLI. */
    createdBy: uuid("created_by"),
    signingSecretRef: text("signing_secret_ref"),
    clientSecretRef: text("client_secret_ref"),
    botTokenRef: text("bot_token_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("slack_apps_app_id_key").on(table.appId),
    check(
      "slack_apps_events_state_check",
      sql`${table.eventsState} IN ('pending', 'verified', 'failed')`,
    ),
    uniqueIndex("slack_apps_live_agent_idx")
      .on(table.workspaceId, table.agentId)
      .where(
        sql`${table.kind} = 'agent' AND ${table.state} IN ('creating', 'created', 'deleting')`,
      ),
    uniqueIndex("slack_apps_live_link_idx")
      .on(table.workspaceId)
      .where(
        sql`${table.kind} = 'link' AND ${table.state} IN ('creating', 'created', 'deleting')`,
      ),
    foreignKey({
      name: "slack_apps_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    check(
      "slack_apps_kind_check",
      sql`${table.kind} IN (${sql.raw(sqlList(SLACK_APP_KIND_VALUES))})`,
    ),
    check(
      "slack_apps_state_check",
      sql`${table.state} IN (${sql.raw(sqlList(SLACK_APP_STATE_VALUES))})`,
    ),
    check(
      "slack_apps_agent_check",
      sql`(${table.kind} = 'agent') = (${table.agentId} IS NOT NULL)`,
    ),
    check(
      "slack_apps_created_check",
      sql`${table.state} NOT IN ('created', 'deleting', 'deleted') OR (${table.appId} IS NOT NULL AND ${table.clientId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Install links in flight: the sha256 of each OAuth `state`, never the
 * value, with who may complete it for which agent's app. A row is deleted
 * when the link is completed, whatever the outcome, or once it expired.
 */
export const slackInstallStates = pgTable(
  "slack_install_states",
  {
    stateHash: bytea("state_hash").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id").notNull(),
    slackAppId: uuid("slack_app_id")
      .notNull()
      .references(() => slackApps.id),
    actorUserId: uuid("actor_user_id").notNull(),
    teamId: text("team_id").notNull(),
    redirectUrl: text("redirect_url").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("slack_install_states_expires_idx").on(table.expiresAt)],
);

// One row per (team_id, event_id): Slack keeps `event_id` across its
// retries. 94S-790 adds the claim columns.
export const slackInboundEvents = pgTable(
  "slack_inbound_events",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id").notNull(),
    slackAppId: uuid("slack_app_id")
      .notNull()
      .references(() => slackApps.id),
    teamId: text("team_id").notNull(),
    appId: text("app_id").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    eventSubtype: text("event_subtype"),
    eventTime: timestamp("event_time", { withTimezone: true }),
    status: text().$type<SlackInboundEventStatus>().notNull(),
    dropReason: text("drop_reason").$type<SlackInboundDropReason>(),
    payload: jsonb().$type<Record<string, unknown>>(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * `<slack_app_id>:<channel>:<thread_ts ?? ts>`: the thread a message
     * belongs to, in which the `slack` role takes one event at a time.
     * Null on dropped rows and on events outside a channel message.
     */
    conversationKey: text("conversation_key"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Claims so far, lease expiries included. */
    attempts: integer().notNull().default(0),
    /** A failed attempt's backoff; unclaimable before it. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  },
  (table) => [
    // Per app: the event_id two apps of one team receive for one message is
    // not documented to differ, and each app's copy is its own work.
    unique("slack_inbound_events_app_event_key").on(table.appId, table.eventId),
    foreignKey({
      name: "slack_inbound_events_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    check(
      "slack_inbound_events_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(SLACK_INBOUND_EVENT_STATUS_VALUES))})`,
    ),
    check(
      "slack_inbound_events_drop_reason_check",
      sql`${table.dropReason} IS NULL OR ${table.dropReason} IN (${sql.raw(sqlList(SLACK_INBOUND_DROP_REASON_VALUES))})`,
    ),
    check(
      "slack_inbound_events_dropped_check",
      sql`(${table.status} = 'dropped') = (${table.dropReason} IS NOT NULL) AND (${table.status} = 'dropped') = (${table.payload} IS NULL)`,
    ),
    check(
      "slack_inbound_events_conversation_check",
      sql`${table.status} <> 'dropped' OR ${table.conversationKey} IS NULL`,
    ),
    check(
      "slack_inbound_events_claim_check",
      sql`(${table.claimToken} IS NULL) = (${table.leaseExpiresAt} IS NULL) AND (${table.status} = 'received' OR ${table.claimToken} IS NULL)`,
    ),
    index("slack_inbound_events_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'received'`),
    index("slack_inbound_events_conversation_idx")
      .on(table.conversationKey, table.eventTime, table.receivedAt)
      .where(sql`${table.status} = 'received'`),
  ],
);

// A person's account on another service (design A.2): today a Slack user,
// linked through Sign in with Slack. Rows are revoked, never deleted, so the
// receipts that name one keep their target; every status change bumps
// `revision`, which a decision made on an older reading compares against.
export const linkedAccounts = pgTable(
  "linked_accounts",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    provider: text().$type<"slack" | "github">().notNull(),
    /** The Slack team id. */
    externalTenant: text("external_tenant").notNull(),
    externalUserId: text("external_user_id").notNull(),
    /** Names from the last verification, for display; null on older links. */
    externalTenantName: text("external_tenant_name"),
    externalUserName: text("external_user_name"),
    status: text()
      .$type<"active" | "stale" | "revoked">()
      .notNull()
      .default("active"),
    revokedReason: text("revoked_reason").$type<"unlinked" | "offboarded">(),
    verifiedVia: text("verified_via")
      .$type<"slack_oidc" | "github_oauth">()
      .notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    revision: integer().notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // One person per external account, and one account per person in each
    // Slack team, among the rows that still resolve.
    uniqueIndex("linked_accounts_external_live_uniq")
      .on(table.provider, table.externalTenant, table.externalUserId)
      .where(sql`${table.status} <> 'revoked'`),
    uniqueIndex("linked_accounts_user_live_uniq")
      .on(table.userId, table.provider, table.externalTenant)
      .where(sql`${table.status} <> 'revoked'`),
    index("linked_accounts_workspace_user_idx").on(
      table.workspaceId,
      table.userId,
    ),
    check(
      "linked_accounts_provider_check",
      sql`${table.provider} IN ('slack', 'github')`,
    ),
    check(
      "linked_accounts_status_check",
      sql`${table.status} IN ('active', 'stale', 'revoked')`,
    ),
    check(
      "linked_accounts_revoked_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL) AND (${table.status} = 'revoked') = (${table.revokedReason} IS NOT NULL)`,
    ),
    check(
      "linked_accounts_revoked_reason_check",
      sql`${table.revokedReason} IS NULL OR ${table.revokedReason} IN ('unlinked', 'offboarded')`,
    ),
  ],
);

// One Grant row per `grantSchema`; the refs are stored as
// (kind, id) column pairs so the evaluator (I0-5a) matches them exactly in
// SQL without unpacking JSON. `service_principal_id` is always a service
// actor, so it carries no kind column.
export const grants = pgTable(
  "grants",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    servicePrincipalId: text("service_principal_id"),
    actions: text().array().notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id").notNull(),
    audienceKind: text("audience_kind").notNull(),
    audienceId: text("audience_id").notNull(),
    /** Narrows the key scope; never widens it. */
    scopes: text().array().notNull().default([]),
    revision: integer().notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Evaluation is one query by actor and resource; revoked rows
    // are kept as history and never match.
    index("grants_lookup_idx")
      .on(
        table.workspaceId,
        table.actorKind,
        table.actorId,
        table.resourceKind,
        table.resourceId,
      )
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "grants_actor_kind_check",
      sql`${table.actorKind} IN ('user', 'service')`,
    ),
    check(
      "grants_resource_kind_check",
      sql`${table.resourceKind} IN (${RESOURCE_KINDS_SQL})`,
    ),
    check(
      "grants_audience_kind_check",
      sql`${table.audienceKind} IN (${AUDIENCE_KINDS_SQL})`,
    ),
    check(
      "grants_actions_check",
      sql`cardinality(${table.actions}) > 0 AND ${oneDimensional(table.actions)} AND ${table.actions} <@ ${AUTHORIZATION_ACTIONS_SQL}`,
    ),
    check(
      "grants_actions_resource_check",
      sql`${table.actions} <@ ${ACTIONS_FOR_RESOURCE_SQL}`,
    ),
    check(
      "grants_scopes_check",
      sql`${oneDimensional(table.scopes)} AND ${table.scopes} <@ ${SESSION_SCOPES_SQL}`,
    ),
    check("grants_revision_check", sql`${table.revision} >= 0`),
    // Same bounds as opaqueIdSchema (1..128) and resource/audience
    // refs (1..512), so an empty id cannot be stored and then never matched.
    check(
      "grants_id_length_check",
      sql`length(${table.actorId}) BETWEEN 1 AND 128 AND (${table.servicePrincipalId} IS NULL OR length(${table.servicePrincipalId}) BETWEEN 1 AND 128) AND length(${table.resourceId}) BETWEEN 1 AND 512 AND length(${table.audienceId}) BETWEEN 1 AND 512`,
    ),
    // A grant stored under workspace A must not name workspace B (
    // grantSchema): the evaluator compares the request's workspace with
    // workspace_id, so such a row would match across the boundary.
    check(
      "grants_workspace_ref_check",
      sql`(${table.resourceKind} <> 'workspace' OR ${table.resourceId} = ${table.workspaceId}::text) AND (${table.audienceKind} <> 'workspace' OR ${table.audienceId} = ${table.workspaceId}::text)`,
    ),
  ],
);

// Legacy owner_id strings are never backfilled into a workspace:
// a row here is an operator's explicit statement that this owner's sessions
// and keys belong to that workspace. An unmapped owner stays visible only on
// the api-key path.
export const ownerWorkspaceMap = pgTable("owner_workspace_map", {
  ownerId: text("owner_id").primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  mappedBy: uuid("mapped_by")
    .notNull()
    .references(() => users.id),
  mappedAt: timestamp("mapped_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey(),
    claudeSessionId: text("claude_session_id"),
    ownerId: text("owner_id").notNull(),
    // Given at create or rename, else derived from the first message.
    // Null on rows from before it (not backfilled) and when the first
    // message had no text to derive one from.
    title: text(),
    // `derived` (cut from the first message) is the only title a generated
    // one replaces; `user` is one given at create or by rename. The default
    // is `user`: rows from before it, and an API from before it still
    // writing during a rollout, cannot tell the two kinds apart.
    titleSource: text("title_source", {
      enum: ["derived", "user", "generated"],
    })
      .notNull()
      .default("user"),
    // 'none' marks a session accepted without a repository. A null
    // repository_id alone cannot say that: it already means a row from
    // before the catalog, which no pair matches.
    repositoryMode: text("repository_mode", { enum: ["repository", "none"] })
      .notNull()
      .default("repository"),
    // Null exactly when repository_mode is 'none'.
    repoUrl: text("repo_url"),
    branch: text(),
    status: sessionStatus().notNull().default("queued"),
    admissionState: admissionState("admission_state")
      .notNull()
      .default("active"),
    revision: integer().notNull().default(0),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    executionGeneration: integer("execution_generation").notNull().default(0),
    authRevision: integer("auth_revision").notNull().default(0),
    executionId: text("execution_id"),
    profileId: text("profile_id"),
    // The profile's fingerprint (catalog.ts profileFingerprint) when the
    // session was accepted: settings and credential reference, never the
    // value. A claim binds only on a host whose profile under this id still
    // hashes to it. Null on rows from before it, pinned by their
    // next claim.
    profileFingerprint: text("profile_fingerprint"),
    // The model the session runs, one the profile offers. What a version 2
    // fingerprint pins it to alongside; a version 1 fingerprint names the
    // model itself, and the API backfills this from it at start. Null where
    // neither says.
    model: text(),
    // The profile declared `billing: none` when the session was accepted.
    // Fixed on the row, not read from each API's catalog: during a rollout
    // a replica that does not know the profile must not price its calls.
    unmetered: boolean().notNull().default(false),
    repositoryId: text("repository_id"),
    // The repositories besides its own the session was started with or
    // attached since, narrowing what its release lists
    // (session-repository-attachment.md). Null on a session that attaches
    // none, and on rows from before an omitted list was stored as empty: the
    // release's list applies whole.
    attachedRepositoryIds: text("attached_repository_ids").array(),
    checkpointRevision: integer("checkpoint_revision"),
    checkpointCommittedAt: timestamp("checkpoint_committed_at", {
      withTimezone: true,
    }),
    // Written once and never overwritten: the pinned image of the session's
    // first reserved launch, and the RuntimeFingerprint of the first
    // checkpoint committed with one. The fingerprint is not taken at
    // reservation: a launch that dies before any checkpoint never ran the
    // combination its image names. Null on rows from before them.
    firstWorkerImage: text("first_worker_image"),
    runtimeEngine: text("runtime_engine"),
    runtimeSdkVersion: text("runtime_sdk_version"),
    runtimeCliVersion: text("runtime_cli_version"),
    runtimeProfileSha256: text("runtime_profile_sha256"),
    // A CheckpointBlockReason that outlives the turn that produced it
    // (durability.ts CHECKPOINT_REASONS); null once a checkpoint commits.
    checkpointPendingReason: text("checkpoint_pending_reason"),
    // The attempt that reported the reason. A checkpoint clears a blocking
    // reason only when another attempt commits one: the runtime holds a
    // mirror failure for the whole run, so a checkpoint from the same attempt
    // was captured before the failure at best and proves nothing about what
    // came after. Any commit clears an advisory one.
    checkpointPendingAttemptId: text("checkpoint_pending_attempt_id"),
    // The earlier revision the session was last restored from because the
    // pointer's own checkpoint was damaged. While set, the
    // session's state is that revision's, not the pointer's; the next
    // committed checkpoint, or another attempt restoring the pointer,
    // clears it. The attempt column names the attempt that was last handed
    // a restore plan on the current pointer, fallback or not: that attempt
    // is held to the base it was given.
    checkpointFallbackRevision: integer("checkpoint_fallback_revision"),
    checkpointRestoreAttemptId: text("checkpoint_restore_attempt_id"),
    // Set by a start_fresh recovery decision: the last turn that
    // ran before the operator accepted losing its context, and the pointer
    // the session had then. Turns up to the first are no longer a context
    // gap; checkpoints up to the second are retired and never restored,
    // since a new engine session started on top of neither.
    contextResetTurnSequence: integer("context_reset_turn_sequence"),
    contextResetCheckpointRevision: integer(
      "context_reset_checkpoint_revision",
    ),
    // The worker's last successful transcript mirror write, as it reported
    // it; only ever moves forward.
    lastTranscriptPersistedAt: timestamp("last_transcript_persisted_at", {
      withTimezone: true,
    }),
    // A stopped session's workspace being reclaimed: set under the
    // session lock before the volume is removed, cleared by the claim id that
    // set it once the removal settles. Resume refuses while it is set, so a
    // resumed session never has its workspace removed underneath it.
    workspaceReclaimId: text("workspace_reclaim_id"),
    workspaceReclaimWorkspaceId: text("workspace_reclaim_workspace_id"),
    workspaceReclaimClaimedAt: timestamp("workspace_reclaim_claimed_at", {
      withTimezone: true,
    }),
    // The stopped session's workspace is gone; a resume comes back on a new
    // one restored from the checkpoint. Cleared by that resume.
    workspaceReclaimedAt: timestamp("workspace_reclaimed_at", {
      withTimezone: true,
    }),
    // Set by a checkpoint collection pass that found the session closed for
    // a day with no open push request: nothing it could collect again, so
    // later passes leave it out (settleCollection).
    checkpointCollectionSettledAt: timestamp(
      "checkpoint_collection_settled_at",
      { withTimezone: true },
    ),
    podId: text("pod_id"),
    pinned: boolean().notNull().default(false),
    lastTurnAt: timestamp("last_turn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Interface track (I0-2). Null on every row from before it: legacy
    // sessions are not backfilled, see owner_workspace_map.
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdByApiKeyId: uuid("created_by_api_key_id").references(
      () => apiKeys.id,
    ),
    // The surface the creating request came from. Rows from before it got
    // it from their creator columns where those prove it (0158), else null.
    channel: text().$type<SurfaceKind>(),
    takeoverRequiredAt: timestamp("takeover_required_at", {
      withTimezone: true,
    }),
    agentReleaseId: text("agent_release_id").references(
      (): AnyPgColumn => agentReleases.id,
    ),
    // The spec this session runs: its release's `spec_source` with the
    // session's own model, and what it derives. The release stays immutable;
    // a model move rewrites these four with `model` in one statement. Same
    // shapes and digests as agent_releases, so verifyReleaseSpec reads both.
    // Null on a session whose release has no verified spec, and on rows from
    // before: the reconciliation counts and repairs them. All null or all set.
    runtimeSpec: jsonb("runtime_spec").$type<Record<string, unknown>>(),
    specSource: jsonb("spec_source").$type<Record<string, unknown>>(),
    specSourceDigest: text("spec_source_digest"),
    specDigest: text("spec_digest"),
    // `platformPromptSchema`, written with the row and never updated: every
    // claim hands it to the worker as it is, since it is part of the
    // checkpoint fingerprint. Null is revision 0, no platform paragraph,
    // which every row from before it is.
    platformPrompt: jsonb("platform_prompt").$type<PlatformPrompt>(),
    // What this session's Messages calls cost, as the egress proxy metered
    // them: each is priced and added once (provider_usage), the
    // engine's calls and a tool's alike. An estimate. Sessions from before
    // it carry the engine's own turn totals up to that point.
    // Compared against SESSION_COST_LIMIT_USD at dispatch.
    costUsd: numeric("cost_usd", { precision: 14, scale: 6, mode: "number" })
      .notNull()
      .default(0),
    // Every token of those same calls (input, cache writes and reads,
    // output), whatever they cost. A provider_usage insert trigger
    // (migration 0127) adds them, so every API build counts them. Compared
    // against SESSION_TOKEN_LIMIT wherever cost_usd is compared against its
    // limit.
    providerTokens: bigint("provider_tokens", { mode: "number" })
      .notNull()
      .default(0),
    // Whether the last status event the stream carries about input said
    // needs_input. A record of what was published, not a state
    // it flips only in the transaction that writes that status event.
    inputAnnounced: boolean("input_announced").notNull().default(false),
    // An operator revoked this session's execution authority.
    // Independent of admission_state on purpose: every lifecycle path that
    // would dispatch again (resume, start_fresh, a claim) refuses while it
    // is set, and only the operator's restore command clears it.
    executionRevokedAt: timestamp("execution_revoked_at", {
      withTimezone: true,
    }),
    executionRevokedReason: text("execution_revoked_reason"),
    // Startups that failed before their worker was ready for input: a
    // restore not reported ready, or any claim that never asked
    // for input. The attempt is the one claimed and not yet ready
    // the count is consecutive, cleared by a ready worker, and at its limit
    // the session waits in recovery_required. Until then no launch is made
    // before retry_at. The reason is the last failed attempt's. Named for
    // the restores they first counted.
    restoreAttemptId: text("restore_attempt_id"),
    restoreFailureCount: integer("restore_failure_count").notNull().default(0),
    restoreRetryAt: timestamp("restore_retry_at", { withTimezone: true }),
    restoreFailureReason: text("restore_failure_reason"),
    // The worker pool that may run this session. Chosen when the
    // session is created and never changed after: every signal and launch
    // copies it, and a claim only binds a session whose partition is the
    // launch's, so a claim never moves a session to another pool.
    partition: text().notNull().default("default"),
    // Why the session is pausing or paused when the system, not a person,
    // asked: 'awaiting_input' is a park on unanswered requests. Null for a
    // person's pause. A trigger (migration await_park) clears it whenever
    // admission_state leaves pausing and paused, on every write path.
    pauseReason: text("pause_reason"),
    // The session's own park and expiry waits, as given at create. Resolved
    // against the profile and the installation cap whenever a request is
    // registered; null means none given.
    permissionWaitOverride: jsonb("permission_wait_override"),
    // Whose GitHub policy the session runs on, fixed at create: `release`
    // its pinned release's, `agent` the agent's settings row at every use.
    githubPolicySource: text("github_policy_source")
      .notNull()
      .default("release"),
    // An `agent` session's GitHub settings as they were when it started
    // (`githubPolicyStartSchema`); later changes can only narrow them for it.
    // Null on a session without one, which reads the row alone.
    githubPolicyStart: jsonb("github_policy_start").$type<unknown>(),
    // The agent's MCP settings as they were when the session started
    // (`mcpStartSchema`); later changes can only narrow them for it. Null
    // on a session started without a settings row, which follows its
    // release's card and pins.
    mcpStart: jsonb("mcp_start").$type<unknown>(),
    // The agent's engine settings and their revision as they were when the
    // session started (`engineSettingsStartSchema`); later changes can only
    // restrict it further. Null on a session started without a settings row
    // or without a release: restrict-only, never granted anything.
    engineSettingsStart: jsonb("engine_settings_start").$type<unknown>(),
    // The user variables the session took when it was accepted
    // (`envStartSchema`). A plain entry keeps its value so claims, retries and
    // restores replay it; a trigger drops the values when the session closes.
    // Null on a session that declared no variable.
    envStart: jsonb("env_start").$type<unknown>(),
    extensions: jsonb("extensions").$type<unknown>(),
    // The run configs (`RuntimeConfig[]`, newest first, at most
    // MAX_RESTORE_PROFILES) the session's checkpoints were made under, taken
    // before the profile tables go. A claim offers them as
    // restore_runtime_configs, so an older checkpoint still hashes to a
    // digest a worker can match once no profile can rebuild them. Null until
    // reconstructed; the permission mode inside is the original one.
    legacyRuntimeConfigs: jsonb("legacy_runtime_configs").$type<unknown>(),
  },
  (table) => [
    check(
      "sessions_spec_check",
      sql`(${table.runtimeSpec} IS NULL) = (${table.specSource} IS NULL) AND (${table.runtimeSpec} IS NULL) = (${table.specSourceDigest} IS NULL) AND (${table.runtimeSpec} IS NULL) = (${table.specDigest} IS NULL)`,
    ),
    check("sessions_cost_usd_nonneg", sql`${table.costUsd} >= 0`),
    check(
      "sessions_github_policy_source_check",
      sql`${table.githubPolicySource} IN (${sql.raw(sqlList(GITHUB_POLICY_SOURCE_VALUES))})`,
    ),
    check(
      "sessions_pause_reason_check",
      sql`${table.pauseReason} IS NULL OR (${table.pauseReason} IN ('awaiting_input') AND ${table.admissionState} IN ('pausing', 'paused'))`,
    ),
    check(
      "sessions_channel_check",
      sql`${table.channel} IN (${sql.raw(sqlList(SURFACE_KIND_VALUES))})`,
    ),
    check(
      "sessions_title_source_check",
      sql`${table.titleSource} IN ('derived', 'user', 'generated')`,
    ),
    check(
      "sessions_restore_failure_count_check",
      sql`${table.restoreFailureCount} >= 0`,
    ),
    check(
      "sessions_execution_revoked_check",
      sql`(${table.executionRevokedAt} IS NULL) = (${table.executionRevokedReason} IS NULL)`,
    ),
    check(
      "sessions_repository_mode_check",
      sql`(${table.repositoryMode} = 'repository' AND ${table.repoUrl} IS NOT NULL AND ${table.branch} IS NOT NULL) OR (${table.repositoryMode} = 'none' AND ${table.repositoryId} IS NULL AND ${table.repoUrl} IS NULL AND ${table.branch} IS NULL)`,
    ),
    uniqueIndex("sessions_pod_uniq")
      .on(table.podId)
      .where(sql`${table.podId} IS NOT NULL`),
    index("sessions_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    index("sessions_created_by_user_idx")
      .on(table.createdByUserId)
      .where(sql`${table.createdByUserId} IS NOT NULL`),
    index("sessions_takeover_idx")
      .on(table.workspaceId, table.takeoverRequiredAt)
      .where(sql`${table.takeoverRequiredAt} IS NOT NULL`),
    // Usage summaries and series pick an installation's sessions by period.
    index("sessions_created_at_idx").on(table.createdAt),
    // The reconciler's sweep for waits that ended with no write.
    index("sessions_input_announced_idx")
      .on(table.id)
      .where(sql`${table.inputAnnounced}`),
    // The sessions a checkpoint collection pass still visits.
    index("sessions_collection_unsettled_idx")
      .on(table.id)
      .where(sql`${table.checkpointCollectionSettledAt} IS NULL`),
    // Lets a later table reference (session_id, owner_id, workspace_id) as
    // one FK. That only pins the row to its session's workspace when the
    // referencing side declares workspace_id NOT NULL (or MATCH FULL): with
    // MATCH SIMPLE a NULL there skips the check. Legacy sessions, whose
    // workspace_id is NULL, are unreachable through such an FK by design.
    unique("sessions_id_owner_workspace_uniq").on(
      table.id,
      table.ownerId,
      table.workspaceId,
    ),
  ],
);

// The one request for a generated title a session gets, made after its first
// turn completed and charged to the attempt that ran it, which the proxy's
// usage report names. Its token is what the egress proxy presents; a row is
// kept once settled, so a session is never asked about twice.
export const sessionTitleRequests = pgTable(
  "session_title_requests",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => sessions.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    tokenHash: bytea("token_hash").notNull(),
    // The session's auth_revision at issue: a revocation since refuses it.
    authRevision: integer("auth_revision").notNull(),
    // The title at issue. One that changed since was renamed, if by an API
    // from before title_source, so it is not replaced.
    issuedTitle: text("issued_title"),
    // The first authorization uses the token up: one request, one exchange.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("session_title_requests_token_uniq").on(table.tokenHash),
  ],
);

// Retained content the installation holds. A `turns` insert trigger
// (migration 0107) charges every input in the same transaction that writes
// it, and admitInput checks STORAGE_LIMIT_BYTES under this row's lock, so no
// concurrent writer can race past the limit. One row per scope: today only
// "installation".
// TODO(94S-187): Add per-workspace rows for memory revisions.
export const storageUsage = pgTable(
  "storage_usage",
  {
    scope: text().primaryKey(),
    bytes: bigint({ mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("storage_usage_bytes_nonneg", sql`${table.bytes} >= 0`)],
);

export const turns = pgTable(
  "turns",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    // Public turn_id: 1-based position within the session, not the global id.
    sequence: integer().notNull(),
    message: text().notNull(),
    status: text().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    resultJson: jsonb("result_json"),
    attemptId: text("attempt_id"),
    deliveryStartedAt: timestamp("delivery_started_at", { withTimezone: true }),
    terminalReason: text("terminal_reason"),
    outcomeUnknown: boolean("outcome_unknown").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** The human whose input started the turn; null on the api-key path. */
    actorId: uuid("actor_id").references(() => users.id),
    /** The surface the input came from; null on rows from before 0185. */
    channel: text().$type<SurfaceKind>(),
    /** The Slack message the input came from; null off Slack and before 0193. */
    slackMessage: jsonb("slack_message").$type<SlackMessageRef>(),
    /** W3C traceparent of the API request span that queued the turn; null before 0263 or when the request was untraced. */
    traceContext: text("trace_context"),
  },
  (table) => [
    uniqueIndex("turns_session_sequence_uniq").on(
      table.sessionId,
      table.sequence,
    ),
    // The few turns not yet settled, which the metrics and installation
    // usage count by status; outcome_unknown waits on an operator.
    index("turns_unsettled_status_idx")
      .on(table.status)
      .where(
        sql`${table.status} IN ('queued', 'running', 'needs_input', 'outcome_unknown')`,
      ),
    check(
      "turns_channel_check",
      sql`${table.channel} IN (${sql.raw(sqlList(SURFACE_KIND_VALUES))})`,
    ),
  ],
);

// Rows from 94S-630 on carry the push request they were opened from; the
// alpha columns stay as they were.
export const pullRequests = pgTable(
  "pull_requests",
  {
    sessionId: uuid("session_id").references(() => sessions.id),
    url: text().notNull(),
    pushRequestId: uuid("push_request_id").references(() => pushRequests.id),
    ownerId: text("owner_id"),
    repositoryId: text("repository_id"),
    number: integer(),
    head: text(),
    base: text(),
    receiptId: uuid("receipt_id").references(() => receipts.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.url] }),
    uniqueIndex("pull_requests_push_request_idx").on(table.pushRequestId),
  ],
);

// What a session made (design github-agent.md §10). Written by the server
// only; a pull request's row shares (session_id, url) and receipt_id with its
// pull_requests row, without a foreign key, as the table will hold more types.
export const sessionOutcomes = pgTable(
  "session_outcomes",
  {
    id: uuid().primaryKey(),
    ownerId: text("owner_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references((): AnyPgColumn => sessions.id),
    agentReleaseId: text("agent_release_id"),
    // Copied from the release when written, so a sum never joins releases.
    agentId: uuid("agent_id"),
    type: text().$type<SessionOutcomeType>().notNull(),
    url: text().notNull(),
    repositoryId: text("repository_id"),
    externalId: text("external_id"),
    state: text().$type<SessionOutcome["state"]>().notNull(),
    stateChangedAt: timestamp("state_changed_at", {
      withTimezone: true,
    }).notNull(),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // When GitHub last answered; a claim leaves it alone.
    stateCheckedAt: timestamp("state_checked_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    checkError: text("check_error").$type<SessionOutcomeCheckError>(),
    metadata: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    receiptId: uuid("receipt_id").references((): AnyPgColumn => receipts.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("session_outcomes_session_type_url_key").on(
      table.sessionId,
      table.type,
      table.url,
    ),
    index("session_outcomes_refresh_idx")
      .on(table.stateCheckedAt)
      .where(
        sql`${table.type} = 'github_pull_request' AND ${table.state} <> 'merged'`,
      ),
    check(
      "session_outcomes_type_check",
      sql`${table.type} IN (${sql.raw(sqlList(SESSION_OUTCOME_TYPE_VALUES))})`,
    ),
    check(
      "session_outcomes_pull_request_state_check",
      sql`${table.type} <> 'github_pull_request' OR ${table.state} IN (${sql.raw(sqlList(GITHUB_PULL_REQUEST_OUTCOME_STATE_VALUES))})`,
    ),
    check(
      "session_outcomes_review_state_check",
      sql`${table.type} <> 'github_review' OR ${table.state} IN (${sql.raw(sqlList(GITHUB_REVIEW_OUTCOME_STATE_VALUES))})`,
    ),
    check(
      "session_outcomes_check_error_check",
      sql`${table.checkError} IS NULL OR ${table.checkError} IN (${sql.raw(sqlList(SESSION_OUTCOME_CHECK_ERROR_VALUES))})`,
    ),
    check(
      "session_outcomes_lease_check",
      sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
  ],
);

// One GitHub rate-limit unit the outcome refresher spends from, shared by
// every API replica: an App installation, or the user behind a PAT.
export const outcomeRefreshQuotas = pgTable("outcome_refresh_quotas", {
  quotaKey: text("quota_key").primaryKey(),
  // The last x-ratelimit-limit seen; null before the first.
  rateLimit: integer("rate_limit"),
  windowStart: timestamp("window_start", { withTimezone: true })
    .notNull()
    .defaultNow(),
  used: integer().notNull().default(0),
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
});

export const events = pgTable(
  "events",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    type: text().notNull(),
    payload: jsonb().notNull(),
    // The engine-neutral fields the control plane derived from payload,
    // kept apart so payload stays what the worker sent (a resend is compared
    // against it). Null until derived; read merged under payload's own keys.
    neutral: jsonb(),
    turnId: bigint("turn_id", { mode: "number" }).references(() => turns.id),
    attemptId: text("attempt_id"),
    sourceSequence: integer("source_sequence"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("events_session_id_idx").on(table.sessionId, table.id),
    uniqueIndex("events_attempt_sequence_uniq")
      .on(table.sessionId, table.attemptId, table.sourceSequence)
      .where(sql`${table.attemptId} IS NOT NULL`),
  ],
);

/**
 * One archived chunk of a session's events: the rows with ids from
 * `from_id` through `through_id` now live only in the checkpoint bucket
 * object at `object_key`, version `version_id`, held, as one JSON line per
 * row with the events columns as stored (session-event-archives.ts). A
 * session's chunks never overlap and every event row left for it is past
 * the last one.
 */
export const sessionEventArchives = pgTable(
  "session_event_archives",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    fromId: bigint("from_id", { mode: "number" }).notNull(),
    throughId: bigint("through_id", { mode: "number" }).notNull(),
    objectKey: text("object_key").notNull(),
    versionId: text("version_id").notNull(),
    // Of the gzip object as stored.
    sha256: text().notNull(),
    eventCount: integer("event_count").notNull(),
    bytes: bigint({ mode: "number" }).notNull(),
    // The chunk's last row, for readers that took them from the newest event.
    lastCreatedAt: timestamp("last_created_at", {
      withTimezone: true,
    }).notNull(),
    lastOccurredAt: timestamp("last_occurred_at", {
      withTimezone: true,
    }).notNull(),
    // The list card's activity over every event through activity_through,
    // taken before they left; a later chunk of the same pass repeats it.
    activity: jsonb().notNull(),
    activityThrough: bigint("activity_through", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.fromId] }),
    check(
      "session_event_archives_range_check",
      sql`${table.fromId} <= ${table.throughId} AND ${table.eventCount} > 0`,
    ),
  ],
);

/**
 * One row per tool call, projected from the tool_use and tool_result events
 * by the reconciler (`projectToolCalls`), paired as the run tree pairs them
 * (94S-923). A read of the usage API never parses events.
 *
 * No foreign keys: a key on session_id would take KEY SHARE on the session
 * row, which a worker append holds FOR UPDATE, so each projection batch and
 * the appends of its sessions would wait on each other. Nothing deletes
 * sessions; event rows leave only once archived, their content kept in the
 * object a `session_event_archives` row names.
 */
export const toolCalls = pgTable(
  "tool_calls",
  {
    useEventId: bigint("use_event_id", { mode: "number" }).notNull(),
    // The tool_use block's place in its event's content.
    ord: integer().notNull(),
    sessionId: uuid("session_id").notNull(),
    // attempt_id, '' for none: a null attempt pairs with null.
    attemptKey: text("attempt_key").notNull(),
    // null when the block's id is no string: such a call pairs with nothing.
    toolUseId: text("tool_use_id"),
    name: text().notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    // used_at, else created_at: when the call shows as made.
    at: timestamp({ withTimezone: true }).notNull(),
    // The tool_use event's created_at, which the period cuts on.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    resultEventId: bigint("result_event_id", { mode: "number" }),
    resultAt: timestamp("result_at", { withTimezone: true }),
    outcome: text().notNull().default("unknown"),
    // Both times known only; a result stamped before its call is 0.
    ms: bigint({ mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.useEventId, table.ord] }),
    check(
      "tool_calls_outcome_check",
      sql`${table.outcome} IN ('ok', 'failed', 'unknown')`,
    ),
    check("tool_calls_ms_check", sql`${table.ms} >= 0`),
    // tool_use id before attempt, so a denied permission request, which may
    // have been answered under another attempt, finds its call by the pair.
    uniqueIndex("tool_calls_session_tool_use_uniq")
      .on(table.sessionId, table.toolUseId, table.attemptKey)
      .where(sql`${table.toolUseId} IS NOT NULL`),
    index("tool_calls_recent_idx").on(
      table.name,
      table.at.desc(),
      table.useEventId.desc(),
      table.ord.desc(),
    ),
    index("tool_calls_slowest_idx").on(
      table.name,
      table.ms.desc().nullsLast(),
      table.useEventId.desc(),
      table.ord.desc(),
    ),
    index("tool_calls_created_at_idx").on(table.createdAt),
    // A scope with few sessions reads its calls from them; the name-led
    // indexes above would walk every call of the tool in the period.
    index("tool_calls_session_name_idx").on(table.sessionId, table.name),
  ],
);

/**
 * A tool's description as a session's engine declared it at init, projected
 * with tool_calls (94S-936). Only MCP tools have one; the adapter has already
 * redacted it and cut it to one line. A usage read takes the newest one among
 * the sessions it may see, so a description never crosses into a scope whose
 * sessions did not declare it.
 */
export const toolDescriptions = pgTable(
  "tool_descriptions",
  {
    sessionId: uuid("session_id").notNull(),
    name: text().notNull(),
    description: text().notNull(),
    // The init event's id: of two inits in a session the later one wins.
    eventId: bigint("event_id", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.name] }),
    check(
      "tool_descriptions_description_check",
      sql`char_length(${table.description}) BETWEEN 1 AND 200`,
    ),
    index("tool_descriptions_name_idx").on(table.name, table.eventId.desc()),
  ],
);

/**
 * How far `projectToolCalls` has read events: every event with an id at or
 * below `applied_through` is in tool_calls. One row.
 */
export const toolCallProgress = pgTable(
  "tool_call_progress",
  {
    id: integer().primaryKey(),
    appliedThrough: bigint("applied_through", { mode: "number" })
      .notNull()
      .default(0),
    // The batch size a statement timeout cut it down to, kept across passes;
    // null is the reconciler's configured size.
    batchSize: integer("batch_size"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("tool_call_progress_one_row", sql`${table.id} = 1`)],
);

/**
 * How far `fillNeutralFields` has read events: every event at or below
 * `filled_through` carries the engine-neutral fields its session's codec
 * gives it, where one could be told. `history_through` is the newest event
 * stored before the control plane wrote those fields itself; until the fill
 * passes it, `projectToolCalls` reads no further than the fill. One row.
 */
export const neutralFieldProgress = pgTable(
  "neutral_field_progress",
  {
    id: integer().primaryKey(),
    filledThrough: bigint("filled_through", { mode: "number" })
      .notNull()
      .default(0),
    historyThrough: bigint("history_through", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("neutral_field_progress_one_row", sql`${table.id} = 1`)],
);

/**
 * tool_calls summed per UTC day of created_at and tool name, once for each
 * scope a usage read can ask for, so a read touches days × tools rows
 * whatever the volume. A session's calls count under scope_key '' (the
 * installation), `user:<user_id>:<owner_id>` and `api_key:<key_id>:<owner_id>`
 * for whoever started it, each once with agent_key '' and once more with its
 * agent's id. `hist` counts timed calls per duration bucket
 * (`tool_ms_bucket`), the only way to a median across rows.
 */
export const toolCallDays = pgTable(
  "tool_call_days",
  {
    scopeKey: text("scope_key").notNull(),
    agentKey: text("agent_key").notNull(),
    day: date({ mode: "string" }).notNull(),
    name: text().notNull(),
    calls: integer().notNull(),
    failed: integer().notNull(),
    timed: integer().notNull(),
    totalMs: bigint("total_ms", { mode: "number" }).notNull(),
    // Never lowered when an earlier result replaces a call's time.
    maxMs: bigint("max_ms", { mode: "number" }).notNull(),
    hist: integer().array().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.scopeKey, table.agentKey, table.day, table.name],
    }),
    check(
      "tool_call_days_hist_check",
      sql`array_length(${table.hist}, 1) = 161`,
    ),
  ],
);

/**
 * tool_calls counted per name and stored outcome by its insert, update,
 * delete and truncate triggers (migration session_data_rollups), so the
 * platform metrics read a row per pair instead of every call. `first_at` is
 * the earliest created_at that entered the row; the least over a name's rows
 * is the name's first call. A denied call still counts under its stored
 * outcome here: the metrics read moves it to `denied`.
 */
export const toolCallOutcomes = pgTable(
  "tool_call_outcomes",
  {
    name: text().notNull(),
    outcome: text().notNull(),
    calls: bigint({ mode: "number" }).notNull(),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.name, table.outcome] })],
);

export const queueMessages = pgTable(
  "queue_messages",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    turnId: bigint("turn_id", { mode: "number" }).references(() => turns.id),
    kind: text().notNull(),
    payload: jsonb().notNull(),
    visibleAt: timestamp("visible_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    claimedBy: text("claimed_by"),
    claimToken: uuid("claim_token"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("queue_messages_pick_idx")
      .on(table.sessionId, table.id)
      .where(sql`${table.claimedBy} IS NULL`),
    // nextInput polls for a session's head every few hundred milliseconds
    // and looks at claimed rows too, which the partial index above cannot
    // serve.
    index("queue_messages_head_idx").on(table.sessionId, table.kind, table.id),
  ],
);

// The one row that says whether a session's spec pin is what a claim reads.
// It only ever goes from false to true (flipPinCutover), and only while the
// pin gate reads zero under the cutover lock.
export const sessionPinCutover = pgTable(
  "session_pin_cutover",
  {
    id: integer().primaryKey().default(1),
    authoritative: boolean().notNull().default(false),
    flippedAt: timestamp("flipped_at", { withTimezone: true }),
  },
  (table) => [
    check("session_pin_cutover_single", sql`${table.id} = 1`),
    check(
      "session_pin_cutover_flipped",
      sql`${table.authoritative} = (${table.flippedAt} IS NOT NULL)`,
    ),
  ],
);

export const unassignedSessions = pgTable("unassigned_sessions", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessions.id),
  signaledAt: timestamp("signaled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  partition: text().notNull().default("default"),
});

export const receipts = pgTable(
  "receipts",
  {
    id: uuid().primaryKey(),
    ownerId: text("owner_id").notNull(),
    operation: text().notNull(),
    targetRef: jsonb("target_ref").notNull(),
    status: receiptStatus().notNull().default("accepted"),
    result: jsonb(),
    error: jsonb(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** `receiptActorSchema`: principal plus the human behind it. */
    actor: jsonb(),
    requestId: text("request_id"),
  },
  (table) => [
    index("receipts_owner_created_at_idx").on(table.ownerId, table.createdAt),
    index("receipts_request_idx").on(table.requestId),
    // The terminate deadline sweep runs every scheduler and reconciler pass
    // and must not read the whole receipt history to find the few open ones.
    // An execution revocation is swept the same way.
    index("receipts_open_terminate_idx")
      .on(table.createdAt)
      .where(
        sql`${table.operation} IN ('terminate', 'revoke_execution') AND ${table.status} = 'accepted'`,
      ),
  ],
);

// No foreign keys, so a row outlives the session, key or user it names for
// as long as the workspace keeps audit rows.
export const authzDecisions = pgTable(
  "authz_decisions",
  {
    id: uuid().primaryKey(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    ownerId: text("owner_id").notNull(),
    workspaceId: uuid("workspace_id"),
    principalKind: text("principal_kind"),
    principalId: text("principal_id"),
    actorUserId: uuid("actor_user_id"),
    agentId: uuid("agent_id"),
    agentReleaseId: text("agent_release_id"),
    linkedAccountId: text("linked_account_id"),
    linkedAccountRevision: integer("linked_account_revision"),
    surface: jsonb().notNull(),
    action: text().notNull(),
    resourceKind: text("resource_kind").notNull(),
    resourceId: text("resource_id"),
    outcome: text().notNull(),
    reasonCode: text("reason_code").notNull(),
    justification: text(),
    policyVersion: text("policy_version").notNull(),
    requestId: text("request_id").notNull(),
  },
  (table) => [
    index("authz_decisions_request_idx").on(table.requestId),
    index("authz_decisions_at_idx").on(table.at),
    check(
      "authz_decisions_outcome_check",
      sql`${table.outcome} IN ('allow', 'deny', 'redact', 'require_approval')`,
    ),
    check(
      "authz_decisions_principal_check",
      sql`(${table.principalKind} IS NULL) = (${table.principalId} IS NULL)`,
    ),
  ],
);

// One row per judgment on one tool call (observability design, section 7).
// Append-only like authz_decisions: UPDATE is refused by a trigger and only
// the retention job deletes. No foreign keys, so a row outlives the session,
// key and user it names for its retention period. Every text column is an id
// or a member of a closed list; there is no column for input text or a result.
export const toolCallAudits = pgTable(
  "tool_call_audits",
  {
    id: uuid().primaryKey().defaultRandom(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    workspaceId: uuid("workspace_id"),
    ownerId: text("owner_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    // The public turn id: the turn's position in its session, not turns.id.
    turnId: bigint("turn_id", { mode: "number" }).notNull(),
    attemptId: text("attempt_id").notNull(),
    // `t:<tool_use_id>`, `n:<ordinal in the turn>`, or `r:<request_id>` for
    // a platform `asked` row whose call has no usable id.
    callKey: text("call_key").notNull(),
    phase: text().notNull(),
    toolUseId: text("tool_use_id"),
    parentToolUseId: text("parent_tool_use_id"),
    toolName: text("tool_name").notNull(),
    mcpServer: text("mcp_server"),
    // Of the redacted input in canonical form, never of the raw arguments.
    inputSha256: text("input_sha256"),
    inputBytes: integer("input_bytes"),
    decision: text().notNull(),
    // Checked by the contracts schema, so a new basis needs no migration.
    basis: text().notNull(),
    agentId: uuid("agent_id"),
    agentReleaseId: text("agent_release_id"),
    actorUserId: uuid("actor_user_id"),
    principalKind: text("principal_kind"),
    principalId: text("principal_id"),
    surface: text().$type<SurfaceKind>(),
    pendingRequestId: text("pending_request_id"),
    answeredBy: jsonb("answered_by"),
    answerSurface: text("answer_surface").$type<SurfaceKind>(),
    answerDecisionId: uuid("answer_decision_id"),
    source: text().notNull(),
    recordVersion: integer("record_version").notNull(),
  },
  (table) => [
    // A resend of the same report is this key again.
    uniqueIndex("tool_call_audits_call_idx").on(
      table.sessionId,
      table.attemptId,
      table.turnId,
      table.callKey,
      table.phase,
    ),
    // One request's approval can ground one call only.
    uniqueIndex("tool_call_audits_approval_once_idx")
      .on(table.pendingRequestId)
      .where(sql`${table.phase} = 'decided' AND ${table.basis} = 'approval'`),
    index("tool_call_audits_session_at_idx").on(table.sessionId, table.at),
    index("tool_call_audits_workspace_at_idx").on(table.workspaceId, table.at),
    // What the retention job scans.
    index("tool_call_audits_at_idx").on(table.at),
    check(
      "tool_call_audits_phase_check",
      sql`${table.phase} IN ('asked', 'decided')`,
    ),
    check(
      "tool_call_audits_decision_check",
      sql`${table.decision} IN ('allow', 'deny', 'require_approval', 'unknown')`,
    ),
    check(
      "tool_call_audits_phase_decision_check",
      sql`(${table.phase} = 'asked') = (${table.decision} = 'require_approval')`,
    ),
    check(
      "tool_call_audits_source_check",
      sql`${table.source} IN ('platform', 'worker_report')`,
    ),
    check(
      "tool_call_audits_principal_check",
      sql`(${table.principalKind} IS NULL) = (${table.principalId} IS NULL)`,
    ),
    check(
      "tool_call_audits_input_check",
      sql`(${table.inputSha256} IS NULL) = (${table.inputBytes} IS NULL)`,
    ),
    check(
      "tool_call_audits_surface_check",
      sql`${table.surface} IS NULL OR ${table.surface} IN (${sql.raw(sqlList(SURFACE_KIND_VALUES))})`,
    ),
  ],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    principal: text().notNull(),
    operation: text().notNull(),
    resource: text().notNull(),
    key: text().notNull(),
    payloadHash: text("payload_hash").notNull(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.principal, table.operation, table.resource, table.key],
    }),
  ],
);

export const pendingRequests = pgTable(
  "pending_requests",
  {
    requestId: text("request_id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    turnId: bigint("turn_id", { mode: "number" })
      .notNull()
      .references(() => turns.id),
    attemptId: text("attempt_id").notNull(),
    kind: text().notNull(),
    payload: jsonb().notNull(),
    inputHash: text("input_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Closed to clients: answered, given up on by the worker, or invalidated
    // with its attempt. The worker's own acknowledgement is `settled_at`.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    answer: jsonb(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    // Per session, allocated under the session row lock, so commit order is
    // sequence order and the worker's answers_after cursor never skips one.
    answerSequence: integer("answer_sequence"),
    answerReceiptId: uuid("answer_receipt_id").references(() => receipts.id),
    // Who answered, where, and the session.approve decision that let them:
    // the answer receipt's actor shape, so a key with no person is still
    // named. No FK on the decision: audit retention prunes authz_decisions
    // and the approval row outlives it. Null on rows answered before 0137.
    answeredBy: jsonb("answered_by"),
    answerSurface: text("answer_surface"),
    answerDecisionId: uuid("answer_decision_id"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    // answered | expired | cancelled from the worker; lost when the
    // execution went away before it said.
    settledOutcome: text("settled_outcome"),
    // Why the worker cancelled it (park | shutdown | interrupt | refused),
    // and what its run said of a delivered answer (applied | stale |
    // unknown). Null from a worker older than them and where it did not say.
    settledReason: text("settled_reason"),
    settledAnswerResult: text("settled_answer_result"),
    // Set when the worker handed the `question` event to the gateway
    // a replay must carry the same pair. Null for a worker that
    // publishes the event itself.
    toolUseId: text("tool_use_id"),
    tool: text(),
    // When the worker should park the turn on this request. Null on rows
    // from before it and for a wait that never parks.
    parkAt: timestamp("park_at", { withTimezone: true }),
    // Written by the transaction that finalizes the parked turn with its
    // checkpoint. From then the row stays answerable whatever happens to
    // the attempt that asked, until it is answered, expires or is closed.
    parkedAt: timestamp("parked_at", { withTimezone: true }),
    // When pendingControl first handed the answer to a worker. An answer
    // with none never reached an engine.
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    // The approval-wait checkpoint taken while the engine waited on this
    // row; a later one of the same turn takes over every row still waiting.
    checkpointRef: text("checkpoint_ref").references(
      () => approvalCheckpoints.manifestRef,
    ),
  },
  (table) => [
    index("pending_requests_unresolved_session_idx")
      .on(table.sessionId)
      .where(sql`${table.resolvedAt} IS NULL`),
    index("pending_requests_park_due")
      .on(table.parkAt)
      .where(
        sql`${table.parkedAt} IS NULL AND ${table.resolvedAt} IS NULL AND ${table.parkAt} IS NOT NULL`,
      ),
    uniqueIndex("pending_requests_session_answer_sequence_idx").on(
      table.sessionId,
      table.answerSequence,
    ),
    // What pendingControl hands out: answered, not yet acknowledged.
    index("pending_requests_undelivered_attempt_idx")
      .on(table.attemptId, table.answerSequence)
      .where(
        sql`${table.answeredAt} IS NOT NULL AND ${table.settledAt} IS NULL`,
      ),
    // The calls the platform metrics count as denied.
    index("pending_requests_denied_tool_use_idx")
      .on(table.sessionId, table.toolUseId)
      .where(
        sql`${table.kind} = 'permission' AND (${table.answer} ->> 'decision') = 'deny' AND ${table.toolUseId} IS NOT NULL`,
      ),
    check(
      "pending_requests_answer_surface_check",
      sql`${table.answerSurface} IN ('web', 'slack', 'api')`,
    ),
    check(
      "pending_requests_approval_check",
      sql`(${table.answerSurface} IS NULL) = (${table.answerDecisionId} IS NULL) AND (${table.answerSurface} IS NULL OR ${table.answeredAt} IS NOT NULL) AND (${table.answeredBy} IS NULL OR ${table.answerSurface} IS NOT NULL)`,
    ),
  ],
);

// A checkpoint captured while a turn waited on a person (design §6.3 K),
// committed with the request it covers. It reaches the session pointer only
// when the execution goes with that wait intact (confirmExecutionGoneAtomic);
// otherwise the turn's own checkpoint takes its revision and garbage
// collection removes its objects like any other attempt directory.
export const approvalCheckpoints = pgTable("approval_checkpoints", {
  manifestRef: text("manifest_ref").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id),
  revision: integer().notNull(),
  manifestSha256: text("manifest_sha256").notNull(),
  manifestVersion: text("manifest_version"),
  versionsHeld: boolean("versions_held").notNull(),
  transcriptBytes: bigint("transcript_bytes", { mode: "number" }),
  // Carried to checkpoints.runtime_* when promoted.
  runtimeEngine: text("runtime_engine"),
  runtimeSdkVersion: text("runtime_sdk_version"),
  runtimeCliVersion: text("runtime_cli_version"),
  runtimeProfileSha256: text("runtime_profile_sha256"),
  attemptId: text("attempt_id")
    .notNull()
    .references(() => attempts.id),
  turnId: bigint("turn_id", { mode: "number" })
    .notNull()
    .references(() => turns.id),
  // The last answer sequence the worker had applied when it captured.
  answersThrough: integer("answers_through").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  // A tool was admitted after the capture.
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
});

// An invalidation that came before the registration carrying its checkpoint
// committed: that registration still may, and must find it void.
// Keyed by the attempt too: another attempt naming the same ref voids
// nothing of this one's.
export const approvalCheckpointVoids = pgTable(
  "approval_checkpoint_voids",
  {
    manifestRef: text("manifest_ref").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    voidedAt: timestamp("voided_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.manifestRef, table.sessionId, table.attemptId],
    }),
  ],
);

// An answer to a parked permission request, to be spent once by the turn
// that resumes it. The tool, input hash and who answered stay on the
// request row; copying them here would let the two disagree.
export const permissionGrants = pgTable("permission_grants", {
  requestId: text("request_id")
    .primaryKey()
    .references(() => pendingRequests.requestId, { onDelete: "cascade" }),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  turnId: bigint("turn_id", { mode: "number" })
    .notNull()
    .references(() => turns.id),
  // The attempt whose claim last carried it; null until one has.
  attemptId: text("attempt_id").references(() => attempts.id),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

// The turn that carries a parked one on with its answers, delivered ahead of
// the session's other queued turns. Its own table, so turns rows stay as
// narrow as the plans over them were tuned for.
export const turnContinuations = pgTable("turn_continuations", {
  turnId: bigint("turn_id", { mode: "number" })
    .primaryKey()
    .references(() => turns.id, { onDelete: "cascade" }),
  parkedTurnId: bigint("parked_turn_id", { mode: "number" })
    .notNull()
    .unique()
    .references(() => turns.id, { onDelete: "cascade" }),
});

// A turn whose request_push came before any checkpoint (94S-1243): when it
// completes with one, the platform queues `continuation_turn_id` so the
// model can ask again for the commits that checkpoint now holds.
export const pushContinuations = pgTable("push_continuations", {
  turnId: bigint("turn_id", { mode: "number" })
    .primaryKey()
    .references(() => turns.id, { onDelete: "cascade" }),
  continuationTurnId: bigint("continuation_turn_id", { mode: "number" })
    .unique()
    .references(() => turns.id, { onDelete: "set null" }),
});

// A Slack push approval's follow-up turn, held while the session had a turn
// running: that turn may open the pull request itself, so the next turn end
// queues the follow-up only if no pull request is recorded by then, and
// deletes the row either way.
export const pushFollowUps = pgTable("push_follow_ups", {
  pushRequestId: uuid("push_request_id")
    .primaryKey()
    .references((): AnyPgColumn => pushRequests.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  message: text().notNull(),
});

// A session result the platform may push to `agent/<session-id>` once a human
// approves it. The commit is pinned when the request is made, so what is
// approved is what is pushed, however far the session moves on.
export const pushRequests = pgTable(
  "push_requests",
  {
    id: uuid().primaryKey(),
    ownerId: text("owner_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    repositoryId: text("repository_id").notNull(),
    checkpointRevision: integer("checkpoint_revision").notNull(),
    gitCommit: text("git_commit").notNull(),
    targetBranch: text("target_branch").notNull(),
    state: text().notNull().default("requested"),
    requestedBy: jsonb("requested_by").notNull(),
    requestReceiptId: uuid("request_receipt_id")
      .notNull()
      .references(() => receipts.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedBy: jsonb("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    decisionReceiptId: uuid("decision_receipt_id").references(
      () => receipts.id,
    ),
    pushStartedAt: timestamp("push_started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    pushError: jsonb("push_error"),
    pushReceiptId: uuid("push_receipt_id").references(() => receipts.id),
    repositoryBinding: text("repository_binding"),
    pushAttempts: integer("push_attempts").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // Null on rows from before these and while undecided. A `policy`
    // approval is judged again before it runs; a person's stands.
    approvalBasis: text("approval_basis"),
    approvalSettingsRevision: integer("approval_settings_revision"),
    // `intent`: made by the intent runner from a revision a finished turn
    // pinned, so the latest-checkpoint rules do not apply to it.
    origin: text().notNull().default("direct"),
    // Fixed at creation; the install setting never decides it later.
    flow: text().notNull().default("legacy"),
    // Filled and run by the pull-request drain; the same-target check reads
    // `pr_state` here so a later push waits for an unfinished PR stage.
    pullRequestIntent: jsonb("pull_request_intent"),
    prState: text("pr_state"),
    // The pull-request drain's claim: the token fences every write of a
    // dropped claim; `pr_next_attempt_at` is the backoff after a forge error.
    prClaimToken: uuid("pr_claim_token"),
    prLeaseExpiresAt: timestamp("pr_lease_expires_at", { withTimezone: true }),
    prAttempts: integer("pr_attempts").notNull().default(0),
    prNextAttemptAt: timestamp("pr_next_attempt_at", { withTimezone: true }),
    // A public code and detail for the stage's end (`head_moved`, ...).
    prError: text("pr_error"),
    prErrorDetails: jsonb("pr_error_details"),
    // Which pull request, at which head commit, the drain verified. Only the
    // drain's path writes these; a row saved by the public open is unverified.
    prVerifiedNumber: integer("pr_verified_number"),
    prVerifiedHeadSha: text("pr_verified_head_sha"),
  },
  (table) => [
    index("push_requests_pr_drain_idx")
      .on(table.prState, table.prNextAttemptAt)
      .where(sql`${table.prState} IN ('due','opening')`),
    check(
      "push_requests_origin_check",
      sql`${table.origin} IN (${sql.raw(sqlList(PUSH_REQUEST_ORIGIN_VALUES))})`,
    ),
    check(
      "push_requests_flow_check",
      sql`${table.flow} IN (${sql.raw(sqlList(PUSH_REQUEST_FLOW_VALUES))})`,
    ),
    check(
      "push_requests_pr_state_check",
      sql`${table.prState} IS NULL OR ${table.prState} IN (${sql.raw(sqlList(PULL_REQUEST_STAGE_VALUES))})`,
    ),
    index("push_requests_pr_open_idx")
      .on(table.sessionId, table.repositoryId, table.targetBranch)
      .where(sql`${table.prState} IN ('due','opening')`),
    check(
      "push_requests_approval_basis_check",
      sql`${table.approvalBasis} IS NULL OR ${table.approvalBasis} IN (${sql.raw(sqlList(PUSH_APPROVAL_BASIS_VALUES))})`,
    ),
    check(
      "push_requests_state_check",
      sql`${table.state} IN (${sql.raw(sqlList(PUSH_REQUEST_STATE_VALUES))})`,
    ),
    check(
      "push_requests_git_commit_check",
      sql`${table.gitCommit} ~ '^[0-9a-f]{40}$'`,
    ),
    check(
      "push_requests_checkpoint_revision_check",
      sql`${table.checkpointRevision} >= 0`,
    ),
    check(
      "push_requests_target_branch_check",
      sql`${table.targetBranch} = 'agent/' || ${table.sessionId}::text OR ${table.targetBranch} ~ ('^agent/' || ${table.sessionId}::text || '-[a-z0-9][a-z0-9-]{0,39}$')`,
    ),
    check(
      "push_requests_decision_check",
      sql`(${table.state} = 'requested') = (${table.decidedAt} IS NULL) AND (${table.decidedAt} IS NULL) = (${table.decidedBy} IS NULL) AND (${table.decidedAt} IS NULL) = (${table.decisionReceiptId} IS NULL)`,
    ),
    // One open request per target: other repositories and branches of the
    // session may each have their own (session-multi-repository.md).
    uniqueIndex("push_requests_open_target_idx")
      .on(table.sessionId, table.repositoryId, table.targetBranch)
      .where(
        sql`${table.state} IN (${sql.raw(sqlList(OPEN_PUSH_REQUEST_STATES))})`,
      ),
    index("push_requests_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    index("push_requests_approved_idx")
      .on(table.createdAt)
      .where(sql`${table.state} = 'approved'`),
    index("push_requests_pushing_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'pushing'`),
  ],
);

// What a `request_push` made inside a running turn asked for: "push what this
// turn ends with". The control-host's action-broker pins the turn's final
// checkpoint revision in the finalize transaction; the intent runner then
// makes the push request from that revision. The actor, approval basis and
// policy source are stored so the runner acts with the requester's authority
// and judges the gates again, never with more.
export const pushIntents = pgTable(
  "push_intents",
  {
    id: uuid().primaryKey(),
    ownerId: text("owner_id").notNull(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    turnId: bigint("turn_id", { mode: "number" })
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").notNull(),
    repositoryId: text("repository_id").notNull(),
    targetBranch: text("target_branch").notNull(),
    // null is the checkpoint's snapshot (HEAD).
    sourceRef: text("source_ref"),
    status: text().notNull().default("deferred"),
    pinnedRevision: integer("pinned_revision"),
    pushRequestId: uuid("push_request_id").references(() => pushRequests.id),
    refusalCode: text("refusal_code"),
    actor: jsonb().notNull(),
    // `push`, or `push.primary` / `push.attached` from before the classes were
    // one; audit only, never read as a permission.
    approvalBasis: text("approval_basis"),
    policySource: text("policy_source"),
    pullRequest: jsonb("pull_request"),
    // The runner's lease: a claim token fences writes of a dropped claim.
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "push_intents_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(PUSH_INTENT_STATUS_VALUES))})`,
    ),
    check(
      "push_intents_refusal_check",
      sql`${table.refusalCode} IS NULL OR ${table.refusalCode} IN (${sql.raw(sqlList(PUSH_INTENT_REFUSAL_VALUES))})`,
    ),
    check(
      "push_intents_shape_check",
      sql`(${table.status} NOT IN ('pinned','requested') OR ${table.pinnedRevision} IS NOT NULL) AND ((${table.status} = 'requested') = (${table.pushRequestId} IS NOT NULL)) AND ((${table.status} IN ('failed','cancelled')) = (${table.refusalCode} IS NOT NULL))`,
    ),
    // One intent per turn and target: the same call again is the same row.
    // One target per turn and repository is enforced by `createDeferred`
    // under the session row lock, not by this index.
    uniqueIndex("push_intents_turn_target_idx").on(
      table.turnId,
      table.repositoryId,
      table.targetBranch,
    ),
    index("push_intents_session_idx").on(table.sessionId, table.createdAt),
    // The runner and the keep-set read the unfinished ones only.
    index("push_intents_open_idx")
      .on(table.status, table.createdAt)
      .where(sql`${table.status} IN ('deferred','pinned')`),
  ],
);

// A repository the session's agent attached mid-session
// (session-repository-attachment.md decision 3), one row per repository: a
// second call reads the row instead of attaching again. `pending` until a
// worker of the session reports the fetch; a failed one goes back to
// `pending` when asked again, with a new receipt.
export const sessionRepositoryAttachments = pgTable(
  "session_repository_attachments",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    repositoryId: text("repository_id").notNull(),
    // The attempt whose agent asked last.
    attemptId: text("attempt_id").notNull(),
    branch: text().notNull(),
    status: text().notNull(),
    gitCommit: text("git_commit"),
    failure: text(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.repositoryId] }),
    check(
      "session_repository_attachments_status_check",
      sql`${table.status} IN ('pending','attached','failed')`,
    ),
    check(
      "session_repository_attachments_settled_check",
      sql`(${table.status} = 'attached') = (${table.gitCommit} IS NOT NULL) AND (${table.status} = 'failed') = (${table.failure} IS NOT NULL) AND (${table.status} = 'pending') = (${table.settledAt} IS NULL)`,
    ),
    index("session_repository_attachments_pending_idx")
      .on(table.sessionId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

// api.md § 승인·중단·강제 종료: a control request the worker has to act on,
// kept apart from the input FIFO. An interrupt names its turn and the attempt
// that turn is bound to — a running turn never moves to another attempt — and
// stays unsettled until that turn reaches a terminal, which settles the
// receipt in the same transaction.
export const controlIntents = pgTable(
  "control_intents",
  {
    id: uuid().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    kind: text().notNull(),
    targetTurnId: bigint("target_turn_id", { mode: "number" }).references(
      () => turns.id,
    ),
    attemptId: text("attempt_id"),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (table) => [
    // Only interrupt rows are ever written. A pause travels as the session's
    // `pausing` admission state and a terminate as executions.desired_state;
    // the two stay allowed only because narrowing the CHECK would cost a
    // migration for no row that exists.
    check(
      "control_intents_kind_check",
      sql`${table.kind} IN ('interrupt', 'pause', 'terminate')`,
    ),
    check(
      "control_intents_interrupt_target_check",
      sql`${table.kind} <> 'interrupt' OR (${table.targetTurnId} IS NOT NULL AND ${table.attemptId} IS NOT NULL)`,
    ),
    uniqueIndex("control_intents_receipt_uniq").on(table.receiptId),
    // What pendingControl hands the attempt, and what a turn's terminal settles.
    index("control_intents_open_attempt_idx")
      .on(table.attemptId, table.issuedAt)
      .where(sql`${table.settledAt} IS NULL`),
    index("control_intents_open_turn_idx")
      .on(table.targetTurnId)
      .where(sql`${table.settledAt} IS NULL`),
  ],
);

export const checkpoints = pgTable(
  "checkpoints",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    revision: integer().notNull(),
    manifestRef: text("manifest_ref").notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    // The object store version finalize verified the manifest at; restore
    // reads exactly that one. Null when the deployment stores no versions.
    manifestVersion: text("manifest_version"),
    // Set only by a locked finalize (CheckpointPointer.versionsHeld).
    versionsHeld: boolean("versions_held").notNull().default(false),
    // CheckpointPointer.parentRevision: what a restore falls back along.
    parentRevision: integer("parent_revision"),
    // The transcript total the verified manifest pins, which the session
    // detail judges TRANSCRIPT_LIMIT on. Null for rows committed before it
    // was recorded.
    transcriptBytes: bigint("transcript_bytes", { mode: "number" }),
    turnId: bigint("turn_id", { mode: "number" }).references(() => turns.id),
    committedAt: timestamp("committed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set by checkpoint garbage collection before it deletes the
    // revision's objects: no restore reaches this revision any more, and a
    // backup leaves it out rather than fail on what is gone.
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    // Set once a collection pass after collected_at deleted every object it
    // found; output usage counts the revision's outputs until then.
    objectsPurgedAt: timestamp("objects_purged_at", { withTimezone: true }),
    // The profile of the attempt that committed it: its runtime fingerprint
    // was computed from that profile, so a restore after a profile change
    // is checked against it. Null on rows from before the column.
    profileId: text("profile_id"),
    profileFingerprint: text("profile_fingerprint"),
    // The attempt's model; null where the fingerprint names it (version 1).
    model: text(),
    // The verified manifest's RuntimeFingerprint, so a launch can pick an
    // image without reading the object store. Not profile_fingerprint above:
    // that is the catalog profile's, this is the engine's own digest. All
    // four null on rows from before the columns, read as the current image.
    runtimeEngine: text("runtime_engine"),
    runtimeSdkVersion: text("runtime_sdk_version"),
    runtimeCliVersion: text("runtime_cli_version"),
    runtimeProfileSha256: text("runtime_profile_sha256"),
    // The profile digest scheme of the image the committing attempt was
    // launched on; null when its launch assumed none, read as scheme 1.
    runtimeProfileScheme: integer("runtime_profile_scheme"),
    // Whether checkpoint_outputs holds what this revision's manifest names
    // under outputs. False on rows committed before it was recorded, whose
    // outputs no figure counts.
    outputsRecorded: boolean("outputs_recorded").notNull().default(false),
    // checkpointOutputsDigest of the manifest's out/ list, recorded with
    // outputs_recorded; null when it names no file or was not recorded.
    outputsDigest: text("outputs_digest"),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.revision] }),
    // Revisions whose outputs no figure counts yet, which installation usage
    // reports as incomplete.
    index("checkpoints_outputs_unrecorded_idx")
      .on(table.sessionId)
      .where(
        sql`${table.objectsPurgedAt} IS NULL AND NOT ${table.outputsRecorded}`,
      ),
  ],
);

// What `verify-restore` found when it asked, for one checkpoint, whether the
// image set that stays after the profile removal can restore it. A row binds
// to the manifest it read (`manifest_sha256`), the candidate digests it
// matched against, and the worker image it asked, so a re-pinned manifest or
// another image set is a checkpoint nobody has verified.
// `assert_checkpoint_restore_verified(retained)` is what the deleting migration
// calls with the content ids of the images that stay: every live checkpoint
// needs an `ok` as the latest check of one of them. It locks `checkpoints`
// until the calling transaction ends.
export const checkpointRestoreChecks = pgTable(
  "checkpoint_restore_check",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    sessionId: uuid("session_id").notNull(),
    revision: integer().notNull(),
    manifestSha256: text("manifest_sha256").notNull(),
    // sha256 over the candidate digests offered to the restore, sorted.
    candidatesDigest: text("candidates_digest").notNull(),
    imageDigest: text("image_digest").notNull(),
    // The image's own runtime (engine, sdk, cli, digest scheme, restorable
    // schemes) as it printed it.
    imageRuntime: jsonb("image_runtime").$type<unknown>().notNull(),
    outcome: text().$type<"ok" | "mismatch" | "error">().notNull(),
    detail: text(),
    checkedAt: timestamp("checked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "checkpoint_restore_check_checkpoint_fk",
      columns: [table.sessionId, table.revision],
      foreignColumns: [checkpoints.sessionId, checkpoints.revision],
    }),
    check(
      "checkpoint_restore_check_outcome_check",
      sql`${table.outcome} IN ('ok', 'mismatch', 'error')`,
    ),
    index("checkpoint_restore_check_latest_idx").on(
      table.sessionId,
      table.revision,
      table.checkedAt,
    ),
  ],
);

// Every output object a committed revision's manifest names, the ones it
// inherited included, so the bytes still kept are the distinct keys of the
// revisions garbage collection has not released.
export const checkpointOutputs = pgTable(
  "checkpoint_outputs",
  {
    sessionId: uuid("session_id").notNull(),
    revision: integer().notNull(),
    objectKey: text("object_key").notNull(),
    bytes: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.revision, table.objectKey],
    }),
    foreignKey({
      name: "checkpoint_outputs_checkpoint_fk",
      columns: [table.sessionId, table.revision],
      foreignColumns: [checkpoints.sessionId, checkpoints.revision],
    }),
    check("checkpoint_outputs_bytes_nonneg", sql`${table.bytes} >= 0`),
  ],
);

/**
 * checkpoint_outputs per object key, kept by the triggers on it and on
 * checkpoints (migration session_data_rollups): `bytes` the largest size
 * recorded, `live_refs` the revisions naming it whose objects are not purged
 * yet (kept while above 0), `first_at` the first naming revision's commit,
 * `released_at` the latest purge among them. Keys carry the session prefix.
 */
export const checkpointOutputObjects = pgTable(
  "checkpoint_output_objects",
  {
    sessionId: uuid("session_id").notNull(),
    objectKey: text("object_key").notNull(),
    bytes: bigint({ mode: "number" }).notNull(),
    liveRefs: integer("live_refs").notNull(),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.objectKey] }),
    index("checkpoint_output_objects_first_at_idx").on(table.firstAt),
    index("checkpoint_output_objects_released_at_idx")
      .on(table.releasedAt)
      .where(sql`${table.liveRefs} = 0`),
  ],
);

// The bytes of the kept keys above, in one row ('installation'), kept by the
// same triggers.
export const checkpointOutputTotals = pgTable(
  "checkpoint_output_totals",
  {
    scope: text().primaryKey(),
    keptBytes: bigint("kept_bytes", { mode: "number" }).notNull(),
  },
  (table) => [
    check("checkpoint_output_totals_kept_nonneg", sql`${table.keptBytes} >= 0`),
  ],
);

export const executions = pgTable(
  "executions",
  {
    id: text().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    backend: text().notNull(),
    providerRef: text("provider_ref"),
    launchOperationId: text("launch_operation_id"),
    generation: integer().notNull(),
    desiredState: text("desired_state").notNull(),
    observedState: text("observed_state").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("executions_launch_operation_id_uniq")
      .on(table.launchOperationId)
      .where(sql`${table.launchOperationId} IS NOT NULL`),
    index("executions_session_generation_idx").on(
      table.sessionId,
      table.generation,
    ),
  ],
);

// One worker binding to a session: the fenced identity every post-claim
// write carries (lease_epoch, execution_generation, auth_revision).
export const attempts = pgTable(
  "attempts",
  {
    id: text().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    executionId: text("execution_id").notNull(),
    leaseEpoch: integer("lease_epoch").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    authRevision: integer("auth_revision").notNull(),
    state: text().notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", {
      withTimezone: true,
    }).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: text("end_reason"),
    // The session's profile when this attempt claimed it. The attempt runs
    // it to the end, so a profile change on the session takes effect at the
    // next claim; null on rows from before the column.
    profileId: text("profile_id"),
    profileFingerprint: text("profile_fingerprint"),
    // The session's model when this attempt claimed it; null where the
    // fingerprint names it (version 1).
    model: text(),
  },
  (table) => [
    index("attempts_session_started_idx").on(table.sessionId, table.startedAt),
    // The lease-expiry sweep only ever looks at attempts still open, in
    // expiry order; ended ones accumulate and stay out of the index.
    index("attempts_open_lease_idx")
      .on(table.leaseExpiresAt, table.id)
      .where(sql`${table.state} NOT IN ('exited', 'lost')`),
  ],
);

// One Messages call the egress proxy metered, priced when it was
// recorded. Its cost is added to the session's in the same transaction, and
// the proxy's own id for the exchange keys it, so a report sent again after
// a lost answer is not counted twice. The attempt is the one the proxy's
// grant named, which may have ended since: the call was still made.
export const providerUsage = pgTable(
  "provider_usage",
  {
    exchangeId: text("exchange_id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    model: text().notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheCreationInputTokens: bigint("cache_creation_input_tokens", {
      mode: "number",
    }).notNull(),
    cacheCreation1hInputTokens: bigint("cache_creation_1h_input_tokens", {
      mode: "number",
    }).notNull(),
    cacheReadInputTokens: bigint("cache_read_input_tokens", {
      mode: "number",
    }).notNull(),
    // What else the price rests on. Rows from before it say
    // `unknown`, as a report from a proxy that predates it does; they were
    // priced as standard with no tool fee.
    speed: text().notNull().default("unknown"),
    webSearchRequests: bigint("web_search_requests", { mode: "number" })
      .notNull()
      .default(0),
    webFetchRequests: bigint("web_fetch_requests", { mode: "number" })
      .notNull()
      .default(0),
    codeExecutionRequests: bigint("code_execution_requests", {
      mode: "number",
    })
      .notNull()
      .default(0),
    // Rows from before say `unknown`, as a report from a proxy that
    // predates it does; they were priced with no geo multiplier.
    inferenceGeo: text("inference_geo").notNull().default("unknown"),
    // The proxy estimated the call high because its answer did not say what
    // it used: a stream cut short, or a body it could not read.
    estimated: boolean().notNull(),
    // What was charged: the priced amount rounded up to the micro-dollar,
    // clamped to what the column holds. Exactly what the session got.
    costUsd: numeric("cost_usd", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),
    // `fallback`: the model was not in the price table and every part was
    // charged at the highest known rate. `unmetered`: the session's profile
    // declared `billing: none`, so the call cost nothing.
    pricedBy: text("priced_by")
      .$type<"table" | "fallback" | "unmetered">()
      .notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("provider_usage_session_idx").on(table.sessionId),
    check(
      "provider_usage_priced_by_check",
      sql`${table.pricedBy} IN ('table', 'fallback', 'unmetered')`,
    ),
    check("provider_usage_cost_usd_nonneg", sql`${table.costUsd} >= 0`),
  ],
);

// provider_usage summed per session and model by the provider_usage insert
// trigger (migration usage_breakdown_rollup), so the usage breakdown reads a row per pair
// instead of every call. The session's created_at and agent are copied for
// the period filter and the grouping; neither changes after the session is
// created. No foreign keys: rows only come from provider_usage, which holds
// the session's, and adding one would block session writes for the whole
// migration.
export const sessionModelUsage = pgTable(
  "session_model_usage",
  {
    sessionId: uuid("session_id").notNull(),
    model: text().notNull(),
    sessionCreatedAt: timestamp("session_created_at", {
      withTimezone: true,
    }).notNull(),
    agentId: uuid("agent_id"),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    cacheReadInputTokens: bigint("cache_read_input_tokens", {
      mode: "number",
    }).notNull(),
    cacheCreationInputTokens: bigint("cache_creation_input_tokens", {
      mode: "number",
    }).notNull(),
    costUsd: numeric("cost_usd", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.model] }),
    index("session_model_usage_created_at_idx").on(table.sessionCreatedAt),
  ],
);

// provider_usage summed per model and pricing by its insert, delete and
// truncate triggers (migration session_data_rollups), for the platform
// metrics. Unbounded numerics: the sums of every call an installation ever
// made, exactly as sum() over provider_usage gives them.
export const providerUsageTotals = pgTable(
  "provider_usage_totals",
  {
    model: text().notNull(),
    pricedBy: text("priced_by").notNull(),
    calls: bigint({ mode: "number" }).notNull(),
    inputTokens: numeric("input_tokens").notNull(),
    outputTokens: numeric("output_tokens").notNull(),
    cacheReadInputTokens: numeric("cache_read_input_tokens").notNull(),
    cacheCreationInputTokens: numeric("cache_creation_input_tokens").notNull(),
    costUsd: numeric("cost_usd").notNull(),
    firstAt: timestamp("first_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.model, table.pricedBy] })],
);

// The part of a session's cost_usd no metered call explains: the engine's
// turn totals from before provider_usage. Written once by migration usage_breakdown_rollup;
// a call adds to cost_usd and to its own sum alike, so the difference stays
// put and new sessions never get a row. No foreign key, as above.
export const sessionPreMeteringCost = pgTable(
  "session_pre_metering_cost",
  {
    sessionId: uuid("session_id").primaryKey(),
    sessionCreatedAt: timestamp("session_created_at", {
      withTimezone: true,
    }).notNull(),
    costUsd: numeric("cost_usd", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),
  },
  (table) => [
    index("session_pre_metering_cost_created_at_idx").on(
      table.sessionCreatedAt,
    ),
  ],
);

// The one launch registry: a row is the reserved slot, and it carries the
// hash of the one-time nonce the worker trades for its binding. The row is
// written when the slot is taken; the nonce columns stay null until a
// container is actually created for it, so a reservation nobody launched
// hands out no credential at all.
export const workerLaunches = pgTable(
  "worker_launches",
  {
    executionId: text("execution_id").primaryKey(),
    generation: integer().notNull(),
    partition: text().notNull().default("default"),
    // Set when the launch was started for one particular session, which is
    // what a backend that mounts a session's workspace into the container
    // does. The claim is then pinned to it instead of taking the partition's
    // head, so an execution built for B can never run A.
    sessionId: uuid("session_id").references(() => sessions.id),
    backend: text().notNull(),
    // Null until the credential is issued. A null never matches a lookup by
    // hash, which is what makes an unlaunched reservation unclaimable.
    nonceHash: bytea("nonce_hash").unique(),
    nonceExpiresAt: timestamp("nonce_expires_at", { withTimezone: true }),
    claimedAttemptId: text("claimed_attempt_id").references(() => attempts.id),
    // Set before the scheduler tears the resource down to rebuild it from
    // the same intent; cleared once the rebuilt one is observed up. A
    // teardown that half happens, or a host that dies mid-way, leaves it
    // set, and that is what keeps the next pass from reading the stopped
    // resource as an ordinary exit.
    replacementReason: text("replacement_reason"),
    // Replacements ever requested for this launch; never reset, so the
    // scheduler's limit holds across settle-and-request-again cycles.
    replacementCount: integer("replacement_count").notNull().default(0),
    // What the launch runs for as long as it lives: the image pinned when it
    // was reserved and the limits it was reserved with. Null on a launch
    // reserved before they were stored, which runs on current settings.
    image: text(),
    resources: jsonb(),
    // The combination the scheduler was told `image` runs, which the claim
    // is held to. All null on a launch reserved without one.
    runtimeEngine: text("runtime_engine"),
    runtimeSdkVersion: text("runtime_sdk_version"),
    runtimeCliVersion: text("runtime_cli_version"),
    runtimeProfileScheme: integer("runtime_profile_scheme"),
    // Launch attempts that failed before any worker bound: a create or start
    // the provider refused, or a resource that exited unclaimed. Never reset,
    // so a launch that keeps failing reaches the scheduler's limit and gives
    // its slot back instead of holding it forever.
    launchFailureCount: integer("launch_failure_count").notNull().default(0),
    // Attempts whose outcome was recorded, success or failure. A failure is
    // fenced on it, so one reported by a pass that lost its lock mid-ensure
    // cannot revoke what a later pass has since launched.
    launchAttempts: integer("launch_attempts").notNull().default(0),
    // No attempt before this, on the database clock; null when none failed
    // or the launch was given up on.
    launchRetryAt: timestamp("launch_retry_at", { withTimezone: true }),
    lastLaunchError: text("last_launch_error"),
    // When the scheduler first asked the worker this launch bound to drain,
    // because its resource no longer meets the isolation contract.
    // From then on the worker is handed no new turn; the replacement waits
    // for the one it runs, up to a deadline counted from here.
    drainRequestedAt: timestamp("drain_requested_at", { withTimezone: true }),
    slotReservedAt: timestamp("slot_reserved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    slotReleasedAt: timestamp("slot_released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("worker_launches_open_slot_idx")
      .on(table.partition)
      .where(sql`${table.slotReleasedAt} IS NULL`),
    // Every reservation asks whether this session already holds a launch.
    index("worker_launches_open_session_idx")
      .on(table.sessionId)
      .where(
        sql`${table.slotReleasedAt} IS NULL AND ${table.sessionId} IS NOT NULL`,
      ),
    check(
      "worker_launches_replacement_reason_check",
      sql`${table.replacementReason} IS NULL OR ${table.replacementReason} IN ('credential_mismatch', 'nonce_expired', 'spec_mismatch', 'stale_isolation')`,
    ),
    check(
      "worker_launches_replacement_count_check",
      sql`${table.replacementCount} >= 0`,
    ),
    check(
      "worker_launches_launch_spec_check",
      sql`(${table.image} IS NULL) = (${table.resources} IS NULL)`,
    ),
    check(
      "worker_launches_launch_failure_count_check",
      sql`${table.launchFailureCount} >= 0`,
    ),
    check(
      "worker_launches_launch_attempts_check",
      sql`${table.launchAttempts} >= 0`,
    ),
  ],
);

// A pinned worker image whose worker claimed under another combination than
// its launch assumed: the configured runtime is wrong for it. The scheduler
// launches nothing on the image under that assumption again; correcting
// the configured runtime is the way out, so the key holds the assumption.
export const workerImageRefusals = pgTable(
  "worker_image_refusals",
  {
    image: text().notNull(),
    assumedEngine: text("assumed_engine").notNull(),
    assumedSdkVersion: text("assumed_sdk_version").notNull(),
    assumedCliVersion: text("assumed_cli_version").notNull(),
    assumedProfileScheme: integer("assumed_profile_scheme").notNull(),
    // What the worker said it runs, as it said it; for the operator only.
    claimed: jsonb().notNull(),
    executionId: text("execution_id").notNull(),
    refusedAt: timestamp("refused_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "worker_image_refusals_pkey",
      columns: [
        table.image,
        table.assumedEngine,
        table.assumedSdkVersion,
        table.assumedCliVersion,
        table.assumedProfileScheme,
      ],
    }),
  ],
);

// Tokens handed out by bootstrapClaim; only their hashes are stored. Each
// attempt holds one live token per purpose: `gateway` authenticates the
// worker's own calls, `provider` and `repository` the egress proxy's
// credential routes, `object_store` its object store route, and `mcp` the
// remote MCP route of a session whose agent release names a server (only
// then is one issued), and `packages` its package registry route. All of
// them are issued, extended and revoked
// together, and a token only ever works for its own purpose.
export const workerCredentials = pgTable(
  "worker_credentials",
  {
    tokenHash: bytea("token_hash").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => attempts.id),
    purpose: text("purpose").notNull().default("gateway"),
    // What an egress token was issued against: the profile fingerprint, the
    // repository binding or the session's object prefix at claim time. A catalog entry that moved since
    // (a restart with an edited config) no longer matches, and the proxy is
    // refused rather than sent somewhere the attempt never agreed to.
    binding: text("binding"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Every heartbeat extends the attempt's live credential, and revoked
    // rows are kept as history, so that lookup needs its own index.
    index("worker_credentials_live_idx")
      .on(table.attemptId)
      .where(sql`${table.revokedAt} IS NULL`),
    uniqueIndex("worker_credentials_live_purpose_idx")
      .on(table.attemptId, table.purpose)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "worker_credentials_purpose_check",
      sql`${table.purpose} IN ('gateway', 'provider', 'repository', 'object_store', 'mcp', 'packages')`,
    ),
    check(
      "worker_credentials_binding_check",
      sql`(${table.purpose} = 'gateway') = (${table.binding} IS NULL)`,
    ),
  ],
);

export const workers = pgTable("workers", {
  podId: text("pod_id").primaryKey(),
  lastSeen: timestamp("last_seen", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Stamped by whoever heartbeats, from its own TTL; the orphan reconciler
  // compares against this and holds no TTL of its own, so a TTL set on one
  // process cannot be judged by another's.
  leaseExpiresAt: timestamp("lease_expires_at", {
    withTimezone: true,
  }).notNull(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid().primaryKey(),
    keyHash: bytea("key_hash").notNull().unique(),
    ownerId: text("owner_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Null on legacy keys until an owner_workspace_map row exists. */
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    /** Null on a key from before scopes: it holds none. */
    scopes: text().array(),
    // personal: a member's own; agent: one agent's; operator: issued by the
    // key CLI to an owner partition outside any workspace.
    kind: text().notNull(),
    name: text(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** An agent key's agent, whose sessions it reaches and nothing else. */
    agentId: uuid("agent_id"),
    // Unindexed so the throttled touch stays a HOT update (touchApiKey).
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "api_keys_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    index("api_keys_agent_idx")
      .on(table.agentId)
      .where(sql`${table.agentId} IS NOT NULL`),
    // A person's key carries their authority, never an agent's.
    check(
      "api_keys_agent_check",
      sql`(${table.kind} = 'agent') = (${table.agentId} IS NOT NULL) AND (${table.kind} <> 'agent' OR ${table.workspaceId} IS NOT NULL)`,
    ),
    // No key reaches a whole workspace as itself.
    check(
      "api_keys_operator_check",
      sql`${table.kind} <> 'operator' OR ${table.workspaceId} IS NULL`,
    ),
    check(
      "api_keys_name_check",
      sql`${table.name} IS NULL OR (char_length(${table.name}) BETWEEN 1 AND 64 AND ${table.name} = btrim(${table.name}))`,
    ),
    index("api_keys_workspace_idx")
      .on(table.workspaceId)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    index("api_keys_personal_creator_idx")
      .on(table.createdByUserId)
      .where(sql`${table.kind} = 'personal'`),
    check(
      "api_keys_kind_check",
      sql`${table.kind} IN ('personal', 'agent', 'operator')`,
    ),
    check(
      "api_keys_personal_check",
      sql`${table.kind} <> 'personal' OR (${table.createdByUserId} IS NOT NULL AND ${table.workspaceId} IS NOT NULL)`,
    ),
    // Same vocabulary as grants.scopes, which may only narrow a key's.
    check(
      "api_keys_scopes_check",
      sql`${table.scopes} IS NULL OR (${oneDimensional(table.scopes)} AND ${table.scopes} <@ ${SESSION_SCOPES_SQL})`,
    ),
  ],
);

// No code of this release reads or writes it. The table stays for one release
// so a rolling replica or a rollback to the release before still finds what
// it locks; the next compatibility-breaking release drops it.
export const catalogAuthority = pgTable(
  "catalog_authority",
  {
    id: integer().primaryKey(),
    revision: text().notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("catalog_authority_singleton_check", sql`${table.id} = 1`)],
);

export const AGENT_ACTIVATION_EVENT_KINDS = [
  "release_created",
  "activated",
] as const;

// Mirror contracts' CREDENTIAL_BINDING_TARGET_VALUES and CREDENTIAL_REF
// pattern; schema.test.ts asserts they agree.
export const CREDENTIAL_BINDING_TARGETS = ["agent", "agent_identity"] as const;
export const CREDENTIAL_REF_PATTERN = "^[a-z0-9][a-z0-9._:/-]{0,127}$";

// Versions, releases and activation events are insert-only (migration 0139
// triggers); a release's approval is set once, by its first activation, and
// its spec columns once, from NULL (migration 0255).
export const agents = pgTable(
  "agents",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    slug: text().notNull(),
    name: text().notNull(),
    /** On the row like `name`, so editing it mints no version. */
    description: text(),
    status: text().notNull().default("active"),
    activeReleaseId: text("active_release_id"),
    activationRevision: integer("activation_revision").notNull().default(-1),
    slackMentionOnly: boolean("slack_mention_only").notNull().default(true),
    /** Read at every GitHub token request, so turning it off is immediate. */
    githubEnabled: boolean("github_enabled").notNull().default(true),
    autoModelMigration: boolean("auto_model_migration").notNull().default(true),
    /** Its leads administer the agent. An agent is never without one. */
    managingTeamId: uuid("managing_team_id").notNull(),
    // Nothing writes the five columns below yet; they hold their defaults.
    /** `follow` takes a profile's newer versions by rollout; `pinned` stays. */
    profileTracking: text("profile_tracking").notNull().default("follow"),
    /** Counts the intents to change behavior; a stale result is told apart by it. */
    behaviorRevision: integer("behavior_revision").notNull().default(0),
    /** `profile` runs the profile's default model; `fixed` the card's own. */
    modelSource: text("model_source").notNull().default("fixed"),
    /**
     * A saved change not yet active: the card version, the target profile
     * and the model source, filled and cleared together. `draft_failure`
     * says why it did not apply.
     */
    draftVersionId: uuid("draft_version_id"),
    draftProfileId: text("draft_profile_id"),
    draftModelSource: text("draft_model_source"),
    draftFailure: text("draft_failure"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("agents_workspace_slug_idx").on(table.workspaceId, table.slug),
    foreignKey({
      name: "agents_draft_version_fk",
      columns: [table.id, table.draftVersionId],
      foreignColumns: [agentVersions.agentId, agentVersions.id],
    }),
    check(
      "agents_profile_tracking_check",
      sql`${table.profileTracking} IN ('follow', 'pinned')`,
    ),
    check(
      "agents_model_source_check",
      sql`${table.modelSource} IN ('fixed', 'profile')`,
    ),
    check(
      "agents_behavior_revision_check",
      sql`${table.behaviorRevision} >= 0`,
    ),
    check(
      "agents_draft_check",
      sql`(${table.draftVersionId} IS NULL) = (${table.draftProfileId} IS NULL) AND (${table.draftVersionId} IS NULL) = (${table.draftModelSource} IS NULL) AND (${table.draftModelSource} IS NULL OR ${table.draftModelSource} IN ('fixed', 'profile')) AND (${table.draftFailure} IS NULL OR ${table.draftVersionId} IS NOT NULL)`,
    ),
    foreignKey({
      name: "agents_managing_team_fk",
      columns: [table.workspaceId, table.managingTeamId],
      foreignColumns: [memberTeams.workspaceId, memberTeams.id],
    }),
    // A team's archive looks for the agents it manages.
    index("agents_managing_team_idx").on(table.managingTeamId),
    // What agent_admins and api_keys reference, so neither can name another
    // workspace's agent.
    unique("agents_workspace_id_key").on(table.workspaceId, table.id),
    foreignKey({
      name: "agents_active_release_fk",
      columns: [table.id, table.activeReleaseId],
      foreignColumns: [agentReleases.agentId, agentReleases.id],
    }),
    check(
      "agents_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(AGENT_STATUS_VALUES))})`,
    ),
    check(
      "agents_slug_check",
      sql`length(${table.slug}) BETWEEN 1 AND 64 AND ${table.slug} ~ '^[a-z0-9][a-z0-9-]*$'`,
    ),
    check(
      "agents_activation_check",
      sql`${table.activationRevision} >= -1 AND (${table.activeReleaseId} IS NULL) = (${table.activationRevision} = -1)`,
    ),
    check(
      "agents_description_check",
      sql`${table.description} IS NULL OR length(${table.description}) <= ${sql.raw(String(AGENT_DESCRIPTION_MAX_LENGTH))}`,
    ),
  ],
);

// An agent's admins (design 4.1): a member gains that agent's management
// actions. Whoever creates an agent is its first (D3). A team as admin is M13.
export const agentAdmins = pgTable(
  "agent_admins",
  {
    workspaceId: uuid("workspace_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.userId] }),
    foreignKey({
      name: "agent_admins_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    // An admin is a member of the agent's workspace, never someone else's.
    foreignKey({
      name: "agent_admins_member_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    index("agent_admins_user_idx").on(table.workspaceId, table.userId),
  ],
);

// What an agent's GitHub work may reach, read at every use and in no version:
// sessions with `github_policy_source = 'agent'` follow a change at once.
// `agents.github_enabled` stays the switch. No row: the agent's sessions run
// on their release.
export const agentGitHubSettings = pgTable(
  "agent_github_settings",
  {
    agentId: uuid("agent_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    repositories: jsonb().$type<string[]>().notNull(),
    pushApproval: boolean("push_approval").notNull(),
    features: jsonb().$type<GitHubFeatures>().notNull(),
    actionsAllow: jsonb("actions_allow").$type<unknown[]>().notNull(),
    // A session named no repository starts on this one.
    startRepositoryId: text("start_repository_id"),
    // `allow` | `ask` | `deny` for a push to an attached repository. Null on
    // a row saved before the column, which reads as `ask`; no column default,
    // because the save writes the value and a default would also rewrite what
    // those rows mean.
    pushAttached: text("push_attached"),
    revision: integer().notNull().default(1),
    /** No foreign key: the row outlives the account. */
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "agent_github_settings_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    check(
      "agent_github_settings_repositories_check",
      sql`jsonb_typeof(${table.repositories}) = 'array'`,
    ),
    check(
      "agent_github_settings_start_check",
      sql`${table.startRepositoryId} IS NULL OR ${table.repositories} ? ${table.startRepositoryId}`,
    ),
    check(
      "agent_github_settings_push_attached_check",
      sql`${table.pushAttached} IS NULL OR ${table.pushAttached} IN ('allow','ask','deny')`,
    ),
  ],
);

// The remote MCP server an agent calls and the credential names it needs,
// read at every use and in no version: access, not behavior, so a change
// makes no release. No row: the agent's sessions follow their release's
// card and pins. `updated_by` is set only by a person's save; a row copied
// from a release leaves it null and does not narrow that release's sessions.
export const agentMcpSettings = pgTable(
  "agent_mcp_settings",
  {
    agentId: uuid("agent_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // The catalog id of the one server, or null for none.
    server: text(),
    // Full `mcp__<server>__<tool>` names the agent may call.
    allowedTools: jsonb("allowed_tools").$type<string[]>().notNull(),
    // Names only; the grant is `credential_bindings`.
    credentialRefs: jsonb("credential_refs").$type<string[]>().notNull(),
    revision: integer().notNull().default(1),
    /** No foreign key: the row outlives the account. */
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "agent_mcp_settings_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    check(
      "agent_mcp_settings_allowed_tools_check",
      // Strings of at most 128 characters that name a tool of the row's
      // server, and none without one. `strict` keeps a nested array from
      // being unwrapped and passing as its elements.
      sql`jsonb_typeof(${table.allowedTools}) = 'array' AND NOT jsonb_path_exists(${table.allowedTools}, 'strict $[*] ? (@.type() != "string")') AND (${table.server} IS NOT NULL OR jsonb_array_length(${table.allowedTools}) = 0) AND (${table.server} IS NULL OR NOT jsonb_path_exists(${table.allowedTools}, 'strict $[*] ? (!(@ starts with $p) || @ == $p || @ like_regex "^.{129,}$")', jsonb_build_object('p', 'mcp__' || ${table.server} || '__')))`,
    ),
    check(
      "agent_mcp_settings_credential_refs_check",
      // Uniqueness is the writer's: a CHECK cannot compare elements.
      sql`jsonb_typeof(${table.credentialRefs}) = 'array' AND jsonb_array_length(${table.credentialRefs}) <= 32 AND NOT jsonb_path_exists(${table.credentialRefs}, 'strict $[*] ? (@.type() != "string")') AND NOT jsonb_path_exists(${table.credentialRefs}, 'strict $[*] ? (!(@ like_regex "^[a-z0-9][a-z0-9._:/-]{0,127}$"))')`,
    ),
    check(
      "agent_mcp_settings_server_check",
      sql`${table.server} IS NULL OR ${table.server} ~ '^[a-z0-9](?:[a-z0-9-]|_(?!_)){0,31}$'`,
    ),
  ],
);

// Structure only: an object of string lists under the given keys, at most 64
// strings each, none empty or over `maxLength`. Whether a rule is one the
// engine takes is the parser's, which a CHECK cannot run. `strict` keeps a
// nested array from being unwrapped and passing as its elements. The strings
// are constants, so they are inlined; a DDL statement takes no parameters.
function stringListsCheck(
  column: AnyPgColumn,
  keys: readonly string[],
  maxLength: number,
) {
  // A regex repeat count stops at 255, so a longer limit is blocks of 128: one
  // character past `blocks * 128` is over the limit. Flag `s` lets `.` match a
  // line break, which it does not by default; without it a newline ends the
  // count and a longer string passes.
  if (maxLength % 128 !== 0) throw new Error("maxLength is a multiple of 128");
  const over = `^(.{128}){${maxLength / 128}}.`;
  const known = keys.map((key) => `@.key == "${key}"`).join(" || ");
  const path = (filter: string) => sql.raw(`'strict ${filter}'`);
  return sql`jsonb_typeof(${column}) = 'object'
    AND NOT jsonb_path_exists(${column}, ${path(`$.keyvalue() ? (!(${known}))`)})
    AND NOT jsonb_path_exists(${column}, ${path('$.* ? (@.type() != "array")')})
    AND NOT jsonb_path_exists(${column}, ${path("$.* ? (@.size() > 64)")})
    AND NOT jsonb_path_exists(${column}, ${path('$.*[*] ? (@.type() != "string")')})
    AND NOT jsonb_path_exists(${column}, ${path(`$.*[*] ? (@ == "" || @ like_regex "${over}" flag "s")`)})`;
}

// An agent's engine settings: the permission rules and auto mode sentences it
// runs with, outside the card, so a change makes no release. No row, or two
// empty objects, means no rules. A row is never deleted: clearing writes
// empty objects and raises `revision`, so a revision is never reused. Nothing
// writes this table yet; the write path ships with the merge that sends the
// settings to the engine. A session follows it as `start ∩ now`, never wider
// than it started.
export const agentEngineSettings = pgTable(
  "agent_engine_settings",
  {
    agentId: uuid("agent_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    // `{allow?, ask?, deny?}`, each a list of rules in the engine's spelling.
    permissions: jsonb()
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),
    // `{allow?, soft_deny?, hard_deny?, environment?}`, each a list of sentences.
    autoMode: jsonb("auto_mode")
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),
    // What the agent inherits from what its profile and the installation
    // blocked: `[{exempt_release_ids, permissions_deny, mcp_deny}]`. Only an
    // operator writes it, never the web API, and an entry applies to a session
    // whose release is not in its `exempt_release_ids`, so a release the agent
    // already had keeps what it was pinned with.
    adminDeny: jsonb("admin_deny")
      .$type<Array<Record<string, string[]>>>()
      .notNull()
      .default([]),
    revision: integer().notNull().default(1),
    /** No foreign key: the row outlives the account. */
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "agent_engine_settings_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    check(
      "agent_engine_settings_admin_deny_check",
      sql`jsonb_typeof(${table.adminDeny}) = 'array'`,
    ),
    check(
      "agent_engine_settings_permissions_check",
      stringListsCheck(table.permissions, ["allow", "ask", "deny"], 256),
    ),
    check(
      "agent_engine_settings_auto_mode_check",
      stringListsCheck(
        table.autoMode,
        ["allow", "soft_deny", "hard_deny", "environment"],
        1024,
      ),
    ),
    check("agent_engine_settings_revision_check", sql`${table.revision} >= 1`),
  ],
);

// A workspace's engine settings, in the shape of an agent's: one row, never
// deleted (clearing writes empty objects and raises `revision`), no row means
// no rules. Every agent of the workspace runs under it; an agent's own rules
// only ever add restrictions to it. Nothing writes this table yet.
export const workspaceEngineSettings = pgTable(
  "workspace_engine_settings",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id),
    permissions: jsonb()
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),
    autoMode: jsonb("auto_mode")
      .$type<Record<string, string[]>>()
      .notNull()
      .default({}),
    revision: integer().notNull().default(1),
    /** No foreign key: the row outlives the account. */
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "workspace_engine_settings_permissions_check",
      stringListsCheck(table.permissions, ["allow", "ask", "deny"], 256),
    ),
    check(
      "workspace_engine_settings_auto_mode_check",
      stringListsCheck(
        table.autoMode,
        ["allow", "soft_deny", "hard_deny", "environment"],
        1024,
      ),
    ),
    check(
      "workspace_engine_settings_revision_check",
      sql`${table.revision} >= 1`,
    ),
  ],
);

// The one row that says whether engine settings may be written. Closed, the
// write API and the migration refuse, so a rule is never saved while some
// replica or worker would not carry it to the engine. Closing it stops
// writes only: rules already saved stay enforced. A writer holds the row
// FOR SHARE for its transaction, so closing waits for the writes in flight.
export const engineSettingsGate = pgTable(
  "engine_settings_gate",
  {
    id: integer().primaryKey().default(1),
    writesOpen: boolean("writes_open").notNull().default(false),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** No foreign key: the row outlives the account. */
    changedBy: uuid("changed_by"),
  },
  (table) => [check("engine_settings_gate_single", sql`${table.id} = 1`)],
);

// How an agent's pull request bodies differ from the workspace's. Apart from
// `agent_github_settings`: a row there makes the agent's sessions follow it
// instead of their release, and saving a template must not do that. No row:
// the workspace's values apply. `template` is never read back into a receipt.
export const agentPullRequestSettings = pgTable(
  "agent_pull_request_settings",
  {
    agentId: uuid("agent_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    formatting: text().notNull(),
    template: text(),
    templateName: text("template_name"),
    revision: integer().notNull().default(1),
    /** No foreign key: the row outlives the account. */
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "agent_pull_request_settings_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    check(
      "agent_pull_request_settings_formatting_check",
      sql`${table.formatting} IN ('inherit', 'on', 'off')`,
    ),
  ],
);

// A group of people in a workspace (design 4.7). Named apart from the
// session teams Lotse will add.
export const memberTeams = pgTable(
  "member_teams",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    revision: integer().notNull().default(1),
    /**
     * Set only by migration 0243 on the team that took the agents which had
     * no managing team. Such agents keep the visibility they had: axis B does
     * not hide their workspace sessions, until an agent moves to a real team.
     */
    holdsUnassigned: boolean("holds_unassigned").notNull().default(false),
  },
  (table) => [
    unique("member_teams_workspace_id_key").on(table.workspaceId, table.id),
    uniqueIndex("member_teams_live_name_uniq")
      .on(table.workspaceId, table.name)
      .where(sql`${table.archivedAt} IS NULL`),
    check(
      "member_teams_name_check",
      sql`length(${table.name}) BETWEEN 1 AND 100`,
    ),
  ],
);

// Read at every decision: a removed row stops granting from the next request.
export const memberTeamMembers = pgTable(
  "member_team_members",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    teamId: uuid("team_id").notNull(),
    userId: uuid("user_id").notNull(),
    addedBy: uuid("added_by").references(() => users.id),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    role: text().notNull().default("member"),
  },
  (table) => [
    check(
      "member_team_members_role_check",
      sql`${table.role} IN (${sql.raw(sqlList(TEAM_MEMBER_ROLE_VALUES))})`,
    ),
    foreignKey({
      name: "member_team_members_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [memberTeams.workspaceId, memberTeams.id],
    }),
    // Only a member of the team's own workspace can join it.
    foreignKey({
      name: "member_team_members_member_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    uniqueIndex("member_team_members_live_uniq")
      .on(table.teamId, table.userId)
      .where(sql`${table.removedAt} IS NULL`),
    index("member_team_members_user_idx")
      .on(table.workspaceId, table.userId)
      .where(sql`${table.removedAt} IS NULL`),
  ],
);

// A team as an agent's admin: every live member of it administers the agent.
export const agentAdminTeams = pgTable(
  "agent_admin_teams",
  {
    workspaceId: uuid("workspace_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    teamId: uuid("team_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.teamId] }),
    foreignKey({
      name: "agent_admin_teams_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    foreignKey({
      name: "agent_admin_teams_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [memberTeams.workspaceId, memberTeams.id],
    }),
    index("agent_admin_teams_team_idx").on(table.teamId),
  ],
);

// Who sees a session (design 4.6). No row reads as `workspace`, which is
// what every session made before this table, and every web, API and channel
// session since, starts as.
export const sessionShares = pgTable(
  "session_shares",
  {
    sessionId: uuid("session_id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    scope: text().notNull(),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revision: integer().notNull().default(1),
  },
  (table) => [
    // NOT NULL workspace_id makes this pin the row to its session's
    // workspace; a legacy session has none and cannot be shared.
    foreignKey({
      name: "session_shares_session_fk",
      columns: [table.sessionId, table.ownerId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.ownerId, sessions.workspaceId],
    }),
    unique("session_shares_workspace_session_key").on(
      table.workspaceId,
      table.sessionId,
    ),
    check(
      "session_shares_scope_check",
      sql`${table.scope} IN ('private', 'people', 'team', 'workspace')`,
    ),
  ],
);

// The people or teams a `people` or `team` share names; a team is read for
// its live members at every decision.
export const sessionShareTargets = pgTable(
  "session_share_targets",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    userId: uuid("user_id"),
    teamId: uuid("team_id"),
    addedBy: uuid("added_by").references(() => users.id),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "session_share_targets_share_fk",
      columns: [table.workspaceId, table.sessionId],
      foreignColumns: [sessionShares.workspaceId, sessionShares.sessionId],
    }).onDelete("cascade"),
    foreignKey({
      name: "session_share_targets_member_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [memberships.workspaceId, memberships.userId],
    }),
    foreignKey({
      name: "session_share_targets_team_fk",
      columns: [table.workspaceId, table.teamId],
      foreignColumns: [memberTeams.workspaceId, memberTeams.id],
    }),
    check(
      "session_share_targets_one_check",
      sql`(${table.userId} IS NULL) <> (${table.teamId} IS NULL)`,
    ),
    uniqueIndex("session_share_targets_user_uniq")
      .on(table.sessionId, table.userId)
      .where(sql`${table.userId} IS NOT NULL`),
    uniqueIndex("session_share_targets_team_uniq")
      .on(table.sessionId, table.teamId)
      .where(sql`${table.teamId} IS NOT NULL`),
  ],
);

// "This Slack app and bot is this agent" (design A.2, M8). App and team are
// the install's; the bot user is pinned here, so a reinstall that answers as
// another bot resolves to no one until linked again.
export const agentIdentities = pgTable(
  "agent_identities",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    provider: text().$type<"slack_bot">().notNull(),
    installationId: uuid("installation_id").notNull(),
    /** The bot user id `auth.test` reported when the identity was linked. */
    externalPrincipalId: text("external_principal_id").notNull(),
    /** The bot token's name in the secret store; the value is never here. */
    credentialRef: text("credential_ref").notNull(),
    status: text().$type<"active" | "revoked">().notNull().default("active"),
    revision: integer().notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedBy: uuid("revoked_by").references(() => users.id),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "agent_identities_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    foreignKey({
      name: "agent_identities_installation_fk",
      columns: [table.workspaceId, table.installationId],
      foreignColumns: [slackInstallations.workspaceId, slackInstallations.id],
    }),
    // An event's app and team name one agent at most.
    uniqueIndex("agent_identities_installation_live_uniq")
      .on(table.installationId)
      .where(sql`${table.status} = 'active'`),
    index("agent_identities_agent_idx").on(table.agentId),
    check(
      "agent_identities_provider_check",
      sql`${table.provider} IN (${sql.raw(sqlList(AGENT_IDENTITY_PROVIDER_VALUES))})`,
    ),
    check(
      "agent_identities_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(AGENT_IDENTITY_STATUS_VALUES))})`,
    ),
    check(
      "agent_identities_revoked_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)`,
    ),
    check(
      "agent_identities_credential_ref_check",
      sql`${table.credentialRef} ~ '^[a-z0-9][a-z0-9._:/-]{0,127}$'`,
    ),
  ],
);

// How an agent answers in one place of a chat surface (03 §5, 94S-177): a
// Slack channel of its app's install, or that install's DMs, which share one
// row with no channel id. Rows are revoked, never deleted; a write replaces
// the row and bumps `revision`. The install is the agent's own: the store
// takes it from the agent's live identity.
export const surfaceBindings = pgTable(
  "surface_bindings",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    surface: text().$type<"web" | "slack" | "api">().notNull().default("slack"),
    installationId: uuid("installation_id"),
    externalSurfaceId: text("external_surface_id"),
    surfaceKind: text("surface_kind").$type<
      "public_channel" | "private_channel" | "dm"
    >(),
    mode: text().$type<"off" | "on">().notNull(),
    /** The channel's ceiling; `surfaceCeilingSchema` split in two columns. */
    ceilingActions: text("ceiling_actions").array().notNull(),
    ceilingDisclosure: text("ceiling_disclosure")
      .$type<"full" | "summary">()
      .notNull(),
    home: boolean().notNull().default(false),
    memoryWritePolicy: text("memory_write_policy")
      .$type<"deny" | "allow_explicit">()
      .notNull()
      .default("deny"),
    status: text()
      .$type<
        "ready" | "pending_approval" | "left" | "partial" | "failed" | "revoked"
      >()
      .notNull()
      .default("ready"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /**
     * The newest join/leave of the channel (`slack_channel_lifecycle`, Slack's
     * own clock) the approval already knew of; 0 when there was none. A later
     * leave voids the approval, an earlier or equal one cannot. Null until
     * approved, and for an approval made before this column existed.
     */
    approvedLifecycleUs: bigint("approved_lifecycle_us", { mode: "number" }),
    muted: boolean().notNull().default(false),
    /** `surfaceMembershipSchema`; null until Slack was asked. */
    membership: text().$type<SurfaceMembershipState>(),
    membershipError: text("membership_error"),
    revision: integer().notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "surface_bindings_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    foreignKey({
      name: "surface_bindings_installation_fk",
      columns: [table.workspaceId, table.installationId],
      foreignColumns: [slackInstallations.workspaceId, slackInstallations.id],
    }),
    // One live binding per channel of an install, and one DM row.
    uniqueIndex("surface_bindings_channel_live_uniq")
      .on(table.installationId, table.externalSurfaceId)
      .where(sql`${table.revokedAt} IS NULL`),
    uniqueIndex("surface_bindings_dm_live_uniq")
      .on(table.installationId)
      .where(sql`${table.surfaceKind} = 'dm' AND ${table.revokedAt} IS NULL`),
    uniqueIndex("surface_bindings_home_live_uniq")
      .on(table.agentId)
      .where(sql`${table.home} AND ${table.revokedAt} IS NULL`),
    index("surface_bindings_agent_idx").on(table.agentId),
    check(
      "surface_bindings_surface_check",
      sql`${table.surface} IN (${sql.raw(sqlList(SURFACE_KIND_VALUES))})`,
    ),
    check(
      "surface_bindings_surface_kind_check",
      sql`${table.surfaceKind} IN (${sql.raw(sqlList(SURFACE_CHANNEL_KIND_VALUES))})`,
    ),
    check(
      "surface_bindings_mode_check",
      sql`${table.mode} IN (${sql.raw(sqlList(BINDING_MODE_VALUES))})`,
    ),
    check(
      "surface_bindings_ceiling_check",
      sql`${table.ceilingActions} <@ ${textArrayLiteral(SLACK_SURFACE_ACTION_VALUES)} AND ${table.ceilingDisclosure} IN (${sql.raw(sqlList(SURFACE_DISCLOSURE_VALUES))})`,
    ),
    check(
      "surface_bindings_memory_write_policy_check",
      sql`${table.memoryWritePolicy} IN (${sql.raw(sqlList(MEMORY_WRITE_POLICY_VALUES))})`,
    ),
    check(
      "surface_bindings_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(SURFACE_BINDING_STATUS_VALUES))})`,
    ),
    check(
      "surface_bindings_membership_check",
      sql`(${table.membership} IS NULL OR ${table.membership} IN (${sql.raw(sqlList(SURFACE_MEMBERSHIP_STATE_VALUES))})) AND (${table.membershipError} IS NULL OR ${table.membership} IS NOT NULL)`,
    ),
    check(
      "surface_bindings_revoked_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)`,
    ),
    // The DM row covers every DM, so it names no channel; a DM is never home.
    check(
      "surface_bindings_dm_check",
      sql`${table.surfaceKind} IS DISTINCT FROM 'dm' OR (${table.externalSurfaceId} IS NULL AND NOT ${table.home})`,
    ),
    // `ready` claims routing works: a slack row then has what routing reads.
    check(
      "surface_bindings_ready_check",
      sql`${table.surface} <> 'slack' OR ${table.status} <> 'ready' OR (${table.installationId} IS NOT NULL AND ${table.surfaceKind} IS NOT NULL AND (${table.externalSurfaceId} IS NOT NULL OR ${table.surfaceKind} = 'dm'))`,
    ),
    check(
      "surface_bindings_pending_check",
      sql`${table.status} <> 'pending_approval' OR (${table.surface} = 'slack' AND ${table.installationId} IS NOT NULL AND ${table.externalSurfaceId} IS NOT NULL AND ${table.surfaceKind} = 'private_channel' AND NOT ${table.home})`,
    ),
    // A channel the bot left is inactive and holds no approval; COALESCE keeps
    // a NULL kind from passing the check as an unknown.
    check(
      "surface_bindings_left_check",
      sql`${table.status} <> 'left' OR (${table.surface} = 'slack' AND ${table.installationId} IS NOT NULL AND ${table.externalSurfaceId} IS NOT NULL AND COALESCE(${table.surfaceKind} = 'private_channel', false) AND NOT ${table.home} AND ${table.approvedAt} IS NULL AND ${table.approvedLifecycleUs} IS NULL)`,
    ),
    check("surface_bindings_revision_check", sql`${table.revision} >= 1`),
  ],
);

/**
 * The newest join/leave Slack told us of per channel of an install, as
 * microseconds since the epoch (Slack's `event_ts` has no finer unit, and a
 * millisecond would tie two events). Kept apart from `surface_bindings` so
 * it outlives a revoked binding: those events carry no `ts`, so an old one
 * arriving late is told apart by this.
 */
export const slackChannelLifecycle = pgTable(
  "slack_channel_lifecycle",
  {
    installationId: uuid("installation_id").notNull(),
    channelId: text("channel_id").notNull(),
    lastEventUs: bigint("last_event_us", { mode: "number" }).notNull(),
    /** The newest join and leave seen, whether or not Slack answered after. */
    lastJoinUs: bigint("last_join_us", { mode: "number" }),
    lastLeaveUs: bigint("last_leave_us", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      name: "slack_channel_lifecycle_pk",
      columns: [table.installationId, table.channelId],
    }),
    foreignKey({
      name: "slack_channel_lifecycle_installation_fk",
      columns: [table.installationId],
      foreignColumns: [slackInstallations.id],
    }),
  ],
);

export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references((): AnyPgColumn => agents.id),
    versionNo: integer("version_no").notNull(),
    card: jsonb().notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("agent_versions_number_idx").on(table.agentId, table.versionNo),
    uniqueIndex("agent_versions_content_idx").on(
      table.agentId,
      table.contentSha256,
    ),
    unique("agent_versions_agent_id_key").on(table.agentId, table.id),
    check("agent_versions_number_check", sql`${table.versionNo} > 0`),
    check(
      "agent_versions_content_check",
      sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const agentReleases = pgTable(
  "agent_releases",
  {
    // deriveReleaseId: a hash of every column below up to policy_pins.
    id: text().primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references((): AnyPgColumn => agents.id),
    versionId: uuid("version_id").notNull(),
    cardSha256: text("card_sha256").notNull(),
    runtimeProfileId: text("runtime_profile_id").notNull(),
    repositoryId: text("repository_id"),
    profileDigest: text("profile_digest").notNull(),
    runtimeConfigSnapshot: jsonb("runtime_config_snapshot").notNull(),
    effectiveTools: jsonb("effective_tools").notNull(),
    policyPins: jsonb("policy_pins").notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    // Outside the id's hash: a re-release of the same content keeps the
    // first note, null included.
    note: text(),
    // What a claim runs on without reading a profile, derived from the
    // columns above. Outside the id's hash: an old release keeps its id and
    // its original columns, and `spec_source` keeps what the spec was made
    // from so both digests recompute after the profile tables are gone. The
    // four are all null or all set.
    runtimeSpec: jsonb("runtime_spec").$type<Record<string, unknown>>(),
    specSource: jsonb("spec_source").$type<Record<string, unknown>>(),
    specSourceDigest: text("spec_source_digest"),
    specDigest: text("spec_digest"),
  },
  (table) => [
    foreignKey({
      name: "agent_releases_version_fk",
      columns: [table.agentId, table.versionId],
      foreignColumns: [agentVersions.agentId, agentVersions.id],
    }),
    check(
      "agent_releases_spec_check",
      sql`(${table.runtimeSpec} IS NULL) = (${table.specSource} IS NULL) AND (${table.runtimeSpec} IS NULL) = (${table.specSourceDigest} IS NULL) AND (${table.runtimeSpec} IS NULL) = (${table.specDigest} IS NULL)`,
    ),
    unique("agent_releases_agent_id_key").on(table.agentId, table.id),
    check(
      "agent_releases_approval_check",
      sql`(${table.approvedBy} IS NULL) = (${table.approvedAt} IS NULL)`,
    ),
    check(
      "agent_releases_note_check",
      sql`${table.note} IS NULL OR char_length(${table.note}) BETWEEN 1 AND 200`,
    ),
  ],
);

export const sessionLinks = pgTable(
  "session_links",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: text("owner_id").notNull(),
    sessionId: uuid("session_id").references(() => sessions.id),
    surface: text().$type<"slack">().notNull().default("slack"),
    installationId: uuid("installation_id").notNull(),
    surfaceBindingId: uuid("surface_binding_id")
      .notNull()
      .references(() => surfaceBindings.id),
    surfaceRef: text("surface_ref").notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id").notNull(),
    /**
     * The message whose turn opens the session: its other event (Slack sends
     * a mention as `app_mention` and as `message`) replays that turn.
     */
    openedByTs: text("opened_by_ts").notNull(),
    agentId: uuid("agent_id").notNull(),
    releaseId: text("release_id").notNull(),
    profileId: text("profile_id").notNull(),
    role: text().$type<"primary" | "mirror">().notNull().default("primary"),
    visibility: text().$type<"full" | "summary">().notNull().default("full"),
    muted: boolean().notNull().default(false),
    revision: integer().notNull().default(1),
    /**
     * The Slack outbox's mark: every turn up to this sequence needs nothing
     * more from it, so its pass reads only the turns after.
     */
    answeredThrough: integer("answered_through").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "session_links_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    foreignKey({
      name: "session_links_release_fk",
      columns: [table.agentId, table.releaseId],
      foreignColumns: [agentReleases.agentId, agentReleases.id],
    }),
    foreignKey({
      name: "session_links_installation_fk",
      columns: [table.workspaceId, table.installationId],
      foreignColumns: [slackInstallations.workspaceId, slackInstallations.id],
    }),
    unique("session_links_surface_ref_key").on(
      table.installationId,
      table.surfaceRef,
    ),
    uniqueIndex("session_links_session_uniq")
      .on(table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    check("session_links_surface_check", sql`${table.surface} = 'slack'`),
    check(
      "session_links_role_check",
      sql`${table.role} IN ('primary', 'mirror')`,
    ),
    check(
      "session_links_visibility_check",
      sql`${table.visibility} IN ('full', 'summary')`,
    ),
    check("session_links_revision_check", sql`${table.revision} >= 1`),
  ],
);

// What the `slack` role sends: a linked turn's answer, its failure or input
// notice, and refusals. A row whose send was under way when its lease ran
// out becomes `uncertain` and is never sent again (design 94S-792).
export const slackOutbox = pgTable(
  "slack_outbox",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id").notNull(),
    slackAppId: uuid("slack_app_id")
      .notNull()
      .references(() => slackApps.id),
    installationId: uuid("installation_id").notNull(),
    kind: text().$type<SlackOutboxKind>().notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    slackUserId: text("slack_user_id"),
    sessionId: uuid("session_id").references(() => sessions.id),
    /** The text before Slack controls are escaped, and the link it carries. */
    body: jsonb().$type<SlackOutboxBody>().notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text().$type<SlackOutboxStatus>().notNull().default("pending"),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Claims so far. */
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    slackTs: text("slack_ts"),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Send order: rows enqueued within one clock tick still go in order.
    seq: bigserial({ mode: "number" }).notNull(),
    // A sent card's redraws once its request moves on (design
    // slack-approval-ui §4): `due` to redraw, `settled` once an end state
    // went out, `abandoned` when Slack will take no more edits.
    settleState: text("settle_state"),
    /** What the posted card shows now: `open`, `reject_only` or an end state. */
    settleRendered: text("settle_rendered"),
    /** Set just before an edit; left behind, its outcome is unknown. */
    settleInflightAt: timestamp("settle_inflight_at", { withTimezone: true }),
    settleUncertainRev: integer("settle_uncertain_rev").notNull().default(0),
    settleUncertainLatestAt: timestamp("settle_uncertain_latest_at", {
      withTimezone: true,
    }),
    settleClaimToken: uuid("settle_claim_token"),
    settleLeaseExpiresAt: timestamp("settle_lease_expires_at", {
      withTimezone: true,
    }),
    settleAttempts: integer("settle_attempts").notNull().default(0),
    settleNextAt: timestamp("settle_next_at", { withTimezone: true }),
    settleError: text("settle_error"),
  },
  (table) => [
    unique("slack_outbox_dedupe_key").on(table.dedupeKey),
    check(
      "slack_outbox_settle_state_check",
      sql`${table.settleState} IN ('due', 'settled', 'abandoned')`,
    ),
    check(
      "slack_outbox_settle_claim_check",
      sql`(${table.settleClaimToken} IS NULL) = (${table.settleLeaseExpiresAt} IS NULL)`,
    ),
    // The cards a redraw may still be owed: few, as an end state leaves it.
    index("slack_outbox_settle_idx")
      .on(table.settleNextAt)
      .where(
        sql`${table.kind} = 'input_notice' AND ${table.status} = 'sent' AND ${table.settleState} IS DISTINCT FROM 'abandoned' AND (${table.settleState} IS DISTINCT FROM 'settled' OR ${table.settleUncertainLatestAt} IS NOT NULL)`,
      ),
    foreignKey({
      name: "slack_outbox_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    check(
      "slack_outbox_kind_check",
      sql`${table.kind} IN ('instruction', 'reply', 'notice', 'failure_notice', 'input_notice', 'welcome', 'action_notice', 'model_notice')`,
    ),
    check(
      "slack_outbox_status_check",
      sql`${table.status} IN ('pending', 'sending', 'sent', 'failed', 'uncertain')`,
    ),
    check(
      "slack_outbox_user_check",
      sql`(${table.kind} = 'notice') = (${table.slackUserId} IS NOT NULL)`,
    ),
    check(
      "slack_outbox_claim_check",
      // A claimed row stays `pending` until its send begins.
      sql`(${table.claimToken} IS NULL) = (${table.leaseExpiresAt} IS NULL) AND (${table.status} IN ('pending', 'sending') OR ${table.claimToken} IS NULL) AND (${table.status} <> 'sending' OR ${table.claimToken} IS NOT NULL)`,
    ),
    index("slack_outbox_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    index("slack_outbox_sending_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.status} = 'sending'`),
    index("slack_outbox_session_idx").on(table.sessionId),
    index("slack_outbox_uncertain_idx")
      .on(table.seq)
      .where(sql`${table.status} = 'uncertain' AND ${table.kind} = 'reply'`),
  ],
);

// The thread status the `slack` role last sent for a session link, and what
// changed since (94S-1292). Writes that change a session's state raise
// dirty_rev from triggers (migration 0225); one writer at a time, under the
// lease, sends the status computed after the last change.
export const slackThreadStatus = pgTable(
  "slack_thread_status",
  {
    sessionLinkId: uuid("session_link_id")
      .primaryKey()
      .references(() => sessionLinks.id, { onDelete: "cascade" }),
    dirtyRev: bigint("dirty_rev", { mode: "number" }).notNull().default(1),
    sentRev: bigint("sent_rev", { mode: "number" }).notNull().default(0),
    /** Null until a send succeeds; differs from every computed status. */
    sentStatus: text("sent_status"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextAt: timestamp("next_at", { withTimezone: true }),
    /** Set just before a send; left behind, its outcome is unknown. */
    inflightAt: timestamp("inflight_at", { withTimezone: true }),
    uncertainRev: integer("uncertain_rev").notNull().default(0),
    uncertainLatestAt: timestamp("uncertain_latest_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    disabledReason: text("disabled_reason"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "slack_thread_status_claim_check",
      sql`(${table.claimToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
    check(
      "slack_thread_status_disabled_check",
      sql`(${table.disabledReason} IS NULL) = (${table.disabledAt} IS NULL)`,
    ),
    index("slack_thread_status_reconciled_idx").on(table.reconciledAt),
  ],
);

// The name of a credential an agent may use, never its value (design 4.4,
// D11). A row is revoked, not deleted, so a later session start sees the
// binding is gone while the receipt keeps who bound it.
export const credentialBindings = pgTable(
  "credential_bindings",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    credentialRef: text("credential_ref").notNull(),
    target: text().notNull(),
    // An agent or an agent identity; the identity table comes later (M8),
    // so the target has no foreign key and the store checks it exists.
    targetId: uuid("target_id").notNull(),
    boundBy: uuid("bound_by")
      .notNull()
      .references(() => users.id),
    boundAt: timestamp("bound_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("credential_bindings_live_idx")
      .on(table.target, table.targetId, table.credentialRef)
      .where(sql`${table.revokedAt} IS NULL`),
    index("credential_bindings_ref_idx")
      .on(table.workspaceId, table.credentialRef)
      .where(sql`${table.revokedAt} IS NULL`),
    check(
      "credential_bindings_target_check",
      sql`${table.target} IN (${sql.raw(sqlList(CREDENTIAL_BINDING_TARGETS))})`,
    ),
    check(
      "credential_bindings_ref_check",
      sql`${table.credentialRef} ~ ${sql.raw(`'${CREDENTIAL_REF_PATTERN}'`)}`,
    ),
  ],
);

// Kept equal to the platform port's lists by extension-bundles.integration.test.ts.
export const EXTENSION_BUNDLE_REVIEWS = [
  "pending",
  "approved",
  "rejected",
] as const;
export const EXTENSION_BUNDLE_SOURCES = ["upload", "github"] as const;

// A skill-only extension bundle, registered once per workspace and digest
// (94S-865). `digest` is the sha256 of the validator's canonical file list;
// every other column is bookkeeping, so a review or a label never moves it.
// The files are in the object store at workspaces/<id>/bundles/<digest>.tar.
// Workspace-owned bundles only; an operator-wide bundle is a later ticket.
export const extensionBundles = pgTable(
  "extension_bundles",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text().notNull(),
    digest: text().notNull(),
    label: text().notNull(),
    source: text().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    manifest: jsonb().notNull(),
    review: text().notNull().default("pending"),
    registeredBy: uuid("registered_by")
      .notNull()
      .references(() => users.id),
    registeredAt: timestamp("registered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("extension_bundles_workspace_digest_idx").on(
      table.workspaceId,
      table.digest,
    ),
    check(
      "extension_bundles_digest_check",
      sql`${table.digest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "extension_bundles_name_check",
      sql`${table.name} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`,
    ),
    check(
      "extension_bundles_label_check",
      sql`char_length(${table.label}) BETWEEN 1 AND 200`,
    ),
    check(
      "extension_bundles_source_check",
      sql`${table.source} IN (${sql.raw(sqlList(EXTENSION_BUNDLE_SOURCES))})`,
    ),
    check(
      "extension_bundles_review_check",
      sql`${table.review} IN (${sql.raw(sqlList(EXTENSION_BUNDLE_REVIEWS))})`,
    ),
    check(
      "extension_bundles_review_actor_check",
      sql`(${table.review} = 'pending') = (${table.reviewedBy} IS NULL AND ${table.reviewedAt} IS NULL)`,
    ),
    check("extension_bundles_size_check", sql`${table.sizeBytes} > 0`),
    check(
      "extension_bundles_manifest_check",
      sql`jsonb_typeof(${table.manifest}) = 'object'`,
    ),
  ],
);

// One counter for every variable write and grant write. A deleted and
// re-created variable never repeats a version, so an `If-Match` that was read
// before the delete cannot match the new row by accident.
export const envVariableVersionsSeq = pgSequence("env_variable_versions_seq");

// User variables a workspace (`agent_id` null) or one agent registers. A secret
// keeps its value in `secret_values`, never here; its columns exist so the
// secret path adds no migration.
export const envVariables = pgTable(
  "env_variables",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id"),
    name: text().notNull(),
    kind: text().notNull(),
    value: text(),
    engineDelivery: boolean("engine_delivery").notNull().default(false),
    allowAutomation: boolean("allow_automation").notNull().default(false),
    grantAll: boolean("grant_all").notNull().default(false),
    version: bigint({ mode: "number" })
      .notNull()
      .default(sql`nextval('env_variable_versions_seq')`),
    grantVersion: bigint("grant_version", { mode: "number" })
      .notNull()
      .default(sql`nextval('env_variable_versions_seq')`),
    /** No foreign key: the row outlives the account. */
    updatedBy: uuid("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "env_variables_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    // The grant rows' composite key: a grant cannot name a variable of
    // another workspace.
    unique("env_variables_workspace_id_uniq").on(table.workspaceId, table.id),
    uniqueIndex("env_variables_workspace_name_uniq")
      .on(table.workspaceId, table.name)
      .where(sql`${table.agentId} IS NULL`),
    uniqueIndex("env_variables_agent_name_uniq")
      .on(table.workspaceId, table.agentId, table.name)
      .where(sql`${table.agentId} IS NOT NULL`),
    check(
      "env_variables_name_check",
      sql`${table.name} ~ ${sql.raw(`'${ENV_VARIABLE_NAME_PATTERN}'`)}`,
    ),
    check(
      "env_variables_kind_check",
      sql`${table.kind} IN (${sql.raw(sqlList(ENV_VARIABLE_KIND_VALUES))})`,
    ),
    // A plain value lives here; a secret's never does.
    check(
      "env_variables_value_check",
      sql`(${table.kind} = 'plain') = (${table.value} IS NOT NULL) AND (${table.value} IS NULL OR octet_length(${table.value}) <= ${sql.raw(String(ENV_VARIABLE_VALUE_MAX_BYTES))})`,
    ),
    check(
      "env_variables_engine_delivery_check",
      sql`NOT ${table.engineDelivery} OR ${table.kind} = 'secret'`,
    ),
    check(
      "env_variables_allow_automation_check",
      sql`NOT ${table.allowAutomation} OR (${table.kind} = 'secret' AND ${table.agentId} IS NOT NULL)`,
    ),
    check(
      "env_variables_grant_all_check",
      sql`NOT ${table.grantAll} OR (${table.kind} = 'plain' AND ${table.agentId} IS NULL)`,
    ),
  ],
);

// The agents a workspace-level variable is granted to. Without a row (and
// without `grant_all`) no agent receives the value.
export const envVariableGrants = pgTable(
  "env_variable_grants",
  {
    workspaceId: uuid("workspace_id").notNull(),
    variableId: uuid("variable_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** Secrets only: the agent's unattended sessions may receive the value. */
    allowAutomation: boolean("allow_automation").notNull().default(false),
    /** No foreign key: the row outlives the account. */
    grantedBy: uuid("granted_by"),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.variableId, table.agentId] }),
    foreignKey({
      name: "env_variable_grants_variable_fk",
      columns: [table.workspaceId, table.variableId],
      foreignColumns: [envVariables.workspaceId, envVariables.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "env_variable_grants_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
  ],
);

export const extensionAttachments = pgTable(
  "extension_attachments",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    scope: text().notNull(),
    agentId: uuid("agent_id"),
    bundleId: uuid("bundle_id")
      .notNull()
      .references(() => extensionBundles.id),
    name: text().notNull(),
    mode: text().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "extension_attachments_agent_fk",
      columns: [table.workspaceId, table.agentId],
      foreignColumns: [agents.workspaceId, agents.id],
    }),
    uniqueIndex("extension_attachments_workspace_name_idx")
      .on(table.workspaceId, table.name)
      .where(sql`${table.scope} = 'workspace'`),
    uniqueIndex("extension_attachments_agent_name_idx")
      .on(table.agentId, table.name)
      .where(sql`${table.scope} = 'agent'`),
    check(
      "extension_attachments_scope_check",
      sql`${table.scope} IN ('workspace', 'agent') AND (${table.scope} = 'agent') = (${table.agentId} IS NOT NULL)`,
    ),
    check(
      "extension_attachments_mode_check",
      sql`${table.mode} IN ('required', 'optional', 'forbidden')`,
    ),
    check(
      "extension_attachments_name_check",
      sql`${table.name} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`,
    ),
  ],
);

export const agentActivationEvents = pgTable(
  "agent_activation_events",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    agentId: uuid("agent_id")
      .notNull()
      .references((): AnyPgColumn => agents.id),
    kind: text().notNull(),
    releaseId: text("release_id")
      .notNull()
      .references(() => agentReleases.id),
    previousReleaseId: text("previous_release_id").references(
      () => agentReleases.id,
    ),
    activationRevision: integer("activation_revision"),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    actor: jsonb(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("agent_activation_events_agent_idx").on(
      table.agentId,
      table.createdAt,
    ),
    check(
      "agent_activation_events_kind_check",
      sql`${table.kind} IN (${sql.raw(sqlList(AGENT_ACTIVATION_EVENT_KINDS))})`,
    ),
    check(
      "agent_activation_events_revision_check",
      sql`(${table.kind} = 'activated') = (${table.activationRevision} IS NOT NULL)`,
    ),
  ],
);

// A version of a workspace profile (94S-1001): an operator profile narrowed
// in the console. A row never changes but for its retirement; a change is
// the next version, under a new id.
export const workspaceProfiles = pgTable(
  "workspace_profiles",
  {
    id: text().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text().notNull(),
    version: integer().notNull(),
    baseProfileId: text("base_profile_id").notNull(),
    baseFingerprint: text("base_fingerprint").notNull(),
    baseRuntimeVersion: text("base_runtime_version").notNull(),
    baseBilling: text("base_billing").notNull(),
    baseRepositoryMode: text("base_repository_mode").notNull(),
    model: text().notNull(),
    models: jsonb().$type<string[]>().notNull(),
    tools: jsonb().$type<string[]>().notNull(),
    // Like the ceiling's: outside the base fingerprint and the digests.
    deny: jsonb().$type<string[]>(),
    toolCatalogId: text("tool_catalog_id"),
    permissionMode: text("permission_mode").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredBy: uuid("retired_by").references(() => users.id),
  },
  (table) => [
    unique("workspace_profiles_version_key").on(
      table.workspaceId,
      table.name,
      table.version,
    ),
    check("workspace_profiles_id_check", sql`${table.id} LIKE 'ws\\_%'`),
    check("workspace_profiles_version_check", sql`${table.version} >= 1`),
    check(
      "workspace_profiles_permission_mode_check",
      sql`${table.permissionMode} IN (${sql.raw(sqlList(PERMISSION_MODE_VALUES))})`,
    ),
    check(
      "workspace_profiles_base_billing_check",
      sql`${table.baseBilling} IN ('metered', 'none')`,
    ),
    check(
      "workspace_profiles_base_repository_mode_check",
      sql`${table.baseRepositoryMode} IN ('required', 'optional', 'none')`,
    ),
    check(
      "workspace_profiles_retired_check",
      sql`(${table.retiredAt} IS NULL) = (${table.retiredBy} IS NULL)`,
    ),
    check(
      "workspace_profiles_deny_check",
      sql`${table.deny} IS NULL OR (jsonb_typeof(${table.deny}) = 'array' AND ${table.toolCatalogId} IS NOT NULL)`,
    ),
  ],
);

// docs/contributing/decisions/achievement-rules.md §3: what a workspace counts
// as an achievement. Categories group rules; a type is what a rule counts.
export const achievementCategories = pgTable(
  "achievement_categories",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text().notNull(),
    position: integer().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: uuid("archived_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("achievement_categories_live_name_uniq")
      .on(table.workspaceId, table.name)
      .where(sql`${table.archivedAt} IS NULL`),
    check(
      "achievement_categories_name_check",
      sql`char_length(${table.name}) BETWEEN 1 AND 32`,
    ),
    check("achievement_categories_position_check", sql`${table.position} >= 0`),
    check(
      "achievement_categories_archived_check",
      sql`(${table.archivedAt} IS NULL) = (${table.archivedBy} IS NULL)`,
    ),
  ],
);

export const achievementTypes = pgTable(
  "achievement_types",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    key: text().notNull(),
    name: text().notNull(),
    evidenceKind: text("evidence_kind").notNull(),
    builtin: boolean().notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: uuid("archived_by").references(() => users.id),
  },
  (table) => [
    unique("achievement_types_key_uniq").on(table.workspaceId, table.key),
    check(
      "achievement_types_key_check",
      sql`${table.key} ~ '^[a-z][a-z0-9_]{1,40}$'`,
    ),
    check(
      "achievement_types_name_check",
      sql`char_length(${table.name}) BETWEEN 1 AND 40`,
    ),
    check(
      "achievement_types_evidence_kind_check",
      sql`${table.evidenceKind} IN (${sql.raw(sqlList(ACHIEVEMENT_EVIDENCE_KIND_VALUES))})`,
    ),
    // Built-in types come from the platform, not from a person.
    check(
      "achievement_types_builtin_check",
      sql`${table.builtin} = (${table.createdBy} IS NULL)`,
    ),
    check(
      "achievement_types_archived_check",
      sql`(${table.archivedAt} IS NULL) = (${table.archivedBy} IS NULL) AND (NOT ${table.builtin} OR ${table.archivedAt} IS NULL)`,
    ),
  ],
);

// A row never changes but `superseded_by` and its disable; an edit is the
// family's next version. `superseded_by` has no foreign key: it is set
// before the next version exists, so the old version leaves the type-in-use
// index before the new one enters it.
export const achievementRules = pgTable(
  "achievement_rules",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    familyId: uuid("family_id").notNull(),
    version: integer().notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => achievementCategories.id),
    title: text().notNull(),
    typeId: uuid("type_id")
      .notNull()
      .references(() => achievementTypes.id),
    definition: text().notNull(),
    judge: text().notNull(),
    agentIds: uuid("agent_ids").array(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    supersededBy: uuid("superseded_by"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: uuid("disabled_by").references(() => users.id),
  },
  (table) => [
    unique("achievement_rules_family_version_uniq").on(
      table.familyId,
      table.version,
    ),
    // One rule in use per type, so a type's achievements share one definition.
    uniqueIndex("achievement_rules_type_in_use_uniq")
      .on(table.typeId)
      .where(
        sql`${table.supersededBy} IS NULL AND ${table.disabledAt} IS NULL`,
      ),
    index("achievement_rules_workspace_idx").on(table.workspaceId),
    check("achievement_rules_version_check", sql`${table.version} >= 1`),
    check(
      "achievement_rules_title_check",
      sql`char_length(${table.title}) BETWEEN 1 AND 80`,
    ),
    check(
      "achievement_rules_definition_check",
      sql`char_length(${table.definition}) BETWEEN 1 AND 2000`,
    ),
    check(
      "achievement_rules_judge_check",
      sql`${table.judge} IN (${sql.raw(sqlList(ACHIEVEMENT_RULE_JUDGE_VALUES))})`,
    ),
    check(
      "achievement_rules_disabled_check",
      sql`(${table.disabledAt} IS NULL) = (${table.disabledBy} IS NULL)`,
    ),
  ],
);

// One judgment of a session's evidence against the workspace's rules
// (achievement-rules.md §3, §4). A session has at most one queued; another
// trigger moves its `next_attempt_at`, so the judge picks it once triggers
// have stopped for a while.
export const achievementJudgments = pgTable(
  "achievement_judgments",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: text("owner_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    trigger: text().notNull(),
    status: text().notNull(),
    rules: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    evidenceIds: text("evidence_ids").array().notNull().default(sql`'{}'`),
    inputDigest: text("input_digest"),
    backend: text(),
    connectionId: text("connection_id"),
    calls: integer().notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" })
      .notNull()
      .default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6, mode: "number" })
      .notNull()
      .default(0),
    /** The workspace threshold the luna pairs were asked against. */
    threshold: doublePrecision(),
    errorCode: text("error_code"),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
    }).notNull(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** sha256 of the judgment's egress token; good while the lease holds. */
    tokenHash: bytea("token_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "achievement_judgments_session_fk",
      columns: [table.sessionId, table.ownerId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.ownerId, sessions.workspaceId],
    }),
    uniqueIndex("achievement_judgments_pending_uniq")
      .on(table.sessionId)
      .where(sql`${table.status} IN ('queued', 'deferred')`),
    index("achievement_judgments_pending_due_idx")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} IN ('queued', 'running', 'deferred')`),
    uniqueIndex("achievement_judgments_token_uniq")
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} IS NOT NULL`),
    index("achievement_judgments_session_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    check(
      "achievement_judgments_trigger_check",
      sql`${table.trigger} IN (${sql.raw(sqlList(ACHIEVEMENT_JUDGMENT_TRIGGER_VALUES))})`,
    ),
    check(
      "achievement_judgments_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(ACHIEVEMENT_JUDGMENT_STATUS_VALUES))})`,
    ),
    check(
      "achievement_judgments_backend_check",
      sql`${table.backend} IS NULL OR ${table.backend} IN (${sql.raw(sqlList(ACHIEVEMENT_JUDGE_BACKEND_VALUES))})`,
    ),
    check(
      "achievement_judgments_error_code_check",
      sql`${table.errorCode} IS NULL OR ${table.errorCode} IN (${sql.raw(sqlList(ACHIEVEMENT_JUDGMENT_ERROR_VALUES))})`,
    ),
    check(
      "achievement_judgments_cost_check",
      sql`${table.calls} >= 0 AND ${table.inputTokens} >= 0 AND ${table.costUsd} >= 0 AND ${table.attempts} >= 0`,
    ),
    check(
      "achievement_judgments_threshold_check",
      sql`${table.threshold} IS NULL OR ${table.threshold} BETWEEN 0 AND 1`,
    ),
    check(
      "achievement_judgments_lease_check",
      sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
    ),
  ],
);

// One call a judgment made through the judgment route, as the proxy
// reported it: what the judgment's totals and the workspace's daily spend
// add up, once per exchange however often the report is retried.
export const achievementJudgmentUsage = pgTable(
  "achievement_judgment_usage",
  {
    exchangeId: text("exchange_id").primaryKey(),
    judgmentId: uuid("judgment_id")
      .notNull()
      .references(() => achievementJudgments.id),
    workspaceId: uuid("workspace_id").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    // Rounded up to the micro-dollar, as the judgment's total adds it.
    costUsd: numeric("cost_usd", {
      precision: 14,
      scale: 6,
      mode: "number",
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("achievement_judgment_usage_workspace_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    check(
      "achievement_judgment_usage_amounts_check",
      sql`${table.inputTokens} >= 0 AND ${table.costUsd} >= 0`,
    ),
  ],
);

// What a rule counted. Only the judge writes a row; a person only confirms
// or rejects one, and a row a person decided is never judged again.
export const sessionAchievements = pgTable(
  "session_achievements",
  {
    id: uuid().primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: text("owner_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    agentId: uuid("agent_id"),
    agentReleaseId: text("agent_release_id"),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => achievementRules.id),
    ruleFamilyId: uuid("rule_family_id").notNull(),
    typeId: uuid("type_id")
      .notNull()
      .references(() => achievementTypes.id),
    title: text().notNull(),
    link: text().notNull(),
    evidenceKind: text("evidence_kind").notNull(),
    // A session_outcomes id, or an out/ path; null for the conversation.
    evidenceId: text("evidence_id"),
    payload: jsonb().$type<Record<string, unknown>>(),
    judge: text().notNull(),
    probability: doublePrecision(),
    judgmentId: uuid("judgment_id")
      .notNull()
      .references(() => achievementJudgments.id),
    reviewState: text("review_state").notNull(),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "session_achievements_session_fk",
      columns: [table.sessionId, table.ownerId, table.workspaceId],
      foreignColumns: [sessions.id, sessions.ownerId, sessions.workspaceId],
    }),
    // An out/ path names a file of one session only.
    uniqueIndex("session_achievements_evidence_uniq")
      .on(table.ruleFamilyId, table.sessionId, table.evidenceId)
      .where(
        sql`${table.evidenceId} IS NOT NULL AND ${table.supersededAt} IS NULL`,
      ),
    uniqueIndex("session_achievements_conversation_uniq")
      .on(table.ruleFamilyId, table.sessionId)
      .where(
        sql`${table.evidenceId} IS NULL AND ${table.supersededAt} IS NULL`,
      ),
    index("session_achievements_session_idx").on(table.sessionId),
    check(
      "session_achievements_evidence_kind_check",
      sql`${table.evidenceKind} IN (${sql.raw(sqlList(ACHIEVEMENT_EVIDENCE_KIND_VALUES))})`,
    ),
    check(
      "session_achievements_evidence_id_check",
      sql`(${table.evidenceId} IS NULL) = (${table.evidenceKind} = 'conversation')`,
    ),
    check(
      "session_achievements_judge_check",
      sql`${table.judge} IN (${sql.raw(sqlList(ACHIEVEMENT_RULE_JUDGE_VALUES))})`,
    ),
    check(
      "session_achievements_probability_check",
      sql`(${table.probability} IS NULL) = (${table.judge} = 'always') AND (${table.probability} IS NULL OR ${table.probability} BETWEEN 0 AND 1)`,
    ),
    check(
      "session_achievements_review_state_check",
      sql`${table.reviewState} IN (${sql.raw(sqlList(ACHIEVEMENT_REVIEW_STATE_VALUES))})`,
    ),
    // Evidence an agent wrote counts only once a person confirms it.
    check(
      "session_achievements_auto_check",
      sql`${table.reviewState} <> 'auto' OR ${table.evidenceKind} IN ('github_pull_request', 'github_review')`,
    ),
    check(
      "session_achievements_reviewed_check",
      sql`(${table.reviewedBy} IS NULL) = (${table.reviewedAt} IS NULL)`,
    ),
  ],
);

// The installation's ceilings (docs/contributing/decisions/profile-db.md §1).
// A row never changes but `retired_at`/`retired_by`; `definition` is the
// profile entry as `catalogProfileConfigSchema` parses it, credential
// references only.
export const installationProfiles = pgTable(
  "installation_profiles",
  {
    id: text().primaryKey(),
    name: text(),
    version: integer().notNull(),
    origin: text().notNull(),
    definition: jsonb().$type<Record<string, unknown>>().notNull(),
    permissionMode: text("permission_mode").notNull(),
    fingerprint: text().notNull(),
    repositoryIds: jsonb("repository_ids").$type<string[]>(),
    // Beside repository_ids and, like it, outside the fingerprint.
    // Null on a row that says nothing about repositories (the workspace's
    // ceiling judges them); the default stays for images from before.
    githubAppRepositories: text("github_app_repositories").default("listed"),
    // Stored, so every image reads a row alike: `profile` judges repositories
    // by the columns above, `workspace` by the workspace's repository ceiling.
    // Null: the row names no repository at all.
    repositoryScope: text("repository_scope").default("profile"),
    /** The version this one narrows; a block on it stops this one too. */
    derivedFrom: text("derived_from"),
    /** Set on a version a workspace's admin made; null is installation-wide. */
    workspaceId: uuid("workspace_id").references(() => workspaces.id),
    /** What the author named it; `name` is then the server's lineage key. */
    displayName: text("display_name"),
    /** The workspace profile id this version was copied from. */
    migratedFrom: text("migrated_from"),
    // The built-in tools blocked, as named in the tool catalog
    // `tool_catalog_id`. Outside `definition` and the fingerprint: an
    // image from before reads the definition strictly, and the digests
    // follow `tools`. Null on a row made from an allow list.
    deny: jsonb().$type<string[]>(),
    toolCatalogId: text("tool_catalog_id"),
    previousId: text("previous_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredBy: uuid("retired_by").references(() => users.id),
    blockedAt: timestamp("blocked_at", { withTimezone: true }),
    blockedBy: uuid("blocked_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("installation_profiles_console_version_key")
      .on(table.name, table.version)
      .where(sql`${table.origin} = 'console'`),
    check("installation_profiles_id_check", sql`${table.id} NOT LIKE 'ws\\_%'`),
    check(
      "installation_profiles_origin_check",
      sql`${table.origin} IN ('catalog', 'console')`,
    ),
    check(
      "installation_profiles_repository_scope_check",
      sql`${table.repositoryScope} IN (${sql.raw(sqlList(REPOSITORY_SCOPE_VALUES))})`,
    ),
    check(
      "installation_profiles_name_check",
      sql`(${table.origin} = 'catalog') = (${table.name} IS NULL)`,
    ),
    check("installation_profiles_version_check", sql`${table.version} >= 1`),
    check(
      "installation_profiles_permission_mode_check",
      sql`${table.permissionMode} IN (${sql.raw(sqlList(PERMISSION_MODE_VALUES))})`,
    ),
    check(
      "installation_profiles_definition_mode_check",
      sql`${table.permissionMode} = ${table.definition}->>'permission_mode'`,
    ),
    check(
      "installation_profiles_retired_check",
      sql`(${table.retiredAt} IS NULL) = (${table.retiredBy} IS NULL)`,
    ),
    check(
      "installation_profiles_blocked_check",
      sql`(${table.blockedAt} IS NULL) = (${table.blockedBy} IS NULL)`,
    ),
    check(
      "installation_profiles_repository_ids_check",
      sql`${table.repositoryIds} IS NOT NULL OR ${table.origin} = 'catalog' OR ${table.repositoryScope} IS NULL`,
    ),
    check(
      "installation_profiles_github_app_repositories_check",
      sql`${table.githubAppRepositories} IN ('listed', 'installed')`,
    ),
    check(
      "installation_profiles_deny_check",
      sql`${table.deny} IS NULL OR (jsonb_typeof(${table.deny}) = 'array' AND ${table.toolCatalogId} IS NOT NULL)`,
    ),
    foreignKey({
      name: "installation_profiles_derived_from_fk",
      columns: [table.derivedFrom],
      foreignColumns: [table.id],
    }),
    uniqueIndex("installation_profiles_migrated_from_key")
      .on(table.migratedFrom)
      .where(sql`${table.migratedFrom} IS NOT NULL`),
    // One lineage of a workspace's profiles: a name and its versions.
    uniqueIndex("installation_profiles_workspace_lineage_key")
      .on(table.workspaceId, table.displayName, table.version)
      .where(sql`${table.workspaceId} IS NOT NULL`),
  ],
);

export const PROFILE_ROLLOUT_KIND_VALUES = [
  "profile_update",
  "tool_unlock",
] as const;
export const PROFILE_ROLLOUT_ITEM_STATUS_VALUES = [
  "pending",
  "applied",
  "superseded",
  "failed",
] as const;

// A profile version's change to the agents that follow it, written with the
// version (an outbox). Nothing writes either table yet.
export const profileRollouts = pgTable(
  "profile_rollouts",
  {
    id: uuid().primaryKey(),
    kind: text().notNull(),
    targetProfileId: text("target_profile_id")
      .notNull()
      .references(() => installationProfiles.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("profile_rollouts_target_kind_key").on(
      table.targetProfileId,
      table.kind,
    ),
    check(
      "profile_rollouts_kind_check",
      sql`${table.kind} IN (${sql.raw(sqlList(PROFILE_ROLLOUT_KIND_VALUES))})`,
    ),
  ],
);

// One agent's turn in a rollout; `generation` is the agent's
// activation_revision when the item was put in.
export const profileRolloutItems = pgTable(
  "profile_rollout_items",
  {
    rolloutId: uuid("rollout_id")
      .notNull()
      .references(() => profileRollouts.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    generation: integer().notNull(),
    status: text().notNull().default("pending"),
    reasonCode: text("reason_code"),
    attempts: integer().notNull().default(0),
    /** A lease: another replica takes the item once it passes. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** Who holds the lease; a result is written only by its holder. */
    lockedBy: text("locked_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "profile_rollout_items_pkey",
      columns: [table.rolloutId, table.agentId, table.generation],
    }),
    index("profile_rollout_items_pending_idx")
      .on(table.lockedUntil)
      .where(sql`${table.status} = 'pending'`),
    index("profile_rollout_items_agent_idx").on(table.agentId),
    check(
      "profile_rollout_items_generation_check",
      sql`${table.generation} >= -1`,
    ),
    check("profile_rollout_items_attempts_check", sql`${table.attempts} >= 0`),
    check(
      "profile_rollout_items_status_check",
      sql`${table.status} IN (${sql.raw(sqlList(PROFILE_ROLLOUT_ITEM_STATUS_VALUES))})`,
    ),
    check(
      "profile_rollout_items_failed_check",
      sql`${table.status} <> 'failed' OR ${table.reasonCode} IS NOT NULL`,
    ),
  ],
);

/** `stored` is a value in `secret_values`; `external` names env or Secrets Manager. */
export type SettingsCredentialSource = "stored" | "external";
export type SettingsOrigin = "import" | "console";
/** `github_app_explicit` names its own App, key and installation. */
export type CatalogRepositoryAuthKind =
  | "github_app"
  | "none"
  | "basic"
  | "bearer"
  | "github_app_explicit";

/**
 * The catalog's repositories. `github_app` rows use the console's GitHub
 * App: seeded or console rows from before, and rows an agent's pick
 * resolved (decision settings-replace-file-catalog.md §1.1). The other
 * kinds hold their own credential (§1). A row is never deleted, so a
 * catalog id never comes back meaning another repository.
 */
export const catalogRepositories = pgTable(
  "catalog_repositories",
  {
    id: text().primaryKey(),
    githubRepositoryId: bigint("github_repository_id", { mode: "number" }),
    // For a kind other than github_app, the URL's last two path segments,
    // or empty: only github_app rows are looked up by name.
    owner: text().notNull(),
    name: text().notNull(),
    url: text().notNull(),
    branch: text().notNull(),
    // A seeded row's yaml `profiles`, kept so its binding hash stays the
    // one sessions claimed under before the move.
    profiles: jsonb().$type<string[]>(),
    authKind: text("auth_kind")
      .$type<CatalogRepositoryAuthKind>()
      .notNull()
      .default("github_app"),
    auth: jsonb().$type<Record<string, unknown>>(),
    credentialSource:
      text("credential_source").$type<SettingsCredentialSource>(),
    appRole: text("app_role").notNull().default("author"),
    source: text().notNull(),
    version: integer().notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by").references(() => users.id),
  },
  (table) => [
    uniqueIndex("catalog_repositories_github_id_key")
      .on(table.githubRepositoryId)
      .where(sql`${table.removedAt} IS NULL`),
    uniqueIndex("catalog_repositories_full_name_key")
      .on(sql`lower(${table.owner})`, sql`lower(${table.name})`)
      .where(
        sql`${table.removedAt} IS NULL AND ${table.authKind} = 'github_app'`,
      ),
    check(
      "catalog_repositories_source_check",
      sql`${table.source} IN ('seed', 'console', 'selection', 'import')`,
    ),
    check(
      "catalog_repositories_app_role_check",
      sql`${table.appRole} = 'author'`,
    ),
    check("catalog_repositories_version_check", sql`${table.version} >= 1`),
    check(
      "catalog_repositories_console_id_check",
      sql`${table.authKind} <> 'github_app' OR ${table.source} = 'seed' OR ${table.githubRepositoryId} IS NOT NULL`,
    ),
    check(
      "catalog_repositories_auth_kind_check",
      sql`${table.authKind} IN ('github_app', 'none', 'basic', 'bearer', 'github_app_explicit')`,
    ),
    check(
      "catalog_repositories_credential_check",
      sql`CASE ${table.authKind}
        WHEN 'github_app' THEN ${table.auth} IS NULL AND ${table.credentialSource} IS NULL
        WHEN 'none' THEN ${table.auth} IS NULL AND ${table.credentialSource} IS NULL
        WHEN 'github_app_explicit' THEN ${table.auth} IS NOT NULL AND ${table.credentialSource} = 'external'
        ELSE ${table.auth} IS NOT NULL AND ${table.credentialSource} IN ('stored', 'external')
      END`,
    ),
  ],
);

/**
 * LLM provider connections a ceiling runs against (decision
 * settings-replace-file-catalog.md §1). A row never changes what it points
 * at: another endpoint, kind, billing or credential source is a new id.
 * Disabling is the only way to stop one.
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    id: text().primaryKey(),
    definition: jsonb().$type<Record<string, unknown>>().notNull(),
    credentialSource: text("credential_source")
      .$type<SettingsCredentialSource>()
      .notNull(),
    origin: text().$type<SettingsOrigin>().notNull(),
    /**
     * The `auth` this row had while its credential came from the
     * deployment (an env or Secrets Manager reference, never a value),
     * set once when the console moves it to a stored value. Ceilings made
     * over the old definition keep matching this row.
     */
    replacesAuth: jsonb("replaces_auth").$type<Record<string, unknown>>(),
    /**
     * The models an agent may name on this connection, and their families
     * for a retired model's successor. Beside `definition`, never in it: the
     * profile fingerprint hashes the whole provider object, and this list
     * changes over a connection's life where the definition does not.
     */
    models: jsonb().$type<string[]>().notNull().default([]),
    modelFamilies: jsonb("model_families").$type<Record<string, unknown>>(),
    /** Whether the engine's auto mode classifier works over this connection. */
    autoMode: text("auto_mode")
      .$type<"supported" | "unsupported" | "unknown">()
      .notNull()
      .default("unknown"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: uuid("disabled_by").references(() => users.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "provider_connections_auto_mode_check",
      sql`${table.autoMode} IN ('supported', 'unsupported', 'unknown')`,
    ),
    check(
      "provider_connections_credential_source_check",
      sql`${table.credentialSource} IN ('stored', 'external')`,
    ),
    check(
      "provider_connections_origin_check",
      sql`${table.origin} IN ('import', 'console')`,
    ),
    // The console never binds the deployment's credential reference to an
    // endpoint (decision §2): only the operator's import brings `external`.
    check(
      "provider_connections_console_stored_check",
      sql`${table.origin} <> 'console' OR ${table.credentialSource} = 'stored'`,
    ),
  ],
);

/**
 * Remote MCP servers an agent card may name (§1). `url`, `credential_ref`
 * and the credential go into a session's MCP binding or its route, so they
 * never change; only the workspaces allowed to use one may.
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: text().primaryKey(),
    url: text().notNull(),
    credentialRef: text("credential_ref").notNull(),
    auth: jsonb().$type<Record<string, unknown>>().notNull(),
    credentialSource: text("credential_source")
      .$type<SettingsCredentialSource>()
      .notNull(),
    // By slug, as the catalog matches them: an import may run before the
    // workspace exists, and a slug never changes.
    workspaces: jsonb().$type<string[]>().notNull(),
    origin: text().$type<SettingsOrigin>().notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: uuid("disabled_by").references(() => users.id),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "mcp_servers_credential_source_check",
      sql`${table.credentialSource} IN ('stored', 'external')`,
    ),
    check(
      "mcp_servers_origin_check",
      sql`${table.origin} IN ('import', 'console')`,
    ),
    check(
      "mcp_servers_console_stored_check",
      sql`${table.origin} <> 'console' OR ${table.credentialSource} = 'stored'`,
    ),
    check("mcp_servers_github_reserved_check", sql`${table.id} <> 'github'`),
  ],
);

/**
 * One row whose `generation` rises with every write to the installation's
 * settings (a trigger on each settings table). A replica that read an older
 * generation than a claim sees may not know a row the session was made
 * with, so it leaves the session for a newer read instead of failing it.
 */
export const settingsGeneration = pgTable(
  "settings_generation",
  {
    id: integer().primaryKey().default(1),
    generation: bigint({ mode: "number" }).notNull().default(0),
  },
  (table) => [check("settings_generation_single_check", sql`${table.id} = 1`)],
);

// One row once the one-time profile fill has run for real. The sweep holds
// back while neither this row nor any rollout exists, so an install that
// deploys the writer before the fill is not rolled out over the fill's head.
export const profileFill = pgTable(
  "profile_fill",
  {
    id: integer().primaryKey().default(1),
    completedAt: timestamp("completed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("profile_fill_single_check", sql`${table.id} = 1`)],
);

// The commit attribution each claim of a session asked for (author, the
// starter's co-author, the Agent-Session value), one row per distinct bundle.
// A push passes a commit that matches any bundle of its session, so a GitHub
// link or authoring App that changed mid-session does not fail the commits
// made before. Only added to; no code before this table reads it.
export const sessionCommitAttributions = pgTable(
  "session_commit_attributions",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    // sha256 of the bundle's canonical JSON; the dedupe key.
    digest: text().notNull(),
    authorName: text("author_name").notNull(),
    authorEmail: text("author_email").notNull(),
    coAuthorName: text("co_author_name"),
    coAuthorEmail: text("co_author_email"),
    agentSession: text("agent_session"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "session_commit_attributions_pk",
      columns: [table.sessionId, table.digest],
    }),
    check(
      "session_commit_attributions_co_author_check",
      sql`(${table.coAuthorName} IS NULL) = (${table.coAuthorEmail} IS NULL)`,
    ),
  ],
);
