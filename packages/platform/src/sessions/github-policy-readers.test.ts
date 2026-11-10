import { describe, expect, test } from "bun:test";
import {
  type AgentGitHub,
  type AgentGitHubSettingsRow,
  GITHUB_FEATURES_NONE,
  GITHUB_POLICY_CLOSED,
  newSessionGitHubPolicy,
  type RepositoryCeiling,
  startRepositoryOf,
} from "@werft-ai/contracts";
import {
  type AdditionalRepositoryContext,
  additionalRepositoriesOf,
  additionalRepositoryAllowed,
} from "./additional-repositories.ts";
import {
  connectionRefusal,
  releaseStartable,
  repositoryInCeiling,
  type SessionCatalog,
} from "./catalog.ts";
import {
  TEST_CONNECTION_ID,
  testCatalog,
  testConnection,
} from "../testing/catalog-fakes.ts";

const repository = (
  name: string,
  auth: object,
): SessionCatalog["repositories"][string] =>
  ({
    url: `https://github.com/acme/${name}.git`,
    branch: "main",
    auth,
  }) as SessionCatalog["repositories"][string];

const CATALOG = testCatalog({
  repositories: {
    app: repository("app", { kind: "github_app", registered: true }),
    docs: repository("docs", { kind: "github_app", registered: true }),
    outside: repository("outside", { kind: "github_app", registered: true }),
  },
});

const SETTINGS: AgentGitHub = {
  repositories: ["app", "docs"],
  push_approval: true,
  features: { ...GITHUB_FEATURES_NONE },
  actions_allow: [],
};

const row = (
  overrides: Partial<AgentGitHubSettingsRow> = {},
): AgentGitHubSettingsRow => ({
  repositories: ["docs"],
  pushApproval: true,
  features: { ...GITHUB_FEATURES_NONE },
  actionsAllow: [],
  startRepositoryId: "docs",
  pushAttached: null,
  revision: 3,
  updatedBy: null,
  ...overrides,
});

const ceilingOf = (...ids: string[]): RepositoryCeiling => ({
  repository_ids: ids,
  github_app_repositories: "listed",
});

const context = (
  overrides: Partial<AdditionalRepositoryContext>,
): AdditionalRepositoryContext => ({
  repositoryId: "app",
  attached: null,
  policySource: "release",
  github: SETTINGS,
  repositoryCeiling: ceilingOf("app", "docs"),
  githubEnabled: true,
  ...overrides,
});

const idsOf = (input: AdditionalRepositoryContext) =>
  additionalRepositoriesOf(CATALOG, input).map(({ id }) => id);

describe("with no settings row, every reader answers as before", () => {
  test("a new session stays on its release's pin, whatever the pin holds", () => {
    expect(newSessionGitHubPolicy(null, undefined)).toEqual({
      source: "release",
      settings: null,
      startRepositoryId: null,
      agentSettingsRevision: null,
      currentRepositories: null,
      startActionsAllow: null,
      enabledAtStart: true,
      pushAttached: "ask",
    });
    expect(newSessionGitHubPolicy(null, SETTINGS)).toMatchObject({
      source: "release",
      settings: SETTINGS,
    });
    expect(newSessionGitHubPolicy(null, { from: "later" })).toMatchObject({
      source: "release",
      settings: "invalid",
    });
  });

  test.each([
    { asked: "docs", release: "app", starts: "docs" },
    { asked: null, release: "app", starts: "app" },
    { asked: undefined, release: "app", starts: "app" },
    { asked: undefined, release: null, starts: null },
    { asked: undefined, release: undefined, starts: null },
  ])("start repository: asked $asked, release $release", (row) => {
    const policy = newSessionGitHubPolicy(null, SETTINGS);
    expect(startRepositoryOf(row.asked, policy, row.release)).toBe(row.starts);
  });

  test.each([
    {
      name: "the release's list, less its own",
      input: {},
      ids: ["docs"],
    },
    {
      name: "the attached list caps it",
      input: { attached: [] },
      ids: [],
    },
    { name: "no pin lists nothing", input: { github: null }, ids: [] },
    { name: "a bad pin lists nothing", input: { github: "invalid" }, ids: [] },
    {
      name: "the agent's switch off lists nothing",
      input: { githubEnabled: false },
      ids: [],
    },
    {
      name: "no workspace ceiling lists nothing",
      input: { repositoryCeiling: null },
      ids: [],
    },
  ] as const)("additional repositories: $name", ({ input, ids }) => {
    const attached = "attached" in input ? [...input.attached] : null;
    expect(idsOf(context({ ...input, attached }))).toEqual([...ids]);
  });

  const MODEL = "claude-sonnet-5";
  test.each([
    { connection: TEST_CONNECTION_ID, model: MODEL, id: "app", starts: true },
    { connection: TEST_CONNECTION_ID, model: MODEL, id: "outside", starts: false },
    { connection: TEST_CONNECTION_ID, model: MODEL, id: "unknown", starts: false },
    { connection: TEST_CONNECTION_ID, model: MODEL, id: null, starts: true },
    { connection: "gone", model: MODEL, id: null, starts: false },
    { connection: TEST_CONNECTION_ID, model: "retired", id: null, starts: false },
    { connection: TEST_CONNECTION_ID, model: undefined, id: null, starts: false },
  ])("Slack's start check: $model over $connection with $id", (row) => {
    const release = {
      connection_id: row.connection,
      model: row.model,
      repository_id: row.id,
      policy_pins: {},
    };
    expect(
      releaseStartable(CATALOG, release, null, ceilingOf("app", "docs")),
    ).toBe(row.starts);
  });
});

