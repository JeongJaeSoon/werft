import { describe, expect, test } from "bun:test";
import {
  type AgentGitHub,
  type AgentGitHubFeatures,
  type AgentGitHubSettings,
  type EffectiveGitHubPolicy,
  GITHUB_CEILING_NONE,
  GITHUB_FEATURES_NONE,
  GITHUB_POLICY_CLOSED,
  type GitHubAppRole,
  type GitHubCeiling,
  type GitHubRefusal,
  newSessionGitHubPolicy,
  type RepositoryCeiling,
} from "@werft-ai/contracts";
import {
  ForgeCredentialError,
  type GitCredential,
  type RepoRef,
} from "../../action/ports/forge.ts";
import type { GitHubApi } from "../../action/ports/github-api.ts";
import type { SessionCatalog } from "../../catalog/catalog.ts";
import { agentPolicy, releasePolicy } from "../../testing/github-fakes.ts";
import type {
  GitHubPinStore,
  GitHubRepositoryPin,
} from "../ports/github-app-store.ts";
import {
  type GitHubConnection,
  type GitHubConnections,
  type GitHubDispatchRecord,
  GitHubGateError,
  type GitHubGateReceipt,
  type GitHubGateStore,
  GitHubPermissionError,
  type GitHubPermissions,
  type GitHubSessionContext,
  type GitHubTokenUse,
  type GitHubWork,
  type RegisteredGitHubConnection,
} from "../ports/github-gate.ts";
import {
  createGitHubConnectionResolver,
  type GitHubConnectionResolver,
} from "./github-connection-resolver.ts";
import { createGitHubGate } from "./github-gate.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const STARTER = "019a0000-0000-7000-8000-0000000000b1";
const ALL_ON: GitHubCeiling = {
  workflows: true,
  actions: true,
  checks: true,
  issues: true,
  review: true,
  merge: true,
};

const CATALOG = {
  connections: {},
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
    ghes: {
      url: "https://ghe.example.com/acme/app.git",
      branch: "main",
      auth: {
        kind: "github_app",
        app_id: 7,
        installation_id: 70,
        api_base: "https://ghe.example.com/api/v3",
        value: "pem",
        ref: { stored: "repository:ghes" },
      },
    },
  },
} satisfies SessionCatalog;

function features(on: Partial<AgentGitHubFeatures> = {}): AgentGitHubFeatures {
  return { ...GITHUB_FEATURES_NONE, ...on };
}

function settings(
  overrides: Partial<AgentGitHubSettings> = {},
): AgentGitHubSettings {
  return {
    repositories: ["app", "ghes"],
    push_approval: true,
    features: features(),
    actions_allow: [],
    ...overrides,
  };
}

function fakeApi(): GitHubApi {
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    maxBodyLength: 65_536,
    getRepository: unused,
    getBranchHead: unused,
    readTree: unused,
    readBlob: unused,
    findPullRequestForBranch: unused,
    findPullRequestsForBranch: unused,
    isAncestor: unused,
    createPullRequest: unused,
    getPullRequest: unused,
    updatePullRequestBody: unused,
    setPullRequestState: unused,
    mergePullRequest: unused,
    upsertComment: unused,
    dispatchWorkflow: unused,
    getWorkflowRun: unused,
    getCommitCi: unused,
    rerunWorkflow: unused,
    submitReview: unused,
  };
}

/** A connection with its own cache; each issued value names the connection. */
function fakeConnection(
  label: string,
  options: {
    githubCom?: boolean;
    appId?: number;
    installed?: boolean | null;
    /** What the installation grants; a token asking past it is refused (422). */
    granted?: GitHubPermissions;
  } = {},
) {
  const issued: Array<{
    repo: RepoRef;
    permissions: GitHubPermissions;
    use: GitHubTokenUse;
  }> = [];
  const cache = new Map<string, GitCredential>();
  let refuse = false;
  const connection: GitHubConnection = {
    kind: "app",
    githubCom: options.githubCom ?? true,
    appId: options.appId ?? 7,
    installedOn: async (repos) =>
      new Map(
        repos.map((repo) => [
          `${repo.owner}/${repo.name}`.toLowerCase(),
          options.installed === undefined ? true : options.installed,
        ]),
      ),
    quotaKey: async () => `${label}:quota`,
    installed: async () =>
      options.installed === undefined ? true : options.installed,
    credential: async (repo, permissions, use) => {
      issued.push({ repo, permissions, use });
      if (refuse) throw new GitHubPermissionError("422");
      const { granted } = options;
      if (
        granted !== undefined &&
        Object.entries(permissions).some(
          ([name, level]) =>
            granted[name] === undefined ||
            (level === "write" && granted[name] !== "write"),
        )
      ) {
        throw new GitHubPermissionError("422");
      }
      const key = JSON.stringify([repo, permissions, use]);
      const cached = cache.get(key);
      if (cached !== undefined) return { credential: cached, fresh: false };
      const made: GitCredential = {
        username: "x-access-token",
        password: `${label}-${cache.size + 1}`,
        expiresAt: new Date("2026-10-30T01:00:00.000Z"),
      };
      cache.set(key, made);
      return { credential: made, fresh: true };
    },
    api: () => fakeApi(),
    grantedPermissions: async () => options.granted ?? null,
  };
  return {
    connection,
    issued,
    refusePermissions: () => {
      refuse = true;
    },
  };
}

function harness(
  options: {
    repositoryId?: string | null;
    /** Default: the catalog entry's URL and branch. */
    repository?: { url: string; branch: string } | null;
    attached?: string[] | null;
    github?: AgentGitHubSettings | "invalid" | null;
    /** Beats `github`: a session under the agent's settings. */
    policy?: EffectiveGitHubPolicy;
    repositoryCeiling?: RepositoryCeiling | null;
    githubEnabled?: boolean;
    ceiling?: GitHubCeiling;
    author?: ReturnType<typeof fakeConnection> | null;
    reviewer?: ReturnType<typeof fakeConnection> | null;
    dispatches?: GitHubDispatchRecord[];
    catalog?: SessionCatalog;
    registered?: Partial<
      Record<GitHubAppRole, readonly RegisteredGitHubConnection[]>
    >;
    pins?: Pick<GitHubPinStore, "get" | "pinFirst">;
  } = {},
) {
  const catalog = options.catalog ?? CATALOG;
  const author =
    options.author === undefined ? fakeConnection("author") : options.author;
  const reviewer =
    options.reviewer === undefined
      ? fakeConnection("reviewer", { appId: 8 })
      : options.reviewer;
  const ghes = fakeConnection("ghes", { githubCom: false });
  const state = {
    repositoryId:
      options.repositoryId === undefined ? "app" : options.repositoryId,
    attached: options.attached ?? null,
    github: options.github === undefined ? settings() : options.github,
    policy: options.policy,
    githubEnabled: options.githubEnabled ?? true,
    ceiling: options.ceiling ?? GITHUB_CEILING_NONE,
    // The workspace ceiling judges every session; by default it holds every
    // repository the fixtures name.
    repositoryCeiling:
      options.repositoryCeiling === undefined
        ? ({
            repository_ids: ["app", "ghes", "docs", "tools"],
            github_app_repositories: "listed",
          } satisfies RepositoryCeiling)
        : options.repositoryCeiling,
  };
  const pinned =
    state.repositoryId !== null &&
    Object.hasOwn(CATALOG.repositories, state.repositoryId)
      ? CATALOG.repositories[
          state.repositoryId as keyof typeof CATALOG.repositories
        ]
      : null;
  const repository =
    options.repository !== undefined
      ? options.repository
      : pinned === null
        ? null
        : { url: pinned.url, branch: pinned.branch };
  const receipts: GitHubGateReceipt[] = [];
  const asked: Array<{ repositoryId: string; role: GitHubAppRole }> = [];
  const store: GitHubGateStore = {
    context: async (sessionId): Promise<GitHubSessionContext | null> =>
      sessionId !== SESSION
        ? null
        : {
            ownerId: "owner-a",
            sessionId,
            repositoryId: state.repositoryId,
            attachedRepositoryIds: state.attached,
            repository,
            startedBy: STARTER,
            agent: {
              id: "agent-1",
              workspaceId: "owner-a",
              githubEnabled: state.githubEnabled,
            },
            release: { id: "release-1" },
            policy: state.policy ?? releasePolicy(state.github),
            ceiling: state.ceiling,
            repositoryCeiling: state.repositoryCeiling,
            ceilingRevision: 0,
          },
    findDispatch: async (repositoryId, runId) =>
      (options.dispatches ?? []).find(
        (record) =>
          record.repositoryId === repositoryId && record.runId === runId,
      ) ?? null,
    recordReceipt: async (receipt) => {
      receipts.push(receipt);
      return `receipt-${receipts.length}`;
    },
  };
  const connections: GitHubConnections = (repositoryId, role) => {
    asked.push({ repositoryId, role });
    if (repositoryId === "ghes") {
      return { kind: "fixed", connection: ghes.connection };
    }
    if (!["app", "docs", "tools"].includes(repositoryId)) return null;
    const registered = options.registered?.[role];
    if (registered !== undefined) {
      return { kind: "registered", candidates: registered };
    }
    const connection = (role === "author" ? author : reviewer)?.connection;
    return connection === undefined ? null : { kind: "fixed", connection };
  };
  const gate = createGitHubGate({
    store,
    catalog,
    connections,
    ...(options.pins === undefined
      ? {}
      : {
          resolver: createGitHubConnectionResolver({
            connections,
            pins: options.pins,
          }),
        }),
  });
  const grant = (work: Omit<GitHubWork, "sessionId">) =>
    gate.grant({ sessionId: SESSION, ...work });
  return { gate, grant, state, receipts, asked, author, reviewer, ghes };
}

