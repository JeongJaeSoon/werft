import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  catalogIdOfRef,
  type RepositoryCeiling,
  repositoryRefOf,
} from "@werft-ai/contracts";
import type {
  CatalogRepositoryRow,
  CatalogRepositoryStore,
} from "../ports/catalog-repository-store.ts";
import {
  GitHubAppCheckError,
  type GitHubAppDirectory,
  type GitHubAppInstallationView,
  type GitHubAppStore,
  type GitHubInstallationRepository,
  type GitHubPinStore,
  type GitHubRepositoryPin,
} from "../ports/github-app-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import { createGitHubRepositoryService } from "./github-repository-service.ts";
import { callerFor, createAuthorizationPolicy } from "./policy.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const INSTALLATION = 77;

const caller = callerFor(
  {
    kind: "user",
    id: "019a0000-0000-7000-8000-0000000000d1",
    workspace_id: WORKSPACE,
    role: "owner",
    scopes: ["sessions:read", "sessions:write"],
  },
  { kind: "web" },
  crypto.randomUUID(),
);

const repository = (
  id: number,
  name: string,
): GitHubInstallationRepository => ({
  id,
  owner: "acme",
  name,
  url: `https://github.com/acme/${name}`,
  defaultBranch: "main",
  private: false,
});

const installation = (
  id: number,
  account = "acme",
): GitHubAppInstallationView => ({
  id,
  account,
  accountType: "organization",
  accountId: 9000 + id,
  repositorySelection: "all",
  htmlUrl: null,
  permissions: { contents: "write" },
  createdAt: null,
  suspendedAt: null,
});

const apps = {
  async find() {
    return { id: "app-row" };
  },
  async credentials() {
    return [
      {
        id: "app-row",
        workspaceId: WORKSPACE,
        appId: 1,
        apiBase: "https://api.github.com",
        privateKey: "unused",
        updatedAt: new Date(),
      },
    ];
  },
} as unknown as GitHubAppStore;

function memoryPins(): GitHubPinStore & { rows: GitHubRepositoryPin[] } {
  const rows: GitHubRepositoryPin[] = [];
  const held = (repositoryId: string, role: string) =>
    rows.find((pin) => pin.repositoryId === repositoryId && pin.role === role);
  return {
    rows,
    async get(repositoryId, role) {
      return held(repositoryId, role) ?? null;
    },
    async list() {
      return [...rows];
    },
    async pinFirst(input) {
      const before = held(input.repositoryId, input.role);
      if (before !== undefined) return { pin: before, created: false };
      const pin = {
        repositoryId: input.repositoryId,
        role: input.role,
        connectionId: input.connectionId,
        appId: input.appId,
        pinnedBy: input.pinnedBy,
      };
      rows.push(pin);
      return { pin, created: true };
    },
    async set(input) {
      const before = held(input.repositoryId, input.role);
      if (before?.connectionId === input.connectionId) {
        return {
          outcome: "stored",
          before: input.connectionId,
          changed: false,
        };
      }
      if (before !== undefined) rows.splice(rows.indexOf(before), 1);
      rows.push({
        repositoryId: input.repositoryId,
        role: input.role,
        connectionId: input.connectionId,
        appId: 0,
        pinnedBy: "admin",
      });
      return {
        outcome: "stored",
        before: before?.connectionId ?? null,
        changed: true,
      };
    },
  };
}

const ROW = {
  id: "widget",
  github_repository_id: 5,
  owner: "acme",
  name: "widget",
  url: "https://github.com/acme/widget.git",
  branch: "main",
  source: "selection",
  version: 1,
  created_at: "",
  updated_at: "",
} as const;

let ceilingHeld: RepositoryCeiling | null = {
  repository_ids: [],
  github_app_repositories: "installed",
};
beforeEach(() => {
  ceilingHeld = { repository_ids: [], github_app_repositories: "installed" };
});

