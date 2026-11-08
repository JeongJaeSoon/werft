import { describe, expect, test } from "bun:test";
import {
  type CatalogProfile,
  type InstallationProfileEntry,
  profileFingerprint,
  type SessionCatalog,
  type WorkspaceProfileRecord,
} from "./catalog.ts";
import {
  type MigrationAgentFact,
  type MigrationInput,
  migrationRefusal,
  planMigration,
} from "./profile-migration.ts";
import { withSeededInstallation } from "./profile-registry.ts";

const W = "019a0000-0000-7000-8000-0000000000a1";
const OWNER = "019a0000-0000-7000-8000-0000000000b1";

const base: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-haiku-5"],
  tools: ["Read", "Edit", "Bash"],
  permission_mode: "acceptEdits",
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value: "resolved-key", ref: { value_env: "K" } },
  },
};

const stored = {
  runtime_kind: base.runtime_kind,
  runtime_version: base.runtime_version,
  model: base.model,
  models: base.models,
  tools: base.tools,
  permission_mode: base.permission_mode,
  provider: {
    kind: "anthropic",
    endpoint: "https://api.anthropic.invalid",
    auth: { kind: "api_key", value_env: "K" },
  },
  repository: "optional",
};

function version(
  name: string,
  n: number,
  overrides: Partial<WorkspaceProfileRecord> = {},
): WorkspaceProfileRecord {
  return {
    id: `ws_acme_${name}_v${n}`,
    workspace_id: W,
    name,
    version: n,
    base_profile_id: "coding",
    base_fingerprint: profileFingerprint(base),
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5"],
    tools: ["Read"],
    permission_mode: "default",
    base_runtime_version: "0.3.270",
    base_billing: "metered",
    base_repository_mode: "required",
    created_by: OWNER,
    created_at: new Date("2026-10-27T00:00:00Z"),
    retired_by: null,
    retired_at: null,
    ...overrides,
  };
}

function catalogWith(
  records: WorkspaceProfileRecord[],
  baseIds: string[] = ["private-a", "url-r", "gone", "held"],
  scope: "profile" | "workspace" = "profile",
): SessionCatalog {
  const seeded = withSeededInstallation({
    profiles: { coding: base },
    repositories: {},
    workspace_profiles: {
      records: new Map(records.map((r) => [r.id, r])),
      refresh: async () => {},
    },
  });
  const entry: InstallationProfileEntry = {
    id: "coding",
    origin: "console",
    state: "usable",
    repository_ids: baseIds,
    repository_scope: scope,
    definition: stored as never,
    record: {
      id: "coding",
      name: "coding",
      version: 1,
      origin: "console",
      definition: stored,
      permission_mode: "acceptEdits",
      fingerprint: "fp-coding",
      repository_ids: baseIds,
      github_app_repositories: "listed",
      repository_scope: scope,
      previous_id: null,
      created_by: null,
      created_at: new Date(0),
      retired_at: null,
      retired_by: null,
      blocked_at: null,
      blocked_by: null,
    },
  };
  return {
    ...seeded,
    installation: new Map([["coding", entry]]),
  } as SessionCatalog;
}

function agent(
  id: string,
  profileId: string,
  overrides: Partial<MigrationAgentFact> = {},
): MigrationAgentFact {
  return {
    agentId: id,
    workspaceId: W,
    activeReleaseId: `rel-${id}`,
    activeProfileId: profileId,
    activationRevision: 3,
    behaviorRevision: 1,
    tracking: "follow",
    modelSource: "fixed",
    draftVersionId: null,
    hasSettingsRow: true,
    releaseRepositoryId: null,
    pinnedRepositories: [],
    toolsBefore: ["Read"],
    ...overrides,
  };
}

