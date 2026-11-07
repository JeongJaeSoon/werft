import { describe, expect, test } from "bun:test";
import {
  type CreateInstallationProfileRequest,
  type CreateWorkspaceProfileRequest,
  listProfilesResponseSchema,
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  installedDescriptors,
  installedToolCatalogs,
  toolCatalogFor,
} from "@werft-ai/runtime-codecs";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import type {
  CreateInstallationProfileInput,
  InstallationProfileRecord,
} from "../ports/installation-profile-store.ts";
import type { WorkspaceProfileStore } from "../ports/workspace-profile-store.ts";
import {
  type CatalogProfile,
  type CatalogProfileConfig,
  catalogProfile,
  catalogProfileConfigSchema,
  profileFingerprint,
  resolveSessionCatalog,
  runtimeConfigOf,
  type WorkspaceProfileRecord,
  workspaceProfileState,
} from "./catalog.ts";
import { ProfileFeatureGate } from "./feature-gate.ts";
import { createInstallationProfileService } from "./installation-profiles.ts";
import {
  catalogRows,
  createProfileRegistry,
  definitionFingerprint,
  profileCatalog,
} from "./profile-registry.ts";
import type { ToolCatalogs } from "./profile-tools.ts";
import { SessionServiceError } from "./session-service.ts";
import {
  createWorkspaceProfileService,
  listCatalogProfiles,
} from "./workspace-profiles.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OWNER = "019a0000-0000-7000-8000-0000000000c1";
const TOOL_CATALOGS: ToolCatalogs = {
  all: installedToolCatalogs,
  for: (kind, version) => toolCatalogFor(installedToolCatalogs, kind, version),
};
const CATALOG = toolCatalogFor(
  installedToolCatalogs,
  "claude_agent_sdk",
  "0.3.270",
);
if (!CATALOG) throw new Error("no catalog for 0.3.270");
const ALL = CATALOG.tools.map((tool) => tool.name);
const without = (...names: string[]) =>
  ALL.filter((name) => !names.includes(name));

const MAIN: CatalogProfileConfig["provider"] = {
  kind: "anthropic",
  endpoint: "https://api.anthropic.invalid",
  auth: { kind: "api_key", value_env: "PROVIDER_KEY" },
};
const SEED: CatalogProfileConfig = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: ["Read", "Edit", "Bash"],
  permission_mode: "acceptEdits",
  provider: MAIN,
  project_settings: { claude_md: false },
  repository: "none",
};

function owner(): Caller {
  const role: WorkspaceRole = "owner";
  const principal: Principal = {
    kind: "user",
    id: OWNER,
    workspace_id: WORKSPACE,
    role,
    scopes: [...scopesForRole(role)],
  };
  return callerFor(principal, { kind: "web" }, crypto.randomUUID());
}

function stores(rows: InstallationProfileRecord[]) {
  const writes: CreateInstallationProfileInput[] = [];
  const versions: WorkspaceProfileRecord[] = [];
  const versionWrites: Parameters<WorkspaceProfileStore["create"]>[0][] = [];
  const installation = {
    listAll: async () => rows.map((row) => ({ ...row })),
    async create(input: CreateInstallationProfileInput) {
      writes.push(input);
      const latest = rows
        .filter((row) => row.origin === "console" && row.name === input.name)
        .sort((a, b) => b.version - a.version)[0];
      if (latest && input.previousId !== latest.id) {
        return { outcome: "stale_previous" as const, latestId: latest.id };
      }
      const version = (latest?.version ?? 0) + 1;
      const record: InstallationProfileRecord = {
        id: `op_${input.name}_v${version}`,
        name: input.name,
        version,
        origin: "console",
        definition: JSON.parse(JSON.stringify(input.definition)),
        permission_mode: input.permission_mode,
        fingerprint: input.fingerprint,
        repository_ids: null,
        github_app_repositories: "listed",
        repository_scope: null,
        deny: input.deny,
        tool_catalog_id: input.toolCatalogId,
        previous_id: input.previousId,
        created_by: OWNER,
        created_at: new Date("2026-11-04T00:00:00Z"),
        retired_at: null,
        retired_by: null,
        blocked_at: null,
        blocked_by: null,
      };
      rows.push(record);
      return { outcome: "created" as const, record };
    },
    retire: async () => ({ outcome: "not_found" as const }),
    async setBlocked(input: { profileId: string; blocked: boolean }) {
      const index = rows.findIndex((row) => row.id === input.profileId);
      const row = rows[index];
      if (!row) return { outcome: "not_found" as const };
      const changed = {
        ...row,
        blocked_at: input.blocked ? new Date("2026-11-04T01:00:00Z") : null,
        blocked_by: input.blocked ? OWNER : null,
      };
      rows[index] = changed;
      return { outcome: "changed" as const, record: changed };
    },
  };
  const workspace: WorkspaceProfileStore = {
    listAll: async () => versions.map((row) => ({ ...row })),
    async create(input) {
      versionWrites.push(input);
      const latest = versions
        .filter((row) => row.name === input.name)
        .sort((a, b) => b.version - a.version)[0];
      if (
        input.previousVersion !== undefined &&
        (latest?.version ?? null) !== input.previousVersion
      ) {
        return { outcome: "version_taken" };
      }
      const version = (latest?.version ?? 0) + 1;
      const record: WorkspaceProfileRecord = {
        id: `ws_acme_${input.name}_v${version}`,
        workspace_id: WORKSPACE,
        name: input.name,
        version,
        base_profile_id: input.baseProfileId,
        base_fingerprint: input.base.fingerprint,
        model: input.narrowing.model,
        models: input.narrowing.models,
        tools: input.narrowing.tools,
        permission_mode: input.narrowing.permission_mode,
        base_runtime_version: input.base.runtimeVersion,
        base_billing: input.base.billing,
        base_repository_mode: input.base.repositoryMode,
        deny: input.deny,
        tool_catalog_id: input.toolCatalogId,
        created_by: OWNER,
        created_at: new Date("2026-11-04T00:00:00Z"),
        retired_by: null,
        retired_at: null,
      };
      versions.push(record);
      return { outcome: "created", record };
    },
    retire: async () => ({ outcome: "not_found" }),
  };
  return { installation, workspace, writes, versions, versionWrites };
}

