import { describe, expect, test } from "bun:test";
import {
  type Principal,
  type ProfileDerivationPolicy,
  scopesForRole,
  WORKSPACE_PROFILE_POLICY,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import type { WorkspaceProfileStore } from "../ports/workspace-profile-store.ts";
import {
  allowedPair,
  allowedRun,
  type CatalogProfile,
  catalogProfile,
  narrowingRefusal,
  profileFingerprint,
  refreshWorkspaceProfilesFor,
  type SessionCatalog,
  sessionCatalogConfigSchema,
  type WorkspaceProfileRecord,
  workspaceProfileRefusal,
  workspaceProfileState,
} from "./catalog.ts";
import { withSeededInstallation } from "./profile-registry.ts";
import { SessionServiceError } from "./session-service.ts";
import {
  createWorkspaceProfileService,
  createWorkspaceProfiles,
  listCatalogProfiles,
  workspaceSummary,
} from "./workspace-profiles.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000a2";

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

function version(
  overrides: Partial<WorkspaceProfileRecord> = {},
): WorkspaceProfileRecord {
  return {
    id: "ws_acme_strict_v1",
    workspace_id: WORKSPACE,
    name: "strict",
    version: 1,
    base_profile_id: "coding",
    base_fingerprint: profileFingerprint(base),
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5"],
    tools: ["Read"],
    permission_mode: "default",
    base_runtime_version: "0.3.270",
    base_billing: "metered",
    base_repository_mode: "required",
    created_by: "019a0000-0000-7000-8000-0000000000b1",
    created_at: new Date("2026-10-27T00:00:00Z"),
    retired_by: null,
    retired_at: null,
    ...overrides,
  };
}

function catalogWith(
  records: WorkspaceProfileRecord[],
  profiles: Record<string, CatalogProfile> = { coding: base },
): SessionCatalog {
  return withSeededInstallation({
    profiles,
    repositories: {
      app: {
        url: "https://git.example.invalid/team/app.git",
        branch: "main",
        profiles: ["coding"],
        auth: { kind: "github_app", registered: true },
      },
    },
    workspace_profiles: {
      records: new Map(records.map((r) => [r.id, r])),
      refresh: async () => {},
    },
  });
}

describe("narrowing", () => {
  test("takes the base's values or fewer, and refuses anything wider", () => {
    expect(narrowingRefusal(base, version())).toBeNull();
    expect(
      narrowingRefusal(base, version({ models: ["claude-opus-5"] }))?.field,
    ).toBe("models");
    expect(
      narrowingRefusal(base, version({ model: "claude-haiku-5" }))?.field,
    ).toBe("model");
    expect(narrowingRefusal(base, version({ tools: ["Write"] }))?.field).toBe(
      "tools",
    );
    for (const mode of ["bypassPermissions", "auto", "dontAsk"] as const) {
      expect(
        narrowingRefusal(base, version({ permission_mode: mode }))?.field,
      ).toBe("permission_mode");
    }
    for (const mode of ["acceptEdits", "default", "plan"] as const) {
      expect(
        narrowingRefusal(base, version({ permission_mode: mode })),
      ).toBeNull();
    }
  });
});

describe("a workspace version in the catalog", () => {
  test("runs as its base narrowed, where its base may, and only while its base holds", () => {
    const catalog = catalogWith([version()]);
    const profile = catalogProfile(catalog, "ws_acme_strict_v1");
    expect(profile).toMatchObject({
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      tools: ["Read"],
      permission_mode: "default",
      provider: base.provider,
    });
    expect(allowedPair(catalog, "ws_acme_strict_v1", "app")?.profile).toEqual(
      profile,
    );
    expect(allowedRun(catalog, "ws_acme_strict_v1", null)).toBeNull();
    expect(workspaceProfileState(catalog, version())).toBe("usable");

    const edited = catalogWith([version()], {
      coding: { ...base, tools: ["Read", "Edit"] },
    });
    expect(workspaceProfileState(edited, version())).toBe("base_changed");
    expect(catalogProfile(edited, "ws_acme_strict_v1")).toBeUndefined();
    expect(allowedPair(edited, "ws_acme_strict_v1", "app")).toBeNull();

    const fewerModels = catalogWith([version()], {
      coding: { ...base, models: ["claude-haiku-5"], model: "claude-haiku-5" },
    });
    expect(workspaceProfileState(fewerModels, version())).toBe("base_changed");

    const removed = catalogWith([version()], { other: base });
    expect(workspaceProfileState(removed, version())).toBe("base_missing");
    expect(catalogProfile(removed, "ws_acme_strict_v1")).toBeUndefined();
  });

  test("a base whose runtime moved to the next image still holds while the version it was made on is accepted", () => {
    const upgraded = (accepted: string[]) => ({
      ...catalogWith([version()], {
        coding: { ...base, runtime_version: "0.3.280" },
      }),
      runtime_versions: { accepted, current: ["0.3.280"] },
    });
    expect(
      workspaceProfileState(upgraded(["0.3.280", "0.3.270"]), version()),
    ).toBe("usable");
    expect(
      catalogProfile(upgraded(["0.3.280", "0.3.270"]), "ws_acme_strict_v1")
        ?.runtime_version,
    ).toBe("0.3.280");
    expect(workspaceProfileState(upgraded(["0.3.280"]), version())).toBe(
      "base_changed",
    );
    expect(workspaceProfileState(upgraded([]), version())).toBe("base_changed");
  });

  test("a retired version still runs what uses it, and takes nothing new", () => {
    const retired = version({ retired_at: new Date("2026-10-28T00:00:00Z") });
    const catalog = catalogWith([retired]);
    expect(catalogProfile(catalog, retired.id)).toBeDefined();
    expect(workspaceProfileRefusal(catalog, WORKSPACE, retired.id)?.state).toBe(
      "retired",
    );
    expect(
      workspaceProfileRefusal(catalog, WORKSPACE, retired.id, {
        retiredAllowed: true,
      }),
    ).toBeNull();
  });

  test("a retired version over a blocked base reads base_blocked, and its releases stop too", () => {
    const retired = version({ retired_at: new Date("2026-10-28T00:00:00Z") });
    const catalog: SessionCatalog = {
      ...catalogWith([retired]),
      profiles: {},
      installation: new Map([
        [
          "coding",
          {
            id: "coding",
            origin: "catalog",
            state: "blocked",
            repository_ids: ["app"],
          },
        ],
      ]),
    };
    expect(workspaceProfileState(catalog, retired)).toBe("base_blocked");
    expect(
      workspaceProfileRefusal(catalog, WORKSPACE, retired.id, {
        retiredAllowed: true,
      })?.state,
    ).toBe("base_blocked");
  });

  test("another workspace's version reads as unknown; an operator id is never refused here", () => {
    const catalog = catalogWith([version()]);
    expect(
      workspaceProfileRefusal(catalog, OTHER_WORKSPACE, "ws_acme_strict_v1")
        ?.state,
    ).toBe("unknown");
    expect(
      workspaceProfileRefusal(catalog, WORKSPACE, "ws_acme_strict_v9")?.state,
    ).toBe("unknown");
    expect(workspaceProfileRefusal(catalog, WORKSPACE, "coding")).toBeNull();
  });

  test("an operator profile id in the workspace prefix is refused at load", () => {
    const parsed = sessionCatalogConfigSchema.safeParse({
      profiles: {
        ws_acme_strict_v1: {
          runtime_kind: "claude_agent_sdk",
          runtime_version: "1",
          model: "m",
          tools: [],
          permission_mode: "default",
          repository: "none",
          provider: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            auth: { kind: "api_key", value_env: "K" },
          },
        },
      },
      repositories: {},
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "workspace profiles' own",
    );
  });
});

describe("listing", () => {
  test("only the operator-kind profiles are listed: an old ws_ version is not, in any workspace", () => {
    const catalog = catalogWith([
      version(),
      version({ id: "ws_other_strict_v1", workspace_id: OTHER_WORKSPACE }),
    ]);
    const listed = listCatalogProfiles(catalog, WORKSPACE).items;
    expect(listed.map((p) => [p.id, p.source, p.workspace?.state])).toEqual([
      ["coding", "operator", undefined],
    ]);
    expect(listCatalogProfiles(catalog, null).items.map((p) => p.id)).toEqual([
      "coding",
    ]);
  });

  test("a version over a removed base still describes its default model first", () => {
    const catalog = catalogWith(
      [version({ models: ["claude-haiku-5", "claude-sonnet-5"] })],
      { other: base },
    );
    const listed = workspaceSummary(
      catalog,
      version({ models: ["claude-haiku-5", "claude-sonnet-5"] }),
    );
    expect(listed?.models).toEqual(["claude-sonnet-5", "claude-haiku-5"]);
  });

  test("a version over a removed base is described as the base was", () => {
    const catalog = catalogWith([version()], { other: base });
    const listed = workspaceSummary(catalog, version());
    expect(listed).toMatchObject({
      id: "ws_acme_strict_v1",
      runtime_version: "0.3.270",
      billing: "metered",
      repository_mode: "required",
      workspace: { state: "base_missing" },
    });
  });
});

describe("refreshing for a lookup", () => {
  test("reads at once for a version not read yet, within a second for one read, never for an operator id, and swallows a failure", async () => {
    const ages: number[] = [];
    const lookup = {
      workspace_profiles: {
        records: new Map([["ws_acme_strict_v1", version()]]),
        refresh: async (maxAgeMs?: number) => {
          ages.push(maxAgeMs ?? 0);
          throw new Error("down");
        },
      },
    };
    await refreshWorkspaceProfilesFor(lookup, ["coding", null]);
    await refreshWorkspaceProfilesFor(lookup, ["ws_acme_strict_v1"]);
    await refreshWorkspaceProfilesFor(lookup, [
      "ws_acme_strict_v1",
      "ws_acme_strict_v2",
    ]);
    expect(ages).toEqual([1000, 0]);
    await expect(
      refreshWorkspaceProfilesFor(lookup, ["ws_acme_strict_v1"], {
        strict: true,
      }),
    ).rejects.toThrow("down");
    await refreshWorkspaceProfilesFor(lookup, ["coding"], { strict: true });
    expect(ages).toEqual([1000, 0, 1000]);
  });
});

describe("the registry", () => {
  test("a read that began earlier never replaces one that began later", async () => {
    const pending: Array<(rows: WorkspaceProfileRecord[]) => void> = [];
    const registry = createWorkspaceProfiles(
      {
        listAll: () =>
          new Promise<WorkspaceProfileRecord[]>((resolve) => {
            pending.push(resolve);
          }),
      },
      () => 0,
    );
    const older = registry.refresh();
    const newer = registry.refresh();
    const retiredAt = new Date("2026-10-28T00:00:00Z");
    pending[1]?.([version({ retired_at: retiredAt })]);
    await newer;
    pending[0]?.([version()]);
    await older;
    expect(registry.records.get("ws_acme_strict_v1")?.retired_at).toEqual(
      retiredAt,
    );
  });

  test("joins a recent read, reads again past its age, and keeps the last read on failure", async () => {
    let clock = 0;
    let reads = 0;
    let fail = false;
    const registry = createWorkspaceProfiles(
      {
        async listAll() {
          reads += 1;
          if (fail) throw new Error("down");
          return [version({ version: reads })];
        },
      },
      () => clock,
    );
    await Promise.all([registry.refresh(1000), registry.refresh(1000)]);
    expect(reads).toBe(1);
    clock = 500;
    await registry.refresh(1000);
    expect(reads).toBe(1);
    await registry.refresh();
    expect(reads).toBe(2);
    fail = true;
    clock = 5000;
    await expect(registry.refresh(1000)).rejects.toThrow("down");
    expect(registry.records.get("ws_acme_strict_v1")?.version).toBe(2);
  });
});

const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
} as const;