describe("an `agent` session", () => {
  test("a row moves new sessions off the pin and starts them without a repository", () => {
    const policy = newSessionGitHubPolicy(row(), SETTINGS);
    expect(policy).toMatchObject({
      source: "agent",
      startRepositoryId: "docs",
      agentSettingsRevision: 3,
    });
    // The row's start repository is still read, but no longer starts a session.
    expect(startRepositoryOf(undefined, policy, "app")).toBeNull();
    expect(startRepositoryOf(null, policy, "app")).toBeNull();
    // A repository the caller names is still the session's own.
    expect(startRepositoryOf("app", policy, "app")).toBe("app");
    const none = newSessionGitHubPolicy(
      row({ startRepositoryId: null }),
      SETTINGS,
    );
    expect(startRepositoryOf(undefined, none, "app")).toBeNull();
  });

  test.each([
    {
      name: "inside the list and the ceiling",
      ceiling: ceilingOf("docs"),
      ids: ["docs"],
    },
    { name: "no ceiling allows none", ceiling: null, ids: [] },
    { name: "off the ceiling", ceiling: ceilingOf("app"), ids: [] },
  ])("additional repositories: $name", ({ ceiling, ids }) => {
    expect(
      idsOf(
        context({
          policySource: "agent",
          repositoryCeiling: ceiling as RepositoryCeiling | null,
        }),
      ),
    ).toEqual([...ids]);
  });

  test("an empty closed policy reaches nothing", () => {
    expect(
      idsOf(
        context({
          policySource: "agent",
          github: GITHUB_POLICY_CLOSED,
          repositoryCeiling: ceilingOf("app", "docs"),
        }),
      ),
    ).toEqual([]);
  });

  test("a repository off the list is not allowed even inside the ceiling", () => {
    expect(
      additionalRepositoryAllowed(
        CATALOG,
        context({
          policySource: "agent",
          github: { ...SETTINGS, repositories: ["app"] },
          repositoryCeiling: ceilingOf("app", "docs"),
        }),
        "docs",
      ),
    ).toBeNull();
  });

  test.each([
    // A session of an agent with a row starts without a repository, so neither
    // its start repository, its list nor the ceiling can stop it.
    {
      name: "start repository on the list, in the ceiling",
      agent: row(),
      ceiling: ceilingOf("docs"),
      starts: true,
    },
    {
      name: "start repository off the ceiling",
      agent: row(),
      ceiling: ceilingOf("app"),
      starts: true,
    },
    { name: "no ceiling", agent: row(), ceiling: null, starts: true },
    {
      name: "start repository off the agent's list",
      agent: row({ repositories: ["app"] }),
      ceiling: ceilingOf("docs"),
      starts: true,
    },
    {
      name: "a row this image cannot read",
      agent: row({ repositories: "a later shape" }),
      ceiling: ceilingOf("docs"),
      starts: false,
    },
    {
      name: "no start repository",
      agent: row({ startRepositoryId: null }),
      ceiling: null,
      starts: true,
    },
  ])("Slack's start check: $name", ({ agent, ceiling, starts }) => {
    const release = {
      connection_id: TEST_CONNECTION_ID,
      model: "claude-sonnet-5",
      repository_id: "app",
      policy_pins: {},
    };
    expect(releaseStartable(CATALOG, release, agent, ceiling)).toBe(starts);
  });
});

describe("the repository ceiling", () => {
  const INSTALLED = {
    ...CATALOG,
    repositories: {
      ...CATALOG.repositories,
      console: repository("console", {
        kind: "github_app",
        registered: true,
      }),
    },
  };

  test("null allows none; a list allows what it names", () => {
    expect(repositoryInCeiling(CATALOG, null, "app")).toBe(false);
    expect(repositoryInCeiling(CATALOG, ceilingOf("app"), "app")).toBe(true);
    expect(repositoryInCeiling(CATALOG, ceilingOf("app"), "docs")).toBe(false);
  });

  test("`installed` reaches console App repositories but not a list's others", () => {
    const ceiling: RepositoryCeiling = {
      repository_ids: [],
      github_app_repositories: "installed",
    };
    expect(repositoryInCeiling(INSTALLED, ceiling, "unknown")).toBe(false);
    expect(repositoryInCeiling(INSTALLED, ceiling, "console")).toBe(true);
  });
});

describe("connectionRefusal", () => {
  const families = {
    "sonnet-1": { family: "sonnet", rank: 1 },
    "sonnet-2": { family: "sonnet", rank: 2 },
    "opus-1": { family: "opus", rank: 1 },
  };
  const catalog = testCatalog({
    connections: {
      [TEST_CONNECTION_ID]: testConnection({
        models: ["sonnet-2"],
        model_families: families,
      }),
    },
  });

  test("a listed model on an enabled connection runs", () => {
    expect(connectionRefusal(catalog, TEST_CONNECTION_ID, "sonnet-2")).toBeNull();
  });

  test("a retired model with a successor still runs: its session moves", () => {
    expect(connectionRefusal(catalog, TEST_CONNECTION_ID, "sonnet-1")).toBeNull();
  });

  test("a retired model with no successor is refused", () => {
    expect(connectionRefusal(catalog, TEST_CONNECTION_ID, "opus-1")).toBe(
      "model_removed",
    );
    expect(connectionRefusal(catalog, TEST_CONNECTION_ID, "unknown")).toBe(
      "model_removed",
    );
  });

  test("a disabled or missing connection is refused", () => {
    expect(connectionRefusal(catalog, "gone", "sonnet-2")).toBe(
      "connection_missing",
    );
  });
});
