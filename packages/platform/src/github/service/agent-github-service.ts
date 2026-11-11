import {
  AGENT_GITHUB_ACTIVITY_LIMIT,
  type AgentGitHubActivityResponse,
  type AgentGitHubFeatureUnavailable,
  type AgentGitHubRepositoryUnavailable,
  type AgentGitHubResponse,
  type AgentGitHubSettings,
  catalogIdOfRef,
  GITHUB_FEATURES_NONE,
  type GitHubAppRole,
  type GitHubFeatures,
  githubFeaturesOverCeiling,
  newSessionGitHubPolicy,
  type PutAgentGitHubEnabledResponse,
  type PutAgentGitHubRepositoryAccessRequest,
  type PutAgentGitHubRepositoryAccessResponse,
  type PutAgentGitHubSettingsRequest,
  type PutAgentGitHubSettingsResponse,
  pushAttachedOf,
  type RepositoryCeiling,
  repositoryRefOf,
} from "@werft-ai/contracts";
import { repoRefOf } from "../../action/ports/forge.ts";
import {
  ACTOR_INACTIVE,
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
  NOT_FOUND,
  OUTRANKED,
} from "../../musterrolle/index.ts";
import type { AgentStore } from "../../ports/agent-store.ts";
import {
  GITHUB_API_BASE,
  repositoryInCeiling,
  requirePermitted,
  type SessionCatalog,
  SessionServiceError,
  viewerOf,
} from "../../sessions/index.ts";
import type { AgentGitHubStore } from "../ports/agent-github-store.ts";
import type {
  GitHubAppStore,
  GitHubPinStore,
} from "../ports/github-app-store.ts";
import type { GitHubConnections } from "../ports/github-gate.ts";
import type { GitHubSettingsStore } from "../ports/github-settings.ts";
import {
  createGitHubConnectionResolver,
  type GitHubConnectionResolver,
} from "./github-connection-resolver.ts";
import type { GitHubRepositoryService } from "./github-repository-service.ts";

type Repository = SessionCatalog["repositories"][string];

const FEATURES: readonly (keyof GitHubFeatures)[] = [
  "workflows",
  "actions",
  "checks",
  "issues",
  "review",
];

/** What the first save writes for a workspace with no repository ceiling. */
const DEFAULT_REPOSITORY_CEILING: RepositoryCeiling = {
  repository_ids: [],
  github_app_repositories: "installed",
};

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** `owner/repo` of a clone URL; its path when the URL has no such shape. */
function fullNameOfUrl(url: string): string {
  const repo = repoRefOf(url);
  if (repo !== null) return `${repo.owner}/${repo.name}`;
  try {
    return new URL(url).pathname.replace(/^\/+|\/+$|\.git$/g, "") || url;
  } catch {
    return url;
  }
}

/** Where a PAT works: github.com. Elsewhere a `basic` login is not GitHub's. */
function onGitHub(repository: Repository): boolean {
  if (repository.auth?.kind === "github_app") return true;
  if (repository.auth?.kind !== "basic") return false;
  try {
    return new URL(repository.url).origin === "https://github.com";
  } catch {
    return false;
  }
}

/** A catalog App on a GitHub Enterprise host: the default work only (§3). */
function enterpriseApp(repository: Repository | undefined): boolean {
  const auth = repository?.auth;
  return (
    auth?.kind === "github_app" &&
    "api_base" in auth &&
    auth.api_base !== GITHUB_API_BASE
  );
}

const writes = (level: string | undefined) =>
  level === "write" || level === "admin";

/**
 * The agent's GitHub tab (design github-agent.md §6, §7): the switch that
 * applies at once, the agent's saved settings (the active release's pins
 * while it has none), and what the tab may offer. Whoever manages the agent
 * reads it; the switch is turned and the settings are saved from a signed-in
 * console session.
 */