async function refused(
  promise: Promise<unknown>,
): Promise<{ reason: GitHubRefusal; receiptId: string | null }> {
  const error = await promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(GitHubGateError);
  const { reasonCode, receiptId } = error as GitHubGateError;
  return { reason: reasonCode, receiptId };
}

describe("permission table", () => {
  test("clone asks contents:read from the author App", async () => {
    const { grant, author } = harness();
    const granted = await grant({ purpose: "clone" });
    expect(granted).toMatchObject({
      role: "author",
      repo: { owner: "acme", name: "app" },
      permissions: { contents: "read" },
      allowedBy: null,
    });
    expect(author?.issued.map((call) => call.permissions)).toEqual([
      { contents: "read" },
    ]);
  });

  test("push asks contents:write, plus workflows:write when workflows is on under the ceiling", async () => {
    const plain = harness();
    expect((await plain.grant({ purpose: "push" }))?.permissions).toEqual({
      contents: "write",
    });
    const withWorkflows = harness({
      github: settings({ features: features({ workflows: true }) }),
      ceiling: ALL_ON,
    });
    expect(
      (await withWorkflows.grant({ purpose: "push" }))?.permissions,
    ).toEqual({ contents: "write", workflows: "write" });
  });

  test("push drops workflows:write when workflows is over the ceiling, and is not refused", async () => {
    const { grant, receipts } = harness({
      github: settings({ features: features({ workflows: true }) }),
      ceiling: GITHUB_CEILING_NONE,
    });
    expect((await grant({ purpose: "push" }))?.permissions).toEqual({
      contents: "write",
    });
    expect(receipts.map((receipt) => receipt.status)).toEqual(["succeeded"]);
  });

  test("pull_request asks contents:read and pull_requests:write", async () => {
    const { grant } = harness();
    expect((await grant({ purpose: "pull_request" }))?.permissions).toEqual({
      contents: "read",
      pull_requests: "write",
    });
  });

  test("actions_read asks actions:read and checks:read, under the workflows switch", async () => {
    const { grant } = harness({
      github: settings({ features: features({ workflows: true }) }),
      ceiling: ALL_ON,
    });
    expect((await grant({ purpose: "actions_read" }))?.permissions).toEqual({
      actions: "read",
      checks: "read",
    });
    // The switch for running workflows does not read them.
    const runOnly = harness({
      github: settings({ features: features({ actions: true }) }),
      ceiling: ALL_ON,
    });
    expect(
      (await refused(runOnly.grant({ purpose: "actions_read" }))).reason,
    ).toBe("feature_off");
  });

  test("with only the workflows switch on no token asks actions:write; turning on direct runs does", async () => {
    const allow = [{ workflow: "ci.yml" }];
    const dispatch = {
      purpose: "dispatch",
      workflow: { file: "ci.yml", ref: "main" },
    } as const;
    const editOnly = harness({
      github: settings({
        features: features({ workflows: true, checks: true }),
        actions_allow: allow,
      }),
      ceiling: ALL_ON,
    });
    await editOnly.grant({ purpose: "push" });
    await editOnly.grant({ purpose: "actions_read" });
    expect((await refused(editOnly.grant(dispatch))).reason).toBe(
      "actions_off",
    );
    expect(
      editOnly.author?.issued.filter(
        ({ permissions }) => permissions.actions === "write",
      ),
    ).toEqual([]);
    const withRuns = harness({
      github: settings({
        features: features({ workflows: true, checks: true, actions: true }),
        actions_allow: allow,
      }),
      ceiling: ALL_ON,
    });
    expect((await withRuns.grant(dispatch))?.permissions).toEqual({
      actions: "write",
    });
  });

  test("a release pin's old actions with no saved switch edits workflows and reads CI, but dispatch is actions_off (94S-2406)", async () => {
    // As a release activated before the switches pinned it, never saved since.
    const oldPin = settings({
      features: features({ actions: true }),
      actions_allow: [{ workflow: "ci.yml" }],
    });
    const dispatch = {
      purpose: "dispatch",
      workflow: { file: "ci.yml", ref: "main" },
    } as const;
    const onCeiling = harness({
      policy: newSessionGitHubPolicy(null, oldPin),
      ceiling: ALL_ON,
    });
    expect((await onCeiling.grant({ purpose: "push" }))?.permissions).toEqual({
      contents: "write",
      workflows: "write",
    });
    expect(
      (await onCeiling.grant({ purpose: "actions_read" }))?.permissions,
    ).toEqual({ actions: "read", checks: "read" });
    expect((await refused(onCeiling.grant(dispatch))).reason).toBe(
      "actions_off",
    );
    expect(
      onCeiling.author?.issued.filter(
        ({ permissions }) => permissions.actions === "write",
      ),
    ).toEqual([]);
    // The ceiling still holds the workflow push it turned on.
    const noWorkflows = harness({
      policy: newSessionGitHubPolicy(null, oldPin),
      ceiling: { ...ALL_ON, workflows: false },
    });
    expect((await noWorkflows.grant({ purpose: "push" }))?.permissions).toEqual(
      { contents: "write" },
    );
  });

  test("push with workflows on falls back to contents:write only when the installation has not granted Workflows", async () => {
    const author = fakeConnection("author", {
      granted: { contents: "write", pull_requests: "write" },
    });
    const { grant, receipts } = harness({
      author,
      github: settings({ features: features({ workflows: true }) }),
      ceiling: ALL_ON,
    });
    const pushed = await grant({ purpose: "push" });
    expect(pushed?.permissions).toEqual({ contents: "write" });
    // Says the App lacks it, so a refused workflow change names the App.
    expect(pushed?.workflowsUngranted).toBe(true);
    expect(pushed?.workflowsOff).toBeUndefined();
    expect(author.issued.map(({ permissions }) => permissions)).toEqual([
      { contents: "write", workflows: "write" },
      { contents: "write" },
    ]);
    expect(receipts.at(-1)).toMatchObject({
      status: "succeeded",
      result: { permissions: { contents: "write" } },
    });
  });

  test("an installation that grants Workflows but still refuses is app_permission_missing, not a narrower push", async () => {
    const author = fakeConnection("author", {
      granted: { contents: "write", workflows: "write" },
    });
    author.refusePermissions();
    const { grant } = harness({
      author,
      github: settings({ features: features({ workflows: true }) }),
      ceiling: ALL_ON,
    });
    expect((await refused(grant({ purpose: "push" }))).reason).toBe(
      "app_permission_missing",
    );
    expect(author.issued).toHaveLength(1);
  });

  test("a push whose installation permissions cannot be read keeps app_permission_missing", async () => {
    for (const lookup of [
      async () => null,
      async () => {
        throw new Error("GitHub 502");
      },
    ]) {
      const author = fakeConnection("author");
      author.refusePermissions();
      const { grant } = harness({
        author: {
          ...author,
          connection: { ...author.connection, grantedPermissions: lookup },
        },
        github: settings({ features: features({ workflows: true }) }),
        ceiling: ALL_ON,
      });
      expect((await refused(grant({ purpose: "push" }))).reason).toBe(
        "app_permission_missing",
      );
      expect(author.issued).toHaveLength(1);
    }
  });

  test("only a push falls back: reading CI without the installation's checks is app_permission_missing", async () => {
    const author = fakeConnection("author", {
      granted: { contents: "write", actions: "read" },
    });
    const { grant } = harness({
      author,
      github: settings({ features: features({ workflows: true }) }),
      ceiling: ALL_ON,
    });
    expect((await refused(grant({ purpose: "actions_read" }))).reason).toBe(
      "app_permission_missing",
    );
    expect(author.issued).toHaveLength(1);
  });

  test("an App from before CI reads were asked for (contents and pull requests only) is refused a CI read as app_permission_missing, with a receipt (94S-2492)", async () => {
    const author = fakeConnection("author", {
      granted: { contents: "write", pull_requests: "write", metadata: "read" },
    });
    const { grant, receipts } = harness({
      author,
      github: settings({
        features: features({ workflows: true, checks: true }),
      }),
      ceiling: ALL_ON,
    });
    expect(await refused(grant({ purpose: "actions_read" }))).toEqual({
      reason: "app_permission_missing",
      receiptId: "receipt-1",
    });
    // Asked once for exactly the read, and not again for less.
    expect(author.issued.map(({ permissions }) => permissions)).toEqual([
      { actions: "read", checks: "read" },
    ]);
    expect(receipts).toMatchObject([
      {
        operation: "mint_github_token",
        status: "failed",
        result: {
          purpose: "actions_read",
          reason_code: "app_permission_missing",
          role: "author",
        },
        error: { code: "GITHUB_REFUSED" },
      },
    ]);
    // What the App already held still works.
    expect((await grant({ purpose: "pull_request" }))?.permissions).toEqual({
      contents: "read",
      pull_requests: "write",
    });
  });

  test("dispatch and rerun ask actions:write", async () => {
    const { grant } = harness({
      github: settings({
        features: features({ actions: true }),
        actions_allow: [{ workflow: "ci.yml" }],
      }),
      ceiling: ALL_ON,
      dispatches: [
        { runId: 5, repositoryId: "app", workflow: "ci.yml", ref: "main" },
      ],
    });
    const dispatched = await grant({
      purpose: "dispatch",
      workflow: { file: "ci.yml", ref: "main" },
    });
    expect(dispatched).toMatchObject({
      permissions: { actions: "write" },
      allowedBy: { workflow: "ci.yml" },
    });
    expect((await grant({ purpose: "rerun", runId: 5 }))?.permissions).toEqual({
      actions: "write",
    });
  });

  test("review takes the reviewer App's credential", async () => {
    const { grant, author, reviewer, receipts } = harness({
      github: settings({ features: features({ review: true }) }),
      ceiling: ALL_ON,
    });
    const granted = await grant({ purpose: "review" });
    expect(granted).toMatchObject({
      role: "reviewer",
      permissions: { contents: "read", pull_requests: "write" },
    });
    expect(granted?.gitCredential.password).toBe("reviewer-1");
    expect(author?.issued).toEqual([]);
    expect(reviewer?.issued).toHaveLength(1);
    expect(receipts[0]?.result).toMatchObject({ role: "reviewer", app_id: 8 });
  });

  test("a refused review is a review_pull_request receipt naming the pull request and commit", async () => {
    const { grant, receipts, reviewer } = harness({
      github: settings({ features: features({ review: true }) }),
      ceiling: ALL_ON,
      reviewer: null,
    });
    const review = {
      number: 12,
      commitId: "a".repeat(40),
      event: "APPROVE" as const,
    };
    expect(await refused(grant({ purpose: "review", review }))).toEqual({
      reason: "no_reviewer_app",
      receiptId: "receipt-1",
    });
    expect(reviewer).toBeNull();
    expect(receipts[0]).toMatchObject({
      operation: "review_pull_request",
      status: "failed",
      result: {
        reason_code: "no_reviewer_app",
        number: 12,
        commit_id: "a".repeat(40),
        event: "APPROVE",
      },
    });
  });

  test("outcome_refresh asks pull_requests:read and skips switch, scope, feature and ceiling", async () => {
    const { grant } = harness({
      githubEnabled: false,
      github: settings({ repositories: ["ghes"] }),
      ceiling: GITHUB_CEILING_NONE,
    });
    expect(await grant({ purpose: "outcome_refresh" })).toMatchObject({
      role: "author",
      permissions: { pull_requests: "read" },
    });
  });

  test("pull_request_read asks pull_requests:read alone, and goes through the agent's switch and scope (94S-1453)", async () => {
    const { grant } = harness();
    const read = await grant({ purpose: "pull_request_read" });
    expect(read?.role).toBe("author");
    expect(read?.permissions).toEqual({ pull_requests: "read" });
    expect(
      (
        await refused(
          harness({ githubEnabled: false }).grant({
            purpose: "pull_request_read",
          }),
        )
      ).reason,
    ).toBe("github_disabled");
    expect(
      (
        await refused(
          harness({ github: settings({ repositories: ["ghes"] }) }).grant({
            purpose: "pull_request_read",
          }),
        )
      ).reason,
    ).toBe("repository_not_allowed");
  });
});