function caller(who: keyof typeof USERS): Caller {
  const role: WorkspaceRole = who;
  const principal: Principal = {
    kind: "user",
    id: USERS[who],
    workspace_id: WORKSPACE,
    role,
    scopes: [...scopesForRole(role)],
  };
  return callerFor(principal, { kind: "web" }, crypto.randomUUID());
}

function service(
  store: Partial<WorkspaceProfileStore> = {},
  readable = true,
  operators?: Record<string, CatalogProfile>,
) {
  const writes: unknown[] = [];
  const catalog = catalogWith([], operators);
  if (!readable && catalog.workspace_profiles) {
    // Down once the write is made: the read before it must still see the base.
    catalog.workspace_profiles.refresh = async () => {
      if (writes.length > 0) throw new Error("database down");
    };
  }
  const profiles = createWorkspaceProfileService({
    authorization: createAuthorizationPolicy({
      agents: {
        agentOf: async () => null,
        isAdmin: async () => false,
      },
      decisions: { record: async () => {} },
    }),
    store: {
      listAll: async () => [],
      async create(input) {
        writes.push(input);
        return {
          outcome: "created",
          record: version({
            ...input.narrowing,
            base_profile_id: input.baseProfileId,
            base_fingerprint: input.base.fingerprint,
          }),
        };
      },
      async retire() {
        return { outcome: "not_found" };
      },
      ...store,
    },
    catalog: {
      ...catalog,
      workspace_profiles: catalog.workspace_profiles as NonNullable<
        SessionCatalog["workspace_profiles"]
      >,
    },
  });
  return { profiles, writes };
}