function serviceWith(
  directory: Partial<GitHubAppDirectory>,
  registered: GitHubAppStore = apps,
  pins: ReturnType<typeof memoryPins> | null = null,
  active: readonly CatalogRepositoryRow[] = [],
  /** Rows with an App of their own: not the console App's list. */
  explicit: readonly CatalogRepositoryRow[] = [],
) {
  const resolved: string[] = [];
  const store = {
    async listActive() {
      return [...active];
    },
    async listAgentChoosable() {
      return [...active, ...explicit];
    },
    async agentCounts() {
      return new Map();
    },
    async resolve(input) {
      resolved.push(`${input.owner}/${input.name}`);
      return {
        outcome: "resolved",
        created: true,
        changed: true,
        repository: {
          id: input.base,
          github_repository_id: input.githubRepositoryId,
          owner: input.owner,
          name: input.name,
          url: input.url,
          branch: input.branch,
          source: "selection",
          version: 1,
          created_at: "",
          updated_at: "",
        },
      };
    },
  } as Partial<CatalogRepositoryStore> as CatalogRepositoryStore;
  const service = createGitHubRepositoryService({
    authorization: createAuthorizationPolicy({}),
    store,
    apps: registered,
    pins,
    directory: {
      async installations() {
        return [installation(INSTALLATION)];
      },
      ...directory,
    } as GitHubAppDirectory,
    agents: {
      async get() {
        // No active release: the workspace's ceiling decides alone.
        return { active_release: null } as unknown as AgentDetail;
      },
    },
    repositoryCeiling: async () => ceilingHeld,
    changed: async () => {},
  });
  const pick = (githubRepositoryId: number) =>
    service.pick(caller, AGENT, async () => ({
      installation_id: INSTALLATION,
      github_repository_id: githubRepositoryId,
    }));
  const list = (installationId?: number) =>
    service.list(caller, WORKSPACE, {
      installation_id: installationId,
      page: 1,
      per_page: 30,
    });
  const agentPage = () =>
    service.agentPage(caller, AGENT, { page: 1, per_page: 30 });
  const setPin = (role: "author" | "reviewer", connectionId: string) =>
    service.setPin(caller, WORKSPACE, ROW.id, role, async () => ({
      connection_id: connectionId,
    }));
  return { pick, list, agentPage, setPin, service, resolved };
}

const credentialOf = (id: string, appId: number) => ({
  id,
  workspaceId: WORKSPACE,
  appId,
  apiBase: "https://api.github.com",
  privateKey: "pem",
  updatedAt: new Date(),
});

const twoApps = {
  async find(_workspaceId: string, role: string) {
    return { id: role === "author" ? "author-row" : "reviewer-row" };
  },
  async credentials(role: string) {
    return [
      role === "author"
        ? credentialOf("author-row", 1)
        : credentialOf("reviewer-row", 2),
    ];
  },
} as unknown as GitHubAppStore;

const failed = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => {
      if (!(error instanceof SessionServiceError)) throw error;
      return { code: error.code, details: error.details };
    },
  );

