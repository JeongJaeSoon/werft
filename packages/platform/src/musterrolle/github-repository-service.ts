import { randomUUID } from "node:crypto";
import {
  type AgentGitHubRepositoryChoice,
  type AgentInstalledGitHubRepository,
  type CatalogGitHubRepository,
  type GetGitHubRepositoryAppPinsResponse,
  GITHUB_APP_ROLE_VALUES,
  type GitHubAppRole,
  type GitHubRepositoryPageQuery,
  type GitHubRepositoryPins,
  type GitHubRepositoryWriteResponse,
  type InstalledGitHubRepository,
  type ListAgentGitHubRepositoriesResponse,
  type ListGitHubRepositoriesResponse,
  type PatchGitHubRepositoryRequest,
  type PickAgentGitHubRepositoryRequest,
  type PickAgentGitHubRepositoryResponse,
  type PutGitHubRepositoryAppPinRequest,
  type PutGitHubRepositoryAppPinResponse,
  type RepositoryCeiling,
  repositoryRefOf,
} from "@werft-ai/contracts";
import type { AgentStore } from "../ports/agent-store.ts";
import type {
  CatalogRepositoryRow,
  CatalogRepositoryStore,
} from "../ports/catalog-repository-store.ts";
import {
  GitHubAppCheckError,
  type GitHubAppCredential,
  type GitHubAppDirectory,
  type GitHubAppInstallationView,
  type GitHubAppStore,
  type GitHubInstallationRepository,
  type GitHubPinStore,
  githubUnavailableOf,
} from "../ports/github-app-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
  receiptActorOf,
} from "./policy.ts";
import { ACTOR_INACTIVE, NOT_FOUND, OUTRANKED } from "./service-errors.ts";

type Unavailable = NonNullable<ListGitHubRepositoriesResponse["unavailable"]>;
type InstallationPage = Pick<
  ListGitHubRepositoriesResponse,
  "installations" | "installation_id" | "page" | "per_page" | "total_count"
> & {
  repositories: GitHubInstallationRepository[];
  unavailable: Unavailable | null;
  role: GitHubAppRole;
};
type Credential = Pick<
  GitHubAppCredential,
  "id" | "appId" | "apiBase" | "privateKey"
>;

/** How many resolved rows the list asks GitHub about, one call each. */
export const CATALOG_INSTALLED_CHECK_MAX = 100;
export const INSTALLATION_COUNT_MAX = 20;

const refused = (reasonCode: string, message: string) =>
  new SessionServiceError("BAD_REQUEST", message, undefined, {
    reason_code: reasonCode,
  });

const installationNotFound = () =>
  new SessionServiceError(
    "NOT_FOUND",
    "No registered GitHub App has an installation with that id",
    undefined,
    { reason_code: "installation_not_found" },
  );

/**
 * GitHub's failure as the API answers it. A 404 for an installation's own
 * token means the installation is gone; any other 401 or 404 is the App.
 */
function githubFailure(error: unknown, asked: "app" | "installation") {
  if (error instanceof SessionServiceError) return error;
  if (
    asked === "installation" &&
    error instanceof GitHubAppCheckError &&
    error.status === 404
  ) {
    return installationNotFound();
  }
  const reason = githubUnavailableOf(error);
  return new SessionServiceError(
    "GITHUB_UNAVAILABLE",
    reason === "github_app_auth_failed"
      ? "GitHub refused the App's key"
      : "GitHub could not be reached to read the App's repositories",
    undefined,
    { reason_code: reason },
  );
}

/** A catalog id from a GitHub repository name: `My.Repo` → `my.repo`. */
export function repositoryIdBase(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 90);
  return id === "" ? "repository" : id;
}

const fullNameOf = (owner: string, name: string) =>
  `${owner}/${name}`.toLowerCase();

const emptyPage = (
  query: GitHubRepositoryPageQuery,
  unavailable: Unavailable | null,
): InstallationPage => ({
  installations: [],
  installation_id: null,
  page: query.page,
  per_page: query.per_page,
  total_count: 0,
  repositories: [],
  unavailable,
  role: "author",
});