const REQUEST = {
  name: "strict",
  base_profile_id: "coding",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-sonnet-5"],
  tools: ["Read"],
  permission_mode: "default" as const,
};

async function refusal(work: Promise<unknown>) {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SessionServiceError);
  return error as SessionServiceError;
}

describe("the service", () => {
  test("an owner or an admin saves a version with the base's fingerprint pinned", async () => {
    for (const who of ["owner", "admin"] as const) {
      const { profiles, writes } = service();
      const saved = await profiles.create(caller(who), REQUEST);
      expect(saved.profile.id).toBe("ws_acme_strict_v1");
      expect(saved.receipt_id).not.toBeNull();
      expect(writes).toMatchObject([
        {
          name: "strict",
          baseProfileId: "coding",
          base: {
            fingerprint: profileFingerprint(base),
            runtimeVersion: "0.3.270",
            billing: "metered",
            repositoryMode: "required",
          },
          narrowing: { models: ["claude-sonnet-5"], tools: ["Read"] },
        },
      ]);
    }
  });

  test("a saved version is answered as saved though the reread after it fails, and the list still has the operator's", async () => {
    const { profiles, writes } = service({}, false);
    const saved = await profiles.create(caller("owner"), REQUEST);
    expect(saved.profile.id).toBe("ws_acme_strict_v1");
    expect(writes).toHaveLength(1);
    const listed = await profiles.list(caller("member"));
    expect(listed.items.map((p) => p.id)).toEqual(["coding"]);
  });

  test("the rollout of a version names its refused agents only to an owner or an admin", async () => {
    const summary = {
      total: 2,
      applied: 1,
      pending: 0,
      failed: 1,
      failed_agents: [
        {
          agent_id: "019a0000-0000-7000-8000-0000000000d1",
          name: "재무 분석가",
          reason: "credential_unbound",
        },
      ],
      fixed_model_agents: 0,
    };
    const seeded = catalogWith([]);
    const profiles = createWorkspaceProfileService({
      authorization: createAuthorizationPolicy({
        agents: { agentOf: async () => null, isAdmin: async () => false },
        decisions: { record: async () => {} },
      }),
      store: {
        listAll: async () => [],
        create: async () => ({ outcome: "not_found" }) as never,
        retire: async () => ({ outcome: "not_found" }),
      },
      catalog: {
        ...seeded,
        installation: new Map([
          [
            "coding",
            {
              id: "coding",
              origin: "catalog",
              state: "usable",
              repository_ids: ["app"],
              // Only what listing a ceiling reads from the stored row.
              record: {
                display_name: null,
                name: "coding",
                version: 1,
                origin: "catalog",
                previous_id: null,
                created_by: null,
                created_at: new Date("2026-10-01T00:00:00Z"),
                retired_by: null,
                retired_at: null,
                blocked_by: null,
                blocked_at: null,
                github_app_repositories: "listed",
              } as never,
            },
          ],
        ]),
        workspace_profiles: seeded.workspace_profiles as NonNullable<
          SessionCatalog["workspace_profiles"]
        >,
      },
      rollouts: { summaries: async () => new Map([["coding", summary]]) },
    });
    const rolloutOf = async (who: keyof typeof USERS) =>
      (await profiles.list(caller(who))).items.find((p) => p.id === "coding")
        ?.installation?.rollout;
    expect(await rolloutOf("owner")).toEqual(summary);
    expect(await rolloutOf("admin")).toEqual(summary);
    expect(await rolloutOf("member")).toEqual({
      ...summary,
      failed_agents: [],
    });
  });

  test("a member is refused before anything is written", async () => {
    const { profiles, writes } = service();
    expect(
      (await refusal(profiles.create(caller("member"), REQUEST))).code,
    ).toBe("FORBIDDEN");
    expect(writes).toEqual([]);
  });

  test("over a bypassPermissions base only an owner or an admin saves bypassPermissions", async () => {
    const bypass = {
      coding: { ...base, permission_mode: "bypassPermissions" as const },
    };
    const request = {
      ...REQUEST,
      permission_mode: "bypassPermissions" as const,
    };
    for (const who of ["owner", "admin"] as const) {
      const { profiles, writes } = service({}, true, bypass);
      await profiles.create(caller(who), request);
      expect(writes).toMatchObject([
        { narrowing: { permission_mode: "bypassPermissions" } },
      ]);
    }
    const { profiles, writes } = service({}, true, bypass);
    const refused = await refusal(profiles.create(caller("member"), request));
    expect(refused.code).toBe("FORBIDDEN");
    expect(refused.details).toMatchObject({ reason_code: "role" });
    expect(writes).toEqual([]);
  });

  test("an unknown base or a widening is 400 naming the field", async () => {
    const { profiles, writes } = service();
    const unknown = await refusal(
      profiles.create(caller("owner"), { ...REQUEST, base_profile_id: "nope" }),
    );
    expect(unknown.code).toBe("BAD_REQUEST");
    expect(unknown.details).toMatchObject({ field: "base_profile_id" });
    const widened = await refusal(
      profiles.create(caller("owner"), {
        ...REQUEST,
        permission_mode: "bypassPermissions",
      }),
    );
    expect(widened.code).toBe("BAD_REQUEST");
    expect(widened.details).toMatchObject({
      reason_code: "widens_base",
      field: "permission_mode",
    });
    expect(writes).toEqual([]);
  });

  test("a version saved at the same time is a retryable conflict; a role lost meanwhile is 403", async () => {
    const raced = service({
      create: async () => ({ outcome: "version_taken" }),
    });
    expect(
      (await refusal(raced.profiles.create(caller("owner"), REQUEST))).code,
    ).toBe("REVISION_CONFLICT");
    const demoted = service({
      create: async () => ({ outcome: "actor_inactive" }),
      retire: async () => ({ outcome: "actor_inactive" }),
    });
    expect(
      (await refusal(demoted.profiles.create(caller("owner"), REQUEST))).code,
    ).toBe("FORBIDDEN");
    expect(
      (await refusal(demoted.profiles.retire(caller("owner"), "ws_a_b_v1")))
        .code,
    ).toBe("FORBIDDEN");
  });

  test("retiring: not found, done once, and again with no receipt", async () => {
    const missing = service();
    expect(
      (await refusal(missing.profiles.retire(caller("admin"), "ws_a_b_v1")))
        .code,
    ).toBe("NOT_FOUND");
    const retiredAt = new Date("2026-10-28T00:00:00Z");
    const again = service({
      retire: async () => ({
        outcome: "unchanged",
        record: version({ retired_at: retiredAt }),
      }),
    });
    const unchanged = await again.profiles.retire(caller("admin"), "ws_a_b_v1");
    expect(unchanged.receipt_id).toBeNull();
    expect(unchanged.profile.workspace?.state).toBe("retired");
    expect(
      (await refusal(service().profiles.retire(caller("member"), "ws_a_b_v1")))
        .code,
    ).toBe("FORBIDDEN");
  });
});