describe("refusals", () => {
  const cases: Array<{
    reason: GitHubRefusal;
    setup: Parameters<typeof harness>[0];
    work: Omit<GitHubWork, "sessionId">;
  }> = [
    {
      reason: "github_disabled",
      setup: { githubEnabled: false },
      work: { purpose: "clone" },
    },
    {
      reason: "repository_not_allowed",
      setup: { github: settings({ repositories: ["ghes"] }) },
      work: { purpose: "push" },
    },
    {
      reason: "feature_off",
      setup: { ceiling: ALL_ON },
      work: { purpose: "actions_read" },
    },
    {
      reason: "over_workspace_ceiling",
      setup: { github: settings({ features: features({ workflows: true }) }) },
      work: { purpose: "actions_read" },
    },
    {
      reason: "over_workspace_ceiling",
      setup: {
        github: settings({
          features: features({ workflows: true, actions: true }),
          actions_allow: [{ workflow: "ci.yml" }],
        }),
        ceiling: { ...ALL_ON, actions: false },
      },
      work: { purpose: "dispatch", workflow: { file: "ci.yml", ref: "main" } },
    },
    ...(
      [
        { purpose: "dispatch", workflow: { file: "ci.yml", ref: "main" } },
        { purpose: "rerun", runId: 7 },
      ] as const
    ).map((work) => ({
      reason: "actions_off" as const,
      setup: {
        github: settings({ features: features({ workflows: true }) }),
        ceiling: ALL_ON,
      },
      work,
    })),
    {
      reason: "review_off",
      setup: { ceiling: ALL_ON },
      work: {
        purpose: "review",
        review: { number: 1, commitId: "a".repeat(40), event: "APPROVE" },
      },
    },
    {
      reason: "no_reviewer_app",
      setup: {
        github: settings({ features: features({ review: true }) }),
        ceiling: ALL_ON,
        reviewer: null,
      },
      work: { purpose: "review" },
    },
    {
      reason: "workflow_not_allowed",
      setup: {
        github: settings({
          features: features({ actions: true }),
          actions_allow: [{ workflow: "ci.yml" }],
        }),
        ceiling: ALL_ON,
      },
      work: {
        purpose: "dispatch",
        workflow: { file: "deploy.yml", ref: "main" },
      },
    },
    {
      reason: "agent_ref_refused",
      setup: {
        github: settings({
          features: features({ actions: true }),
          actions_allow: [{ workflow: "ci.yml", ref: "*" }],
        }),
        ceiling: ALL_ON,
      },
      work: {
        purpose: "dispatch",
        workflow: { file: "ci.yml", ref: `agent/${SESSION}` },
      },
    },
    {
      reason: "run_ref_unprovable",
      setup: {
        github: settings({
          features: features({ actions: true }),
          actions_allow: [{ workflow: "ci.yml" }],
        }),
        ceiling: ALL_ON,
      },
      work: { purpose: "rerun", runId: 404 },
    },
    {
      reason: "github_settings_unsupported",
      setup: { github: "invalid" },
      work: { purpose: "clone" },
    },
    {
      reason: "github_host_unsupported",
      setup: {
        repositoryId: "ghes",
        github: settings({
          features: features({ actions: true }),
          actions_allow: [{ workflow: "ci.yml" }],
        }),
        ceiling: ALL_ON,
      },
      work: { purpose: "dispatch", workflow: { file: "ci.yml", ref: "main" } },
    },
    {
      reason: "repository_none",
      setup: { repositoryId: null },
      work: { purpose: "clone" },
    },
    ...(
      [
        { purpose: "dispatch", workflow: { file: "ci.yml", ref: "main" } },
        { purpose: "rerun", runId: 7 },
        { purpose: "actions_read" },
        {
          purpose: "review",
          review: { number: 1, commitId: "a".repeat(40), event: "COMMENT" },
        },
      ] as const
    ).map((work) => ({
      reason: "workflow_review_need_session_repository" as const,
      setup: { repositoryId: null },
      work,
    })),
  ];

  for (const { reason, setup, work } of cases) {
    test(`${reason}: refused with a receipt naming it, no credential issued`, async () => {
      const { grant, receipts, author, reviewer, ghes } = harness(setup);
      expect(await refused(grant(work))).toEqual({
        reason,
        receiptId: "receipt-1",
      });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        status: "failed",
        result: { reason_code: reason, purpose: work.purpose },
        error: { code: "GITHUB_REFUSED" },
      });
      expect(author?.issued ?? []).toEqual([]);
      expect(reviewer?.issued ?? []).toEqual([]);
      expect(ghes.issued).toEqual([]);
    });
  }

  test("app_permission_missing: GitHub refusing the permissions is a refusal with a receipt", async () => {
    const author = fakeConnection("author");
    author.refusePermissions();
    const { grant, receipts } = harness({ author });
    expect(await refused(grant({ purpose: "push" }))).toEqual({
      reason: "app_permission_missing",
      receiptId: "receipt-1",
    });
    expect(receipts[0]).toMatchObject({
      operation: "mint_github_token",
      status: "failed",
      result: { reason_code: "app_permission_missing" },
    });
  });

  test("a refusal receipt names the operation of the work: dispatch_workflow, rerun_workflow, mint_github_token", async () => {
    const off = { github: settings({ features: features() }), ceiling: ALL_ON };
    const dispatch = harness(off);
    await refused(
      dispatch.grant({
        purpose: "dispatch",
        workflow: { file: "ci.yml", ref: "main" },
      }),
    );
    const rerun = harness(off);
    await refused(rerun.grant({ purpose: "rerun", runId: 5 }));
    const clone = harness({ githubEnabled: false });
    await refused(clone.grant({ purpose: "clone" }));
    expect(
      [dispatch, rerun, clone].map(({ receipts }) => [
        receipts[0]?.operation,
        receipts[0]?.result.reason_code,
      ]),
    ).toEqual([
      ["dispatch_workflow", "actions_off"],
      ["rerun_workflow", "actions_off"],
      ["mint_github_token", "github_disabled"],
    ]);
    expect(dispatch.receipts[0]?.result).toMatchObject({
      workflow: "ci.yml",
      ref: "main",
    });
    expect(rerun.receipts[0]?.result).toMatchObject({ run_id: 5 });
  });

  test("a refusal receipt names the human who started the session unless the work names an actor", async () => {
    const { grant, receipts } = harness({ githubEnabled: false });
    await refused(grant({ purpose: "clone" }));
    await refused(grant({ purpose: "push", actor: null }));
    expect(receipts.map((receipt) => receipt.actor)).toEqual([
      {
        principal: { kind: "user", id: STARTER },
        actor_user_id: STARTER,
        agent_id: null,
      },
      null,
    ]);
  });
});