function setup(
  options: { rows?: InstallationProfileRecord[]; catalogs?: boolean } = {},
) {
  const rows = options.rows ?? catalogRows({ seed: SEED });
  const made = stores(rows);
  const catalog = profileCatalog(
    {
      repositories: {},
      ...(options.catalogs === false ? {} : { tool_catalogs: TOOL_CATALOGS }),
    },
    createProfileRegistry({
      workspaces: made.workspace,
      installations: made.installation,
      sources: {
        connections: { main: MAIN },
        allowUnattended: false,
        runtimeSupported: () => true,
        materialize: (id, definition) => {
          const profile = resolveSessionCatalog(
            { profiles: { [id]: definition }, repositories: {} },
            () => "a-provider-key",
          ).profiles[id];
          if (!profile) throw new Error(`no ${id}`);
          return profile as CatalogProfile;
        },
      },
    }),
  );
  const authorization = createAuthorizationPolicy({
    agents: { agentOf: async () => null, isAdmin: async () => false },
    decisions: { record: async () => {} },
  });
  const ceilings = createInstallationProfileService({
    authorization,
    store: made.installation,
    rollouts: { retryFailed: async () => false },
    catalog,
    connections: () => catalog.workspace_profiles.connections,
    allowUnattended: false,
    runtimes: new ProfileFeatureGate(installedDescriptors),
    newId: () => "019a0000-0000-7000-8000-0000000000e1",
  });
  const workspace = createWorkspaceProfileService({
    authorization,
    store: made.workspace,
    catalog,
    newId: () => "019a0000-0000-7000-8000-0000000000e2",
  });
  return { ...made, rows, catalog, ceilings, workspace };
}

const { tools: _tools, ...CEILING } = {
  name: "coding",
  connection_id: "main",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  tools: [] as string[],
  permission_mode: "acceptEdits",
} satisfies CreateInstallationProfileRequest;

const VERSION = {
  name: "strict",
  base_profile_id: "op_coding_v1",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5"],
  permission_mode: "acceptEdits",
} satisfies Omit<CreateWorkspaceProfileRequest, "tools">;

async function refused(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof SessionServiceError)) {
    throw new Error(`expected a refusal, got ${String(error)}`);
  }
  return {
    code: error.code,
    ...(error.details as { reason_code?: string; field?: string }),
  };
}