describe("the workspace's page of App installations", () => {
  test("lists the author App's installations, then the reviewer App's, with role, approval and count", async () => {
    const { list } = serviceWith(
      {
        async installations(app) {
          return app.appId === 1
            ? [installation(12, "zeta"), installation(11, "acme")]
            : [installation(21, "acme")];
        },
        async installationRepositoriesPage(_app, installationId) {
          return { repositories: [], totalCount: installationId };
        },
      },
      twoApps,
    );
    const page = await list();
    expect(page.installation_id).toBe(11);
    expect(page.installations).toEqual([
      {
        id: 11,
        account: "acme",
        connection_id: "author-row",
        role: "author",
        permissions: { contents: "write" },
        repository_count: 11,
      },
      expect.objectContaining({ id: 12, account: "zeta", role: "author" }),
      expect.objectContaining({
        id: 21,
        connection_id: "reviewer-row",
        role: "reviewer",
        repository_count: 21,
      }),
    ]);
  });

  test("an App GitHub fails for leaves the other App's installations", async () => {
    const { list } = serviceWith(
      {
        async installations(app) {
          if (app.appId === 2) throw new GitHubAppCheckError("github_rejected");
          return [installation(11, "acme")];
        },
        async installationRepositoriesPage() {
          return { repositories: [], totalCount: 1 };
        },
      },
      twoApps,
    );
    expect((await list()).installations.map(({ id }) => id)).toEqual([11]);
    expect(await failed(list(21))).toEqual({
      code: "GITHUB_UNAVAILABLE",
      details: { reason_code: "github_app_auth_failed" },
    });
  });

  test("an agent's picker reads the author App's installations only, since a pick resolves through it", async () => {
    const { agentPage } = serviceWith(
      {
        async installations(app) {
          return app.appId === 1
            ? [installation(11, "acme")]
            : [installation(21, "other")];
        },
        async installationRepositoriesPage() {
          return { repositories: [], totalCount: 0 };
        },
      },
      twoApps,
    );
    const page = await agentPage();
    expect(page.installations.map(({ id, role }) => [id, role])).toEqual([
      [11, "author"],
    ]);
  });

  test("an installation no App has is 404; a suspended one is 409", async () => {
    const { list } = serviceWith({
      async installations() {
        return [
          installation(11, "acme"),
          { ...installation(12, "zeta"), suspendedAt: new Date() },
        ];
      },
    });
    expect(await failed(list(99))).toEqual({
      code: "NOT_FOUND",
      details: { reason_code: "installation_not_found" },
    });
    expect(await failed(list(12))).toEqual({
      code: "INSTALLATION_SUSPENDED",
      details: { reason_code: "installation_suspended" },
    });
  });

  test("GitHub failing for the default page answers the cause, not an error", async () => {
    const { list } = serviceWith({
      async installations() {
        throw new GitHubAppCheckError("github_rejected", 401);
      },
    });
    const page = await list();
    expect([page.installations, page.unavailable]).toEqual([
      [],
      "github_app_auth_failed",
    ]);
    const paging = serviceWith({
      async installations() {
        return [installation(11)];
      },
      async installationRepositoriesPage() {
        throw new Error("socket hang up");
      },
    });
    expect((await paging.list()).unavailable).toBe("github_unavailable");
    expect(await failed(paging.list(11))).toEqual({
      code: "GITHUB_UNAVAILABLE",
      details: { reason_code: "github_unavailable" },
    });
    // The author App failing is not hidden behind the reviewer App's page.
    const authorDown = serviceWith(
      {
        async installations(app) {
          if (app.appId === 1) throw new Error("socket hang up");
          return [installation(21, "acme")];
        },
        async installationRepositoriesPage() {
          return { repositories: [], totalCount: 0 };
        },
      },
      twoApps,
    );
    const down = await authorDown.list();
    expect(down.unavailable).toBe("github_unavailable");
    // The reviewer App's installations stay listed, to be named.
    expect(down.installations.map(({ id }) => id)).toEqual([21]);
    expect((await authorDown.list(21)).installation_id).toBe(21);
    // An installation dropped after the list was read is that, not a key fault.
    const dropped = serviceWith({
      async installations() {
        return [installation(11)];
      },
      async installationRepositoriesPage() {
        throw new GitHubAppCheckError("github_rejected", 404);
      },
    });
    expect(await failed(dropped.list())).toEqual({
      code: "NOT_FOUND",
      details: { reason_code: "installation_not_found" },
    });
  });

  test("with none named and every installation suspended, the page says so and lists them", async () => {
    const { list } = serviceWith({
      async installations() {
        return [{ ...installation(11, "acme"), suspendedAt: new Date() }];
      },
    });
    const page = await list();
    // The default fake answers the same App for both roles.
    expect([
      page.unavailable,
      page.installations.map(({ id }) => id).slice(0, 1),
    ]).toEqual(["installation_suspended", [11]]);
    expect(await failed(list(11))).toEqual({
      code: "INSTALLATION_SUSPENDED",
      details: { reason_code: "installation_suspended" },
    });
  });

  test("with none named, the first installation not suspended is read", async () => {
    const { list } = serviceWith({
      async installations() {
        return [
          { ...installation(11, "acme"), suspendedAt: new Date() },
          installation(12, "zeta"),
        ];
      },
      async installationRepositoriesPage() {
        return { repositories: [], totalCount: 0 };
      },
    });
    expect((await list()).installation_id).toBe(12);
  });

  test("a reviewer App left without an author App still lists its installations; the picker has none", async () => {
    const reviewerOnly = {
      ...twoApps,
      async credentials(role: string) {
        return role === "reviewer" ? [credentialOf("reviewer-row", 2)] : [];
      },
    } as unknown as GitHubAppStore;
    const { list, agentPage } = serviceWith(
      {
        async installations() {
          return [installation(21, "acme")];
        },
        async installationRepositoriesPage() {
          return { repositories: [], totalCount: 0 };
        },
      },
      reviewerOnly,
    );
    const page = await list();
    expect([page.installation_id, page.unavailable]).toEqual([21, null]);
    expect((await agentPage()).unavailable).toBe("no_author_app");
  });

  test("the picker follows the workspace ceiling, not a release", async () => {
    const { agentPage, pick } = serviceWith({
      async installationRepositoriesPage() {
        return { repositories: [], totalCount: 0 };
      },
    });
    // The fixture agent has no active release; `installed` still opens it.
    expect((await agentPage()).unavailable).toBeNull();
    ceilingHeld = {
      repository_ids: ["named"],
      github_app_repositories: "listed",
    };
    expect((await agentPage()).unavailable).toBe("ceiling_listed");
    expect(await reasonOf(pick(5))).toBe("repository_not_allowed");
    // No ceiling yet: shown as the default the first save writes.
    ceilingHeld = null;
    expect((await agentPage()).unavailable).toBeNull();
  });
});