describe("credentials and receipts", () => {
  test("a fresh credential writes a mint_github_token receipt and a cached one does not", async () => {
    const { grant, receipts, author } = harness();
    const first = await grant({ purpose: "clone" });
    const second = await grant({ purpose: "clone" });
    expect(second?.gitCredential).toBe(first?.gitCredential as GitCredential);
    expect(author?.issued).toHaveLength(2);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      operation: "mint_github_token",
      status: "succeeded",
      error: null,
      result: {
        session_id: SESSION,
        agent_id: "agent-1",
        agent_release_id: "release-1",
        repository_id: "app",
        purpose: "clone",
        role: "author",
        app_id: 7,
        permissions: { contents: "read" },
        expires_at: "2026-10-30T01:00:00.000Z",
      },
    });
    expect(JSON.stringify(receipts)).not.toContain(
      first?.gitCredential.password ?? "?",
    );
  });

  test("a release read gets a contents:read token of its own and a receipt on the workspace; the session's clone still mints its own", async () => {
    const { gate, grant, receipts, author } = harness();
    const read = {
      ownerId: "owner-a",
      agentId: "agent-1",
      repositoryId: "app",
      actor: null,
    };
    const granted = await gate.releaseRead(read);
    expect(granted).not.toBeNull();
    expect(author?.issued).toEqual([
      {
        repo: granted?.repo as RepoRef,
        permissions: { contents: "read" },
        use: "release_instructions",
      },
    ]);
    expect(receipts).toEqual([
      {
        ownerId: "owner-a",
        sessionId: null,
        workspaceId: "owner-a",
        actor: null,
        operation: "mint_github_token",
        status: "succeeded",
        error: null,
        result: {
          agent_id: "agent-1",
          repository_id: "app",
          purpose: "release_instructions",
          role: "author",
          connection_id: null,
          app_id: 7,
          permissions: { contents: "read" },
          expires_at: "2026-10-30T01:00:00.000Z",
        },
      },
    ]);
    await gate.releaseRead(read);
    expect(receipts).toHaveLength(1);

    await grant({ purpose: "clone" });
    expect(author?.issued.at(-1)?.use).toBe("session");
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toMatchObject({
      sessionId: SESSION,
      operation: "mint_github_token",
      result: { purpose: "clone", permissions: { contents: "read" } },
    });
  });

  test("a release read of a repository the catalog lacks, or that no App serves, is null and issues nothing", async () => {
    const read = { ownerId: "owner-a", agentId: "agent-1", actor: null };
    const { gate, receipts } = harness();
    expect(
      await gate.releaseRead({ ...read, repositoryId: "gone" }),
    ).toBeNull();
    const without = harness({ author: null });
    expect(
      await without.gate.releaseRead({ ...read, repositoryId: "app" }),
    ).toBeNull();
    expect([...receipts, ...without.receipts]).toEqual([]);
  });

  test("the switch turned off refuses the next grant though the connection still caches a credential", async () => {
    const { grant, state, author } = harness();
    await grant({ purpose: "clone" });
    expect(author?.issued).toHaveLength(1);
    state.githubEnabled = false;
    expect((await refused(grant({ purpose: "clone" }))).reason).toBe(
      "github_disabled",
    );
    expect(author?.issued).toHaveLength(1);
  });

  test("lowering the ceiling makes the next grant over_workspace_ceiling and raising it restores it", async () => {
    const { grant, state } = harness({
      github: settings({ features: features({ workflows: true }) }),
      ceiling: ALL_ON,
    });
    expect(await grant({ purpose: "actions_read" })).not.toBeNull();
    state.ceiling = GITHUB_CEILING_NONE;
    expect((await refused(grant({ purpose: "actions_read" }))).reason).toBe(
      "over_workspace_ceiling",
    );
    state.ceiling = ALL_ON;
    expect((await grant({ purpose: "actions_read" }))?.permissions).toEqual({
      actions: "read",
      checks: "read",
    });
  });
});

describe("merge", () => {
  const MERGE_ON = settings({ features: features({ merge: true }) });
  const mergeRefused = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error("expected a refusal");
      },
      (caught: unknown) => {
        expect(caught).toBeInstanceOf(GitHubGateError);
        const { reasonCode, offIn } = caught as GitHubGateError;
        return { reason: reasonCode, offIn };
      },
    );

  test("off by default on both sides: merge_off before any credential is issued, and the receipt names no App", async () => {
    const { grant, receipts, author } = harness();
    expect(await mergeRefused(grant({ purpose: "merge" }))).toEqual({
      reason: "merge_off",
      offIn: "both",
    });
    expect(author?.issued).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      operation: "merge_pull_request",
      status: "failed",
      result: { purpose: "merge", reason_code: "merge_off", off_in: "both" },
    });
    for (const key of ["connection_id", "app_id", "role"]) {
      expect(receipts[0]?.result).not.toHaveProperty(key);
    }
  });

  test("merge_off names the side that is off: the agent's settings, the workspace ceiling, or both (94S-2492)", async () => {
    const everythingElse = features({
      workflows: true,
      actions: true,
      checks: true,
      issues: true,
      review: true,
    });
    for (const [github, ceiling, offIn] of [
      // The agent's other switches and the ceiling's do not stand in for it.
      [settings({ features: everythingElse }), ALL_ON, "agent"],
      [
        settings({ features: { ...everythingElse, merge: false } }),
        ALL_ON,
        "agent",
      ],
      // No settings at all (a release from before them) has no switch on.
      [null, ALL_ON, "agent"],
      [MERGE_ON, { ...ALL_ON, merge: false }, "ceiling"],
      [
        settings({ features: everythingElse }),
        { ...ALL_ON, merge: false },
        "both",
      ],
    ] as const) {
      const { grant, author, receipts } = harness({ github, ceiling });
      expect(await mergeRefused(grant({ purpose: "merge" }))).toEqual({
        reason: "merge_off",
        offIn,
      });
      expect(author?.issued).toEqual([]);
      expect(receipts.at(-1)?.result).toMatchObject({ off_in: offIn });
    }
  });

  test("with both on the grant asks contents write and pull_requests read and nothing else; either side turned off refuses the next one", async () => {
    const { grant, state, author, receipts } = harness({
      github: MERGE_ON,
      ceiling: { ...GITHUB_CEILING_NONE, merge: true },
    });
    const granted = await grant({ purpose: "merge" });
    expect(granted).toMatchObject({ role: "author" });
    expect(granted?.permissions).toEqual({
      contents: "write",
      pull_requests: "read",
    });
    expect(author?.issued).toHaveLength(1);
    state.ceiling = GITHUB_CEILING_NONE;
    expect((await mergeRefused(grant({ purpose: "merge" }))).offIn).toBe(
      "ceiling",
    );
    state.ceiling = { ...GITHUB_CEILING_NONE, merge: true };
    state.github = settings();
    expect((await mergeRefused(grant({ purpose: "merge" }))).offIn).toBe(
      "agent",
    );
    expect(author?.issued).toHaveLength(1);
    expect(receipts.map((receipt) => receipt.operation)).toEqual([
      "mint_github_token",
      "merge_pull_request",
      "merge_pull_request",
    ]);
  });

  test("the agent's merge switch gives no other work a wider token", async () => {
    const { grant } = harness({ github: MERGE_ON, ceiling: ALL_ON });
    expect((await grant({ purpose: "push" }))?.permissions).toEqual({
      contents: "write",
    });
    expect((await grant({ purpose: "pull_request" }))?.permissions).toEqual({
      contents: "read",
      pull_requests: "write",
    });
    expect((await refused(grant({ purpose: "review" }))).reason).toBe(
      "review_off",
    );
  });

  test("with the ceiling off the resolver is never asked: no pin read or written, no installation probed", async () => {
    const a = registered(CONNECTION_A, 101);
    const b = registered(CONNECTION_B, 102);
    const { pins } = memoryPins();
    const touched: string[] = [];
    const probed = (entry: typeof a.entry) => ({
      ...entry,
      connection: {
        ...entry.connection,
        installedOn: async (repos: readonly RepoRef[]) => {
          touched.push(`installedOn:${entry.id}`);
          return entry.connection.installedOn(repos);
        },
      },
    });
    const { grant } = harness({
      registered: { author: [probed(a.entry), probed(b.entry)] },
      pins: {
        get: async (...args) => {
          touched.push("pins.get");
          return pins.get(...args);
        },
        pinFirst: async (input) => {
          touched.push("pins.pinFirst");
          return pins.pinFirst(input);
        },
      },
    });
    expect((await refused(grant({ purpose: "merge" }))).reason).toBe(
      "merge_off",
    );
    expect(touched).toEqual([]);
    expect(a.fake.issued).toEqual([]);
    expect(b.fake.issued).toEqual([]);
  });

  test("another repository's pull request cannot be merged", async () => {
    const { grant, author } = harness({
      github: settings({
        repositories: ["app", "docs"],
        features: features({ merge: true }),
      }),
      ceiling: { ...GITHUB_CEILING_NONE, merge: true },
    });
    expect(
      (await refused(grant({ purpose: "merge", repositoryId: "docs" }))).reason,
    ).toBe("repository_not_allowed");
    expect(author?.issued).toEqual([]);
  });
});