describe("a ceiling saved with a deny", () => {
  test("stores the catalog less the deny as tools, the deny and catalog id beside the definition", async () => {
    const { ceilings, writes, catalog } = setup();
    const saved = await ceilings.create(owner(), {
      ...CEILING,
      deny: ["WebSearch", "Bash"],
    });
    expect(writes[0]?.definition).toMatchObject({
      tools: without("Bash", "WebSearch"),
    });
    expect(Object.keys(writes[0]?.definition as object)).not.toContain("deny");
    expect(writes[0]?.deny).toEqual(["Bash", "WebSearch"]);
    expect(writes[0]?.toolCatalogId).toBe(CATALOG.id);
    expect(saved.profile).toMatchObject({
      tools: without("Bash", "WebSearch"),
      deny: ["Bash", "WebSearch"],
    });
    // What a session of it is handed: the stored tools.
    const profile = catalogProfile(catalog, "op_coding_v1");
    if (!profile) throw new Error("not running");
    expect(runtimeConfigOf(profile, "token", false).tools).toEqual(
      without("Bash", "WebSearch"),
    );
  });

  test("deny: [] runs every catalog tool", async () => {
    const { ceilings, writes } = setup();
    const saved = await ceilings.create(owner(), { ...CEILING, deny: [] });
    expect(writes[0]?.definition).toMatchObject({ tools: ALL });
    expect(saved.profile.deny).toEqual([]);
  });

  test("hashes as the allow list it worked out to: the deny is in no digest", async () => {
    const denied = setup();
    await denied.ceilings.create(owner(), { ...CEILING, deny: ["Bash"] });
    const listed = setup();
    await listed.ceilings.create(owner(), {
      ...CEILING,
      tools: without("Bash"),
    });
    expect(denied.writes[0]?.definition).toEqual(
      listed.writes[0]?.definition as object,
    );
    expect(denied.writes[0]?.fingerprint).toBe(
      listed.writes[0]?.fingerprint as string,
    );
    const a = catalogProfile(denied.catalog, "op_coding_v1");
    const b = catalogProfile(listed.catalog, "op_coding_v1");
    if (!a || !b) throw new Error("not running");
    expect(profileFingerprint(a)).toBe(profileFingerprint(b));
    expect(listed.writes[0]?.deny).toBeNull();
    expect(listed.writes[0]?.toolCatalogId).toBeNull();
  });

  test("an old client's allow list is kept as given, tools: [] included", async () => {
    const { ceilings, writes } = setup();
    const saved = await ceilings.create(owner(), {
      ...CEILING,
      tools: [],
    });
    expect(writes[0]?.definition).toMatchObject({ tools: [] });
    expect(writes[0]?.deny).toBeNull();
    expect(saved.profile.tools).toEqual([]);
    // Listed with what the allow list leaves out of its catalog.
    expect(saved.profile.deny).toEqual(ALL);
  });

  test("names only whole catalog tools: MCP tools, patterns and unknown names are 400", async () => {
    const { ceilings, writes } = setup();
    for (const [name, reason] of [
      ["mcp__github__get_file", "mcp_tool"],
      ["Bash(rm:*)", "tool_pattern"],
      ["Task", "unknown_tool"],
      ["TodoWrite", "unknown_tool"],
    ] as const) {
      expect(
        await refused(ceilings.create(owner(), { ...CEILING, deny: [name] })),
      ).toEqual({ code: "BAD_REQUEST", reason_code: reason, field: "deny" });
    }
    expect(writes).toEqual([]);
  });

  test("a runtime version no catalog lists takes tools, and its deny is 400", async () => {
    const { ceilings, writes } = setup();
    const unknown = { ...CEILING, runtime_version: "0.0.1" };
    expect(
      await refused(ceilings.create(owner(), { ...unknown, deny: [] })),
    ).toEqual({
      code: "BAD_REQUEST",
      reason_code: "no_tool_catalog",
      field: "deny",
    });
    const saved = await ceilings.create(owner(), {
      ...unknown,
      tools: ["Read"],
    });
    expect(writes[0]?.deny).toBeNull();
    expect(saved.profile.deny).toBeNull();
  });

  test("a server given no tool catalogs refuses every deny and lists none", async () => {
    const { ceilings } = setup({ catalogs: false });
    expect(
      (await refused(ceilings.create(owner(), { ...CEILING, deny: [] })))
        .reason_code,
    ).toBe("no_tool_catalog");
    const saved = await ceilings.create(owner(), { ...CEILING, tools: [] });
    expect("deny" in saved.profile).toBe(false);
  });
});