export function createAgentGitHubService(deps: {
  authorization: AuthorizationPolicy;
  agents: Pick<AgentStore, "get">;
  store: AgentGitHubStore;
  catalog: SessionCatalog;
  githubSettings: Pick<GitHubSettingsStore, "get" | "appPermissions">;
  /** Each repository's connections, asked whether their App is installed. */
  connections?: GitHubConnections;
  resolver?: GitHubConnectionResolver;
  /**
   * GitHub's answer for a repository picked from an installation, with the
   * means to reload the catalog after the write. Absent: only a repository
   * the catalog holds can be turned on.
   */
  selection?: GitHubRepositoryService["selection"];
  /** Absent: permissions come from `githubSettings.appPermissions`. */
  pinned?: {
    apps: Pick<GitHubAppStore, "list">;
    pins: Pick<GitHubPinStore, "list">;
  };
}) {
  const { authorization, catalog, store } = deps;
  const resolver =
    deps.resolver ??
    (deps.connections === undefined
      ? null
      : createGitHubConnectionResolver({
          connections: deps.connections,
          pins: null,
        }));

  // GitHub not answering leaves the badge off rather than failing the tab.
  // One ask per connection and role for all the repositories, not one per
  // repository; a failed ask is not retried repository by repository.
  async function installedBy(
    role: GitHubAppRole,
    repositories: readonly [id: string, url: string][],
  ): Promise<Map<string, boolean | null>> {
    const items = repositories.flatMap(([repositoryId, url]) => {
      const repo = repoRefOf(url);
      return repo === null ? [] : [{ repositoryId, repo }];
    });
    if (resolver === null || items.length === 0) return new Map();
    return resolver.installedMany(role, items).catch(() => new Map());
  }

  /**
   * Per role, the permissions of the connections the scope's repositories
   * use: the pinned one, or the role's only connection where none is pinned
   * yet, as the first token issue will pin it. A repository neither tells is
   * left to the gate. Null with no connection of the role.
   */
  async function scopePermissions(
    workspaceId: string,
    scope: readonly string[],
  ): Promise<Record<
    GitHubAppRole,
    { permissions: (Record<string, string> | null)[] } | null
  > | null> {
    if (deps.pinned === undefined) return null;
    const [apps, pins] = await Promise.all([
      deps.pinned.apps.list(workspaceId),
      deps.pinned.pins.list(),
    ]);
    const of = (role: GitHubAppRole) => {
      const held = apps.filter((app) => app.role === role);
      if (held.length === 0) return null;
      // Every pin of the role is this one, or emptied by a removal.
      if (held.length === 1) {
        return { permissions: held.map((app) => app.permissions) };
      }
      const permissions = scope.flatMap((id) => {
        const pin = pins.find(
          (entry) => entry.repositoryId === id && entry.role === role,
        );
        const app =
          pin === undefined
            ? undefined
            : held.find(
                ({ id: connection }) => connection === pin.connectionId,
              );
        return app === undefined ? [] : [app.permissions];
      });
      return { permissions };
    };
    return { author: of("author"), reviewer: of("reviewer") };
  }

  const entry = (id: string) =>
    Object.hasOwn(catalog.repositories, id)
      ? catalog.repositories[id]
      : undefined;

  const manage = (caller: Caller, agentId: string) =>
    requirePermitted(authorization, caller, "agent.manage", {
      kind: "agent",
      id: agentId,
    });
  const read = (caller: Caller, agentId: string) =>
    requirePermitted(authorization, caller, "agent.settings_read", {
      kind: "agent",
      id: agentId,
    });

  return {
    async get(caller: Caller, agentId: string): Promise<AgentGitHubResponse> {
      await read(caller, agentId);
      const workspaceId = caller.ownerId;
      const [detail, enabled, settings, apps] = await Promise.all([
        deps.agents.get(workspaceId, agentId),
        store.enabled(workspaceId, agentId),
        deps.githubSettings.get(workspaceId),
        deps.githubSettings.appPermissions(workspaceId),
      ]);
      if (detail === null || enabled === null) throw NOT_FOUND();
      const release = detail.active_release;
      const [agentRow, repositoryCeiling] = await Promise.all([
        store.settings(agentId),
        store.repositoryCeiling(workspaceId),
      ]);
      const policy = newSessionGitHubPolicy(
        agentRow,
        release?.policy_pins.github,
      );
      // Settings this image cannot read are shown as none, never guessed.
      const github = policy.settings === "invalid" ? null : policy.settings;

      // Saved settings apply to the agent, not to a release, so only the
      // workspace's ceiling and the catalog judge a repository.
      const onGitHubRepositories = Object.entries(catalog.repositories).filter(
        ([, repository]) => onGitHub(repository),
      );
      const asked = onGitHubRepositories.map(
        ([id, repository]): [string, string] => [id, repository.url],
      );
      const [authorInstalled, reviewerInstalled] = await Promise.all([
        installedBy("author", asked),
        installedBy("reviewer", asked),
      ]);
      const repositories = onGitHubRepositories
        .map(([id, repository]) => {
          const reason: AgentGitHubRepositoryUnavailable | null =
            !repositoryInCeiling(
              catalog,
              // Display only: the first save writes this default.
              repositoryCeiling ?? DEFAULT_REPOSITORY_CEILING,
              id,
            )
              ? "repository_not_allowed"
              : repository.auth?.kind !== "github_app"
                ? "app_required"
                : null;
          const name = fullNameOfUrl(repository.url);
          return {
            id,
            url: repository.url,
            repository: name,
            full_name: name,
            private: null,
            ref: repositoryRefOf(id),
            available: reason === null,
            reason,
            installed: {
              author: authorInstalled.get(id) ?? null,
              reviewer: reviewerInstalled.get(id) ?? null,
            },
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));

      const legacyDefaults: AgentGitHubSettings | null =
        github === null
          ? {
              repositories: [],
              // What a first save starts from (owner decision d123,
              // 2026-11-02). Until then the release still asks a person:
              // only an explicit false turns approval off.
              push_approval: false,
              features: { ...GITHUB_FEATURES_NONE },
              actions_allow: [],
            }
          : null;

      // The gate decides at every token issue; these are what the tab shows
      // before it, from the ceiling and the permissions each App last read.
      const scope = github?.repositories ?? [];
      const enterprise =
        scope.length > 0 && scope.every((id) => enterpriseApp(entry(id)));
      const pinned = await scopePermissions(workspaceId, scope);
      const known = (
        role: GitHubAppRole,
      ): { present: boolean; permissions: Record<string, string>[] } => {
        if (pinned !== null) {
          const held = pinned[role];
          return {
            present: held !== null,
            permissions: (held?.permissions ?? []).filter(
              (entry): entry is Record<string, string> => entry !== null,
            ),
          };
        }
        const app = apps[role];
        return {
          present: app !== null,
          permissions: app?.permissions == null ? [] : [app.permissions],
        };
      };
      const authors = known("author");
      const reviewers = known("reviewer");
      const featureOption = (feature: keyof GitHubFeatures) => {
        const missing =
          feature === "review"
            ? reviewers.permissions.some(
                (permissions) => !writes(permissions.pull_requests),
              )
            : authors.permissions.some(
                (permissions) => !writes(permissions[feature]),
              );
        const reason: AgentGitHubFeatureUnavailable | null = enterprise
          ? "github_host_unsupported"
          : !settings.ceiling[feature]
            ? "over_workspace_ceiling"
            : feature === "review" && !reviewers.present
              ? "no_reviewer_app"
              : missing
                ? "app_permission_missing"
                : null;
        return { available: reason === null, reason };
      };

      // A row the catalog dropped still has its name in the table.
      const dropped = await store.repositoryNames(
        scope.filter((id) => entry(id) === undefined),
      );
      const selected = scope.map((id) => {
        const held = entry(id);
        return {
          id,
          repository:
            held === undefined
              ? (dropped.get(id) ?? null)
              : fullNameOfUrl(held.url),
          private: null,
          ref: repositoryRefOf(id),
        };
      });

      return {
        enabled,
        active_release_id: release?.id ?? null,
        github,
        settings_revision: agentRow?.revision ?? null,
        selected_repositories: selected,
        start_repository_id: agentRow?.startRepositoryId ?? null,
        // No row: what a first save writes. A row: its value, `ask` for one
        // from before the column. A value this image cannot read shows as
        // `deny`, as the gate would treat it.
        push_attached:
          agentRow === null ? "allow" : pushAttachedOf(agentRow.pushAttached),
        legacy_defaults: legacyDefaults,
        options: {
          repositories,
          repository_ceiling_unset: repositoryCeiling === null,
          features: Object.fromEntries(
            FEATURES.map((feature) => [feature, featureOption(feature)]),
          ) as AgentGitHubResponse["options"]["features"],
        },
      };
    },

    async putEnabled(
      caller: Caller,
      agentId: string,
      enabled: boolean,
    ): Promise<PutAgentGitHubEnabledResponse> {
      await manage(caller, agentId);
      if (
        caller.subject.surface.kind !== "web" ||
        caller.subject.principal?.kind !== "user"
      ) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "An agent's GitHub switch is turned from a signed-in console session, not with an API key",
          undefined,
          { reason_code: "web_session_required" },
        );
      }
      const result = await store.setEnabled({
        workspaceId: caller.ownerId,
        agentId,
        enabled,
        principal: caller,
        managerRoles: MANAGEMENT_ROLES["agent.manage"] ?? [],
      });
      switch (result.outcome) {
        case "saved":
          return { enabled, receipt_id: result.receiptId };
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },

    /**
     * Replaces the agent's settings (never makes a release). Only what the
     * save adds is judged against the catalog and the workspace's ceilings,
     * so narrowing is always possible; the invariants between fields hold
     * for the whole request.
     */
    async putSettings(
      caller: Caller,
      agentId: string,
      request: PutAgentGitHubSettingsRequest,
    ): Promise<PutAgentGitHubSettingsResponse> {
      await manage(caller, agentId);
      const userId = caller.actor?.userId;
      if (
        caller.subject.surface.kind !== "web" ||
        caller.subject.principal?.kind !== "user" ||
        !userId
      ) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "An agent's GitHub settings are saved from a signed-in console session, not with an API key",
          undefined,
          { reason_code: "web_session_required" },
        );
      }
      const refused = (field: string, reason: string) =>
        new SessionServiceError(
          "BAD_REQUEST",
          `${field}: ${reason}`,
          undefined,
          {
            field,
            reason_code: reason,
          },
        );
      const settings: AgentGitHubSettings = {
        ...request.settings,
        repositories: [...new Set(request.settings.repositories)],
      };
      if (settings.actions_allow.length > 0 && !settings.features.actions) {
        throw refused("settings.actions_allow", "actions_off");
      }
      const start = request.start_repository_id;
      if (start !== null && !settings.repositories.includes(start)) {
        throw refused("start_repository_id", "start_repository_outside");
      }
      const workspaceId = caller.ownerId;
      const workspace = await deps.githubSettings.get(workspaceId);
      const result = await store.putSettings({
        workspaceId,
        agentId,
        expectedRevision: request.expected_revision,
        settings,
        startRepositoryId: start,
        pushAttached: request.push_attached,
        userId,
        principal: caller,
        managerRoles: MANAGEMENT_ROLES["agent.manage"] ?? [],
        check: (current, repositoryCeiling) => {
          const held = new Set<unknown>(
            Array.isArray(current?.repositories) ? current.repositories : [],
          );
          for (const [index, id] of settings.repositories.entries()) {
            if (held.has(id)) continue;
            const field = `settings.repositories.${index}`;
            if (!repositoryInCeiling(catalog, repositoryCeiling, id)) {
              throw refused(field, "repository_not_allowed");
            }
            if (entry(id)?.auth?.kind !== "github_app") {
              throw refused(field, "app_required");
            }
          }
          const before = current?.features;
          const wasOn = (feature: keyof GitHubFeatures) =>
            typeof before === "object" &&
            before !== null &&
            (before as Record<string, unknown>)[feature] === true;
          const over = githubFeaturesOverCeiling(
            settings.features,
            workspace.ceiling,
          ).find((feature) => !wasOn(feature));
          if (over !== undefined) {
            throw refused(
              `settings.features.${over}`,
              "over_workspace_ceiling",
            );
          }
        },
      });
      switch (result.outcome) {
        case "saved":
          return {
            settings_revision: result.revision,
            receipt_id: result.receiptId,
          };
        case "conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `The GitHub settings are at revision ${result.revision ?? "none"}, not ${request.expected_revision ?? "none"}`,
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },

    /**
     * Turns one repository on or off: one request, one change, never a
     * release. A repository the catalog does not hold yet is added in the same
     * transaction as the settings, the receipts and the App pin, so a refusal
     * or a failure anywhere leaves none of them.
     */
    async putRepositoryAccess(
      caller: Caller,
      agentId: string,
      request: PutAgentGitHubRepositoryAccessRequest,
    ): Promise<PutAgentGitHubRepositoryAccessResponse> {
      await manage(caller, agentId);
      const userId = caller.actor?.userId;
      if (
        caller.subject.surface.kind !== "web" ||
        caller.subject.principal?.kind !== "user" ||
        !userId
      ) {
        throw new SessionServiceError(
          "FORBIDDEN",
          "An agent's GitHub repositories are turned on or off from a signed-in console session, not with an API key",
          undefined,
          { reason_code: "web_session_required" },
        );
      }
      const refuse = (field: string, reason: string) =>
        new SessionServiceError(
          "BAD_REQUEST",
          `${field}: ${reason}`,
          undefined,
          { field, reason_code: reason },
        );
      const named = request.repository;
      let selected: Awaited<
        ReturnType<NonNullable<typeof deps.selection>>
      > | null = null;
      let target: Parameters<typeof store.setRepository>[0]["target"];
      if ("ref" in named) {
        const id = catalogIdOfRef(named.ref);
        if (id === null) throw refuse("repository.ref", "invalid_ref");
        target = { kind: "catalog", id };
      } else {
        if (deps.selection === undefined) {
          throw refuse("repository", "no_author_app");
        }
        selected = await deps.selection(caller, agentId, named);
        const { repository, app } = selected;
        target = {
          kind: "github",
          resolve: {
            base: selected.base,
            githubRepositoryId: repository.id,
            owner: repository.owner,
            name: repository.name,
            url: selected.url,
            branch: repository.defaultBranch,
            receiptId: selected.newId(),
          },
          pin: selected.pinning
            ? {
                connectionId: app.id,
                appId: app.appId,
                receiptId: selected.newId(),
              }
            : null,
        };
      }
      const result = await store.setRepository({
        workspaceId: caller.ownerId,
        agentId,
        enabled: request.enabled,
        expectedRevision: request.expected_revision,
        target,
        userId,
        principal: caller,
        managerRoles: MANAGEMENT_ROLES["agent.manage"] ?? [],
        check: (repository, ceiling) => {
          // A repository from an installation is picked only where the
          // ceiling runs on the App's repositories, as `pick` does.
          const installed = ceiling.github_app_repositories === "installed";
          if (repository.via === "github" && !installed) {
            throw refuse("repository", "repository_not_allowed");
          }
          if (
            !ceiling.repository_ids.includes(repository.id) &&
            !(
              installed &&
              (repository.authKind === "github_app" ||
                repository.authKind === "github_app_explicit")
            )
          ) {
            throw refuse("repository", "repository_not_allowed");
          }
          if (
            repository.authKind !== "github_app" &&
            repository.authKind !== "github_app_explicit"
          ) {
            throw refuse("repository", "app_required");
          }
        },
      });
      switch (result.outcome) {
        case "saved":
          if (result.catalogChanged) await selected?.reload();
          return {
            settings_revision: result.revision,
            receipt_id: result.receiptId,
            enabled: request.enabled,
            repository: {
              ref: repositoryRefOf(result.repository.id),
              repository: result.repository.label,
              private: null,
            },
          };
        case "conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            `The GitHub settings are at revision ${result.revision ?? "none"}, not ${request.expected_revision ?? "none"}`,
            undefined,
            { revision: result.revision },
          );
        case "seed_unavailable":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "The agent has no saved GitHub settings and no active release to start them from",
            undefined,
            { reason_code: "settings_seed_unavailable" },
          );
        case "app_gone":
          throw refuse("repository", "no_author_app");
        case "name_held":
          throw refuse("repository", "name_held");
        case "repository_not_found":
          throw refuse("repository", "repository_not_found");
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },

    async activity(
      caller: Caller,
      agentId: string,
    ): Promise<AgentGitHubActivityResponse> {
      await read(caller, agentId);
      if ((await store.enabled(caller.ownerId, agentId)) === null) {
        throw NOT_FOUND();
      }
      const receipts = await store.activity(
        caller.ownerId,
        agentId,
        viewerOf(caller),
        AGENT_GITHUB_ACTIVITY_LIMIT,
      );
      // New receipts carry `owner/repo`; the older ones only a catalog id,
      // read as the repository's name now.
      const named = (receipt: (typeof receipts)[number]) => {
        const result = receipt.result;
        if (result === null || typeof result !== "object") return null;
        const held = result as Record<string, unknown>;
        return {
          repository: nonEmpty(held.repository) ?? nonEmpty(held.full_name),
          id: nonEmpty(held.repository_id),
        };
      };
      const names = await store.repositoryNames([
        ...new Set(
          receipts.flatMap((receipt) => {
            const found = named(receipt);
            return found?.repository == null && found?.id != null
              ? [found.id]
              : [];
          }),
        ),
      ]);
      return {
        items: receipts,
        receipt_repositories: receipts.flatMap((receipt) => {
          const found = named(receipt);
          const repository =
            found?.repository ??
            (found?.id == null ? null : (names.get(found.id) ?? null));
          return repository === null
            ? []
            : [{ receipt_id: receipt.id, repository }];
        }),
      };
    },
  };
}

export type AgentGitHubService = ReturnType<typeof createAgentGitHubService>;