describe("the agent's repositories read as owner/repo", () => {
  const BILLING = {
    ...ROW,
    id: "billing",
    github_repository_id: 9,
    name: "billing",
    url: "https://github.com/acme/billing.git",
  };
  const OUTSIDE = {
    ...ROW,
    id: "outside",
    github_repository_id: 10,
    name: "outside",
    url: "https://github.com/acme/outside.git",
  };
  const pageOf = (...repositories: GitHubInstallationRepository[]) => ({
    async installationRepositoriesPage() {
      return { repositories, totalCount: repositories.length };
    },
  });

  test("under ceiling_listed the list is empty but every allowed repository is in the merged one", async () => {
    const { agentPage } = serviceWith(pageOf(), apps, null, [
      ROW,
      BILLING,
      OUTSIDE,
    ]);
    ceilingHeld = {
      repository_ids: ["widget", "billing"],
      github_app_repositories: "listed",
    };
    const page = await agentPage();
    expect(page.unavailable).toBe("ceiling_listed");
    expect(page.repositories).toEqual([]);
    expect(page.all_repositories).toEqual([
      {
        github_repository_id: 9,
        repository: "acme/billing",
        full_name: "acme/billing",
        private: null,
        ref: repositoryRefOf("billing"),
      },
      {
        github_repository_id: 5,
        repository: "acme/widget",
        full_name: "acme/widget",
        private: null,
        ref: repositoryRefOf("widget"),
      },
    ]);
  });

  test("a row with an App of its own is a choice only where the ceiling names it", async () => {
    const OWN = {
      ...ROW,
      id: "ghe",
      github_repository_id: null,
      name: "ghe",
      url: "https://ghe.example.invalid/acme/ghe.git",
    };
    const { agentPage } = serviceWith(pageOf(), apps, null, [ROW], [OWN]);
    const names = async () =>
      ((await agentPage()).all_repositories ?? []).map(
        (entry) => entry.repository,
      );
    // `installed` opens the console App's rows, not this one.
    expect(await names()).toEqual(["acme/widget"]);
    ceilingHeld = {
      repository_ids: ["ghe"],
      github_app_repositories: "installed",
    };
    expect(await names()).toEqual(["acme/ghe", "acme/widget"]);
    // Under a list the console App's rows need naming too.
    ceilingHeld = {
      repository_ids: ["ghe"],
      github_app_repositories: "listed",
    };
    const page = await agentPage();
    expect(page.unavailable).toBe("ceiling_listed");
    expect((page.all_repositories ?? []).map((entry) => entry.ref)).toEqual([
      repositoryRefOf("ghe"),
    ]);
  });

  test("the installation page and the catalog merge into one line per repository, the page's name and visibility winning", async () => {
    const { agentPage } = serviceWith(
      pageOf(
        // Renamed on GitHub since the row was made.
        { ...repository(5, "widget-2"), private: true },
        repository(77, "fresh"),
      ),
      apps,
      null,
      [ROW, BILLING],
    );
    const page = await agentPage();
    expect(page.repositories).toEqual([
      {
        github_repository_id: 5,
        full_name: "acme/widget-2",
        repository: "acme/widget-2",
        default_branch: "main",
        private: true,
        catalog_id: "widget",
        ref: repositoryRefOf("widget"),
      },
      {
        github_repository_id: 77,
        full_name: "acme/fresh",
        repository: "acme/fresh",
        default_branch: "main",
        private: false,
        catalog_id: null,
        ref: null,
      },
    ]);
    expect(
      (page.all_repositories ?? []).map(
        ({ repository, private: hidden, ref }) => [
          repository,
          hidden,
          ref === null ? null : catalogIdOfRef(ref),
        ],
      ),
    ).toEqual([
      ["acme/billing", null, "billing"],
      ["acme/fresh", false, null],
      ["acme/widget-2", true, "widget"],
    ]);
  });

  test("a row renamed away and a row with no GitHub id under the new name are one repository, not two lines", async () => {
    const OLD = { ...ROW, id: "old", github_repository_id: 5, name: "old" };
    const SEEDED = {
      ...ROW,
      id: "widget",
      github_repository_id: null,
      name: "widget",
    };
    const { agentPage } = serviceWith(
      pageOf({ ...repository(5, "widget"), private: true }),
      apps,
      null,
      [OLD, SEEDED],
    );
    const page = await agentPage();
    expect(page.all_repositories).toEqual([
      {
        github_repository_id: 5,
        repository: "acme/widget",
        full_name: "acme/widget",
        private: true,
        // The row GitHub's id names; the id-less one is its duplicate.
        ref: repositoryRefOf("old"),
      },
    ]);
  });

  test("a row with an App of its own and the page's entry for the same GitHub id are one line", async () => {
    const OWN = {
      ...ROW,
      id: "ghe",
      github_repository_id: 9,
      name: "shared",
      url: "https://ghe.example.invalid/acme/shared.git",
    };
    ceilingHeld = {
      repository_ids: ["ghe"],
      github_app_repositories: "installed",
    };
    const { agentPage } = serviceWith(
      pageOf({ ...repository(9, "shared"), private: false }),
      apps,
      null,
      [],
      [OWN],
    );
    const page = await agentPage();
    expect(page.all_repositories).toEqual([
      {
        github_repository_id: 9,
        repository: "acme/shared",
        full_name: "acme/shared",
        private: false,
        ref: repositoryRefOf("ghe"),
      },
    ]);
  });

  test("a row without a GitHub id listed first does not swallow differently numbered rows of its name", async () => {
    const rowOf = (id: string, githubId: number | null) => ({
      ...ROW,
      id,
      github_repository_id: githubId,
    });
    // Catalog order puts the id-less row first.
    const { agentPage } = serviceWith(pageOf(), apps, null, [
      rowOf("a", null),
      rowOf("b", 5),
      rowOf("c", 8),
    ]);
    const choices = (await agentPage()).all_repositories ?? [];
    expect(choices.map((entry) => entry.github_repository_id)).toEqual([5, 8]);
    expect(choices.map((entry) => entry.ref)).toEqual([
      repositoryRefOf("b"),
      repositoryRefOf("c"),
    ]);
  });

  test("a name an older repository held is not taken for the repository that has it now", async () => {
    const { agentPage } = serviceWith(
      pageOf(repository(8, "widget")),
      apps,
      null,
      [ROW],
    );
    const page = await agentPage();
    // Row `widget` is GitHub repository 5; the page's `acme/widget` is 8.
    expect(page.repositories[0]?.ref).toBeNull();
    expect(
      (page.all_repositories ?? []).map((entry) => entry.github_repository_id),
    ).toEqual([8, 5]);
  });
});

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    if (!(error instanceof SessionServiceError)) throw error;
    return (error.details as { reason_code?: string } | undefined)?.reason_code;
  }
};