describe("tools a next version adds", () => {
  test("over an allow list, every tool it did not allow opens only once accepted", async () => {
    const { ceilings, writes } = setup();
    await ceilings.create(owner(), { ...CEILING, tools: ["Read", "Edit"] });
    const next = { ...CEILING, previous_id: "op_coding_v1" };
    expect(
      await refused(ceilings.create(owner(), { ...next, deny: [] })),
    ).toEqual({
      code: "BAD_REQUEST",
      reason_code: "added_tool_not_accepted",
      field: "accept_added_tools",
    });
    expect(
      await refused(
        ceilings.create(owner(), {
          ...next,
          deny: ["WebSearch"],
          accept_added_tools: ["Bash"],
        }),
      ),
    ).toMatchObject({ reason_code: "added_tool_not_accepted" });
    expect(writes).toHaveLength(1);
    // Blocking what it never weighed keeps it equal; accepting opens it.
    await ceilings.create(owner(), {
      ...next,
      deny: without("Read", "Edit"),
    });
    const opened = await ceilings.create(owner(), {
      ...CEILING,
      previous_id: "op_coding_v2",
      deny: ["WebSearch"],
      accept_added_tools: ["Bash", "Glob"],
    });
    expect(opened.profile.tools).toEqual(without("WebSearch"));
    expect(writes.at(-1)?.deny).toEqual(["WebSearch"]);
  });

  test("over a deny of the same catalog nothing is added, so unblocking needs no acceptance", async () => {
    const { ceilings } = setup();
    await ceilings.create(owner(), { ...CEILING, deny: ["Bash", "WebSearch"] });
    const next = await ceilings.create(owner(), {
      ...CEILING,
      previous_id: "op_coding_v1",
      deny: [],
    });
    expect(next.profile.tools).toEqual(ALL);
  });

  test("a deny row whose catalog grew under the same id weighed only its own tools and deny", async () => {
    const definition = catalogProfileConfigSchema.parse({
      ...SEED,
      tools: ["Read", "Edit"],
    });
    const grown: InstallationProfileRecord = {
      ...catalogRows({ seed: SEED })[0],
      id: "op_coding_v1",
      name: "coding",
      origin: "console",
      definition,
      fingerprint: definitionFingerprint("coding", definition),
      deny: ["Bash"],
      tool_catalog_id: CATALOG.id,
    } as InstallationProfileRecord;
    const { ceilings } = setup({ rows: [grown] });
    const next = { ...CEILING, previous_id: "op_coding_v1" };
    expect(
      (await refused(ceilings.create(owner(), { ...next, deny: ["Bash"] })))
        .reason_code,
    ).toBe("added_tool_not_accepted");
    const accepted = await ceilings.create(owner(), {
      ...next,
      deny: ["Bash"],
      accept_added_tools: without("Read", "Edit", "Bash"),
    });
    expect(accepted.profile.tools).toEqual(without("Bash"));
  });

  test("a previous version this replica has not read refuses the save", async () => {
    const { ceilings } = setup();
    expect(
      await refused(
        ceilings.create(owner(), {
          ...CEILING,
          previous_id: "op_nowhere_v1",
          deny: [],
        }),
      ),
    ).toMatchObject({ reason_code: "unknown_previous" });
  });
});

describe("a deny read back", () => {
  test("a column that no longer says what the tools leave out reads as the tools do, and the next save names the drift", async () => {
    const definition = catalogProfileConfigSchema.parse({
      ...SEED,
      tools: without("Bash"),
    });
    const drifted: InstallationProfileRecord = {
      ...catalogRows({ seed: SEED })[0],
      id: "op_coding_v1",
      name: "coding",
      origin: "console",
      definition,
      fingerprint: definitionFingerprint("coding", definition),
      deny: ["Bash", "WebSearch"],
      tool_catalog_id: CATALOG.id,
    } as InstallationProfileRecord;
    const { ceilings, catalog, writes } = setup({ rows: [drifted] });
    await catalog.workspace_profiles.refresh();
    const listed = listCatalogProfiles(catalog, WORKSPACE).items.find(
      (item) => item.id === "op_coding_v1",
    );
    expect(listed?.deny).toEqual(["Bash"]);
    expect(listed?.installation?.state).toBe("usable");
    await ceilings.create(owner(), {
      ...CEILING,
      previous_id: "op_coding_v1",
      deny: ["Bash"],
    });
    expect(writes[0]?.previousDenyDrift).toBe(true);
  });

  test("lists parse for a reader of either version", async () => {
    const { ceilings, catalog } = setup();
    await ceilings.create(owner(), { ...CEILING, deny: ["Bash"] });
    const listed = listCatalogProfiles(catalog, WORKSPACE);
    expect(listProfilesResponseSchema.parse(listed)).toEqual(listed);
    expect(listed.items.find((item) => item.id === "seed")?.deny).toEqual(
      without("Read", "Edit", "Bash"),
    );
  });

  test("options carry each catalog under both spellings of its runtime version", async () => {
    const { ceilings } = setup();
    const options = await ceilings.options(owner());
    expect(
      options.tool_catalogs?.map((entry) => [entry.id, entry.runtime_version]),
    ).toEqual([
      [CATALOG.id, CATALOG.sdkVersion],
      [CATALOG.id, CATALOG.engineVersion],
    ]);
    expect(options.tool_catalogs?.[0]?.tools).toEqual(
      CATALOG.tools.map((tool) => ({ ...tool })),
    );
  });
});

