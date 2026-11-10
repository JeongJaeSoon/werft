import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  type AgentGitHub,
  type AgentGitHubSettingsRow,
  catalogIdOfRef,
  GITHUB_FEATURES_NONE,
  type GitHubCeiling,
  type RepositoryCeiling,
  repositoryRefOf,
} from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { AgentGitHubStore } from "../ports/agent-github-store.ts";
import type { SessionCatalog } from "../sessions/catalog.ts";
import { createAgentGitHubService } from "./agent-github-service.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";

const app = (extra: object = {}) => ({
  kind: "github_app" as const,
  registered: true as const,
  ...extra,
});
const enterprise = {
  kind: "github_app" as const,
  app_id: 1,
  installation_id: 2,
  api_base: "https://ghe.example.com/api/v3",
  value: "pem",
  ref: { value_env: "PEM" },
};

const catalog: SessionCatalog = {
  connections: {},
  repositories: {
    "sample-app": {
      url: "https://github.com/acme/sample-app",
      branch: "main",
      auth: app(),
    },
    "elsewhere-app": {
      url: "https://github.com/acme/elsewhere",
      branch: "main",
      auth: app(),
    },
    "ghe-app": {
      url: "https://ghe.example.com/acme/app",
      branch: "main",
      auth: enterprise,
    },
  },
};

const ALL_ON: GitHubCeiling = {
  workflows: true,
  actions: true,
  checks: true,
  issues: true,
  review: true,
  merge: true,
};

// Every fixture repository is under it: `installed` reaches the two console
// App ones, the list names the Enterprise one.
const DEFAULT_CEILING: RepositoryCeiling = {
  repository_ids: ["ghe-app"],
  github_app_repositories: "installed",
};

function serviceWith(input: {
  github?: AgentGitHub;
  store?: Partial<AgentGitHubStore>;
  /** The agent's own settings row. */
  settings?: AgentGitHubSettingsRow;
  repositoryCeiling?: RepositoryCeiling | null;
  catalog?: SessionCatalog;
  ceiling?: GitHubCeiling;
  author?: Record<string, "read" | "write" | "admin"> | null;
  reviewer?: Record<string, "read" | "write" | "admin"> | null | "none";
  noRelease?: boolean;
  /** `<repository>:<role>` → GitHub's answer; absent: no connection. */
  installed?: Record<string, boolean | null | Error>;
  /** Counts the asks the tab makes of a connection, by kind. */
  asks?: { batch: number; single: number };
  selection?: NonNullable<
    Parameters<typeof createAgentGitHubService>[0]["selection"]
  >;
}) {
  const release = input.noRelease
    ? null
    : {
        id: "sha256:release",
        repository_id: "sample-app",
        policy_pins: input.github === undefined ? {} : { github: input.github },
      };
  const store: AgentGitHubStore = {
    settings: () => Promise.resolve(input.settings ?? null),
    repositoryCeiling: () =>
      Promise.resolve(
        input.repositoryCeiling === undefined
          ? DEFAULT_CEILING
          : input.repositoryCeiling,
      ),
    async enabled() {
      return true;
    },
    async setEnabled() {
      return { outcome: "saved", receiptId: null };
    },
    async putSettings() {
      return { outcome: "saved", revision: 1, receiptId: null };
    },
    async setRepository() {
      return { outcome: "not_found" };
    },
    async activity() {
      return [];
    },
    repositoryNames: () => Promise.resolve(new Map()),
    ...input.store,
  };
  return createAgentGitHubService({
    authorization: createAuthorizationPolicy(),
    ...(input.selection === undefined ? {} : { selection: input.selection }),
    agents: {
      async get() {
        return { active_release: release } as unknown as AgentDetail;
      },
    },
    store,
    catalog: input.catalog ?? catalog,
    githubSettings: {
      async get() {
        return { ceiling: input.ceiling ?? ALL_ON, revision: 1 };
      },
      async appPermissions() {
        return {
          author:
            input.author === null
              ? null
              : { permissions: input.author ?? { contents: "write" } },
          reviewer:
            input.reviewer === "none"
              ? null
              : { permissions: input.reviewer ?? { pull_requests: "write" } },
        };
      },
    },
    connections: (id, role) => {
      const answer = input.installed?.[`${id}:${role}`];
      if (answer === undefined) return null;
      return {
        kind: "fixed",
        connection: {
          kind: "app",
          githubCom: true,
          appId: 1,
          installedOn: async (repos) => {
            if (input.asks) input.asks.batch += 1;
            if (answer instanceof Error) throw answer;
            return new Map(
              repos.map((repo) => [
                `${repo.owner}/${repo.name}`.toLowerCase(),
                answer,
              ]),
            );
          },
          quotaKey: () => {
            throw new Error("not used");
          },
          credential: async () => {
            throw new Error("not used");
          },
          api: () => {
            throw new Error("not used");
          },
          installed: async () => {
            if (input.asks) input.asks.single += 1;
            if (answer instanceof Error) throw answer;
            return answer;
          },
        },
      };
    },
  });
}

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