function input(
  catalog: SessionCatalog,
  agents: MigrationAgentFact[],
  overrides: Partial<MigrationInput> = {},
): MigrationInput {
  let n = 0;
  return {
    now: "2026-11-08T00:00:00.000Z",
    catalog,
    workspaces: [
      {
        id: W,
        ceiling: {
          repository_ids: ["held"],
          github_app_repositories: "installed",
        },
        owners: [OWNER],
      },
    ],
    agents,
    repositories: [
      { id: "private-a", authKind: "github_app_explicit", removed: false },
      { id: "url-r", authKind: "none", removed: false },
      { id: "gone", authKind: "github_app_explicit", removed: true },
      { id: "held", authKind: "github_app_explicit", removed: false },
      { id: "pin-b", authKind: "github_app_explicit", removed: false },
    ],
    sessions: [],
    copies: [],
    takenNames: new Map(),
    newId: () => `id${++n}`,
    migrationId: "mig-1",
    ...overrides,
  };
}

const planOf = (i: MigrationInput) =>
  planMigration(i).workspaces[0] as NonNullable<
    ReturnType<typeof planMigration>["workspaces"][number]
  >;

describe("planMigration", () => {
  test("copies usable versions in old-number order and keeps one lineage", () => {
    const records = [
      version("strict", 2),
      version("strict", 1),
      version("old", 1, { retired_at: new Date("2026-10-30T00:00:00Z") }),
      version("lost", 1, { base_profile_id: "missing" }),
    ];
    const plan = planOf(
      input(catalogWith(records), [
        agent("a1", "ws_acme_strict_v1"),
        agent("a2", "ws_acme_strict_v2"),
        agent("a3", "ws_acme_old_v1"),
        agent("a4", "ws_acme_lost_v1"),
      ]),
    );
    const strict = plan.profiles.filter((p) => p.name === "strict");
    expect(strict.map((p) => [p.source_id, p.decision])).toEqual([
      ["ws_acme_strict_v1", "copy"],
      ["ws_acme_strict_v2", "copy"],
    ]);
    const [v1, v2] = strict.map((p) => p.target);
    expect(v1?.lineage_name).toStartWith("wl_");
    expect(v2?.lineage_name).toBe(v1?.lineage_name as string);
    expect([v1?.lineage_version, v2?.lineage_version]).toEqual([1, 2]);
    expect(v2?.previous_id).toBe(v1?.id as string);
    expect(v1?.display_name).toBe("strict");
    expect(v1?.definition).toMatchObject({
      tools: ["Read"],
      models: ["claude-sonnet-5"],
      permission_mode: "default",
    });
    expect(v1?.definition).not.toHaveProperty("repository");
    expect(plan.profiles.find((p) => p.name === "old")).toMatchObject({
      decision: "skip",
      skip: "retired",
    });
    expect(plan.profiles.find((p) => p.name === "lost")).toMatchObject({
      decision: "skip",
      skip: "base_missing",
    });
  });

  test("an agent on a version that is not the newest of its name is pinned; the others keep their tracking", () => {
    const plan = planOf(
      input(catalogWith([version("strict", 1), version("strict", 2)]), [
        agent("a1", "ws_acme_strict_v1"),
        agent("a2", "ws_acme_strict_v2", { tracking: "pinned" }),
        agent("a3", "ws_acme_strict_v2"),
        agent("a4", "ws_acme_old_v1"),
      ]),
    );
    const byId = Object.fromEntries(plan.agents.map((a) => [a.agent_id, a]));
    expect(byId.a1).toMatchObject({
      decision: "move",
      tracking_after: "pinned",
    });
    expect(byId.a2).toMatchObject({
      decision: "move",
      tracking_after: "pinned",
    });
    expect(byId.a3).toMatchObject({
      decision: "move",
      tracking_after: "follow",
    });
    expect(byId.a1?.to_profile_id).not.toBe(byId.a3?.to_profile_id);
    expect(byId.a4).toBeUndefined();
    expect(byId.a1?.expected).toEqual({
      active_release_id: "rel-a1",
      activation_revision: 3,
      behavior_revision: 1,
      tracking: "follow",
      model_source: "fixed",
    });
  });

  test("the states that do not copy leave the agent where it is, with the reason", () => {
    const records = [
      version("r", 1, { retired_at: new Date("2026-10-30T00:00:00Z") }),
      version("c", 1, { tools: ["Write"] }),
    ];
    const plan = planOf(
      input(catalogWith(records), [
        agent("a1", "ws_acme_r_v1"),
        agent("a2", "ws_acme_c_v1"),
      ]),
    );
    expect(
      plan.agents.map((a) => [a.agent_id, a.decision, a.stay_reason]),
    ).toEqual([
      ["a1", "stay", "retired"],
      ["a2", "stay", "base_changed"],
    ]);
  });

  test("the ceiling gains live explicit-App values the copied versions allow, and nothing else", () => {
    const plan = planOf(
      input(catalogWith([version("strict", 1)]), [
        agent("a1", "ws_acme_strict_v1"),
      ]),
    );
    expect(plan.ceiling.additions).toEqual([
      {
        repository_id: "private-a",
        source: { kind: "profile", id: "ws_acme_strict_v1" },
      },
    ]);
    expect(
      plan.ceiling.not_added.map((n) => [n.repository_id, n.reason]),
    ).toEqual([
      ["gone", "removed"],
      ["url-r", "url"],
    ]);
    expect(plan.ceiling.after?.repository_ids).toEqual(["held", "private-a"]);
    expect(plan.ceiling.before?.repository_ids).toEqual(["held"]);
    expect(plan.sessions.widened_repositories).toEqual(["private-a"]);
  });

  test("a base that the workspace ceiling already judges allows nothing of its own", () => {
    const plan = planOf(
      input(catalogWith([version("strict", 1)], ["private-a"], "workspace"), [
        agent("a1", "ws_acme_strict_v1"),
      ]),
    );
    expect(plan.ceiling.additions).toEqual([]);
  });

  test("an agent without a settings row brings its pins; a version not copied brings nothing", () => {
    const plan = planOf(
      input(catalogWith([version("strict", 1)], []), [
        agent("a1", "ws_acme_strict_v1", {
          hasSettingsRow: false,
          releaseRepositoryId: "pin-b",
          pinnedRepositories: ["pin-b", "url-r", "held"],
        }),
      ]),
    );
    expect(plan.ceiling.additions).toEqual([
      { repository_id: "pin-b", source: { kind: "agent_pin", id: "a1" } },
    ]);
    expect(plan.ceiling.not_added.map((n) => n.reason)).toEqual(["url"]);
  });

  test("start conditions: a release without a settings row, a workspace with no ceiling", () => {
    const withoutRow = planMigration(
      input(catalogWith([version("strict", 1)]), [
        agent("a1", "ws_acme_strict_v1", { hasSettingsRow: false }),
      ]),
    );
    expect(withoutRow.preconditions.r2_complete).toBe(false);
    expect(migrationRefusal(withoutRow)).toContain("R2 is not complete");
    const noCeiling = planMigration(
      input(catalogWith([version("strict", 1)]), [], {
        workspaces: [{ id: W, ceiling: null, owners: [OWNER] }],
      }),
    );
    expect(noCeiling.preconditions.null_ceiling_workspaces).toEqual([W]);
    expect(migrationRefusal(noCeiling)).toContain("no repository ceiling");
    const ready = planMigration(
      input(catalogWith([version("strict", 1)]), [
        agent("a1", "ws_acme_strict_v1"),
      ]),
    );
    expect(migrationRefusal(ready)).toBeNull();
  });

  test("a copy an earlier run wrote is reused; a newer-first lineage does not get an older version appended", () => {
    const first = planOf(
      input(catalogWith([version("strict", 1), version("strict", 2)]), [
        agent("a1", "ws_acme_strict_v1"),
      ]),
    );
    const copies = first.profiles.map((p, index) => ({
      id: p.target?.id as string,
      migratedFrom: p.source_id,
      name: p.target?.lineage_name as string,
      displayName: "strict",
      workspaceId: W,
      version: index + 1,
      derivedFrom: "coding",
      definition: p.target?.definition as Record<string, unknown>,
      deny: p.target?.deny ?? null,
      retired: false,
    }));
    const again = planOf(
      input(catalogWith([version("strict", 1), version("strict", 2)]), [], {
        copies,
      }),
    );
    expect(again.profiles.map((p) => p.decision)).toEqual(["exists", "exists"]);
    expect(again.profiles.map((p) => p.target?.id)).toEqual(
      first.profiles.map((p) => p.target?.id),
    );

    const onlyNewest = planOf(
      input(
        catalogWith([version("strict", 1), version("strict", 2)]),
        [agent("a1", "ws_acme_strict_v1")],
        { copies: copies.slice(1).map((c) => ({ ...c, version: 1 })) },
      ),
    );
    const v1 = onlyNewest.profiles.find(
      (p) => p.source_id === "ws_acme_strict_v1",
    );
    expect(v1).toMatchObject({ decision: "skip", skip: "older_than_copied" });
    expect(onlyNewest.agents[0]).toMatchObject({
      decision: "stay",
      stay_reason: "older_than_copied",
    });

    const retiredCopy = planOf(
      input(catalogWith([version("strict", 1), version("strict", 2)]), [], {
        copies: copies.map((c) => ({ ...c, retired: true })),
      }),
    );
    expect(retiredCopy.profiles.map((p) => p.skip)).toEqual([
      "copy_unusable",
      "copy_unusable",
    ]);
  });

  test("a display name another profile has gets a suffix, said in the plan", () => {
    const plan = planOf(
      input(catalogWith([version("strict", 1)]), [], {
        takenNames: new Map([["strict", new Set<string | null>([null])]]),
      }),
    );
    expect(plan.profiles[0]?.target).toMatchObject({
      display_name: "strict-2",
      display_name_suffixed: true,
    });
  });

  test("sessions are counted for the report, not for the decision", () => {
    const plan = planOf(
      input(catalogWith([version("strict", 1)]), [], {
        sessions: [
          {
            workspaceId: W,
            profileId: "ws_acme_strict_v1",
            hasAgent: false,
            active: false,
            createdAt: "2026-11-01T00:00:00.000Z",
          },
          {
            workspaceId: W,
            profileId: "ws_acme_strict_v1",
            hasAgent: false,
            active: false,
            createdAt: "2026-08-01T00:00:00.000Z",
          },
          {
            workspaceId: W,
            profileId: "x",
            hasAgent: true,
            active: true,
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
    );
    expect(plan.sessions).toMatchObject({
      agentless_on_copied_profiles: 1,
      agentless_recent: 1,
      agent_recent: 1,
    });
  });

  test("each version reports what runs on it today, and whether an installation version already has its form", () => {
    const plan = planOf(
      input(
        catalogWith([
          version("strict", 1),
          version("same", 1, {
            models: [...(base.models ?? [])],
            tools: [...base.tools],
            permission_mode: "acceptEdits",
          }),
        ]),
        [
          agent("a1", "ws_acme_strict_v1"),
          agent("a2", "ws_acme_strict_v1"),
          agent("a3", "ws_acme_same_v1"),
        ],
        {
          releaseCounts: new Map([["ws_acme_strict_v1", 4]]),
          checkpointCounts: new Map([["ws_acme_strict_v1", 7]]),
          sessions: [
            {
              workspaceId: W,
              profileId: "ws_acme_strict_v1",
              hasAgent: true,
              active: true,
              createdAt: "2026-11-07T00:00:00.000Z",
            },
            {
              workspaceId: W,
              profileId: "ws_acme_strict_v1",
              hasAgent: false,
              active: false,
              createdAt: "2026-11-07T00:00:00.000Z",
            },
          ],
        },
      ),
    );
    const usage = (id: string) =>
      plan.profiles.find((p) => p.source_id === id)?.usage;
    expect(usage("ws_acme_strict_v1")).toEqual({
      agents_on_active: 2,
      pinned_releases: 4,
      running_sessions: 1,
      checkpoints: 7,
      equivalent_installation_version: null,
    });
    expect(usage("ws_acme_same_v1")).toMatchObject({
      agents_on_active: 1,
      pinned_releases: 0,
      running_sessions: 0,
      checkpoints: 0,
      equivalent_installation_version: "coding",
    });
  });

  test("a retired version is reported with its effective value and equivalent version too", () => {
    const plan = planOf(
      input(
        catalogWith([
          version("old", 1, {
            models: [...(base.models ?? [])],
            tools: [...base.tools],
            permission_mode: "acceptEdits",
            retired_at: new Date("2026-10-30T00:00:00Z"),
            retired_by: OWNER,
          }),
          version("gone-base", 1, { base_profile_id: "missing" }),
        ]),
        [],
      ),
    );
    const old = plan.profiles.find((p) => p.source_id === "ws_acme_old_v1");
    expect(old).toMatchObject({
      state: "retired",
      decision: "skip",
      skip: "retired",
      usage: { equivalent_installation_version: "coding" },
    });
    expect(old?.effective).toMatchObject({ tools: base.tools });
    const missing = plan.profiles.find(
      (p) => p.source_id === "ws_acme_gone-base_v1",
    );
    expect(missing?.effective).toBeNull();
  });

  test("the report gives the allowed sets before and after, by kind of session", () => {
    const plan = planOf(
      input(
        catalogWith([version("strict", 1)]),
        [
          agent("a1", "ws_acme_strict_v1", {
            settingsRepositories: ["private-a", "url-r"],
          }),
          agent("a2", "ws_acme_strict_v1", { settingsRepositories: ["held"] }),
        ],
        {
          sessions: [
            {
              workspaceId: W,
              profileId: "ws_acme_strict_v1",
              hasAgent: true,
              policySource: "agent",
              active: true,
              createdAt: "2026-11-07T00:00:00.000Z",
            },
            {
              workspaceId: W,
              profileId: "ws_acme_strict_v1",
              hasAgent: false,
              policySource: "release",
              active: true,
              createdAt: "2026-11-07T00:00:00.000Z",
            },
            {
              workspaceId: W,
              profileId: "coding",
              hasAgent: false,
              policySource: "release",
              active: true,
              createdAt: "2026-11-07T00:00:00.000Z",
            },
          ],
        },
      ),
    );
    const access = plan.session_access;
    expect(access.ceiling_before).toEqual(["held"]);
    expect(access.ceiling_after).toEqual(["held", "private-a"]);
    // Agent sessions are always judged by the ceiling; only the agent whose
    // own settings list the new value gains it.
    expect(access.agent_sessions).toMatchObject({
      sessions: 1,
      judged_by_ceiling: 1,
      unchanged: 0,
      widened_repositories: ["private-a"],
    });
    expect(access.agents_widened).toEqual([
      { agent_id: "a1", repositories: ["private-a"] },
    ]);
    // The copied version's base lists its own repositories, so a release-source
    // session on it is not judged by the ceiling and gains nothing.
    expect(access.agentless_on_copied_profiles).toMatchObject({
      sessions: 1,
      judged_by_ceiling: 0,
      unchanged: 1,
      widened_repositories: [],
    });
    expect(access.other_profile_sessions.sessions).toBe(1);
    // The sets themselves, by profile: the ceiling's for a session it judges,
    // the profile's own list (unchanged) for one it does not.
    expect(access.agent_sessions.by_profile).toEqual([
      {
        profile_id: "ws_acme_strict_v1",
        judged_by_ceiling: true,
        sessions: 1,
        before: ["held"],
        after: ["held", "private-a"],
      },
    ]);
    expect(access.other_profile_sessions.by_profile).toEqual([
      {
        profile_id: "coding",
        judged_by_ceiling: false,
        sessions: 1,
        before: ["gone", "held", "private-a", "url-r"],
        after: ["gone", "held", "private-a", "url-r"],
      },
    ]);
  });

  test("when the base defers to the workspace ceiling, agentless sessions on a copy are widened with it", () => {
    const plan = planOf(
      input(
        catalogWith([version("strict", 1)], ["private-a"], "workspace"),
        [agent("a1", "ws_acme_strict_v1")],
        {
          sessions: [
            {
              workspaceId: W,
              profileId: "ws_acme_strict_v1",
              hasAgent: false,
              policySource: "release",
              active: true,
              createdAt: "2026-11-07T00:00:00.000Z",
            },
          ],
        },
      ),
    );
    expect(plan.session_access.agentless_on_copied_profiles).toMatchObject({
      sessions: 1,
      judged_by_ceiling: 1,
    });
  });
});

describe("planMigration and mcp__ deny", () => {
  const blockedBase: CatalogProfile = { ...base, mcp_deny: ["mcp__a__b"] };

  function blockedCatalog(records: WorkspaceProfileRecord[]) {
    const catalog = catalogWith(records);
    (catalog.profiles as Record<string, CatalogProfile>).coding = blockedBase;
    const record = catalog.installation?.get("coding")?.record;
    if (record) {
      record.deny = ["WebSearch", "mcp__a__b"];
      record.tool_catalog_id = "engine@old";
    }
    return catalog;
  }
  const own = (overrides: Partial<WorkspaceProfileRecord> = {}) =>
    version("strict", 1, {
      base_fingerprint: profileFingerprint(blockedBase),
      ...overrides,
    });

  // The whole report, hashed: a field, a value or an order that moves for a
  // profile with no mcp__ name changes this. Pinned from the code before
  // mcp__ names were read.
  test("without mcp__ names the whole plan is byte for byte what it was", () => {
    const records = [
      version("strict", 1, { deny: ["WebSearch"] }),
      version("strict", 2),
      version("loose", 1, { tools: ["Read", "Edit"] }),
    ];
    const plan = planMigration(
      input(catalogWith(records), [
        agent("a1", "ws_acme_strict_v1"),
        agent("a2", "ws_acme_loose_v1", { tracking: "follow" }),
      ]),
    );
    const hash = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(plan))
      .digest("hex");
    expect(hash).toBe(
      "7513c55a1460bf05321a719056384af269b83778e782c94a180b18b096ef0051",
    );
  });

  test("without mcp__ names the plan is what it was: the version's deny, no mcp key anywhere", () => {
    const plan = planOf(
      input(catalogWith([version("strict", 1, { deny: ["WebSearch"] })]), [
        agent("a1", "ws_acme_strict_v1"),
      ]),
    );
    const [profile] = plan.profiles;
    expect(profile?.target?.deny).toEqual(["WebSearch"]);
    expect(Object.keys(profile?.target?.definition ?? {})).not.toContain(
      "mcp_deny",
    );
    expect(Object.keys(profile?.effective ?? {})).not.toContain("mcp_deny");
    const none = planOf(
      input(catalogWith([version("strict", 1)]), [
        agent("a1", "ws_acme_strict_v1"),
      ]),
    );
    expect(none.profiles[0]?.target?.deny).toBeNull();
  });

  test("a copy takes the base's names the version lacks, into the deny column and not the definition", () => {
    const plan = planOf(
      input(blockedCatalog([own({ deny: ["WebSearch"] })]), [
        agent("a1", "ws_acme_strict_v1"),
      ]),
    );
    const [profile] = plan.profiles;
    expect(profile?.decision).toBe("copy");
    expect(profile?.target?.deny).toEqual(["WebSearch", "mcp__a__b"]);
    expect(Object.keys(profile?.target?.definition ?? {})).not.toContain(
      "mcp_deny",
    );
    expect(Object.keys(profile?.effective ?? {})).not.toContain("mcp_deny");
  });

  test("a version with no deny column still copies the base's names", () => {
    const plan = planOf(
      input(blockedCatalog([own()]), [agent("a1", "ws_acme_strict_v1")]),
    );
    expect(plan.profiles[0]?.target?.deny).toEqual(["mcp__a__b"]);
    // The table wants a catalog id beside any deny: the base's, here.
    expect(plan.profiles[0]?.target?.tool_catalog_id).toBe("engine@old");
  });

  test("an earlier copy counts as the same only when its mcp__ names match", () => {
    const records = [own({ deny: ["WebSearch", "mcp__a__b"] })];
    const first = planOf(
      input(blockedCatalog(records), [agent("a1", "ws_acme_strict_v1")]),
    );
    const target = first.profiles[0]?.target;
    const copy = (deny: string[] | null) => ({
      id: target?.id as string,
      migratedFrom: "ws_acme_strict_v1",
      name: target?.lineage_name as string,
      displayName: "strict",
      workspaceId: W,
      version: 1,
      derivedFrom: "coding",
      definition: target?.definition as Record<string, unknown>,
      deny,
      retired: false,
    });
    const decisionWith = (deny: string[] | null) =>
      planOf(
        input(blockedCatalog(records), [agent("a1", "ws_acme_strict_v1")], {
          copies: [copy(deny)],
        }),
      ).profiles[0]?.decision;
    expect(decisionWith(["WebSearch", "mcp__a__b"])).toBe("exists");
    expect(decisionWith(["WebSearch"])).toBe("skip");
  });
});
