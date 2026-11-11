import {
  GITHUB_APP_ROLE_VALUES,
  type GitHubAppRole,
  type GitHubOAuth,
  type GitHubSettingsConnection,
  type GitHubSettingsResponse,
  githubPermissionsMissing,
  type PutGitHubOAuthClientSecretRequest,
  type PutGitHubOAuthClientSecretResponse,
  type PutGitHubPullRequestSettingsRequest,
  type PutGitHubPullRequestSettingsResponse,
  type PutGitHubSettingsRequest,
  type PutGitHubUserLinkAppRequest,
  type PutGitHubUserLinkAppResponse,
} from "@werft-ai/contracts";
import { prepareTemplateText } from "../../action/change-request/pull-request-template.ts";
import {
  ACTOR_INACTIVE,
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
  NOT_FOUND,
  OUTRANKED,
  receiptActorOf,
} from "../../musterrolle/index.ts";
import type { PullRequestSettingsStore } from "../../ports/pull-request-settings.ts";
import { requirePermitted, SessionServiceError } from "../../sessions/index.ts";
import {
  type GitHubAppCredential,
  type GitHubAppDirectory,
  type GitHubAppInstallationView,
  type GitHubAppRecord,
  type GitHubAppStore,
  type GitHubInstallationLink,
  type GitHubInstallationSnapshot,
  type GitHubInstallationStore,
  githubUnavailableOf,
} from "../ports/github-app-store.ts";
import type {
  GitHubOAuthStore,
  GitHubSettingsStore,
} from "../ports/github-settings.ts";
import { INSTALLATION_COUNT_MAX } from "./github-repository-service.ts";

const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];

const noAuthorApp = () =>
  new SessionServiceError(
    "GITHUB_LINK_NOT_CONFIGURED",
    "Register the author GitHub App before its client secret",
    undefined,
    { reason_code: "no_author_app" },
  );

/**
 * The workspace's GitHub ceiling (design github-agent.md decision 9): what
 * its agents may turn on. Members read it; an owner or admin signed in to
 * the console changes it. The gate applies it at every token issue, so a
 * lowered ceiling refuses the next one.
 */