describe("a workspace version saved with a deny", () => {
  async function overDenyBase() {
    const made = setup();
    await made.ceilings.create(owner(), {
      ...CEILING,
      deny: ["WebSearch"],
    });
    return made;
  }

  test("runs the base's tools less the deny, keeping the base's blocks", async () => {
    const { workspace, versionWrites, catalog } = await overDenyBase();
    const saved = await workspace.create(owner(), {
      ...VERSION,
      deny: ["WebSearch", "Bash"],
    });
    expect(versionWrites[0]?.narrowing.tools).toEqual(
      without("Bash", "WebSearch"),
    );
    expect(versionWrites[0]?.deny).toEqual(["Bash", "WebSearch"]);
    expect(versionWrites[0]?.toolCatalogId).toBe(CATALOG.id);
    expect(saved.profile.deny).toEqual(["Bash", "WebSearch"]);
    const profile = catalogProfile(catalog, saved.profile.id);
    if (!profile) throw new Error("not running");
    expect(runtimeConfigOf(profile, "token", false).tools).toEqual(
      without("Bash", "WebSearch"),
    );
  });

  test("a deny that leaves out a base block is 400", async () => {
    const { workspace, versionWrites } = await overDenyBase();
    expect(
      await refused(workspace.create(owner(), { ...VERSION, deny: ["Bash"] })),
    ).toEqual({
      code: "BAD_REQUEST",
      reason_code: "base_denies",
      field: "deny",
    });
    expect(versionWrites).toEqual([]);
  });

  test("over an allow-list base the version stays a subset of the base's tools", async () => {
    const { workspace, versionWrites } = setup();
    const saved = await workspace.create(owner(), {
      ...VERSION,
      base_profile_id: "seed",
      deny: ["Edit"],
    });
    expect(versionWrites[0]?.narrowing.tools).toEqual(["Read", "Bash"]);
    expect(versionWrites[0]?.deny).toEqual(without("Read", "Bash"));
    expect(saved.profile.workspace?.state).toBe("usable");
  });

  test("a tool the previous version never weighed opens only once accepted", async () => {
    const { workspace } = await overDenyBase();
    await workspace.create(owner(), { ...VERSION, tools: ["Read"] });
    expect(
      (
        await refused(
          workspace.create(owner(), { ...VERSION, deny: ["WebSearch"] }),
        )
      ).reason_code,
    ).toBe("added_tool_not_accepted");
    const accepted = await workspace.create(owner(), {
      ...VERSION,
      deny: without("Read", "Edit"),
      accept_added_tools: ["Edit"],
    });
    expect(accepted.profile.tools).toEqual(["Read", "Edit"]);
  });

  test("a block on the base stops a deny-made version and what runs on it", async () => {
    const { workspace, ceilings, catalog } = await overDenyBase();
    const saved = await workspace.create(owner(), {
      ...VERSION,
      deny: ["WebSearch"],
    });
    await ceilings.setBlocked(owner(), "op_coding_v1", true);
    await catalog.workspace_profiles.refresh();
    const record = catalog.workspace_profiles.records.get(saved.profile.id);
    if (!record) throw new Error("not read");
    expect(workspaceProfileState(catalog, record)).toBe("base_blocked");
  });

  test("a replica that reads no deny columns runs the same tools under the same base fingerprint", async () => {
    const { workspace, catalog } = await overDenyBase();
    const saved = await workspace.create(owner(), {
      ...VERSION,
      deny: ["WebSearch", "Bash"],
    });
    const record = catalog.workspace_profiles.records.get(saved.profile.id);
    if (!record) throw new Error("not read");
    const { deny: _deny, tool_catalog_id: _id, ...older } = record;
    const asOlder = {
      ...catalog,
      workspace_profiles: {
        ...catalog.workspace_profiles,
        records: new Map([[older.id, older]]),
      },
    };
    expect(workspaceProfileState(asOlder, older)).toBe("usable");
    expect(catalogProfile(asOlder, older.id)).toEqual(
      catalogProfile(catalog, record.id) as CatalogProfile,
    );
  });
});