/**
 * The console's GitHub App repositories (settings-replace-file-catalog.md
 * §1.1): read from the author App's installations a page at a time, never
 * registered. A pick resolves one to a catalog row, which a release names.
 */
export function createGitHubRepositoryService(deps: {
  authorization: AuthorizationPolicy;
  store: CatalogRepositoryStore;
  /** Null when the API runs without a master key. */
  apps: GitHubAppStore | null;
  /** Null when the API runs without a master key: no App, so no pin. */
  pins: GitHubPinStore | null;
  directory: GitHubAppDirectory;
  agents: Pick<AgentStore, "get">;
  /** The workspace's repository ceiling; null allows none. */
  repositoryCeiling: (workspaceId: string) => Promise<RepositoryCeiling | null>;
  /** Called after a write commits, so this replica's catalog picks it up. */
  changed: () => Promise<void>;
  newId?: () => string;
}) {
  const { authorization, directory, store } = deps;
  const newId = deps.newId ?? randomUUID;

  /** A signed-in console user: picks and branch changes are not for keys. */
  function writer(caller: Caller) {
    const actor = receiptActorOf(caller);
    const userId = actor?.actor_user_id ?? null;
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user" ||
      actor === null ||
      userId === null
    ) {
      throw new SessionServiceError(
        "FORBIDDEN",
        "Repositories are chosen from a signed-in console session, not with an API key",
        undefined,
        { reason_code: "web_session_required" },
      );
    }
    return {
      workspaceId: caller.ownerId,
      userId,
      actor,
      requestId: caller.requestId,
    };
  }

  async function managed(caller: Caller, workspaceId: string) {
    if (workspaceId !== caller.ownerId) throw NOT_FOUND();
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: workspaceId,
    });
    return writer(caller);
  }

  const manageAgent = (caller: Caller, agentId: string) =>
    requirePermitted(authorization, caller, "agent.manage", {
      kind: "agent",
      id: agentId,
    });

  // After a write has committed, a failed reload must not report it failed;
  // the periodic one catches up.
  const reload = () => deps.changed().catch(() => undefined);

  const credentials = async (
    workspaceId: string,
    role: GitHubAppRole = "author",
  ): Promise<Credential[]> =>
    deps.apps === null ? [] : await deps.apps.credentials(role, workspaceId);

  const repositoryCount = (
    app: Credential,
    installation: GitHubAppInstallationView,
  ): Promise<number | null> =>
    installation.suspendedAt !== null
      ? Promise.resolve(null)
      : directory
          .installationRepositoriesPage(app, installation.id, {
            page: 1,
            perPage: 1,
          })
          .then(
            (page) => page.totalCount,
            () => null,
          );

  // An App GitHub does not answer for leaves its installations out; the
  // request fails only when that may hide the installation asked for.
  async function installationPage(
    workspaceId: string,
    query: GitHubRepositoryPageQuery,
    roles: readonly GitHubAppRole[],
  ): Promise<InstallationPage> {
    const apps =
      deps.apps === null
        ? []
        : (
            await Promise.all(
              roles.map(
                async (role) =>
                  (
                    await deps.apps?.credentials(role, workspaceId)
                  )?.map((app) => ({ role, app })) ?? [],
              ),
            )
          ).flat();
    if (apps.length === 0) return emptyPage(query, "no_author_app");
    const defaultRole = apps[0]?.role;
    if (
      query.installation_id === undefined &&
      apps.filter(({ role }) => role === defaultRole).length > 1
    ) {
      throw refused(
        "installation_required",
        "Several GitHub Apps of the role are registered; name the installation to read",
      );
    }
    const failures: { role: GitHubAppRole; error: unknown }[] = [];
    const held = (
      await Promise.all(
        apps.map(async ({ role, app }) => {
          try {
            return (await directory.installations(app)).map((installation) => ({
              role,
              app,
              installation,
            }));
          } catch (error) {
            failures.push({ role, error });
            return [];
          }
        }),
      )
    )
      .flat()
      .sort(
        (a, b) =>
          roles.indexOf(a.role) - roles.indexOf(b.role) ||
          a.installation.account.localeCompare(b.installation.account) ||
          a.installation.id - b.installation.id,
      );
    const named = query.installation_id !== undefined;
    const summaries = (counts: readonly (number | null)[] = []) =>
      held.map(({ role, app, installation }, index) => ({
        id: installation.id,
        account: installation.account,
        connection_id: app.id,
        role,
        permissions: installation.permissions,
        repository_count: counts[index] ?? null,
      }));
    // The default page answers why it is empty rather than failing, so the
    // catalog beside it still shows and another installation can be named.
    const degraded = (unavailable: Unavailable): InstallationPage => ({
      ...emptyPage(query, unavailable),
      installations: summaries(),
    });
    // It is the author App's when it has one: its failure is not hidden
    // behind the reviewer App's page.
    const defaultFailure =
      failures.find(({ role }) => role === "author") ?? failures[0];
    if (
      !named &&
      defaultFailure !== undefined &&
      (held.length === 0 || defaultFailure.role === "author")
    ) {
      return degraded(githubUnavailableOf(defaultFailure.error));
    }
    const chosen = named
      ? held.find(
          ({ installation }) => installation.id === query.installation_id,
        )
      : (held.find(({ installation }) => installation.suspendedAt === null) ??
        held[0]);
    if (chosen === undefined) {
      const failure = failures[0];
      if (failure !== undefined) throw githubFailure(failure.error, "app");
      if (named) throw installationNotFound();
      return emptyPage(query, "no_installation");
    }
    if (chosen.installation.suspendedAt !== null) {
      if (!named) return degraded("installation_suspended");
      throw new SessionServiceError(
        "INSTALLATION_SUSPENDED",
        "GitHub has suspended this installation of the App",
        undefined,
        { reason_code: "installation_suspended" },
      );
    }
    const page = await directory
      .installationRepositoriesPage(chosen.app, chosen.installation.id, {
        page: query.page,
        perPage: query.per_page,
      })
      .catch((error: unknown) => {
        const failure = githubFailure(error, "installation");
        if (named || failure.code !== "GITHUB_UNAVAILABLE") throw failure;
        return githubUnavailableOf(error);
      });
    if (typeof page === "string") return degraded(page);
    const counts = await Promise.all(
      held.map((entry, index) =>
        entry === chosen
          ? Promise.resolve(page.totalCount)
          : index < INSTALLATION_COUNT_MAX
            ? repositoryCount(entry.app, entry.installation)
            : Promise.resolve(null),
      ),
    );
    return {
      installations: summaries(counts),
      installation_id: chosen.installation.id,
      role: chosen.role,
      page: query.page,
      per_page: query.per_page,
      total_count: page.totalCount,
      repositories: page.repositories,
      unavailable: null,
    };
  }

  const pickedOf = (
    repository: GitHubInstallationRepository,
    rows: readonly CatalogRepositoryRow[],
  ): InstalledGitHubRepository => ({
    github_repository_id: repository.id,
    full_name: `${repository.owner}/${repository.name}`,
    default_branch: repository.defaultBranch,
    private: repository.private,
    catalog_id: rowOfRepository(repository, rows)?.id ?? null,
  });

  /**
   * The row of that GitHub repository: by its id, and by name only a row
   * not yet tied to an id (another repository may hold a name this one had).
   */
  const rowOfRepository = (
    repository: GitHubInstallationRepository,
    rows: readonly CatalogRepositoryRow[],
  ) =>
    rows.find((row) => row.github_repository_id === repository.id) ??
    rows.find(
      (row) =>
        row.github_repository_id === null &&
        fullNameOf(row.owner, row.name) ===
          fullNameOf(repository.owner, repository.name),
    );

  /**
   * The catalog rows the workspace ceiling allows for an agent, together
   * with the installation page's repositories: one entry per repository,
   * the page's answer for its name and visibility winning. `rows` are the
   * console App's; `choosable` adds the rows with an App of their own. A PAT
   * repository the ceiling names cannot be chosen for an agent
   * (`app_required`), so it is no choice here. As in `ceilingHolds`, an
   * `installed` ceiling opens the console App's rows and a row with an App of
   * its own is open only when the ceiling names it.
   */
  const choicesOf = (
    page: readonly GitHubInstallationRepository[],
    rows: readonly CatalogRepositoryRow[],
    choosable: readonly CatalogRepositoryRow[],
    ceiling: RepositoryCeiling | null,
  ): AgentGitHubRepositoryChoice[] => {
    const consoleApp = new Set(rows.map((row) => row.id));
    const opened =
      ceiling === null || ceiling.github_app_repositories === "installed";
    const allowed = choosable.filter(
      (row) =>
        (opened && consoleApp.has(row.id)) ||
        ceiling?.repository_ids.includes(row.id) === true,
    );
    const choices: AgentGitHubRepositoryChoice[] = [];
    // The same GitHub id is one repository. A name settles it only where an
    // id is missing: two ids sharing a name are two repositories, the older
    // one renamed away.
    const held = (githubId: number | null, name: string) =>
      choices.some((choice) =>
        githubId !== null && choice.github_repository_id !== null
          ? choice.github_repository_id === githubId
          : choice.repository.toLowerCase() === name.toLowerCase(),
      );
    for (const repository of page) {
      const row = rowOfRepository(repository, allowed);
      const name = `${repository.owner}/${repository.name}`;
      choices.push({
        github_repository_id: repository.id,
        repository: name,
        full_name: name,
        private: repository.private,
        ref: row === undefined ? null : repositoryRefOf(row.id),
      });
    }
    for (const row of allowed) {
      const name = `${row.owner}/${row.name}`;
      if (held(row.github_repository_id, name)) continue;
      choices.push({
        github_repository_id: row.github_repository_id,
        repository: name,
        full_name: name,
        private: null,
        ref: repositoryRefOf(row.id),
      });
    }
    return choices.sort((a, b) =>
      a.repository.toLowerCase().localeCompare(b.repository.toLowerCase()),
    );
  };

  const agentRepositoryOf = (
    repository: GitHubInstallationRepository,
    rows: readonly CatalogRepositoryRow[],
  ): AgentInstalledGitHubRepository => {
    const picked = pickedOf(repository, rows);
    return {
      ...picked,
      repository: picked.full_name,
      ref:
        picked.catalog_id === null ? null : repositoryRefOf(picked.catalog_id),
    };
  };

  const rowView = (
    row: CatalogRepositoryRow,
    installed: boolean | null,
  ): CatalogGitHubRepository => ({
    id: row.id,
    github_repository_id: row.github_repository_id,
    full_name: `${row.owner}/${row.name}`,
    url: row.url,
    branch: row.branch,
    source: row.source,
    version: row.version,
    installed,
    updated_at: row.updated_at,
  });

  /** Whether an installation of the App covers the row; null when unknown. */
  async function installedNow(
    app: Credential,
    row: { owner: string; name: string },
  ): Promise<boolean | null> {
    try {
      return (
        (await directory.installationFor(app, {
          owner: row.owner,
          name: row.name,
        })) !== null
      );
    } catch {
      return null;
    }
  }

  async function reaches(
    app: Credential,
    row: { owner: string; name: string },
  ): Promise<boolean> {
    const found = await directory.installationFor(app, {
      owner: row.owner,
      name: row.name,
    });
    if (found === null) return false;
    const installation = (await directory.installations(app)).find(
      ({ id }) => id === found.id,
    );
    return installation !== undefined && installation.suspendedAt === null;
  }

  async function installedByAny(
    apps: readonly Credential[],
    row: CatalogRepositoryRow,
  ): Promise<boolean | null> {
    if (apps.length === 0) return null;
    const answers = await Promise.all(
      apps.map((app) => installedNow(app, row)),
    );
    if (answers.includes(true)) return true;
    return answers.includes(null) ? null : false;
  }

  async function pinsOf(repositoryId: string): Promise<GitHubRepositoryPins> {
    const [author, reviewer] = await Promise.all([
      deps.pins?.get(repositoryId, "author"),
      deps.pins?.get(repositoryId, "reviewer"),
    ]);
    return {
      author: author?.connectionId ?? null,
      reviewer: reviewer?.connectionId ?? null,
    };
  }

  async function rowViews(
    workspaceId: string,
    rows: readonly CatalogRepositoryRow[],
  ): Promise<CatalogGitHubRepository[]> {
    const apps = await credentials(workspaceId);
    return Promise.all(
      rows.map(async (row, index) =>
        rowView(
          row,
          index < CATALOG_INSTALLED_CHECK_MAX
            ? await installedByAny(apps, row)
            : null,
        ),
      ),
    );
  }

  async function ownRow(repositoryId: string): Promise<CatalogRepositoryRow> {
    const row = (await store.listActive()).find(
      (held) => held.id === repositoryId,
    );
    if (row === undefined) throw NOT_FOUND();
    return row;
  }

  async function pinTable() {
    const pins = (await deps.pins?.list()) ?? [];
    return (id: string): GitHubRepositoryPins => {
      const of = (role: GitHubAppRole) =>
        pins.find((pin) => pin.repositoryId === id && pin.role === role)
          ?.connectionId ?? null;
      return { author: of("author"), reviewer: of("reviewer") };
    };
  }

  /**
   * An agent's repositories may be picked among the App's when the
   * workspace's ceiling says `installed` (design 3.2); the profile of its
   * release no longer decides.
   */
  async function installedCeiling(workspaceId: string, agentId: string) {
    const detail = await deps.agents.get(workspaceId, agentId);
    if (detail === null) throw NOT_FOUND();
    const ceiling = await deps.repositoryCeiling(workspaceId);
    // No ceiling yet: the first save writes the default ("installed"), so
    // the picker shows what that save will allow. Reading writes nothing.
    return ceiling === null || ceiling.github_app_repositories === "installed"
      ? null
      : ("ceiling_listed" as const);
  }

  /**
   * The repository with that id, only when the installation named covers
   * it: a public repository reads by id from any installation's token, so
   * the App's own answer for its name decides.
   */
  async function coveredRepository(
    app: Credential,
    installationId: number,
    repositoryId: number,
  ): Promise<GitHubInstallationRepository | null> {
    // GitHub refuses a token for an installation of another App as it does
    // when it is down; only the App's own list tells the two apart.
    const installations = await directory
      .installations(app)
      .catch((error: unknown) => {
        throw githubFailure(error, "app");
      });
    if (!installations.some(({ id }) => id === installationId)) return null;
    const repository = await directory.repositoryById(
      app,
      installationId,
      repositoryId,
    );
    if (repository === null) return null;
    const found = await directory.installationFor(app, {
      owner: repository.owner,
      name: repository.name,
    });
    return found?.id === installationId ? repository : null;
  }

  return {
    async list(
      caller: Caller,
      workspaceId: string,
      query: GitHubRepositoryPageQuery,
    ): Promise<ListGitHubRepositoriesResponse> {
      await managed(caller, workspaceId);
      const [{ role, ...page }, rows, counts, pinsOf] = await Promise.all([
        installationPage(workspaceId, query, ["author", "reviewer"]),
        store.listActive(),
        store.agentCounts(),
        pinTable(),
      ]);
      const views = (await rowViews(workspaceId, rows)).map((row) =>
        deps.pins === null ? row : { ...row, pins: pinsOf(row.id) },
      );
      return {
        ...page,
        repositories: page.repositories.map((repository) => {
          const picked = pickedOf(repository, rows);
          return {
            ...picked,
            agent_count:
              picked.catalog_id === null
                ? 0
                : (counts.get(picked.catalog_id)?.[role] ?? 0),
          };
        }),
        catalog: views.map((row) => ({
          ...row,
          agent_count: counts.get(row.id)?.author ?? 0,
        })),
      };
    },

    async setBranch(
      caller: Caller,
      workspaceId: string,
      repositoryId: string,
      readBody: () => Promise<PatchGitHubRepositoryRequest>,
    ): Promise<GitHubRepositoryWriteResponse> {
      const write = await managed(caller, workspaceId);
      const body = await readBody();
      const receiptId = newId();
      const result = await store.setBranch({
        ...write,
        receiptId,
        id: repositoryId,
        branch: body.branch,
        version: body.version,
      });
      switch (result.outcome) {
        case "stored": {
          await reload();
          const [repository] = await rowViews(workspaceId, [result.repository]);
          if (repository === undefined) throw NOT_FOUND();
          return { repository, receipt_id: receiptId };
        }
        case "revision_conflict":
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "The repository changed since it was read; read it again",
          );
        case "not_found":
          throw NOT_FOUND();
        default:
          throw ACTOR_INACTIVE();
      }
    },

    async agentPage(
      caller: Caller,
      agentId: string,
      query: GitHubRepositoryPageQuery,
    ): Promise<ListAgentGitHubRepositoriesResponse> {
      await manageAgent(caller, agentId);
      const workspaceId = caller.ownerId;
      const blocked = await installedCeiling(workspaceId, agentId);
      const [rows, choosable, ceiling] = await Promise.all([
        store.listActive(),
        store.listAgentChoosable(),
        deps.repositoryCeiling(workspaceId),
      ]);
      if (blocked !== null) {
        const { role: _author, ...empty } = emptyPage(query, null);
        return {
          ...empty,
          repositories: [],
          all_repositories: choicesOf([], rows, choosable, ceiling),
          unavailable: blocked,
        };
      }
      const { role: _author, ...page } = await installationPage(
        workspaceId,
        query,
        ["author"],
      );
      return {
        ...page,
        repositories: page.repositories.map((repository) =>
          agentRepositoryOf(repository, rows),
        ),
        all_repositories: choicesOf(
          page.repositories,
          rows,
          choosable,
          ceiling,
        ),
      };
    },

    /**
     * `readBody` runs only once the caller is allowed, so a refused caller
     * learns nothing about the request body.
     */
    async pick(
      caller: Caller,
      agentId: string,
      readBody: () => Promise<PickAgentGitHubRepositoryRequest>,
    ): Promise<PickAgentGitHubRepositoryResponse> {
      await manageAgent(caller, agentId);
      const write = writer(caller);
      const body = await readBody();
      if ((await installedCeiling(write.workspaceId, agentId)) !== null) {
        throw refused(
          "repository_not_allowed",
          "The active release's ceiling does not run on the App's repositories",
        );
      }
      const apps = await credentials(write.workspaceId);
      if (apps.length === 0) {
        throw refused(
          "no_author_app",
          "Register the author GitHub App before choosing repositories",
        );
      }
      // The installation belongs to one App; the others answer null.
      let picked: {
        repository: GitHubInstallationRepository;
        app: Credential;
      } | null = null;
      let failure: unknown = null;
      for (const app of apps) {
        try {
          // A rename between the two reads makes the name miss once.
          const repository =
            (await coveredRepository(
              app,
              body.installation_id,
              body.github_repository_id,
            )) ??
            (await coveredRepository(
              app,
              body.installation_id,
              body.github_repository_id,
            ));
          if (repository !== null) {
            picked = { repository, app };
            break;
          }
        } catch (error) {
          failure = error;
        }
      }
      if (picked === null && failure !== null) {
        throw githubFailure(failure, "installation");
      }
      if (picked === null) {
        throw refused(
          "not_installed",
          "That installation of the author App does not cover the repository",
        );
      }
      const { repository, app } = picked;
      const receiptId = newId();
      // The URL and branch come from GitHub's answer, never from the body.
      const result = await store.resolve({
        ...write,
        agentId,
        managerRoles: MANAGEMENT_ROLES["agent.manage"] ?? [],
        receiptId,
        base: repositoryIdBase(repository.name),
        githubRepositoryId: repository.id,
        owner: repository.owner,
        name: repository.name,
        url: `https://github.com/${repository.owner}/${repository.name}.git`,
        branch: repository.defaultBranch,
      });
      if (result.outcome === "name_held") {
        throw refused(
          "name_held",
          `Catalog row ${result.id} holds that name, for another GitHub repository or not yet tied to one; picking the repository it was, now renamed, frees the name`,
        );
      }
      if (result.outcome === "outranked") throw OUTRANKED();
      if (result.outcome !== "resolved") throw ACTOR_INACTIVE();
      if (result.changed) await reload();
      const pinned = await deps.pins?.pinFirst({
        repositoryId: result.repository.id,
        role: "author",
        connectionId: app.id,
        appId: app.appId,
        pinnedBy: "selection",
        audit: {
          ownerId: write.workspaceId,
          actor: write.actor,
          receiptId: newId(),
        },
      });
      const connectionId = pinned?.pin?.connectionId;
      return {
        catalog_id: result.repository.id,
        receipt_id: result.changed ? receiptId : null,
        ...(connectionId == null ? {} : { connection_id: connectionId }),
      };
    },

    async pinCandidates(
      caller: Caller,
      workspaceId: string,
      repositoryId: string,
    ): Promise<GetGitHubRepositoryAppPinsResponse> {
      await managed(caller, workspaceId);
      const row = await ownRow(repositoryId);
      const records =
        deps.apps === null ? [] : await deps.apps.list(workspaceId);
      const keys = new Map(
        (
          await Promise.all(
            GITHUB_APP_ROLE_VALUES.map((role) =>
              credentials(workspaceId, role),
            ),
          )
        )
          .flat()
          .map((app) => [app.id, app]),
      );
      const candidates = await Promise.all(
        records.map(async (record) => {
          const app = keys.get(record.id);
          return {
            connection_id: record.id,
            role: record.role,
            name: record.name,
            app_id: record.appId,
            installed:
              app === undefined
                ? null
                : await reaches(app, row).catch(() => null),
          };
        }),
      );
      return {
        catalog_id: row.id,
        pins: await pinsOf(row.id),
        candidates,
      };
    },

    async setPin(
      caller: Caller,
      workspaceId: string,
      repositoryId: string,
      role: GitHubAppRole,
      readBody: () => Promise<PutGitHubRepositoryAppPinRequest>,
    ): Promise<PutGitHubRepositoryAppPinResponse> {
      const write = await managed(caller, workspaceId);
      const row = await ownRow(repositoryId);
      const body = await readBody();
      if (deps.pins === null || deps.apps === null) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
        );
      }
      const connectionId = body.connection_id.toLowerCase();
      const app = (await credentials(workspaceId, role)).find(
        (held) => held.id === connectionId,
      );
      if (app === undefined) {
        if ((await deps.apps.get(workspaceId, connectionId)) === null) {
          throw NOT_FOUND();
        }
        throw refused(
          "role_mismatch",
          `That connection is not a ${role} GitHub App`,
        );
      }
      let reached: boolean;
      try {
        reached = await reaches(app, row);
      } catch (error) {
        throw githubFailure(error, "app");
      }
      if (!reached) {
        throw refused(
          "not_installed",
          "No installation of that App, not suspended, covers the repository",
        );
      }
      const receiptId = newId();
      const result = await deps.pins.set({
        workspaceId,
        repositoryId: row.id,
        role,
        connectionId,
        actor: write.actor,
        receiptId,
      });
      switch (result.outcome) {
        case "stored":
          return {
            catalog_id: row.id,
            role,
            connection_id: connectionId,
            receipt_id: result.changed ? receiptId : null,
          };
        case "role_mismatch":
          throw refused(
            "role_mismatch",
            `That connection is not a ${role} GitHub App`,
          );
        default:
          throw NOT_FOUND();
      }
    },
  };
}

export type GitHubRepositoryService = ReturnType<
  typeof createGitHubRepositoryService
>;