type Put = Parameters<AgentGitHubStore["putSettings"]>[0];

/**
 * A service whose `putSettings` store runs the service's `check` against
 * `current`, as the real one does under its lock, then answers `outcome`.
 */
function serviceWithPuts(input: {
  current?: AgentGitHubSettingsRow;
  outcome?: Awaited<ReturnType<AgentGitHubStore["putSettings"]>>;
  ceiling?: GitHubCeiling;
  repositoryCeiling?: RepositoryCeiling | null;
}) {
  const puts: Put[] = [];
  const service = serviceWith({
    ...(input.ceiling === undefined ? {} : { ceiling: input.ceiling }),
    ...(input.repositoryCeiling === undefined
      ? {}
      : { repositoryCeiling: input.repositoryCeiling }),
    store: {
      async putSettings(put) {
        puts.push(put);
        // The real store writes the default when a workspace has none.
        put.check(
          input.current ?? null,
          input.repositoryCeiling ?? DEFAULT_CEILING,
        );
        return (
          input.outcome ?? {
            outcome: "saved",
            revision: (input.current?.revision ?? 0) + 1,
            receiptId: "receipt-1",
          }
        );
      },
    },
  });
  return { service, puts };
}

const WITH_SETTINGS: AgentGitHub = {
  repositories: ["sample-app"],
  push_approval: true,
  features: { ...GITHUB_FEATURES_NONE },
  actions_allow: [],
};