describe("picking a GitHub App repository for an agent", () => {
  test("a public repository the installation does not cover reads by id but is refused", async () => {
    const { pick, resolved } = serviceWith({
      async repositoryById() {
        return repository(5, "someone-elses");
      },
      // Another installation of the App, or none, covers it.
      async installationFor() {
        return { id: 99, permissions: {} };
      },
    });
    expect(await reasonOf(pick(5))).toBe("not_installed");
    expect(resolved).toEqual([]);
  });

  test("an installation the App does not have is refused before GitHub is asked for a token", async () => {
    let read = false;
    const { pick, resolved } = serviceWith({
      async installations() {
        return [installation(99)];
      },
      async repositoryById() {
        read = true;
        throw new Error(
          "GitHub refuses a token for another App's installation",
        );
      },
    });
    expect(await reasonOf(pick(5))).toBe("not_installed");
    expect(read).toBe(false);
    expect(resolved).toEqual([]);
  });

  test("a rename between the two reads is asked once more, then resolved", async () => {
    let reads = 0;
    const { pick, resolved } = serviceWith({
      async repositoryById() {
        reads += 1;
        return repository(6, reads === 1 ? "old-name" : "new-name");
      },
      async installationFor(_app, repo) {
        return repo.name === "new-name"
          ? { id: INSTALLATION, permissions: {} }
          : null;
      },
    });
    expect(await pick(6)).toEqual({
      catalog_id: "new-name",
      receipt_id: expect.any(String),
    });
    expect(reads).toBe(2);
    expect(resolved).toEqual(["acme/new-name"]);
  });

  test("GitHub failing is GITHUB_UNAVAILABLE by cause, or a vanished installation", async () => {
    for (const [thrown, code, reason] of [
      [new Error("socket hang up"), "GITHUB_UNAVAILABLE", "github_unavailable"],
      [
        new GitHubAppCheckError("github_unreachable", 502),
        "GITHUB_UNAVAILABLE",
        "github_unavailable",
      ],
      [
        new GitHubAppCheckError("github_rejected", 401),
        "GITHUB_UNAVAILABLE",
        "github_app_auth_failed",
      ],
      [
        new GitHubAppCheckError("github_rejected", 404),
        "NOT_FOUND",
        "installation_not_found",
      ],
    ] as const) {
      const { pick, resolved } = serviceWith({
        async repositoryById() {
          throw thrown;
        },
      });
      expect(await failed(pick(7))).toEqual({
        code,
        details: { reason_code: reason },
      });
      expect(resolved).toEqual([]);
    }
  });

  test("a refused App key is told apart from the App's installation list", async () => {
    const { pick } = serviceWith({
      async installations() {
        throw new GitHubAppCheckError("github_rejected", 404);
      },
    });
    expect(await failed(pick(7))).toEqual({
      code: "GITHUB_UNAVAILABLE",
      details: { reason_code: "github_app_auth_failed" },
    });
  });
});