describe("connections", () => {
  test("a GHES repository is granted clone, push and pull_request, but dispatch is github_host_unsupported", async () => {
    const { grant, ghes } = harness({
      repositoryId: "ghes",
      github: settings({
        features: features({ actions: true }),
        actions_allow: [{ workflow: "ci.yml" }],
      }),
      ceiling: ALL_ON,
    });
    for (const purpose of ["clone", "push", "pull_request"] as const) {
      expect(await grant({ purpose })).toMatchObject({
        role: "author",
        repo: { owner: "acme", name: "app" },
      });
    }
    expect(ghes.issued).toHaveLength(3);
    expect(
      (
        await refused(
          grant({
            purpose: "dispatch",
            workflow: { file: "ci.yml", ref: "main" },
          }),
        )
      ).reason,
    ).toBe("github_host_unsupported");
    expect(ghes.issued).toHaveLength(3);
  });

  test("two repositories with the same App id and repo name on different hosts never share credentials", async () => {
    const onApp = harness();
    const onGhes = harness({ repositoryId: "ghes" });
    const fromApp = await onApp.grant({ purpose: "clone" });
    const fromGhes = await onGhes.grant({ purpose: "clone" });
    expect(fromApp?.gitCredential.password).toBe("author-1");
    expect(fromGhes?.gitCredential.password).toBe("ghes-1");
    expect(onApp.asked.map((ask) => ask.repositoryId)).toEqual(["app"]);
    expect(onGhes.asked.map((ask) => ask.repositoryId)).toEqual(["ghes"]);
    expect(onApp.ghes.issued).toEqual([]);
    expect(onGhes.author?.issued).toEqual([]);
  });

  test("a catalog entry re-pointed after the session pinned it grants nothing", async () => {
    for (const repository of [
      { url: "https://github.com/acme/other.git", branch: "main" },
      { url: "https://github.com/acme/app.git", branch: "release" },
      null,
    ]) {
      const { grant, author, receipts } = harness({
        repository,
        github: settings({
          features: features({ actions: true }),
          actions_allow: [{ workflow: "ci.yml" }],
        }),
        ceiling: ALL_ON,
      });
      for (const work of [
        { purpose: "actions_read" },
        { purpose: "dispatch", workflow: { file: "ci.yml", ref: "main" } },
        { purpose: "clone" },
      ] as const) {
        await expect(grant(work)).rejects.toThrow(
          "The session's repository moved",
        );
      }
      expect(author?.issued).toEqual([]);
      expect(receipts).toEqual([]);
    }
  });

  test("a session the store does not know is not granted", async () => {
    const { gate } = harness();
    await expect(
      gate.grant({ sessionId: OTHER_SESSION, purpose: "clone" }),
    ).rejects.toThrow("The session was not found");
  });
});

describe("workflow allow-list", () => {
  const allow = (actions_allow: AgentGitHub["actions_allow"]) =>
    harness({
      github: settings({
        features: features({ actions: true }),
        actions_allow,
      }),
      ceiling: ALL_ON,
    });

  test("a ref glob's * does not cross /", async () => {
    const { grant } = allow([{ workflow: "ci.yml", ref: "release/*" }]);
    expect(
      await grant({
        purpose: "dispatch",
        workflow: { file: "ci.yml", ref: "release/1.0" },
      }),
    ).toMatchObject({ allowedBy: { workflow: "ci.yml", ref: "release/*" } });
    expect(
      (
        await refused(
          grant({
            purpose: "dispatch",
            workflow: { file: "ci.yml", ref: "release/1.0/hotfix" },
          }),
        )
      ).reason,
    ).toBe("workflow_not_allowed");
  });

  test("an entry without ref allows only the catalog entry's branch", async () => {
    const { grant } = allow([{ workflow: "ci.yml" }]);
    expect(
      await grant({
        purpose: "dispatch",
        workflow: { file: "ci.yml", ref: "main" },
      }),
    ).toMatchObject({ allowedBy: { workflow: "ci.yml" } });
    expect(
      (
        await refused(
          grant({
            purpose: "dispatch",
            workflow: { file: "ci.yml", ref: "develop" },
          }),
        )
      ).reason,
    ).toBe("workflow_not_allowed");
  });

  test("a recorded run whose workflow left the allow-list is workflow_not_allowed", async () => {
    const { grant, receipts } = harness({
      github: settings({
        features: features({ actions: true }),
        actions_allow: [{ workflow: "ci.yml" }],
      }),
      ceiling: ALL_ON,
      dispatches: [
        { runId: 9, repositoryId: "app", workflow: "old.yml", ref: "main" },
      ],
    });
    expect((await refused(grant({ purpose: "rerun", runId: 9 }))).reason).toBe(
      "workflow_not_allowed",
    );
    expect(receipts[0]).toMatchObject({
      operation: "rerun_workflow",
      result: { run_id: 9, workflow: "old.yml", ref: "main" },
    });
  });
});