describe("the agent GitHub tab's options", () => {
  test("repositories: each with why it cannot be picked", async () => {
    const read = await serviceWith({
      repositoryCeiling: {
        repository_ids: ["ghe-app", "sample-app"],
        github_app_repositories: "listed",
      },
    }).get(caller, AGENT);
    const unknown = { author: null, reviewer: null };
    expect(read.options.repositories).toEqual([
      {
        id: "elsewhere-app",
        url: "https://github.com/acme/elsewhere",
        repository: "acme/elsewhere",
        full_name: "acme/elsewhere",
        private: null,
        ref: repositoryRefOf("elsewhere-app"),
        available: false,
        reason: "repository_not_allowed",
        installed: unknown,
      },
      {
        id: "ghe-app",
        url: "https://ghe.example.com/acme/app",
        repository: "acme/app",
        full_name: "acme/app",
        private: null,
        ref: repositoryRefOf("ghe-app"),
        available: true,
        reason: null,
        installed: unknown,
      },
      {
        id: "sample-app",
        url: "https://github.com/acme/sample-app",
        repository: "acme/sample-app",
        full_name: "acme/sample-app",
        private: null,
        ref: repositoryRefOf("sample-app"),
        available: true,
        reason: null,
        installed: unknown,
      },
    ]);
  });

  test("installed: each role's App as GitHub answers; no connection or no answer is null", async () => {
    const read = await serviceWith({
      installed: {
        "sample-app:author": true,
        "sample-app:reviewer": false,
        "elsewhere-app:author": false,
        "elsewhere-app:reviewer": new Error("GitHub failed (502)"),
      },
    }).get(caller, AGENT);
    const installed = Object.fromEntries(
      read.options.repositories.map((entry) => [entry.id, entry.installed]),
    );
    expect(installed).toEqual({
      "elsewhere-app": { author: false, reviewer: null },
      "ghe-app": { author: null, reviewer: null },
      "sample-app": { author: true, reviewer: false },
    });
  });

  test("installed: the tab asks in batches and never repeats a failed batch one repository at a time", async () => {
    const asks = { batch: 0, single: 0 };
    await serviceWith({
      asks,
      installed: {
        "sample-app:author": true,
        "sample-app:reviewer": new Error("GitHub failed (502)"),
        "elsewhere-app:author": false,
        "elsewhere-app:reviewer": new Error("GitHub failed (502)"),
      },
    }).get(caller, AGENT);
    expect(asks.single).toBe(0);
    expect(asks.batch).toBe(4);
  });

  test("features: the ceiling, the reviewer App and the App's permissions, in that order", async () => {
    const read = await serviceWith({
      github: WITH_SETTINGS,
      ceiling: { ...ALL_ON, checks: false },
      author: {
        contents: "write",
        actions: "write",
        issues: "read",
        workflows: "admin",
      },
      reviewer: "none",
    }).get(caller, AGENT);
    expect(read.options.features).toEqual({
      workflows: { available: true, reason: null },
      actions: { available: true, reason: null },
      checks: { available: false, reason: "over_workspace_ceiling" },
      issues: { available: false, reason: "app_permission_missing" },
      review: { available: false, reason: "no_reviewer_app" },
    });
  });

  test("a reviewer App without pull request write is missing the permission; unread permissions are not judged", async () => {
    const lacking = await serviceWith({
      reviewer: { pull_requests: "read" },
      author: null,
    }).get(caller, AGENT);
    expect(lacking.options.features.review.reason).toBe(
      "app_permission_missing",
    );
    expect(lacking.options.features.checks.available).toBe(true);
  });

  test("only GitHub Enterprise repositories chosen: every optional permission is unsupported", async () => {
    const read = await serviceWith({
      github: { ...WITH_SETTINGS, repositories: ["ghe-app"] },
    }).get(caller, AGENT);
    for (const option of Object.values(read.options.features)) {
      expect(option).toEqual({
        available: false,
        reason: "github_host_unsupported",
      });
    }
    const mixed = await serviceWith({
      github: { ...WITH_SETTINGS, repositories: ["sample-app", "ghe-app"] },
      author: { actions: "write" },
    }).get(caller, AGENT);
    expect(mixed.options.features.actions.available).toBe(true);
  });

  test("legacy defaults: no repository, push approval off, nothing optional", async () => {
    const read = await serviceWith({}).get(caller, AGENT);
    expect(read.github).toBeNull();
    expect(read.legacy_defaults).toEqual({
      ...WITH_SETTINGS,
      repositories: [],
      push_approval: false,
    });
    const saved = await serviceWith({ github: WITH_SETTINGS }).get(
      caller,
      AGENT,
    );
    expect(saved.github).toEqual(WITH_SETTINGS);
    expect(saved.legacy_defaults).toBeNull();
  });

  test("an agent's row answers before the release's pin; one that cannot be read shows as none", async () => {
    const row = {
      repositories: ["ghe-app"],
      pushApproval: false,
      features: { ...GITHUB_FEATURES_NONE },
      actionsAllow: [],
      startRepositoryId: null,
      pushAttached: null,
      revision: 2,
      updatedBy: null,
    };
    const read = await serviceWith({
      github: WITH_SETTINGS,
      settings: row,
    }).get(caller, AGENT);
    expect(read.github).toEqual({
      repositories: ["ghe-app"],
      push_approval: false,
      features: { ...GITHUB_FEATURES_NONE },
      actions_allow: [],
    });
    const bad = await serviceWith({
      github: WITH_SETTINGS,
      settings: { ...row, repositories: "a later shape" },
    }).get(caller, AGENT);
    expect(bad.github).toBeNull();
  });

  describe("which repositories can be picked: the workspace's ceiling alone", () => {
    const reasons = async (input: Parameters<typeof serviceWith>[0]) => {
      const read = await serviceWith(input).get(caller, AGENT);
      return Object.fromEntries(
        read.options.repositories.map(({ id, reason }) => [id, reason]),
      );
    };

    test("`installed` reaches every repository on a GitHub App, its own or the console's; a listed id reaches its own", async () => {
      expect(
        await reasons({
          repositoryCeiling: {
            repository_ids: [],
            github_app_repositories: "installed",
          },
        }),
      ).toEqual({
        "elsewhere-app": null,
        "ghe-app": null,
        "sample-app": null,
      });
      expect(
        await reasons({
          repositoryCeiling: {
            repository_ids: ["ghe-app"],
            github_app_repositories: "listed",
          },
        }),
      ).toEqual({
        "elsewhere-app": "repository_not_allowed",
        "ghe-app": null,
        "sample-app": "repository_not_allowed",
      });
    });

    test("no ceiling yet: shown as the default the first save writes, and flagged; a ceiling that reads is not", async () => {
      const unset = await serviceWith({ repositoryCeiling: null }).get(
        caller,
        AGENT,
      );
      expect(unset.options.repository_ceiling_unset).toBe(true);
      expect(await reasons({ repositoryCeiling: null })).toEqual(
        await reasons({
          repositoryCeiling: {
            repository_ids: [],
            github_app_repositories: "installed",
          },
        }),
      );
      expect(
        (await serviceWith({}).get(caller, AGENT)).options
          .repository_ceiling_unset,
      ).toBe(false);
    });

    test("no active release, a row or not: the same answer", async () => {
      const bare = await reasons({ noRelease: true });
      expect(bare).toEqual(await reasons({}));
      expect(
        await reasons({
          noRelease: true,
          settings: {
            repositories: ["sample-app"],
            pushApproval: true,
            features: { ...GITHUB_FEATURES_NONE },
            actionsAllow: [],
            startRepositoryId: null,
            pushAttached: null,
            revision: 1,
            updatedBy: null,
          },
        }),
      ).toEqual(bare);
    });
  });

  test("a save starts from the row's revision; none without a row", async () => {
    const none = await serviceWith({ noRelease: true }).get(caller, AGENT);
    expect(none.settings_revision).toBeNull();
    expect(none.start_repository_id).toBeNull();
    // The defaults may list no repository: nothing is picked yet.
    expect(none.legacy_defaults?.repositories).toEqual([]);
    const row = await serviceWith({
      settings: {
        repositories: ["sample-app"],
        pushApproval: true,
        features: { ...GITHUB_FEATURES_NONE },
        actionsAllow: [],
        startRepositoryId: "sample-app",
        pushAttached: null,
        revision: 4,
        updatedBy: crypto.randomUUID(),
      },
    }).get(caller, AGENT);
    expect(row.settings_revision).toBe(4);
    expect(row.start_repository_id).toBe("sample-app");
    expect(row.legacy_defaults).toBeNull();
  });

  test("push_attached: a first save starts from allow, a row from before the column asks, a stored value shows as it is", async () => {
    const rowWith = (pushAttached: string | null) => ({
      repositories: ["sample-app"],
      pushApproval: true,
      features: { ...GITHUB_FEATURES_NONE },
      actionsAllow: [],
      startRepositoryId: null,
      pushAttached,
      revision: 2,
      updatedBy: crypto.randomUUID(),
    });
    // No row: what a first save writes (owner decision D6).
    expect(
      (await serviceWith({ noRelease: true }).get(caller, AGENT)).push_attached,
    ).toBe("allow");
    // A row saved before the column keeps asking a person.
    expect(
      (await serviceWith({ settings: rowWith(null) }).get(caller, AGENT))
        .push_attached,
    ).toBe("ask");
    for (const stored of ["allow", "ask", "deny"] as const) {
      expect(
        (await serviceWith({ settings: rowWith(stored) }).get(caller, AGENT))
          .push_attached,
      ).toBe(stored);
    }
    // A value this image cannot read is shown as the strictest.
    expect(
      (await serviceWith({ settings: rowWith("ask_once") }).get(caller, AGENT))
        .push_attached,
    ).toBe("deny");
  });
});