const twoAuthors = {
  async get(_workspaceId: string, id: string) {
    return ["author-a", "author-b", "reviewer-row"].includes(id)
      ? { id, role: id === "reviewer-row" ? "reviewer" : "author" }
      : null;
  },
  async list() {
    return [
      { id: "author-a", role: "author", name: "A", appId: 1 },
      { id: "author-b", role: "author", name: "B", appId: 2 },
      { id: "reviewer-row", role: "reviewer", name: "R", appId: 3 },
    ];
  },
  async credentials(role: string) {
    return role === "author"
      ? [credentialOf("author-a", 1), credentialOf("author-b", 2)]
      : [credentialOf("reviewer-row", 3)];
  },
} as unknown as GitHubAppStore;

const byApp = {
  async installations(app: { id: string }) {
    return app.id === "author-b"
      ? [installation(INSTALLATION)]
      : [installation(app.id === "author-a" ? 11 : 12)];
  },
  async repositoryById() {
    return repository(5, "widget");
  },
  async installationRepositoriesPage() {
    return { repositories: [], totalCount: 0 };
  },
  async installationFor(app: { id: string }) {
    return app.id === "author-b" ? { id: INSTALLATION, permissions: {} } : null;
  },
} as unknown as Partial<GitHubAppDirectory>;