describe("another repository than the session's", () => {
  // `docs` is in the settings; `app` is the session's own.
  const MULTI = {
    ...CATALOG,
    repositories: {
      ...CATALOG.repositories,
      docs: {
        url: "https://github.com/acme/docs.git",
        branch: "main",
        auth: { kind: "github_app", registered: true },
      },
    },
  } satisfies SessionCatalog;

  test("is granted for the repository named, as its release lists it", async () => {
    const { grant, receipts } = harness({
      catalog: MULTI,
      github: settings({ repositories: ["app", "docs"] }),
    });
    const granted = await grant({ purpose: "push", repositoryId: "docs" });
    expect(granted).toMatchObject({
      repo: { owner: "acme", name: "docs" },
      permissions: { contents: "write" },
      context: { repositoryId: "docs" },
    });
    expect(receipts.at(-1)).toMatchObject({
      operation: "mint_github_token",
      result: { repository_id: "docs", purpose: "push" },
    });
  });

  test("push_attached deny refuses a push to the session's own repository too", async () => {
    const onList = settings({ repositories: ["app", "docs"] });
    const { grant } = harness({
      catalog: MULTI,
      policy: agentPolicy(onList, { pushAttached: "deny" }),
      repositoryCeiling: {
        repository_ids: ["app", "docs"],
        github_app_repositories: "listed",
      },
    });
    expect(
      (await refused(grant({ purpose: "push", repositoryId: "docs" }))).reason,
    ).toBe("repository_not_allowed");
    expect((await refused(grant({ purpose: "push" }))).reason).toBe(
      "repository_not_allowed",
    );
    expect(await grant({ purpose: "clone" })).not.toBeNull();
  });

  test("a push to an attached repository gets no credential when push.attached is deny, whoever approved the request", async () => {
    const onList = settings({ repositories: ["app", "docs"] });
    for (const [pushAttached, granted] of [
      ["allow", true],
      ["ask", true],
      ["deny", false],
    ] as const) {
      const { grant, receipts } = harness({
        catalog: MULTI,
        policy: agentPolicy(onList, { pushAttached }),
        repositoryCeiling: {
          repository_ids: ["app", "docs"],
          github_app_repositories: "listed",
        },
      });
      if (granted) {
        expect(
          await grant({ purpose: "push", repositoryId: "docs" }),
        ).toMatchObject({ repo: { owner: "acme", name: "docs" } });
        continue;
      }
      expect(
        (await refused(grant({ purpose: "push", repositoryId: "docs" })))
          .reason,
      ).toBe("repository_not_allowed");
      expect(receipts.at(-1)?.result).toMatchObject({
        repository_id: "docs",
        purpose: "push",
      });
      expect((await refused(grant({ purpose: "push" }))).reason).toBe(
        "repository_not_allowed",
      );
      expect(
        await grant({ purpose: "clone", repositoryId: "docs" }),
      ).not.toBeNull();
    }
  });

  test("is repository_not_allowed off the release's list, the settings, the ceiling or with GitHub off", async () => {
    const cases: Array<Parameters<typeof harness>[0]> = [
      { catalog: MULTI, github: settings({ repositories: ["app"] }) },
      { catalog: CATALOG, github: settings({ repositories: ["app", "docs"] }) },
      {
        catalog: MULTI,
        github: settings({ repositories: ["app", "docs"] }),
        githubEnabled: false,
      },
      { catalog: MULTI, github: null },
    ];
    for (const options of cases) {
      const { grant, receipts } = harness(options);
      expect(
        (await refused(grant({ purpose: "clone", repositoryId: "docs" })))
          .reason,
      ).toBe("repository_not_allowed");
      expect(receipts.at(-1)?.result).toMatchObject({ repository_id: "docs" });
    }
  });

  test("the platform's own read of a recorded pull request needs only the catalog", async () => {
    const { grant } = harness({
      catalog: MULTI,
      github: settings({ repositories: ["app"] }),
    });
    expect(
      await grant({ purpose: "outcome_refresh", repositoryId: "docs" }),
    ).toMatchObject({ repo: { name: "docs" } });
  });

  test("lists the repositories a claim attaches", async () => {
    const listed = harness({
      catalog: MULTI,
      github: settings({ repositories: ["app", "docs", "removed"] }),
    });
    expect(await listed.gate.additionalRepositories?.(SESSION)).toEqual([
      "docs",
    ]);
    const off = harness({ catalog: MULTI, githubEnabled: false });
    expect(await off.gate.additionalRepositories?.(SESSION)).toEqual([]);
  });

  describe("with the repositories the session was started with", () => {
    const ATTACHED = {
      ...MULTI,
      repositories: {
        ...MULTI.repositories,
        tools: {
          url: "https://github.com/acme/tools.git",
          branch: "main",
          auth: { kind: "github_app", registered: true },
        },
      },
    } satisfies SessionCatalog;
    const released = settings({ repositories: ["app", "docs", "tools"] });

    test("a repository the release lists but the session did not attach is repository_not_allowed", async () => {
      const { grant, receipts, gate } = harness({
        catalog: ATTACHED,
        github: released,
        attached: ["docs"],
      });
      expect(
        (await refused(grant({ purpose: "clone", repositoryId: "tools" })))
          .reason,
      ).toBe("repository_not_allowed");
      expect(receipts.at(-1)).toMatchObject({
        operation: "mint_github_token",
        status: "failed",
        result: {
          repository_id: "tools",
          purpose: "clone",
          reason_code: "repository_not_allowed",
        },
      });
      expect(
        await grant({ purpose: "clone", repositoryId: "docs" }),
      ).toMatchObject({ repo: { name: "docs" } });
      expect(await gate.additionalRepositories?.(SESSION)).toEqual(["docs"]);
    });

    test("an attached repository the release no longer lists is refused", async () => {
      const { grant, gate } = harness({
        catalog: ATTACHED,
        github: settings({ repositories: ["app", "docs"] }),
        attached: ["docs", "tools"],
      });
      expect(
        (await refused(grant({ purpose: "push", repositoryId: "tools" })))
          .reason,
      ).toBe("repository_not_allowed");
      expect(await gate.additionalRepositories?.(SESSION)).toEqual(["docs"]);
    });

    test("no list leaves the release's whole, an empty one leaves none", async () => {
      const whole = harness({ catalog: ATTACHED, github: released });
      expect(
        await whole.grant({ purpose: "clone", repositoryId: "tools" }),
      ).toMatchObject({ repo: { name: "tools" } });
      expect(await whole.gate.additionalRepositories?.(SESSION)).toEqual([
        "docs",
        "tools",
      ]);
      const none = harness({
        catalog: ATTACHED,
        github: released,
        attached: [],
      });
      expect(
        (await refused(none.grant({ purpose: "clone", repositoryId: "docs" })))
          .reason,
      ).toBe("repository_not_allowed");
      expect(await none.gate.additionalRepositories?.(SESSION)).toEqual([]);
    });

    test("another repository is read with contents: read, pushed to and given pull requests", async () => {
      const { grant, receipts } = harness({
        catalog: ATTACHED,
        github: released,
        attached: ["docs"],
      });
      expect(
        await grant({ purpose: "clone", repositoryId: "docs" }),
      ).toMatchObject({ permissions: { contents: "read" } });
      expect(receipts.at(-1)?.result).toMatchObject({
        repository_id: "docs",
        purpose: "clone",
        permissions: { contents: "read" },
      });
      for (const purpose of [
        "push",
        "pull_request",
        "pull_request_read",
      ] as const) {
        expect(await grant({ purpose, repositoryId: "docs" })).toMatchObject({
          context: { repositoryId: "docs" },
        });
        expect(receipts.at(-1)?.result).toMatchObject({
          repository_id: "docs",
          purpose,
        });
      }
      expect(
        (
          await refused(
            grant({ purpose: "pull_request", repositoryId: "tools" }),
          )
        ).reason,
      ).toBe("repository_not_allowed");
    });

    test("running workflows and reviews on another repository are repository_not_allowed even when attached", async () => {
      const { grant, receipts } = harness({
        catalog: ATTACHED,
        github: settings({
          repositories: ["app", "docs", "tools"],
          features: features({ workflows: true, actions: true, review: true }),
          actions_allow: [{ workflow: "ci.yml", ref: "main" }],
        }),
        ceiling: {
          ...GITHUB_CEILING_NONE,
          workflows: true,
          actions: true,
          review: true,
        },
        attached: ["docs"],
      });
      const works: Array<Omit<GitHubWork, "sessionId">> = [
        {
          purpose: "dispatch",
          repositoryId: "docs",
          workflow: { file: "ci.yml", ref: "main" },
        },
        { purpose: "rerun", repositoryId: "docs", runId: 1 },
        {
          purpose: "review",
          repositoryId: "docs",
          review: { number: 1, commitId: "a".repeat(40), event: "COMMENT" },
        },
      ];
      for (const work of works) {
        expect((await refused(grant(work))).reason).toBe(
          "repository_not_allowed",
        );
        expect(receipts.at(-1)).toMatchObject({
          status: "failed",
          result: { repository_id: "docs", purpose: work.purpose },
        });
      }
      // The session's own repository keeps them, and a CI read takes the
      // attached one too.
      expect(await grant({ purpose: "actions_read" })).toMatchObject({
        context: { repositoryId: "app" },
      });
      expect(
        await grant({ purpose: "actions_read", repositoryId: "docs" }),
      ).toMatchObject({ context: { repositoryId: "docs" } });
    });

    // 94S-2465, PM decision B: a CI read names any repository the agent may
    // work on, with or without a repository of the session's own; a write
    // keeps the session's repository rules.
    describe("a CI read naming its repository by owner/name", () => {
      const ciOn = settings({
        repositories: ["app", "docs", "tools"],
        features: features({ workflows: true }),
      });
      const ceiling = { ...GITHUB_CEILING_NONE, workflows: true };

      test("a session with no repository of its own (a DM) reads an attached, listed one, with a read token for that repository alone", async () => {
        const { grant, receipts } = harness({
          catalog: ATTACHED,
          repositoryId: null,
          github: ciOn,
          ceiling,
          attached: ["docs"],
        });
        const ci = await grant({
          purpose: "actions_read",
          repositoryName: "acme/docs",
        });
        expect(ci).toMatchObject({
          repo: { owner: "acme", name: "docs" },
          context: { repositoryId: "docs" },
        });
        expect(ci?.permissions).toEqual({ actions: "read", checks: "read" });
        expect(receipts.at(-1)).toMatchObject({
          status: "succeeded",
          result: {
            repository_id: "docs",
            repository: "acme/docs",
            purpose: "actions_read",
          },
        });
        // The head of a pull request: a pull request read, nothing more.
        const head = await grant({
          purpose: "pull_request_read",
          repositoryName: "acme/docs",
        });
        expect(head?.repo).toEqual({ owner: "acme", name: "docs" });
        expect(head?.permissions).toEqual({ pull_requests: "read" });
        // The service asks for the head by the id the CI read resolved.
        expect(
          (await grant({ purpose: "pull_request_read", repositoryId: "docs" }))
            ?.permissions,
        ).toEqual({ pull_requests: "read" });
        // Without a name it stays the session's repository, which it has not.
        expect((await refused(grant({ purpose: "actions_read" }))).reason).toBe(
          "workflow_review_need_session_repository",
        );
      });

      test("a repository outside what the agent may work on is repository_not_allowed", async () => {
        const { grant, receipts } = harness({
          catalog: ATTACHED,
          repositoryId: null,
          github: ciOn,
          ceiling,
          attached: ["docs"],
        });
        // Listed but not attached, and not in the catalog at all.
        for (const name of ["acme/tools", "acme/elsewhere"]) {
          expect(
            (
              await refused(
                grant({ purpose: "actions_read", repositoryName: name }),
              )
            ).reason,
          ).toBe("repository_not_allowed");
          expect(receipts.at(-1)).toMatchObject({
            status: "failed",
            result: {
              repository_id: null,
              repository: name,
              reason_code: "repository_not_allowed",
            },
          });
        }
      });

      test("with a repository of its own, a name reads another allowed one, the session's own name reads its own, and no name reads its own", async () => {
        const { grant } = harness({
          catalog: ATTACHED,
          github: ciOn,
          ceiling,
          attached: ["docs"],
        });
        expect(
          (
            await grant({
              purpose: "actions_read",
              repositoryName: "acme/docs",
            })
          )?.context.repositoryId,
        ).toBe("docs");
        expect(
          (await grant({ purpose: "actions_read", repositoryName: "acme/app" }))
            ?.context.repositoryId,
        ).toBe("app");
        expect(
          (await grant({ purpose: "actions_read" }))?.context.repositoryId,
        ).toBe("app");
      });

      test("a name matches github.com repositories only: one on another host with the same owner/name is not read", async () => {
        const { grant } = harness({
          catalog: {
            ...ATTACHED,
            repositories: {
              ...ATTACHED.repositories,
              docs: {
                url: "https://ghe.example.com/acme/docs.git",
                branch: "main",
                auth: { kind: "github_app", registered: true },
              },
            },
          },
          repositoryId: null,
          github: ciOn,
          ceiling,
          attached: ["docs"],
        });
        expect(
          (
            await refused(
              grant({ purpose: "actions_read", repositoryName: "acme/docs" }),
            )
          ).reason,
        ).toBe("repository_not_allowed");
      });

      test("a catalog URL ending in .GIT is not named: its key, token and API path would keep the suffix", async () => {
        const { grant } = harness({
          catalog: {
            ...ATTACHED,
            repositories: {
              ...ATTACHED.repositories,
              docs: {
                url: "https://github.com/acme/docs.GIT",
                branch: "main",
                auth: { kind: "github_app", registered: true },
              },
            },
          },
          repositoryId: null,
          github: ciOn,
          ceiling,
          attached: ["docs"],
        });
        expect(
          (
            await refused(
              grant({ purpose: "actions_read", repositoryName: "acme/docs" }),
            )
          ).reason,
        ).toBe("repository_not_allowed");
      });

      test("a write never takes a name: push and pull requests keep the session's repository rules", async () => {
        const { grant } = harness({
          catalog: ATTACHED,
          github: ciOn,
          ceiling,
          attached: ["docs"],
        });
        for (const purpose of ["push", "pull_request"] as const) {
          expect(
            (await refused(grant({ purpose, repositoryName: "acme/docs" })))
              .reason,
          ).toBe("repository_not_allowed");
        }
        // As before: another repository by its catalog id.
        expect(
          (await grant({ purpose: "push", repositoryId: "docs" }))?.context
            .repositoryId,
        ).toBe("docs");
      });
    });
  });
});

