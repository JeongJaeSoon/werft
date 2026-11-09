import { z } from "zod";
import {
  agentIdSchema,
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/ids.ts";
import { permissionModeSchema, runtimeKindSchema } from "./session.ts";

const projectSettingsSchema = z.object({ claude_md: z.boolean() }).strict();

/**
 * Whether a session of the profile names a repository: `required` always,
 * `optional` may, `none` never.
 */
export const repositoryModeSchema = z.enum(["required", "optional", "none"]);

/**
 * Which GitHub App repositories an installation ceiling runs against besides
 * its `repository_ids`: `listed` none, `installed` every one the author App's
 * installations reach. Kept beside `repository_ids`, outside the fingerprint.
 */
export const GITHUB_APP_REPOSITORIES_VALUES = ["listed", "installed"] as const;
export const githubAppRepositoriesSchema = z.enum(
  GITHUB_APP_REPOSITORIES_VALUES,
);
export type GitHubAppRepositories = z.infer<typeof githubAppRepositoriesSchema>;

/**
 * The repositories agent sessions and `repository_scope = workspace` profiles
 * may reach, with a profile ceiling's two fields.
 */
export const repositoryCeilingSchema = z
  .object({
    repository_ids: z.array(z.string().min(1).max(128)),
    github_app_repositories: githubAppRepositoriesSchema,
  })
  .strict();
export type RepositoryCeiling = z.infer<typeof repositoryCeilingSchema>;

/** Null, for no value or one a later image wrote: nothing is allowed. */
export function repositoryCeilingOf(stored: unknown): RepositoryCeiling | null {
  const parsed = repositoryCeilingSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/**
 * Where a profile is defined: the operator's installation settings, or a
 * workspace owner or admin in the console, narrowing one operator profile.
 */
export const profileSourceSchema = z.enum(["operator", "workspace"]);

/**
 * Whether a workspace profile takes new releases and sessions. Only
 * `usable` does. `base_changed`: the operator changed the profile it narrows
 * since it was made, so it and the sessions made on it stop until the
 * operator restores the base or someone makes a new version. `base_missing`:
 * the operator removed the base. `retired`: an owner or admin retired it;
 * what already uses it keeps running. `base_retired`: the operator retired
 * its base; it takes nothing new, and what already uses it keeps running.
 * `base_blocked`: the operator blocked its base; it runs nothing.
 */
export const workspaceProfileStateSchema = z.enum([
  "usable",
  "base_changed",
  "base_missing",
  "retired",
  "base_retired",
  "base_blocked",
]);

/**
 * Whether an installation ceiling runs on this replica. Only `usable` takes
 * new releases, sessions and workspace versions; `retired` still runs what
 * already uses it. The rest run nothing: `blocked` (the operator stopped it
 * and everything over it, running sessions included), `connection_missing` (its provider
 * is none of the installation's connections), `unattended_off` (its mode
 * needs PLATFORM_ALLOW_UNATTENDED_PERMISSIONS), `definition_drift` (the row
 * no longer reads as it was written), `runtime_unsupported` (no installed
 * runtime serves its runtime or mode).
 */
export const installationProfileStateSchema = z.enum([
  "usable",
  "retired",
  "blocked",
  "connection_missing",
  "unattended_off",
  "definition_drift",
  "runtime_unsupported",
]);

/**
 * `catalog`: seeded under a plain id (the settings CLI, or the old file
 * catalog). `console`: a named version an operator made, `op_<name>_v<n>`.
 */
export const installationProfileOriginSchema = z.enum(["catalog", "console"]);

export function installationProfileId(name: string, version: number): string {
  return `op_${name}_v${version}`;
}

export const workspaceProfileNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

/**
 * How long a session of the profile waits on a permission or question
 * request, as resolved for new sessions, and where each value came from:
 * the profile, or the installation default where the profile sets none. A
 * session may only shorten them (`permission_wait` at create).
 */
const permissionWaitSourceSchema = z.enum(["profile", "installation"]);
export const permissionWaitSchema = z
  .object({
    park_after_seconds: z.number().int().nonnegative(),
    expire_after_seconds: z.number().int().positive(),
    source: z
      .object({
        park_after_seconds: permissionWaitSourceSchema,
        expire_after_seconds: permissionWaitSourceSchema,
      })
      .strict(),
  })
  .strict();

/**
 * Where a profile version's rollout stands in the caller's workspace: the
 * agents that follow the profile and were to move onto this version, and the
 * agents whose own model a change of the default model does not reach.
 */
export const profileRolloutSchema = z
  .object({
    /** Agents counted: `applied`, `pending` and `failed`. */
    total: z.number().int().min(0),
    applied: z.number().int().min(0),
    pending: z.number().int().min(0),
    failed: z.number().int().min(0),
    /** The agents a person can retry; empty when none failed, and for a caller who is not an owner or admin (`failed` still counts them). */
    failed_agents: z.array(
      z
        .object({
          agent_id: agentIdSchema,
          name: z.string(),
          reason: z.string().min(1).max(128),
        })
        .strict(),
    ),
    /** Agents running this profile on a model of their own, not its default. */
    fixed_model_agents: z.number().int().min(0),
  })
  .strict();

/**
 * GET /v1/profiles: the profiles a session or a release may name, the
 * operator's and this workspace's. Only what a caller picks by; the
 * provider endpoint and credential reference stay with the operator.
 */
export const profileSummarySchema = z
  .object({
    id: z.string().min(1),
    source: profileSourceSchema,
    // The default; `models` lists every model a session may name, it first.
    model: z.string().min(1),
    models: z.array(z.string().min(1)).min(1),
    // Optional so a reader ahead of its server reads a profile without it.
    model_successors: z
      .record(z.string().min(1), z.string().min(1))
      .optional()
      .meta({
        description:
          "Each model the profile dropped that has a successor, with the listed model of the same series a session on it moves to at its next turn. Absent when none does.",
      }),
    tools: z.array(z.string().min(1)),
    // Optional so a reader ahead of its server reads a profile without it;
    // `tools` stays what a session gets.
    deny: z.array(z.string().min(1)).nullable().optional().meta({
      description:
        "The built-in tools of its runtime version's tool catalog that `tools` leaves out: what it blocks. Null when no catalog lists that version.",
    }),
    // Optional so a reader ahead of its server reads a profile without it.
    mcp_deny: z.array(z.string().min(1)).optional().meta({
      description:
        "The `mcp__<server>__<tool>` names it blocks, sorted; absent when it blocks none. A deny request names them in `deny`, beside the built-in tools.",
    }),
    permission_mode: permissionModeSchema,
    runtime_kind: runtimeKindSchema,
    runtime_version: z.string().min(1),
    // `none`: the profile declared `billing: none`, so its sessions run at
    // no recorded cost and with no dollar limit.
    billing: z.enum(["metered", "none"]),
    // Optional so a reader ahead of its server reads a profile that names
    // no repository.
    repository_mode: repositoryModeSchema.optional(),
    // Optional so a reader ahead of its server reads a profile without it.
    repository_ids: z.array(z.string().min(1)).optional().meta({
      description:
        "The catalog repositories that allow this profile, which a session or an agent release of it may name as `repository_id`.",
    }),
    // Optional so a reader ahead of its server reads a profile without it.
    permission_wait: permissionWaitSchema.optional(),
    // Set exactly when `source` is `workspace`.
    workspace: z
      .object({
        name: workspaceProfileNameSchema,
        version: z.number().int().min(1),
        base_profile_id: z.string().min(1),
        state: workspaceProfileStateSchema,
        // Optional so a reader ahead of its server reads a version without them.
        created_by: userIdSchema.nullable().optional(),
        created_at: timestampSchema,
        retired_by: userIdSchema.nullable().optional(),
        retired_at: timestampSchema.nullable(),
      })
      .strict()
      .optional(),
    // Optional so a reader ahead of its server reads a profile without it;
    // set on every `operator` profile a server of this version lists.
    installation: z
      .object({
        // Null for an imported ceiling: its id is its name.
        name: workspaceProfileNameSchema.nullable(),
        version: z.number().int().min(1),
        origin: installationProfileOriginSchema,
        state: installationProfileStateSchema,
        // The connection its provider is; null when it is none of them.
        connection_id: z.string().min(1).nullable(),
        title_model: z.string().min(1).nullable(),
        project_settings: projectSettingsSchema,
        previous_id: z.string().min(1).nullable(),
        // The catalog profile a workspace profile narrows; optional like the
        // fields below, null for a ceiling.
        derived_from: z.string().min(1).nullable().optional(),
        created_by: userIdSchema.nullable(),
        created_at: timestampSchema,
        retired_by: userIdSchema.nullable(),
        retired_at: timestampSchema.nullable(),
        // Optional so a reader ahead of its server reads a ceiling without them.
        blocked_by: userIdSchema.nullable().optional(),
        blocked_at: timestampSchema.nullable().optional(),
        github_app_repositories: githubAppRepositoriesSchema.optional(),
        // Optional so a reader ahead of its server reads a profile without
        // it; absent when this workspace has nothing to show for the version.
        rollout: profileRolloutSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const listProfilesResponseSchema = z
  .object({ items: z.array(profileSummarySchema) })
  .strict();

/** A slug that is not id-safe gives way to the workspace's uuid. */
export function workspaceProfileId(
  workspace: { readonly id: string; readonly slug: string },
  name: string,
  version: number,
): string {
  const prefix = /^[a-z0-9-]+$/.test(workspace.slug)
    ? workspace.slug
    : workspace.id;
  return `ws_${prefix}_${name}_v${version}`;
}

const toolNamesSchema = z.array(z.string().min(1).max(200)).max(64);

/**
 * A version names its built-in tools one way: `tools`, an allow list kept
 * as given, or `deny`, the tools of the runtime's catalog it blocks (`[]`
 * blocks none). `accept_added_tools` opens tools the previous version never
 * weighed, which a deny otherwise keeps blocked.
 */
const toolChoiceFields = {
  tools: toolNamesSchema.exactOptional().meta({
    description:
      "The built-in tools sessions run, kept as given. Exactly one of `tools` and `deny`.",
  }),
  deny: toolNamesSchema.exactOptional().meta({
    description:
      "The built-in tools of the runtime version's tool catalog to block, and `mcp__<server>__<tool>` names of the servers this installation lists (not the built-in `github` server); the server stores the rest of the catalog as `tools`. A derived version names every `mcp__` name its base blocks; a next version keeps those of the one before. `[]` blocks none. Exactly one of `tools` and `deny`; 400 for a runtime version with no catalog.",
  }),
  accept_added_tools: toolNamesSchema.exactOptional().meta({
    description:
      "With `deny`: catalog tools the previous version never weighed that this one may run. Any such tool neither here nor in `deny` is 400.",
  }),
  unblock_mcp_tools: toolNamesSchema.exactOptional().meta({
    description:
      "`mcp__<server>__<tool>` names the previous version blocked that this next version no longer blocks: the only way to lift one, as a version otherwise keeps every `mcp__` name of the one before. Each must be held by the previous version (400 `mcp_unblock_unknown`), not named in `deny` too (400 `mcp_unblock_conflict`) and not blocked by the base (400 `base_mcp_deny_dropped`); a version with no previous one cannot lift any (400 `mcp_unblock_no_previous`). A workspace version names its previous version in `previous_id`.",
  }),
};

function namesOneToolChoice(request: {
  tools?: unknown;
  deny?: unknown;
  accept_added_tools?: unknown;
}): boolean {
  return (
    (request.tools === undefined) !== (request.deny === undefined) &&
    (request.accept_added_tools === undefined || request.deny !== undefined)
  );
}

const ONE_TOOL_CHOICE = {
  message:
    "name exactly one of tools and deny; accept_added_tools goes with deny",
  path: ["deny"],
};

/**
 * POST /v1/workspace-profiles: a new version of the workspace profile
 * `name`, narrowing the operator profile `base_profile_id`. Its id is new
 * (`ws_<workspace slug>_<name>_v<n>`); earlier versions stay as they were.
 */
export const createWorkspaceProfileRequestSchema = z
  .object({
    name: workspaceProfileNameSchema,
    base_profile_id: z.string().min(1).max(200),
    // The default model, one of `models`.
    model: z.string().min(1).max(200),
    models: z.array(z.string().min(1).max(200)).min(1).max(32),
    ...toolChoiceFields,
    permission_mode: permissionModeSchema,
    // The version this one follows, as the form read it. Required with
    // `unblock_mcp_tools`; a latest version that is another one is 409
    // `stale_previous`, so a lifted name is judged against what was seen.
    previous_id: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(namesOneToolChoice, ONE_TOOL_CHOICE);

export const workspaceProfileIdParamsSchema = z
  .object({ profile_id: z.string().min(1).max(200) })
  .strict();

export const workspaceProfileChangeResponseSchema = z
  .object({
    profile: profileSummarySchema,
    /** Null when the profile already was what was asked: nothing was written. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

/**
 * POST /v1/installation-profiles: a new installation ceiling, the next
 * version of `name` (`op_<name>_v<n>`), on the connection `connection_id`;
 * the server copies that connection's provider into it. A new version of an
 * existing name names the latest one as `previous_id`; a first version may
 * name the ceiling it replaces (an imported one, say).
 */
export const createInstallationProfileRequestSchema = z
  .object({
    name: workspaceProfileNameSchema,
    // Owner: required. Admin: the server copies the source's, so sending
    // `connection_id`, `runtime_kind`, `runtime_version` or `title_model` is 400.
    connection_id: z.string().min(1).max(200).optional(),
    runtime_kind: runtimeKindSchema.optional(),
    runtime_version: z.string().min(1).max(200).optional(),
    // The default model, one of `models`.
    model: z.string().min(1).max(200),
    models: z.array(z.string().min(1).max(200)).min(1).max(32),
    title_model: z.string().min(1).max(200).optional(),
    ...toolChoiceFields,
    permission_mode: permissionModeSchema,
    project_settings: projectSettingsSchema.optional(),
    previous_id: z.string().min(1).max(200).optional(),
    // Admin only: the version a new profile narrows. A later version of the
    // same profile keeps the source of the one before.
    derived_from: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(namesOneToolChoice, ONE_TOOL_CHOICE);

export const installationProfileIdParamsSchema = workspaceProfileIdParamsSchema;

export const installationProfileChangeResponseSchema =
  workspaceProfileChangeResponseSchema;

/** POST /v1/installation-profiles/{profile_id}/rollout/retry */
export const retryProfileRolloutRequestSchema = z
  .object({ agent_id: agentIdSchema })
  .strict();

export const retryProfileRolloutResponseSchema = z
  .object({
    /** False: nothing of this agent was in `failed` (already retried, say). */
    retried: z.boolean(),
  })
  .strict();

/**
 * GET /v1/installation-profiles/options: what a new ceiling may name. A
 * connection shows only its id, kind and billing; its endpoint and
 * credential reference stay with the installation.
 */
export const installationProfileOptionsResponseSchema = z
  .object({
    connections: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.enum(["anthropic", "litellm"]),
          billing: z.enum(["metered", "none"]),
        })
        .strict(),
    ),
    runtimes: z.array(
      z
        .object({
          runtime_kind: runtimeKindSchema,
          permission_modes: z.array(permissionModeSchema),
        })
        .strict(),
    ),
    // Optional so a reader ahead of its server reads options without it.
    repositories: z
      .array(z.object({ id: z.string().min(1) }).strict())
      .optional(),
    // Optional so a reader ahead of its server reads options without it.
    tool_catalogs: z
      .array(
        z
          .object({
            id: z.string().min(1),
            runtime_kind: runtimeKindSchema,
            runtime_version: z.string().min(1),
            tools: z.array(
              z
                .object({
                  name: z.string().min(1),
                  boundary: z.enum(["local", "egress", "provider"]),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional()
      .meta({
        description:
          "The built-in tools this installation supports, per runtime version: what a profile's deny may name. A version not listed takes only `tools`.",
      }),
    // Whether PLATFORM_ALLOW_UNATTENDED_PERMISSIONS lets a ceiling run
    // bypassPermissions here.
    unattended_allowed: z.boolean(),
  })
  .strict();

export type RepositoryMode = z.infer<typeof repositoryModeSchema>;
export type ProfileSource = z.infer<typeof profileSourceSchema>;
export type WorkspaceProfileState = z.infer<typeof workspaceProfileStateSchema>;
export type ProfileSummary = z.infer<typeof profileSummarySchema>;
export type ListProfilesResponse = z.infer<typeof listProfilesResponseSchema>;
export type CreateWorkspaceProfileRequest = z.infer<
  typeof createWorkspaceProfileRequestSchema
>;
export type WorkspaceProfileChangeResponse = z.infer<
  typeof workspaceProfileChangeResponseSchema
>;
export type InstallationProfileState = z.infer<
  typeof installationProfileStateSchema
>;
export type CreateInstallationProfileRequest = z.infer<
  typeof createInstallationProfileRequestSchema
>;
export type InstallationProfileOptionsResponse = z.infer<
  typeof installationProfileOptionsResponseSchema
>;
export type ProfileRollout = z.infer<typeof profileRolloutSchema>;
export type RetryProfileRolloutRequest = z.infer<
  typeof retryProfileRolloutRequestSchema
>;
export type RetryProfileRolloutResponse = z.infer<
  typeof retryProfileRolloutResponseSchema
>;