describe("saving the agent's GitHub settings", () => {
  const SAVED: AgentGitHub = {
    ...WITH_SETTINGS,
    repositories: ["sample-app"],
    features: { ...GITHUB_FEATURES_NONE, actions: true },
    actions_allow: [{ workflow: "ci.yml" }],
  };
  const HELD: AgentGitHubSettingsRow = {
    repositories: ["sample-app"],
    pushApproval: true,
    features: { ...GITHUB_FEATURES_NONE, actions: true },
    actionsAllow: [],
    startRepositoryId: null,
    pushAttached: null,
    revision: 2,
    updatedBy: "019a0000-0000-7000-8000-0000000000d1",
  };
  const request = (
    over: Partial<{
      expected_revision: number | null;
      settings: AgentGitHub;
      start_repository_id: string | null;
    }> = {},
  ) => ({
    expected_revision: null,
    settings: SAVED,
    start_repository_id: null,
    ...over,
  });
  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      const failure = error as {
        code: string;
        details?: { reason_code?: string };
      };
      return `${failure.code}:${failure.details?.reason_code ?? ""}`;
    }
    return "saved";
  };

  test("saves as the caller and returns the store's revision", async () => {
    const { service, puts } = serviceWithPuts({});
    const result = await service.putSettings(caller, AGENT, request());
    expect(result).toEqual({ settings_revision: 1, receipt_id: "receipt-1" });
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      agentId: AGENT,
      expectedRevision: null,
      userId: caller.actor?.userId,
      settings: SAVED,
    });
  });

  test("push_attached goes to the store as sent, and is left out when the request leaves it out", async () => {
    const { service, puts } = serviceWithPuts({});
    await service.putSettings(caller, AGENT, request());
    await service.putSettings(caller, AGENT, {
      ...request(),
      push_attached: "deny",
    });
    expect(puts[0]?.pushAttached).toBeUndefined();
    expect(puts[1]?.pushAttached).toBe("deny");
  });

  test("only a signed-in console user may save; an API key is refused", async () => {
    const { service, puts } = serviceWithPuts({});
    const keyCaller = callerFor(
      {
        kind: "user",
        id: "019a0000-0000-7000-8000-0000000000d1",
        workspace_id: WORKSPACE,
        role: "owner",
        scopes: ["sessions:read", "sessions:write"],
      },
      { kind: "api" },
      crypto.randomUUID(),
    );
    expect(
      await refusal(service.putSettings(keyCaller, AGENT, request())),
    ).toBe("FORBIDDEN:web_session_required");
    expect(puts).toHaveLength(0);
  });

  test("the fields hold together: an allow-list needs Actions, the start repository is listed", async () => {
    const { service, puts } = serviceWithPuts({});
    expect(
      await refusal(
        service.putSettings(
          caller,
          AGENT,
          request({
            settings: { ...SAVED, features: { ...GITHUB_FEATURES_NONE } },
          }),
        ),
      ),
    ).toBe("BAD_REQUEST:actions_off");
    expect(
      await refusal(
        service.putSettings(
          caller,
          AGENT,
          request({ start_repository_id: "elsewhere-app" }),
        ),
      ),
    ).toBe("BAD_REQUEST:start_repository_outside");
    expect(puts).toHaveLength(0);
  });

  test("a repository the save adds must be under the ceiling and an App one", async () => {
    const { service } = serviceWithPuts({
      repositoryCeiling: {
        repository_ids: [],
        github_app_repositories: "listed",
      },
    });
    expect(await refusal(service.putSettings(caller, AGENT, request()))).toBe(
      "BAD_REQUEST:repository_not_allowed",
    );
  });

  test("a repository the row holds stays, even when the ceiling dropped it", async () => {
    const { service } = serviceWithPuts({
      repositoryCeiling: {
        repository_ids: [],
        github_app_repositories: "listed",
      },
      current: HELD,
    });
    expect(
      await refusal(
        service.putSettings(caller, AGENT, request({ expected_revision: 2 })),
      ),
    ).toBe("saved");
  });

  test("a feature the save turns on must be under the feature ceiling; one already on may stay", async () => {
    const off = { ...ALL_ON, actions: false };
    expect(
      await refusal(
        serviceWithPuts({ ceiling: off }).service.putSettings(
          caller,
          AGENT,
          request(),
        ),
      ),
    ).toBe("BAD_REQUEST:over_workspace_ceiling");
    expect(
      await refusal(
        serviceWithPuts({ ceiling: off, current: HELD }).service.putSettings(
          caller,
          AGENT,
          request({ expected_revision: 2 }),
        ),
      ),
    ).toBe("saved");
  });

  test("a stale revision answers REVISION_CONFLICT", async () => {
    const { service } = serviceWithPuts({
      outcome: { outcome: "conflict", revision: 5 },
    });
    expect(
      await refusal(
        service.putSettings(caller, AGENT, request({ expected_revision: 4 })),
      ),
    ).toBe("REVISION_CONFLICT:");
  });

  test("duplicate repositories are saved once", async () => {
    const { service, puts } = serviceWithPuts({});
    await service.putSettings(
      caller,
      AGENT,
      request({
        settings: { ...SAVED, repositories: ["sample-app", "sample-app"] },
      }),
    );
    expect(puts[0]?.settings.repositories).toEqual(["sample-app"]);
  });
});