describe("several Apps of one role (decision github-agent.md 11)", () => {
  test("a pick pins the repository to the App holding the installation, once", async () => {
    const pins = memoryPins();
    const { pick } = serviceWith(byApp, twoAuthors, pins);
    expect(await pick(5)).toMatchObject({
      catalog_id: "widget",
      connection_id: "author-b",
    });
    expect(pins.rows).toEqual([
      {
        repositoryId: "widget",
        role: "author",
        connectionId: "author-b",
        appId: 2,
        pinnedBy: "selection",
      },
    ]);
    pins.rows[0] = {
      ...(pins.rows[0] as GitHubRepositoryPin),
      connectionId: "author-a",
      pinnedBy: "admin",
    };
    expect((await pick(5)).connection_id).toBe("author-a");
    expect(pins.rows).toHaveLength(1);
  });

  test("a page with no installation named is refused only when its role has several Apps", async () => {
    const { list, agentPage } = serviceWith(byApp, twoAuthors, memoryPins());
    for (const read of [list(), agentPage()]) {
      expect(await failed(read)).toEqual({
        code: "BAD_REQUEST",
        details: { reason_code: "installation_required" },
      });
    }
    const named = await list(INSTALLATION);
    expect(named.installation_id).toBe(INSTALLATION);
    const single = serviceWith(
      {
        async installationRepositoriesPage() {
          return { repositories: [], totalCount: 0 };
        },
      },
      twoApps,
      memoryPins(),
    );
    expect((await single.list()).installation_id).toBe(INSTALLATION);
  });

  test("an admin pin needs a connection of the role whose App covers the repository", async () => {
    const pins = memoryPins();
    const { setPin } = serviceWith(byApp, twoAuthors, pins, [ROW]);
    expect(await reasonOf(setPin("author", "author-a"))).toBe("not_installed");
    expect(await reasonOf(setPin("author", "reviewer-row"))).toBe(
      "role_mismatch",
    );
    expect((await failed(setPin("author", "author-z"))).code).toBe("NOT_FOUND");
    expect(pins.rows).toEqual([]);
    expect(await setPin("author", "author-b")).toEqual({
      catalog_id: "widget",
      role: "author",
      connection_id: "author-b",
      receipt_id: expect.any(String),
    });
    expect((await setPin("author", "author-b")).receipt_id).toBeNull();
  });

  test("an App whose covering installation GitHub suspended does not reach the repository", async () => {
    const suspended = {
      ...byApp,
      async installations() {
        return [
          {
            ...installation(INSTALLATION),
            suspendedAt: new Date("2026-11-01T00:00:00Z"),
          },
        ];
      },
    } as unknown as Partial<GitHubAppDirectory>;
    const pins = memoryPins();
    const { setPin, service } = serviceWith(suspended, twoAuthors, pins, [ROW]);
    expect(await reasonOf(setPin("author", "author-b"))).toBe("not_installed");
    expect(pins.rows).toEqual([]);
    const { candidates } = await service.pinCandidates(
      caller,
      WORKSPACE,
      "widget",
    );
    expect(candidates.map(({ installed }) => installed)).toEqual([
      false,
      false,
      false,
    ]);
  });

  test("the catalog row carries its pins, and candidates say which App reaches it", async () => {
    const pins = memoryPins();
    const { setPin, list, service } = serviceWith(byApp, twoAuthors, pins, [
      ROW,
    ]);
    await setPin("author", "author-b");
    const catalog = (await list(INSTALLATION)).catalog;
    expect(catalog).toEqual([
      expect.objectContaining({
        id: "widget",
        installed: true,
        pins: { author: "author-b", reviewer: null },
      }),
    ]);
    const candidates = await service.pinCandidates(caller, WORKSPACE, "widget");
    expect(candidates.pins).toEqual({ author: "author-b", reviewer: null });
    expect(
      candidates.candidates.map(({ connection_id, installed }) => [
        connection_id,
        installed,
      ]),
    ).toEqual([
      ["author-a", false],
      ["author-b", true],
      ["reviewer-row", false],
    ]);
  });
});