describe("a session under the agent's settings", () => {
  const IN_CEILING: RepositoryCeiling = {
    repository_ids: ["app"],
    github_app_repositories: "listed",
  };
  const onList = settings({ repositories: ["app"] });
  test("is granted on the list, in the ceiling; the receipt names the source", async () => {
    const { grant, receipts } = harness({
      policy: agentPolicy(onList, { revision: 7 }),
      repositoryCeiling: IN_CEILING,
    });
    await grant({ purpose: "clone" });
    expect(receipts.at(-1)?.result).toMatchObject({
      policy_source: "agent",
      agent_settings_revision: 7,
      workspace_ceiling_revision: 0,
    });
  });

  test("a release session's receipt names its source too", async () => {
    const { grant, receipts } = harness();
    await grant({ purpose: "clone" });
    expect(receipts.at(-1)?.result).toMatchObject({
      policy_source: "release",
      agent_settings_revision: null,
    });
  });

  test.each([
    {
      name: "off the agent's list",
      policy: agentPolicy(settings({ repositories: ["ghes"] })),
      ceiling: IN_CEILING,
      reason: "repository_not_allowed",
    },
    {
      name: "the closed policy of a missing row",
      policy: agentPolicy(GITHUB_POLICY_CLOSED),
      ceiling: IN_CEILING,
      reason: "repository_not_allowed",
    },
    {
      name: "no workspace ceiling",
      policy: agentPolicy(onList),
      ceiling: null,
      reason: "repository_not_allowed",
    },
    {
      name: "off the workspace ceiling",
      policy: agentPolicy(onList),
      ceiling: { ...IN_CEILING, repository_ids: ["ghes"] },
      reason: "repository_not_allowed",
    },
    {
      name: "a row this image cannot read",
      policy: agentPolicy("invalid"),
      ceiling: IN_CEILING,
      reason: "github_settings_unsupported",
    },
  ])("is refused: $name", async ({ policy, ceiling, reason }) => {
    const { grant, asked } = harness({
      policy,
      repositoryCeiling: ceiling as RepositoryCeiling | null,
    });
    expect((await refused(grant({ purpose: "clone" }))).reason).toBe(
      reason as GitHubRefusal,
    );
    expect(asked).toEqual([]);
  });

  test("the agent's switch still holds", async () => {
    const { grant } = harness({
      policy: agentPolicy(onList),
      repositoryCeiling: IN_CEILING,
      githubEnabled: false,
    });
    expect((await refused(grant({ purpose: "clone" }))).reason).toBe(
      "github_disabled",
    );
  });

  test("another repository under a bad row is the row's refusal, not the list's", async () => {
    const { grant } = harness({
      policy: agentPolicy("invalid"),
      repositoryCeiling: IN_CEILING,
    });
    expect(
      (await refused(grant({ purpose: "clone", repositoryId: "ghes" }))).reason,
    ).toBe("github_settings_unsupported");
  });

  test("a release session: the ceiling judges, the pin lists", async () => {
    const inCeiling = harness({
      repositoryCeiling: IN_CEILING,
    });
    await inCeiling.grant({ purpose: "clone" });
    const outside = harness({
      repositoryCeiling: { ...IN_CEILING, repository_ids: [] },
    });
    expect((await refused(outside.grant({ purpose: "clone" }))).reason).toBe(
      "repository_not_allowed",
    );
    const none = harness({ repositoryCeiling: null });
    expect((await refused(none.grant({ purpose: "clone" }))).reason).toBe(
      "repository_not_allowed",
    );
  });

  test("a pin-less release takes only the list a person saved as its limit", async () => {
    const policy = (currentRepositories: string[]) => ({
      ...releasePolicy(null),
      currentRepositories,
    });
    const listed = harness({
      policy: policy(["app"]),
      repositoryCeiling: IN_CEILING,
    });
    await listed.grant({ purpose: "clone" });
    const off = harness({
      policy: policy(["ghes"]),
      repositoryCeiling: IN_CEILING,
    });
    expect((await refused(off.grant({ purpose: "clone" }))).reason).toBe(
      "repository_not_allowed",
    );
  });

  test("a workflow must be allowed by the list the session started with as well as by the current one", async () => {
    const run = (startActionsAllow: AgentGitHub["actions_allow"]) =>
      harness({
        policy: {
          ...agentPolicy(
            settings({
              repositories: ["app"],
              features: features({ actions: true }),
              actions_allow: [{ workflow: "release.yml" }],
            }),
          ),
          startActionsAllow,
        },
        repositoryCeiling: IN_CEILING,
        ceiling: ALL_ON,
      });
    const work = {
      purpose: "dispatch",
      workflow: { file: "release.yml", ref: "main" },
    } as const;
    await run([{ workflow: "release.yml" }]).grant(work);
    expect(
      (await refused(run([{ workflow: "ci.yml" }]).grant(work))).reason,
    ).toBe("workflow_not_allowed");
    // An empty list at the start allows nothing, as an empty list now does.
    expect((await refused(run([]).grant(work))).reason).toBe(
      "workflow_not_allowed",
    );
  });

  test("the platform reading a recorded pull request answers to no ceiling", async () => {
    const { grant } = harness({
      policy: agentPolicy(GITHUB_POLICY_CLOSED),
      repositoryCeiling: null,
    });
    expect(await grant({ purpose: "outcome_refresh" })).toMatchObject({
      repo: { owner: "acme", name: "app" },
    });
  });
});

function memoryPins(initial: GitHubRepositoryPin[] = []) {
  const rows = new Map(
    initial.map((pin) => [`${pin.repositoryId}:${pin.role}`, pin]),
  );
  const pins: Pick<GitHubPinStore, "get" | "pinFirst"> = {
    get: async (repositoryId, role) =>
      rows.get(`${repositoryId}:${role}`) ?? null,
    pinFirst: async (input) => {
      const key = `${input.repositoryId}:${input.role}`;
      const held = rows.get(key);
      if (held !== undefined) return { pin: held, created: false };
      const pin: GitHubRepositoryPin = {
        repositoryId: input.repositoryId,
        role: input.role,
        connectionId: input.connectionId,
        appId: input.appId,
        pinnedBy: input.pinnedBy,
      };
      rows.set(key, pin);
      return { pin, created: true };
    },
  };
  return { pins, rows };
}

const CONNECTION_A = "0193a000-0000-7000-8000-00000000000a";
const CONNECTION_B = "0193a000-0000-7000-8000-00000000000b";

function registered(
  id: string,
  appId: number,
  installed: boolean | null = true,
) {
  const fake = fakeConnection(id, { appId, installed });
  return { fake, entry: { id, appId, connection: fake.connection } };
}

describe("registered connections", () => {
  test("a claim's pin is chosen as a first mint's and recorded as the claim's, with its audit", async () => {
    const a = registered(CONNECTION_A, 101);
    const b = registered(CONNECTION_B, 102, false);
    const { pins, rows } = memoryPins();
    const given: unknown[] = [];
    const resolver = createGitHubConnectionResolver({
      connections: () => ({
        kind: "registered",
        candidates: [a.entry, b.entry],
      }),
      pins: {
        get: pins.get,
        pinFirst: (input) => {
          given.push(input);
          return pins.pinFirst(input);
        },
      },
    });
    const claim = { sessionId: "s-1", receiptId: "r-1" };
    expect(
      await resolver.resolve(
        "app",
        "author",
        { owner: "o", name: "app" },
        { pin: true, claim },
      ),
    ).toMatchObject({
      kind: "connection",
      connectionId: CONNECTION_A,
      pinnedBy: "claim",
    });
    expect(given).toEqual([
      {
        repositoryId: "app",
        role: "author",
        connectionId: CONNECTION_A,
        appId: 101,
        pinnedBy: "claim",
        audit: claim,
      },
    ]);
    expect(rows.get("app:author")?.pinnedBy).toBe("claim");

    const both = createGitHubConnectionResolver({
      connections: () => ({
        kind: "registered",
        candidates: [a.entry, registered(CONNECTION_B, 102).entry],
      }),
      pins: memoryPins().pins,
    });
    expect(
      await both.resolve(
        "other",
        "author",
        { owner: "o", name: "other" },
        { pin: true, claim },
      ),
    ).toMatchObject({ kind: "refused", reason: "ambiguous_app" });
  });

  test("the one connection that reaches an unpinned repository pins it at the first mint and is used after", async () => {
    const a = registered(CONNECTION_A, 101);
    const b = registered(CONNECTION_B, 102, false);
    const { pins, rows } = memoryPins();
    const { grant, receipts } = harness({
      registered: { author: [a.entry, b.entry] },
      pins,
    });
    expect(await grant({ purpose: "push" })).toMatchObject({ role: "author" });
    expect(rows.get("app:author")).toEqual({
      repositoryId: "app",
      role: "author",
      connectionId: CONNECTION_A,
      appId: 101,
      pinnedBy: "first_mint",
    });
    expect(receipts.at(-1)).toMatchObject({
      operation: "mint_github_token",
      status: "succeeded",
      result: {
        connection_id: CONNECTION_A,
        pinned_by: "first_mint",
        app_id: 101,
      },
    });
    expect(b.fake.issued).toEqual([]);

    const later = harness({
      registered: {
        author: [
          registered(CONNECTION_A, 101).entry,
          registered(CONNECTION_B, 102).entry,
        ],
      },
      pins,
    });
    await later.grant({ purpose: "clone" });
    expect(later.receipts.at(-1)?.result).toMatchObject({
      connection_id: CONNECTION_A,
    });
    expect(later.receipts.at(-1)?.result).not.toHaveProperty("pinned_by");
  });

  test("two connections that reach an unpinned repository refuse with both named, and nothing is pinned", async () => {
    const { pins, rows } = memoryPins();
    const { grant, receipts } = harness({
      registered: {
        author: [
          registered(CONNECTION_A, 101).entry,
          registered(CONNECTION_B, 102).entry,
        ],
      },
      pins,
    });
    expect((await refused(grant({ purpose: "push" }))).reason).toBe(
      "ambiguous_app",
    );
    expect(receipts.at(-1)).toMatchObject({
      status: "failed",
      result: {
        reason_code: "ambiguous_app",
        role: "author",
        candidate_connection_ids: [CONNECTION_A, CONNECTION_B],
      },
    });
    expect(rows.size).toBe(0);
  });

  test("a pin whose connection was removed refuses; it never falls back to another connection", async () => {
    const other = registered(CONNECTION_B, 102);
    const { pins } = memoryPins([
      {
        repositoryId: "app",
        role: "author",
        connectionId: null,
        appId: 101,
        pinnedBy: "admin",
      },
    ]);
    const { grant, receipts } = harness({
      registered: { author: [other.entry] },
      pins,
    });
    expect((await refused(grant({ purpose: "clone" }))).reason).toBe(
      "pinned_app_removed",
    );
    expect(receipts.at(-1)?.result).toMatchObject({
      reason_code: "pinned_app_removed",
      role: "author",
    });
    expect(other.fake.issued).toEqual([]);
  });

  test("no connection reaching it, or GitHub not answering, fails with a receipt and pins nothing", async () => {
    for (const [installed, other, pinState] of [
      [false, false, "none_unreachable"],
      [null, false, "lookup_failed"],
      // B reaches it, but A unanswered might too: never pick among the rest.
      [null, true, "lookup_failed"],
    ] as const) {
      const { pins, rows } = memoryPins();
      const { grant, receipts } = harness({
        registered: {
          author: [
            registered(CONNECTION_A, 101, installed).entry,
            registered(CONNECTION_B, 102, other).entry,
          ],
        },
        pins,
      });
      const error = await grant({ purpose: "clone" }).then(
        () => null,
        (caught: unknown) => caught,
      );
      // As with one App not installed: forge_failed, not "no credential".
      expect(error).toBeInstanceOf(ForgeCredentialError);
      expect(receipts.at(-1)).toMatchObject({
        status: "failed",
        result: { role: "author", connection_id: null, pin_state: pinState },
      });
      expect((error as ForgeCredentialError).receiptId).toBe(
        `receipt-${receipts.length}`,
      );
      expect(rows.size).toBe(0);
    }
  });

  test("a pin to a connection this replica has not read yet is unreachable, not another App", async () => {
    const { pins } = memoryPins([
      {
        repositoryId: "app",
        role: "author",
        connectionId: CONNECTION_B,
        appId: 102,
        pinnedBy: "selection",
      },
    ]);
    const a = registered(CONNECTION_A, 101);
    const { grant, receipts } = harness({
      registered: { author: [a.entry] },
      pins,
    });
    await expect(grant({ purpose: "clone" })).rejects.toBeInstanceOf(
      ForgeCredentialError,
    );
    expect(receipts.at(-1)?.result).toMatchObject({
      connection_id: CONNECTION_B,
      pin_state: "pinned_unreachable",
    });
    expect(a.fake.issued).toEqual([]);
  });

  test("a pinned connection this replica still reads as another App issues nothing", async () => {
    const { pins } = memoryPins([
      {
        repositoryId: "app",
        role: "author",
        connectionId: CONNECTION_A,
        appId: 102,
        pinnedBy: "admin",
      },
    ]);
    const stale = registered(CONNECTION_A, 101);
    const { grant, receipts } = harness({
      registered: { author: [stale.entry] },
      pins,
    });
    await expect(grant({ purpose: "clone" })).rejects.toBeInstanceOf(
      ForgeCredentialError,
    );
    expect(receipts.at(-1)?.result).toMatchObject({
      connection_id: CONNECTION_A,
      pin_state: "pinned_unreachable",
    });
    expect(stale.fake.issued).toEqual([]);
  });

  test("a first pin the store refuses, its connection now another App, issues nothing", async () => {
    const a = registered(CONNECTION_A, 101);
    const { grant, receipts } = harness({
      registered: { author: [a.entry] },
      pins: {
        get: async () => null,
        pinFirst: async () => ({ pin: null, created: false }),
      },
    });
    await expect(grant({ purpose: "clone" })).rejects.toBeInstanceOf(
      ForgeCredentialError,
    );
    expect(receipts.at(-1)?.result).toMatchObject({
      connection_id: CONNECTION_A,
      pin_state: "pinned_unreachable",
    });
    expect(a.fake.issued).toEqual([]);
  });

  test("the reviewer role is pinned on its own; the author's pin does not choose it", async () => {
    const { pins, rows } = memoryPins([
      {
        repositoryId: "app",
        role: "author",
        connectionId: CONNECTION_A,
        appId: 101,
        pinnedBy: "selection",
      },
    ]);
    const reviewerId = "0193a000-0000-7000-8000-00000000000c";
    const { grant } = harness({
      github: settings({ features: features({ review: true }) }),
      ceiling: ALL_ON,
      registered: {
        author: [registered(CONNECTION_A, 101).entry],
        reviewer: [registered(reviewerId, 103).entry],
      },
      pins,
    });
    expect(await grant({ purpose: "review" })).toMatchObject({
      role: "reviewer",
    });
    expect(rows.get("app:reviewer")).toMatchObject({
      connectionId: reviewerId,
      pinnedBy: "first_mint",
    });
  });
});