describe("repositories read as owner/repo", () => {
  test("a repository the catalog dropped still answers; one it never held does not", async () => {
    const asked: string[][] = [];
    const read = await serviceWith({
      github: {
        ...WITH_SETTINGS,
        repositories: ["sample-app", "gone", "nope"],
      },
      store: {
        repositoryNames: (ids) => {
          asked.push([...ids]);
          return Promise.resolve(new Map([["gone", "acme/old-name"]]));
        },
      },
    }).get(caller, AGENT);
    expect(read.selected_repositories).toEqual([
      {
        id: "sample-app",
        repository: "acme/sample-app",
        private: null,
        ref: repositoryRefOf("sample-app"),
      },
      {
        id: "gone",
        repository: "acme/old-name",
        private: null,
        ref: repositoryRefOf("gone"),
      },
      {
        id: "nope",
        repository: null,
        private: null,
        ref: repositoryRefOf("nope"),
      },
    ]);
    // Only the ids the live catalog lacks go to the table.
    expect(asked).toEqual([["gone", "nope"]]);
  });

  test("a ref hides the catalog id and gives it back only to its own reader", () => {
    const ref = repositoryRefOf("sample-app");
    expect(ref).not.toContain("sample-app");
    expect(catalogIdOfRef(ref)).toBe("sample-app");
    expect(catalogIdOfRef("sample-app")).toBeNull();
    expect(catalogIdOfRef("r1.")).toBeNull();
    expect(catalogIdOfRef(`${ref}x`)).toBeNull();
  });

  describe("putRepositoryAccess", () => {
    type Toggle = Parameters<AgentGitHubStore["setRepository"]>[0];
    const SAVED_TOGGLE = {
      outcome: "saved",
      revision: 5,
      receiptId: "receipt-5",
      repository: {
        id: "sample-app",
        owner: "octo",
        name: "sample",
        label: "octo/sample",
      },
      catalogChanged: false,
    } as const;
    const WEB_KEY = callerFor(
      {
        kind: "user",
        id: "019a0000-0000-7000-8000-0000000000d1",
        workspace_id: WORKSPACE,
        role: "owner",
        scopes: ["sessions:read", "sessions:write"],
      },
      { kind: "api" },
      crypto.randomUUID(),
    );
    const refusal = async (promise: Promise<unknown>) => {
      try {
        await promise;
      } catch (error) {
        const failure = error as {
          code: string;
          details?: { reason_code?: string; revision?: number | null };
        };
        return `${failure.code}:${failure.details?.reason_code ?? ""}`;
      }
      return "saved";
    };
    const serviceWithToggles = (input: {
      outcome?: Awaited<ReturnType<AgentGitHubStore["setRepository"]>>;
      /** What the store judges, as the real one does in its transaction. */
      enabling?: { id: string; authKind: string; via: "catalog" | "github" };
      ceiling?: RepositoryCeiling;
      selection?: Parameters<typeof serviceWith>[0]["selection"];
    }) => {
      const toggles: Toggle[] = [];
      const service = serviceWith({
        ...(input.selection === undefined
          ? {}
          : { selection: input.selection }),
        store: {
          async setRepository(toggle) {
            toggles.push(toggle);
            if (input.enabling !== undefined) {
              toggle.check(input.enabling, input.ceiling ?? DEFAULT_CEILING);
            }
            return input.outcome ?? SAVED_TOGGLE;
          },
        },
      });
      return { service, toggles };
    };
    const ref = repositoryRefOf("sample-app");

    test("a ref toggles a catalog repository with nothing compared by default", async () => {
      const { service, toggles } = serviceWithToggles({});
      const result = await service.putRepositoryAccess(caller, AGENT, {
        repository: { ref },
        enabled: true,
      });
      expect(result).toEqual({
        settings_revision: 5,
        receipt_id: "receipt-5",
        enabled: true,
        repository: { ref, repository: "octo/sample", private: null },
      });
      expect(toggles).toHaveLength(1);
      expect(toggles[0]).toMatchObject({
        agentId: AGENT,
        enabled: true,
        expectedRevision: undefined,
        target: { kind: "catalog", id: "sample-app" },
        userId: caller.actor?.userId,
      });
    });

    test("null expected_revision is passed as null, not as left out", async () => {
      const { service, toggles } = serviceWithToggles({});
      await service.putRepositoryAccess(caller, AGENT, {
        repository: { ref },
        enabled: false,
        expected_revision: null,
      });
      expect(toggles[0]?.expectedRevision).toBeNull();
    });

    test("a ref the server did not make is refused before the store", async () => {
      const { service, toggles } = serviceWithToggles({});
      expect(
        await refusal(
          service.putRepositoryAccess(caller, AGENT, {
            // Not the canonical encoding of what it decodes to.
            repository: { ref: "r1.AB" },
            enabled: true,
          }),
        ),
      ).toBe("BAD_REQUEST:invalid_ref");
      expect(toggles).toHaveLength(0);
    });

    test("an API key is refused", async () => {
      const { service, toggles } = serviceWithToggles({});
      expect(
        await refusal(
          service.putRepositoryAccess(WEB_KEY, AGENT, {
            repository: { ref },
            enabled: true,
          }),
        ),
      ).toBe("FORBIDDEN:web_session_required");
      expect(toggles).toHaveLength(0);
    });

    test("the ceiling judges what is turned on: ids, and under `installed` every App row", async () => {
      const turnOn = (
        enabling: { id: string; authKind: string; via: "catalog" | "github" },
        ceiling: RepositoryCeiling,
      ) =>
        refusal(
          serviceWithToggles({ enabling, ceiling }).service.putRepositoryAccess(
            caller,
            AGENT,
            { repository: { ref }, enabled: true },
          ),
        );
      const installed: RepositoryCeiling = {
        repository_ids: [],
        github_app_repositories: "installed",
      };
      const listed: RepositoryCeiling = {
        repository_ids: ["sample-app"],
        github_app_repositories: "listed",
      };
      expect(
        await turnOn(
          { id: "sample-app", authKind: "github_app", via: "catalog" },
          installed,
        ),
      ).toBe("saved");
      // Listed by id: an existing row may be turned on again, as a PUT allows.
      expect(
        await turnOn(
          { id: "sample-app", authKind: "github_app", via: "catalog" },
          listed,
        ),
      ).toBe("saved");
      expect(
        await turnOn(
          { id: "other", authKind: "github_app", via: "catalog" },
          listed,
        ),
      ).toBe("BAD_REQUEST:repository_not_allowed");
      // An own-App row is a GitHub App's too: an `installed` ceiling opens it.
      expect(
        await turnOn(
          { id: "own", authKind: "github_app_explicit", via: "catalog" },
          installed,
        ),
      ).toBe("saved");
      expect(
        await turnOn(
          { id: "sample-app", authKind: "basic", via: "catalog" },
          listed,
        ),
      ).toBe("BAD_REQUEST:app_required");
      // A pick from an installation needs a ceiling on the App's repositories.
      expect(
        await turnOn(
          { id: "sample-app", authKind: "github_app", via: "github" },
          listed,
        ),
      ).toBe("BAD_REQUEST:repository_not_allowed");
    });

    test("the store's refusals become the API's", async () => {
      const answer = (
        outcome: Awaited<ReturnType<AgentGitHubStore["setRepository"]>>,
      ) =>
        refusal(
          serviceWithToggles({ outcome }).service.putRepositoryAccess(
            caller,
            AGENT,
            { repository: { ref }, enabled: true },
          ),
        );
      expect(await answer({ outcome: "conflict", revision: 3 })).toBe(
        "REVISION_CONFLICT:",
      );
      expect(await answer({ outcome: "seed_unavailable" })).toBe(
        "REVISION_CONFLICT:settings_seed_unavailable",
      );
      expect(await answer({ outcome: "name_held", id: "x" })).toBe(
        "BAD_REQUEST:name_held",
      );
      expect(await answer({ outcome: "repository_not_found" })).toBe(
        "BAD_REQUEST:repository_not_found",
      );
      expect(await answer({ outcome: "not_found" })).toBe("NOT_FOUND:");
    });

    test("a conflict names the revision to read again", async () => {
      const { service } = serviceWithToggles({
        outcome: { outcome: "conflict", revision: 7 },
      });
      let details: unknown;
      try {
        await service.putRepositoryAccess(caller, AGENT, {
          repository: { ref },
          enabled: true,
          expected_revision: 2,
        });
      } catch (error) {
        details = (error as { details?: unknown }).details;
      }
      expect(details).toEqual({ revision: 7 });
    });

    test("a pick from an installation goes to the store with GitHub's answer and the catalog reloads", async () => {
      let reloads = 0;
      let ids = 0;
      const { service, toggles } = serviceWithToggles({
        outcome: { ...SAVED_TOGGLE, catalogChanged: true },
        selection: async () =>
          ({
            repository: {
              id: 42,
              owner: "octo",
              name: "Sample",
              defaultBranch: "trunk",
            },
            app: { id: "conn-1", appId: 9 },
            base: "sample",
            url: "https://github.com/octo/Sample.git",
            pinning: true,
            reload: async () => {
              reloads += 1;
            },
            newId: () => `id-${++ids}`,
          }) as never,
      });
      await service.putRepositoryAccess(caller, AGENT, {
        repository: { installation_id: 7, github_repository_id: 42 },
        enabled: true,
      });
      expect(toggles[0]?.target).toEqual({
        kind: "github",
        resolve: {
          base: "sample",
          githubRepositoryId: 42,
          owner: "octo",
          name: "Sample",
          url: "https://github.com/octo/Sample.git",
          branch: "trunk",
          receiptId: "id-1",
        },
        pin: { connectionId: "conn-1", appId: 9, receiptId: "id-2" },
      });
      expect(reloads).toBe(1);
    });

    test("without an App store nothing is pinned, and without a selection a pick is refused", async () => {
      const noPin = serviceWithToggles({
        selection: async () =>
          ({
            repository: { id: 1, owner: "o", name: "r", defaultBranch: "main" },
            app: { id: "c", appId: 1 },
            base: "r",
            url: "https://github.com/o/r.git",
            pinning: false,
            reload: async () => {},
            newId: () => "n",
          }) as never,
      });
      await noPin.service.putRepositoryAccess(caller, AGENT, {
        repository: { installation_id: 1, github_repository_id: 1 },
        enabled: true,
      });
      expect(noPin.toggles[0]?.target).toMatchObject({ pin: null });
      const none = serviceWithToggles({});
      expect(
        await refusal(
          none.service.putRepositoryAccess(caller, AGENT, {
            repository: { installation_id: 1, github_repository_id: 1 },
            enabled: true,
          }),
        ),
      ).toBe("BAD_REQUEST:no_author_app");
      expect(none.toggles).toHaveLength(0);
    });
  });

  test("activity names the repository: the receipt's own name, then the catalog's now", async () => {
    const receipt = (id: string, result: unknown) => ({
      id,
      operation: "mint_github_token",
      target_ref: { session_id: "s" },
      status: "succeeded",
      result,
      error: null,
      created_at: "2026-11-08T00:00:00Z",
      updated_at: "2026-11-08T00:00:00Z",
    });
    const asked: string[][] = [];
    const response = await serviceWith({
      store: {
        activity: () =>
          Promise.resolve([
            receipt("new", { repository: "acme/new", repository_id: "a" }),
            receipt("then", { full_name: "acme/then", repository_id: "b" }),
            receipt("old", { repository_id: "removed" }),
            receipt("lost", { repository_id: "never" }),
            receipt("none", { purpose: "mint" }),
            receipt("empty", null),
          ] as never),
        repositoryNames: (ids) => {
          asked.push([...ids]);
          return Promise.resolve(new Map([["removed", "acme/was-removed"]]));
        },
      },
    }).activity(caller, AGENT);
    expect(response.receipt_repositories).toEqual([
      { receipt_id: "new", repository: "acme/new" },
      { receipt_id: "then", repository: "acme/then" },
      { receipt_id: "old", repository: "acme/was-removed" },
    ]);
    expect(response.items).toHaveLength(6);
    // A receipt that already names its repository is not looked up.
    expect(asked).toEqual([["removed", "never"]]);
  });
});