describe("the derivation policy", () => {
  const permissive: ProfileDerivationPolicy = {
    ...WORKSPACE_PROFILE_POLICY,
    kind: "test-permissive",
    refusal: () => null,
    apply: (profile, derived) => ({
      ...profile,
      tools: [...derived.tools, "MarkedByPolicy"],
    }),
  };
  const wider = version({ tools: ["Read", "WebFetch"] });

  test("a swapped policy decides what saves and what runs; the default refuses the same version", async () => {
    const narrow = catalogWith([wider]);
    expect(workspaceProfileState(narrow, wider)).toBe("base_changed");
    expect(catalogProfile(narrow, wider.id)).toBeUndefined();
    const { profiles: defaults, writes: refused } = service();
    const widened = await refusal(
      defaults.create(caller("owner"), {
        ...REQUEST,
        tools: ["Read", "WebFetch"],
      }),
    );
    expect(widened.details).toMatchObject({
      reason_code: "widens_base",
      field: "tools",
    });
    expect(refused).toEqual([]);

    const swapped = catalogWith([wider]);
    const registry = createWorkspaceProfiles(
      { listAll: async () => [wider] },
      Date.now,
      permissive,
    );
    await registry.refresh();
    swapped.workspace_profiles = registry;
    expect(workspaceProfileState(swapped, wider)).toBe("usable");
    expect(catalogProfile(swapped, wider.id)?.tools).toEqual([
      "Read",
      "WebFetch",
      "MarkedByPolicy",
    ]);
    const listed = workspaceSummary(swapped, wider);
    expect(listed?.tools).toEqual(["Read", "WebFetch", "MarkedByPolicy"]);

    const writes: unknown[] = [];
    const profiles = createWorkspaceProfileService({
      authorization: createAuthorizationPolicy({
        agents: { agentOf: async () => null, isAdmin: async () => false },
        decisions: { record: async () => {} },
      }),
      store: {
        listAll: async () => [],
        async create(input) {
          writes.push(input);
          return { outcome: "created", record: wider };
        },
        async retire() {
          return { outcome: "not_found" };
        },
      },
      catalog: { ...swapped, workspace_profiles: registry },
    });
    await profiles.create(caller("owner"), {
      ...REQUEST,
      tools: ["Read", "WebFetch"],
    });
    expect(writes).toMatchObject([
      { narrowing: { tools: ["Read", "WebFetch"] } },
    ]);
  });
});