export function createGitHubSettingsService(deps: {
  authorization: AuthorizationPolicy;
  store: GitHubSettingsStore;
  pullRequestSettings: Pick<PullRequestSettingsStore, "get" | "put">;
  oauth: GitHubOAuthStore;
  /** Null when the console has no origin to be called back on. */
  callbackUrl: string | null;
  /** False when the API runs without a master key: no secret can be kept. */
  secretsOn: boolean;
  /** Null when the API runs without a master key: no App is registered. */
  apps: GitHubAppStore | null;
  directory: GitHubAppDirectory;
  installations?: GitHubInstallationStore | null;
  newId?: () => string;
  now?: () => Date;
}) {
  const { authorization, store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => new Date());

  async function oauthOf(workspaceId: string): Promise<GitHubOAuth> {
    const status = await deps.oauth.status(workspaceId);
    return {
      connection_id: status.connectionId,
      client_id: status.clientId,
      client_secret_set: status.clientSecretSet,
      callback_url: deps.callbackUrl,
    };
  }

  const repositoryCount = (
    app: GitHubAppCredential,
    installation: GitHubAppInstallationView,
  ): Promise<number | null> =>
    installation.suspendedAt !== null
      ? Promise.resolve(null)
      : deps.directory
          .installationRepositoriesPage(app, installation.id, {
            page: 1,
            perPage: 1,
          })
          .then(
            (page) => page.totalCount,
            () => null,
          );

  async function connectionOf(
    record: GitHubAppRecord & { role: GitHubAppRole },
    credential: GitHubAppCredential,
    manager: boolean,
    links: ReadonlyMap<number, GitHubInstallationLink>,
  ): Promise<GitHubSettingsConnection> {
    const [described, listed] = await Promise.allSettled([
      deps.directory.describe(credential),
      deps.directory
        .installations(credential)
        .then((installations) => ({ installations, readAt: now() })),
    ]);
    const checkedAt = now().toISOString();
    const profile = described.status === "fulfilled" ? described.value : null;
    if (manager && profile !== null && deps.apps !== null) {
      // An owner widens the App on GitHub; a manager's read is how it shows here.
      await deps.apps
        .recordPermissions(
          record.id,
          credential.appId,
          profile.permissions,
          profile.clientId,
        )
        .catch(() => undefined);
    }
    const asked = profile?.permissions ?? record.permissions;
    const rejected = [described, listed].some(
      (settled) =>
        settled.status === "rejected" &&
        githubUnavailableOf(settled.reason) === "github_app_auth_failed",
    );
    const answered = profile !== null || listed.status === "fulfilled";
    const kept = deps.installations;
    let snapshot: GitHubInstallationSnapshot | null = null;
    if (listed.status === "fulfilled") {
      snapshot = listed.value;
      if (kept) {
        await kept
          .recordSnapshot(record.id, credential.appId, snapshot)
          .catch(() => undefined);
      }
    } else if (kept) {
      snapshot = await kept
        .snapshot(record.id, credential.appId)
        .catch(() => null);
    }
    const fresh = listed.status === "fulfilled";
    const installations = [...(snapshot?.installations ?? [])].sort(
      (a, b) => a.account.localeCompare(b.account) || a.id - b.id,
    );
    const counts =
      manager && fresh
        ? await Promise.all(
            installations.map((installation, index) =>
              index < INSTALLATION_COUNT_MAX
                ? repositoryCount(credential, installation)
                : Promise.resolve(null),
            ),
          )
        : [];
    return {
      connection_id: record.id,
      role: record.role,
      name: profile?.name ?? record.name,
      app_id: record.appId,
      html_url: profile?.htmlUrl ?? record.htmlUrl,
      owner: profile?.owner ?? null,
      permissions: asked,
      key_status: answered ? "ok" : rejected ? "rejected" : "unknown",
      installations: installations.map((installation, index) => {
        const approval =
          asked === null || !fresh
            ? "unknown"
            : githubPermissionsMissing(installation.permissions, asked)
                  .length === 0
              ? "approved"
              : "pending";
        const connected = links.get(installation.id);
        return {
          id: installation.id,
          account: installation.account,
          account_type: installation.accountType,
          status: !fresh
            ? "unknown"
            : installation.suspendedAt !== null
              ? "suspended"
              : approval === "pending"
                ? "approval_pending"
                : approval === "unknown"
                  ? "unknown"
                  : "active",
          detail: manager
            ? {
                connection_id: record.id,
                role: record.role,
                account_id: installation.accountId,
                permissions: installation.permissions,
                approval,
                repository_count: counts[index] ?? null,
                repository_selection: installation.repositorySelection,
                html_url: installation.htmlUrl,
                created_at: installation.createdAt?.toISOString() ?? null,
                suspended_at: installation.suspendedAt?.toISOString() ?? null,
                connected:
                  connected === undefined
                    ? null
                    : {
                        by:
                          connected.connectedBy === null
                            ? null
                            : {
                                user_id: connected.connectedBy.userId,
                                display_name: connected.connectedBy.displayName,
                              },
                        at: connected.connectedAt.toISOString(),
                      },
              }
            : null,
        };
      }),
      installations_read_at: snapshot?.readAt.toISOString() ?? null,
      check:
        listed.status === "fulfilled"
          ? { state: "ok", checked_at: checkedAt }
          : {
              state: "failed",
              reason_code: githubUnavailableOf(listed.reason),
              checked_at: checkedAt,
            },
    };
  }

  async function connectionsOf(
    workspaceId: string,
    manager: boolean,
  ): Promise<GitHubSettingsConnection[]> {
    const apps = deps.apps;
    if (apps === null) return [];
    const kept = deps.installations;
    const [records, credentials, links] = await Promise.all([
      apps.list(workspaceId),
      Promise.all(
        GITHUB_APP_ROLE_VALUES.map((role) =>
          apps.credentials(role, workspaceId),
        ),
      ),
      manager && kept
        ? kept.links(workspaceId).catch(() => [])
        : Promise.resolve([]),
    ]);
    const linksOf = (connectionId: string) =>
      new Map(
        links
          .filter((link) => link.connectionId === connectionId)
          .map((link) => [link.installationId, link]),
      );
    const keyOf = new Map(credentials.flat().map((held) => [held.id, held]));
    return await Promise.all(
      records.flatMap((record) => {
        // Deleted or replaced (same row, another App) between the two reads.
        const credential = keyOf.get(record.id);
        return credential === undefined || credential.appId !== record.appId
          ? []
          : [connectionOf(record, credential, manager, linksOf(record.id))];
      }),
    );
  }

  async function manages(caller: Caller, workspaceId: string) {
    const decision = await authorization
      .authorize(
        {
          subject: caller.subject,
          action: "workspace.manage",
          resource: {
            kind: "workspace",
            id: workspaceId,
            owner_scope: caller.ownerId,
          },
          request_id: caller.requestId,
        },
        { record: false },
      )
      .catch(() => null);
    return decision?.outcome === "allow";
  }

  async function read(
    workspaceId: string,
    manager: boolean,
  ): Promise<GitHubSettingsResponse> {
    const [settings, pullRequest, agentsUsing, apps, oauth, connections] =
      await Promise.all([
        store.get(workspaceId),
        deps.pullRequestSettings.get(workspaceId),
        store.agentsUsing(workspaceId),
        store.appPermissions(workspaceId),
        oauthOf(workspaceId),
        connectionsOf(workspaceId, manager),
      ]);
    return {
      ...settings,
      pull_request: pullRequest.settings,
      pull_request_revision: pullRequest.revision,
      agents_using: agentsUsing,
      oauth,
      connections,
      apps,
    };
  }

  async function requireConsoleManager(
    caller: Caller,
    workspaceId: string,
    what: string,
  ) {
    if (workspaceId !== caller.ownerId) throw NOT_FOUND();
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: workspaceId,
    });
    const principal = caller.subject.principal;
    if (caller.subject.surface.kind !== "web" || principal?.kind !== "user") {
      throw new SessionServiceError(
        "FORBIDDEN",
        `${what} is set from a signed-in console session, not with an API key`,
        undefined,
        { reason_code: "web_session_required" },
      );
    }
    return principal;
  }

  return {
    async get(
      caller: Caller,
      workspaceId: string,
    ): Promise<GitHubSettingsResponse> {
      if (workspaceId !== caller.ownerId) throw NOT_FOUND();
      // Any member reads it; the policy has no read action for a workspace.
      if (caller.subject.principal?.kind !== "user") {
        throw new SessionServiceError(
          "FORBIDDEN",
          "The GitHub settings are read by a workspace member",
        );
      }
      return await read(workspaceId, await manages(caller, workspaceId));
    },

    async put(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<PutGitHubSettingsRequest>,
    ): Promise<GitHubSettingsResponse> {
      const principal = await requireConsoleManager(
        caller,
        workspaceId,
        "The GitHub ceiling",
      );
      const body = await readBody();
      const actor = receiptActorOf(caller);
      if (actor === null) throw ACTOR_INACTIVE();
      const result = await store.putCeiling({
        workspaceId,
        ceiling: body.ceiling,
        revision: body.revision,
        updatedBy: principal.id,
        actor,
      });
      switch (result.outcome) {
        case "stored":
          return await read(workspaceId, true);
        case "revision_conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "The GitHub settings changed since they were read",
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        default:
          throw NOT_FOUND();
      }
    },

    async putPullRequest(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<PutGitHubPullRequestSettingsRequest>,
    ): Promise<PutGitHubPullRequestSettingsResponse> {
      const principal = await requireConsoleManager(
        caller,
        workspaceId,
        "The pull request settings",
      );
      const body = await readBody();
      const template = body.pull_request.default_template;
      if (template !== null) {
        const prepared = prepareTemplateText(template);
        if (!prepared.ok) {
          throw new SessionServiceError(
            "BAD_REQUEST",
            "The pull request template cannot be used",
            undefined,
            { reason_code: `template_${prepared.reason}` },
          );
        }
      }
      const actor = receiptActorOf(caller);
      if (actor === null) throw ACTOR_INACTIVE();
      const result = await deps.pullRequestSettings.put({
        workspaceId,
        settings: body.pull_request,
        revision: body.revision,
        updatedBy: principal.id,
        actor,
      });
      switch (result.outcome) {
        case "stored":
          return {
            pull_request: result.settings,
            pull_request_revision: result.revision,
            receipt_id: result.receiptId,
          };
        case "revision_conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "The pull request settings changed since they were read",
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
      }
    },

    /**
     * The author App's client secret for linking people's accounts. Sealed
     * like the App's key and never answered back, not even in part: the
     * receipt keeps its last four characters, as for every secret.
     */
    async putOAuthClientSecret(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<PutGitHubOAuthClientSecretRequest>,
    ): Promise<PutGitHubOAuthClientSecretResponse> {
      await requireConsoleManager(
        caller,
        workspaceId,
        "The OAuth client secret",
      );
      if (!deps.secretsOn) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
          undefined,
          { reason_code: "secret_store_off" },
        );
      }
      // Refused before the secret is read; the store checks again under its lock.
      if (!(await deps.oauth.status(workspaceId)).authorApp) {
        throw noAuthorApp();
      }
      const body = await readBody();
      const receiptId = newId();
      const result = await deps.oauth.putClientSecret(
        workspaceId,
        body.client_secret,
        { principal: caller, receiptId, roles: MANAGERS },
        body.client_id,
      );
      switch (result.outcome) {
        case "stored":
          return { receipt_id: receiptId, oauth: await oauthOf(workspaceId) };
        case "no_author_app":
          throw noAuthorApp();
        case "client_changed":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "The author GitHub App changed since its client id was read",
            undefined,
            { reason_code: "github_app_changed" },
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },

    async putUserLinkApp(
      caller: Caller,
      workspaceId: string,
      readBody: () => Promise<PutGitHubUserLinkAppRequest>,
    ): Promise<PutGitHubUserLinkAppResponse> {
      await requireConsoleManager(
        caller,
        workspaceId,
        "The App people link their accounts with",
      );
      if (deps.apps === null) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
          undefined,
          { reason_code: "secret_store_off" },
        );
      }
      const body = await readBody();
      const receiptId = newId();
      const result = await deps.apps.setUserLink(
        workspaceId,
        body.connection_id,
        { principal: caller, receiptId, roles: MANAGERS },
      );
      switch (result.outcome) {
        case "stored":
          return {
            receipt_id: result.changed ? receiptId : null,
            oauth: await oauthOf(workspaceId),
          };
        case "role_mismatch":
          throw new SessionServiceError(
            "BAD_REQUEST",
            "People link their accounts with an author App only",
            undefined,
            { reason_code: "role_mismatch" },
          );
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },
  };
}

export type GitHubSettingsService = ReturnType<
  typeof createGitHubSettingsService
>;