describe("connection resolver", () => {
  const repo = { owner: "acme", name: "app" };

  test("installed: the pin's answer, one reach true, none false, several or unknown null", async () => {
    const yes = registered(CONNECTION_A, 101).entry;
    const no = registered(CONNECTION_B, 102, false).entry;
    const unknown = registered(CONNECTION_B, 102, null).entry;
    const resolverOf = (
      candidates: RegisteredGitHubConnection[],
      initial: GitHubRepositoryPin[] = [],
    ) =>
      createGitHubConnectionResolver({
        connections: () => ({ kind: "registered", candidates }),
        pins: memoryPins(initial).pins,
      });
    expect(await resolverOf([yes, no]).installed("app", "author", repo)).toBe(
      true,
    );
    expect(await resolverOf([no]).installed("app", "author", repo)).toBe(false);
    expect(
      await resolverOf([yes, { ...yes, id: CONNECTION_B }]).installed(
        "app",
        "author",
        repo,
      ),
    ).toBeNull();
    expect(
      await resolverOf([yes, unknown]).installed("app", "author", repo),
    ).toBeNull();
    expect(await resolverOf([]).installed("app", "author", repo)).toBeNull();
    const pinnedTo = (connectionId: string | null): GitHubRepositoryPin => ({
      repositoryId: "app",
      role: "author",
      connectionId,
      appId: 102,
      pinnedBy: "admin",
    });
    expect(
      await resolverOf([yes, no], [pinnedTo(CONNECTION_B)]).installed(
        "app",
        "author",
        repo,
      ),
    ).toBe(false);
    expect(
      await resolverOf([yes], [pinnedTo(null)]).installed(
        "app",
        "author",
        repo,
      ),
    ).toBe(false);
    expect(
      await resolverOf([yes], [pinnedTo(CONNECTION_B)]).installed(
        "app",
        "author",
        repo,
      ),
    ).toBeNull();
  });

  test("installedMany gives installed's answer per repository and asks each connection once", async () => {
    const yes = registered(CONNECTION_A, 101).entry;
    const no = registered(CONNECTION_B, 102, false).entry;
    const unknown = registered(CONNECTION_B, 102, null).entry;
    const asks: number[] = [];
    const counted = (entry: RegisteredGitHubConnection) => ({
      ...entry,
      connection: {
        ...entry.connection,
        installedOn: async (repos: readonly RepoRef[]) => {
          asks.push(repos.length);
          return entry.connection.installedOn(repos);
        },
      },
    });
    const resolverOf = (
      candidates: RegisteredGitHubConnection[],
      initial: GitHubRepositoryPin[] = [],
    ) =>
      createGitHubConnectionResolver({
        connections: (repositoryId) =>
          repositoryId === "none" ? null : { kind: "registered", candidates },
        pins: memoryPins(initial).pins,
      });
    const items = [
      { repositoryId: "app", repo },
      { repositoryId: "second", repo: { owner: "acme", name: "second" } },
      { repositoryId: "none", repo: { owner: "acme", name: "none" } },
    ];
    const many = await resolverOf([counted(yes), counted(no)]).installedMany(
      "author",
      items,
    );
    expect([...many]).toEqual([
      ["app", true],
      ["second", true],
      ["none", null],
    ]);
    // Two connections, three repositories, one ask each.
    expect(asks).toEqual([2, 2]);
    const first = items.slice(0, 1);
    const answerOf = async (resolver: GitHubConnectionResolver) => [
      ...(await resolver.installedMany("author", first)),
    ];
    expect(await answerOf(resolverOf([no]))).toEqual([["app", false]]);
    expect(await answerOf(resolverOf([yes, unknown]))).toEqual([["app", null]]);
    const pinned = (connectionId: string | null): GitHubRepositoryPin => ({
      repositoryId: "app",
      role: "author",
      connectionId,
      appId: 102,
      pinnedBy: "admin",
    });
    expect(
      await answerOf(resolverOf([yes, no], [pinned(CONNECTION_B)])),
    ).toEqual([["app", false]]);
    expect(await answerOf(resolverOf([yes], [pinned(null)]))).toEqual([
      ["app", false],
    ]);
  });

  test("resolve without pin leaves no pin; another request's pin decides over this one", async () => {
    const a = registered(CONNECTION_A, 101).entry;
    const plain = memoryPins();
    const resolver = createGitHubConnectionResolver({
      connections: () => ({ kind: "registered", candidates: [a] }),
      pins: plain.pins,
    });
    expect(
      await resolver.resolve("app", "author", repo, { pin: false }),
    ).toMatchObject({
      kind: "connection",
      connectionId: CONNECTION_A,
      pinnedBy: null,
    });
    expect(plain.rows.size).toBe(0);

    const raced = memoryPins();
    const racing: Pick<GitHubPinStore, "get" | "pinFirst"> = {
      get: async () => null,
      pinFirst: async (input) => {
        await raced.pins.pinFirst({
          ...input,
          connectionId: CONNECTION_B,
          appId: 102,
        });
        return raced.pins.pinFirst(input);
      },
    };
    const b = registered(CONNECTION_B, 102).entry;
    expect(
      await createGitHubConnectionResolver({
        connections: () => ({ kind: "registered", candidates: [a, b] }),
        pins: racing,
      }).resolve("app", "author", repo, {
        pin: true,
        source: {
          kind: "registered",
          candidates: [
            a,
            {
              ...b,
              connection: registered(CONNECTION_B, 102, false).fake.connection,
            },
          ],
        },
      }),
    ).toMatchObject({
      kind: "connection",
      connectionId: CONNECTION_B,
      pinnedBy: null,
    });
  });
});
