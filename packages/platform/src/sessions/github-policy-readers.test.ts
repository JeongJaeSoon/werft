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
  allowedPair,
  allowedRun,
  type InstallationProfileEntry,
  releaseStartable,
  repositoryInCeiling,
  type SessionCatalog,
  usesWorkspaceCeiling,
} from "./catalog.ts";

const repository = (
  name: string,
  auth: object,
): SessionCatalog["repositories"][string] =>
  ({
    url: `https://github.com/acme/${name}.git`,
    branch: "main",
    auth,
  }) as SessionCatalog["repositories"][string];

const entry = (
  id: string,
  repositoryIds: string[],
  extra: Partial<InstallationProfileEntry> = {},
): [string, InstallationProfileEntry] => [
  id,
  {
    id,
    origin: "catalog",
    state: "usable",
    repository_ids: repositoryIds,
    ...extra,
  },
];

const profile = (mode: string) =>
  ({ repository: mode }) as unknown as SessionCatalog["profiles"][string];

const CATALOG = {
  profiles: {
    coding: profile("required"),
    optional: profile("optional"),
    broad: profile("required"),
  },
  repositories: {
    app: repository("app", { kind: "github_app", registered: true }),
    docs: repository("docs", { kind: "github_app", registered: true }),
    outside: repository("outside", { kind: "github_app", registered: true }),
  },
  installation: new Map<string, InstallationProfileEntry>([
    entry("coding", ["app", "docs"]),
    entry("optional", ["app"]),
    entry("broad", ["app"], { repository_scope: "workspace" }),
  ]),
} satisfies SessionCatalog;

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
  profileId: "coding",
  attached: null,
  policySource: "release",
  github: SETTINGS,
  repositoryCeiling: null,
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
    { profile: "coding", id: "app", pair: true, run: true },
    { profile: "coding", id: "docs", pair: true, run: true },
    { profile: "coding", id: "outside", pair: false, run: false },
    { profile: "coding", id: null, pair: false, run: false },
    { profile: "optional", id: null, pair: false, run: true },
    { profile: "missing", id: "app", pair: false, run: false },
  ])("catalog pair: $profile with $id", (row) => {
    expect(
      row.id !== null && allowedPair(CATALOG, row.profile, row.id) !== null,
    ).toBe(row.pair);
    expect(allowedRun(CATALOG, row.profile, row.id) !== null).toBe(row.run);
    // The default and the stored `release` are one reading.
    expect(allowedRun(CATALOG, row.profile, row.id, "release") !== null).toBe(
      row.run,
    );
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
      name: "the workspace ceiling plays no part",
      input: { repositoryCeiling: null },
      ids: ["docs"],
    },
  ] as const)("additional repositories: $name", ({ input, ids }) => {
    const attached = "attached" in input ? [...input.attached] : null;
    expect(idsOf(context({ ...input, attached }))).toEqual([...ids]);
  });

  test.each([
    { profile: "coding", id: "app", starts: true },
    { profile: "coding", id: "outside", starts: false },
    { profile: "coding", id: null, starts: false },
    { profile: "optional", id: null, starts: true },
    { profile: "missing", id: "app", starts: false },
  ])("Slack's start check: $profile with $id", (row) => {
    const release = {
      runtime_profile_id: row.profile,
      repository_id: row.id,
      policy_pins: {},
    };
    expect(releaseStartable(CATALOG, release, null, null)).toBe(row.starts);
    expect(allowedRun(CATALOG, row.profile, row.id) !== null).toBe(row.starts);
  });

  test("a stored profile keeps its own ceiling", () => {
    expect(usesWorkspaceCeiling(CATALOG, "coding", "release")).toBe(false);
    expect(usesWorkspaceCeiling(CATALOG, "missing", "release")).toBe(false);
  });
});

describe("an `agent` session", () => {
  test("a row moves new sessions off the pin, onto the row's start repository", () => {
    const policy = newSessionGitHubPolicy(row(), SETTINGS);
    expect(policy).toMatchObject({
      source: "agent",
      startRepositoryId: "docs",
      agentSettingsRevision: 3,
    });
    expect(startRepositoryOf(undefined, policy, "app")).toBe("docs");
    expect(startRepositoryOf("app", policy, "app")).toBe("app");
    const none = newSessionGitHubPolicy(
      row({ startRepositoryId: null }),
      SETTINGS,
    );
    expect(startRepositoryOf(undefined, none, "app")).toBeNull();
  });

  test("runs off the profile's list and without a required repository: the workspace ceiling judges it", () => {
    expect(allowedPair(CATALOG, "coding", "outside", "agent")).not.toBeNull();
    expect(allowedRun(CATALOG, "coding", null, "agent")).not.toBeNull();
    expect(allowedPair(CATALOG, "missing", "app", "agent")).toBeNull();
    expect(allowedPair(CATALOG, "coding", "unknown", "agent")).toBeNull();
    expect(usesWorkspaceCeiling(CATALOG, "coding", "agent")).toBe(true);
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
    {
      name: "start repository on the list, in the ceiling",
      agent: row(),
      ceiling: ceilingOf("docs"),
      starts: true,
    },
    {
      name: "off the ceiling",
      agent: row(),
      ceiling: ceilingOf("app"),
      starts: false,
    },
    { name: "no ceiling", agent: row(), ceiling: null, starts: false },
    {
      name: "off the agent's list",
      agent: row({ repositories: ["app"] }),
      ceiling: ceilingOf("docs"),
      starts: false,
    },
    {
      name: "a row this image cannot read",
      agent: row({ repositories: "a later shape" }),
      ceiling: ceilingOf("docs"),
      starts: false,
    },
    {
      name: "no start repository on a required profile",
      agent: row({ startRepositoryId: null }),
      ceiling: null,
      starts: true,
    },
  ])("Slack's start check: $name", ({ agent, ceiling, starts }) => {
    const release = {
      runtime_profile_id: "coding",
      repository_id: "app",
      policy_pins: {},
    };
    expect(releaseStartable(CATALOG, release, agent, ceiling)).toBe(starts);
  });
});

describe("a profile with repository_scope = workspace", () => {
  test("the workspace ceiling judges it even on a release session", () => {
    expect(usesWorkspaceCeiling(CATALOG, "broad", "release")).toBe(true);
    expect(allowedPair(CATALOG, "broad", "docs", "release")).not.toBeNull();
    expect(
      idsOf(
        context({
          profileId: "broad",
          repositoryCeiling: ceilingOf("docs"),
        }),
      ),
    ).toEqual(["docs"]);
    expect(idsOf(context({ profileId: "broad" }))).toEqual([]);
  });

  test("Slack's start check reads the ceiling, not the profile's list", () => {
    const release = {
      runtime_profile_id: "broad",
      repository_id: "docs",
      policy_pins: {},
    };
    expect(releaseStartable(CATALOG, release, null, ceilingOf("docs"))).toBe(
      true,
    );
    expect(releaseStartable(CATALOG, release, null, ceilingOf("app"))).toBe(
      false,
    );
    expect(releaseStartable(CATALOG, release, null, null)).toBe(false);
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
