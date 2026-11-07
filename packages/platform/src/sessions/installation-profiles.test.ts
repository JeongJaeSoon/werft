import { describe, expect, test } from "bun:test";
import {
  type CreateInstallationProfileRequest,
  type Principal,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { installedDescriptors } from "@werft-ai/runtime-codecs";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
} from "../musterrolle/policy.ts";
import type {
  CreateInstallationProfileInput,
  InstallationProfileRecord,
  InstallationProfileStore,
} from "../ports/installation-profile-store.ts";
import type { InstallationSettings } from "../ports/installation-settings-store.ts";
import {
  type CatalogProfile,
  type CatalogProfileConfig,
  resolveSessionCatalog,
} from "./catalog.ts";
import { ProfileFeatureGate } from "./feature-gate.ts";
import { createInstallationProfileService } from "./installation-profiles.ts";
import { settingsSnapshot } from "./installation-settings.ts";
import { sameExecutionForm } from "./profile-execution-form.ts";
import {
  type Connections,
  catalogRows,
  createProfileRegistry,
  profileCatalog,
} from "./profile-registry.ts";
import { SessionServiceError } from "./session-service.ts";
import {
  createWorkspaceProfileService,
  listCatalogProfiles,
} from "./workspace-profiles.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const USERS = {
  owner: "019a0000-0000-7000-8000-0000000000c1",
  admin: "019a0000-0000-7000-8000-0000000000c2",
  member: "019a0000-0000-7000-8000-0000000000c3",
} as const;

const MAIN: CatalogProfileConfig["provider"] = {
  kind: "anthropic",
  endpoint: "https://api.anthropic.invalid",
  auth: { kind: "api_key", value_env: "PROVIDER_KEY" },
};
const SEED: CatalogProfileConfig = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-haiku-5"],
  tools: ["Read", "Edit"],
  permission_mode: "default",
  provider: MAIN,
  project_settings: { claude_md: false },
  repository: "required",
};
const REPOSITORIES = {
  app: {
    url: "https://git.example.invalid/team/app.git",
    branch: "main",
    profiles: ["seed"],
  },
  docs: {
    url: "https://git.example.invalid/team/docs.git",
    branch: "main",
    profiles: [],
  },
};

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

const apiKey = callerFor(
  {
    kind: "api_key",
    id: "key-1",
    owner_id: WORKSPACE,
    workspace_id: WORKSPACE,
    scopes: [...scopesForRole("owner")],
  } as Principal,
  { kind: "api" },
  crypto.randomUUID(),
);

function memoryStore(rows: InstallationProfileRecord[]) {
  const writes: CreateInstallationProfileInput[] = [];
  const reads = { failing: false };
  const store: Pick<
    InstallationProfileStore,
    "listAll" | "create" | "retire" | "setBlocked"
  > = {
    listAll: async () => {
      if (reads.failing) throw new Error("the database went away");
      return rows.map((row) => ({ ...row }));
    },
    // A stand-in for the lineage rules the database store enforces (its own
    // integration tests hold the real ones).
    async create(input) {
      writes.push(input);
      const workspaceId =
        input.scope.kind === "workspace" ? input.scope.workspaceId : null;
      const versions = rows.filter(
        (row) =>
          row.origin === "console" &&
          (workspaceId === null
            ? row.name === input.name && !row.workspace_id
            : row.workspace_id === workspaceId &&
              row.display_name === input.name),
      );
      const latest = versions.sort((a, b) => b.version - a.version)[0];
      if (latest && input.previousId !== latest.id) {
        return { outcome: "stale_previous", latestId: latest.id };
      }
      if (
        latest &&
        !latest.retired_at &&
        !latest.blocked_at &&
        sameExecutionForm(
          latest.definition as Record<string, unknown>,
          input.definition as Record<string, unknown>,
        )
      ) {
        return { outcome: "unchanged", record: latest };
      }
      if (
        !latest &&
        input.previousId !== null &&
        !rows.some((row) => row.id === input.previousId)
      ) {
        return { outcome: "unknown_previous" };
      }
      if (
        !latest &&
        rows.some(
          (row) =>
            row.display_name === input.name ||
            (!row.workspace_id && row.name === input.name),
        )
      ) {
        return { outcome: "name_taken" };
      }
      const version = (latest?.version ?? 0) + 1;
      const key =
        workspaceId === null
          ? input.name
          : (latest?.name ?? `wl_${crypto.randomUUID()}`);
      const id = `op_${key}_v${version}`;
      if (rows.some((row) => row.id === id)) {
        return { outcome: "id_taken", id };
      }
      const record: InstallationProfileRecord = {
        id,
        name: key,
        version,
        origin: "console",
        definition: JSON.parse(JSON.stringify(input.definition)),
        permission_mode: input.permission_mode,
        fingerprint: input.fingerprint,
        repository_ids: null,
        github_app_repositories: "listed",
        repository_scope: null,
        workspace_id: workspaceId,
        display_name: workspaceId === null ? null : input.name,
        derived_from:
          input.scope.kind === "workspace"
            ? (latest?.derived_from ?? input.scope.derivedFrom)
            : null,
        previous_id: input.previousId,
        created_by: input.actor.userId,
        created_at: new Date("2026-10-28T00:00:00Z"),
        retired_at: null,
        retired_by: null,
        blocked_at: null,
        blocked_by: null,
      };
      rows.push(record);
      return { outcome: "created", record };
    },
    async retire(input) {
      const index = rows.findIndex((row) => row.id === input.profileId);
      const row = rows[index];
      if (!row) return { outcome: "not_found" };
      if (row.retired_at !== null) return { outcome: "unchanged", record: row };
      const retired = {
        ...row,
        retired_at: new Date("2026-10-28T01:00:00Z"),
        retired_by: input.actor.userId,
      };
      rows[index] = retired;
      return { outcome: "retired", record: retired };
    },
    async setBlocked(input) {
      const index = rows.findIndex((row) => row.id === input.profileId);
      const row = rows[index];
      if (!row) return { outcome: "not_found" };
      if ((row.blocked_at !== null) === input.blocked)
        return { outcome: "unchanged", record: row };
      const changed = {
        ...row,
        blocked_at: input.blocked ? new Date("2026-10-28T02:00:00Z") : null,
        blocked_by: input.blocked ? input.actor.userId : null,
      };
      rows[index] = changed;
      return { outcome: "changed", record: changed };
    },
  };
  return { store, writes, reads };
}

function setup(
  options: {
    allowUnattended?: boolean;
    rows?: InstallationProfileRecord[];
    fileConnections?: Connections;
    settings?: InstallationSettings;
  } = {},
) {
  const rows = options.rows ?? catalogRows({ seed: SEED }, REPOSITORIES);
  const { store, writes, reads } = memoryStore(rows);
  const connections = options.fileConnections ?? { main: MAIN };
  const { settings } = options;
  const catalog = profileCatalog(
    { repositories: REPOSITORIES },
    createProfileRegistry({
      workspaces: { listAll: async () => [] },
      installations: store,
      ...(settings === undefined
        ? {}
        : {
            settings: {
              read: async () =>
                settingsSnapshot(settings, () => "a-settings-key"),
            },
          }),
      sources: {
        connections,
        allowUnattended: options.allowUnattended ?? false,
        runtimeSupported: () => true,
        materialize: (id, definition, lookup) => {
          const profile = resolveSessionCatalog(
            { profiles: { [id]: definition }, repositories: {} },
            (ref) => lookup?.(ref) ?? "a-provider-key",
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
  const service = createInstallationProfileService({
    authorization,
    store,
    rollouts: { retryFailed: async () => false },
    catalog,
    connections: () => catalog.workspace_profiles.connections,
    allowUnattended: options.allowUnattended ?? false,
    runtimes: new ProfileFeatureGate(installedDescriptors),
    newId: () => "019a0000-0000-7000-8000-0000000000e1",
  });
  const versions = createWorkspaceProfileService({
    authorization,
    store: {
      listAll: async () => [],
      create: async () => {
        throw new Error("not reached");
      },
      retire: async () => ({ outcome: "not_found" }),
    },
    catalog,
  });
  return { service, versions, catalog, rows, writes, reads };
}

const REQUEST: CreateInstallationProfileRequest = {
  name: "coding",
  connection_id: "main",
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  models: ["claude-sonnet-5", "claude-opus-5"],
  title_model: "claude-haiku-5",
  tools: ["Read", "Edit", "Bash"],
  permission_mode: "acceptEdits",
};

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof SessionServiceError)) {
    throw new Error(`expected a refusal, got ${String(error)}`);
  }
  return {
    code: error.code,
    reason: (error.details as { reason_code?: string } | null)?.reason_code,
  };
}

describe("saving an installation ceiling", () => {
  test("the owner saves v1, the connection's provider copied in, listed with its installation fields", async () => {
    const { service, writes } = setup();
    const saved = await service.create(caller("owner"), REQUEST);
    expect(writes[0]?.definition).toMatchObject({ provider: MAIN });
    expect(writes[0]?.previousId).toBeNull();
    expect(saved.receipt_id).toBe("019a0000-0000-7000-8000-0000000000e1");
    expect(saved.profile).toMatchObject({
      id: "op_coding_v1",
      source: "operator",
      models: ["claude-sonnet-5", "claude-opus-5"],
      tools: ["Read", "Edit", "Bash"],
      installation: {
        name: "coding",
        version: 1,
        origin: "console",
        state: "usable",
        connection_id: "main",
        title_model: "claude-haiku-5",
        project_settings: { claude_md: false },
        previous_id: null,
        created_by: USERS.owner,
        retired_by: null,
      },
    });
    expect(JSON.stringify(saved)).not.toContain("api.anthropic.invalid");
  });

  test("the definition written has no repository key", async () => {
    const { service, writes } = setup();
    await service.create(caller("owner"), REQUEST);
    expect(Object.hasOwn(writes[0]?.definition as object, "repository")).toBe(
      false,
    );
  });

  test("a save that runs the same answers the latest version with a null receipt and writes nothing", async () => {
    const { service, rows } = setup();
    await service.create(caller("owner"), REQUEST);
    const again = await service.create(caller("owner"), {
      ...REQUEST,
      previous_id: "op_coding_v1",
      models: ["claude-opus-5", "claude-sonnet-5"],
    });
    expect(again.receipt_id).toBeNull();
    expect(again.profile.id).toBe("op_coding_v1");
    expect(rows.filter((row) => row.name === "coding")).toHaveLength(1);
  });

  test("an admin narrows a version, which the server copies the runtime from; the owner's fields are 400", async () => {
    const { service, rows } = setup();
    const saved = await service.create(caller("admin"), {
      name: "narrow",
      derived_from: "seed",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      tools: ["Read"],
      permission_mode: "default",
    });
    expect(saved.profile.installation?.name).toBe("narrow");
    expect(saved.profile.id).toMatch(/^op_wl_[0-9a-f-]{36}_v1$/);
    expect(rows.at(-1)).toMatchObject({
      workspace_id: WORKSPACE,
      display_name: "narrow",
      derived_from: "seed",
    });
    expect(rows.at(-1)?.definition).toMatchObject({
      runtime_version: "0.3.270",
      provider: MAIN,
    });
    for (const extra of [
      { connection_id: "main" },
      { runtime_kind: "claude_agent_sdk" as const },
      { runtime_version: "0.3.270" },
      { title_model: "claude-haiku-5" },
    ]) {
      const refused = await refusal(
        service.create(caller("admin"), {
          name: "other",
          derived_from: "seed",
          model: "claude-sonnet-5",
          models: ["claude-sonnet-5"],
          tools: ["Read"],
          permission_mode: "default",
          ...extra,
        }),
      );
      expect([refused.code, refused.reason]).toEqual([
        "BAD_REQUEST",
        "source_field",
      ]);
    }
  });

  test("an admin cannot widen the source, name none, or reach another workspace's version; the owner must name the runtime", async () => {
    const { service, writes } = setup();
    const base = {
      name: "wide",
      derived_from: "seed",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      tools: ["Read"],
      permission_mode: "default" as const,
    };
    expect(
      await refusal(
        service.create(caller("admin"), { ...base, tools: ["Read", "Bash"] }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "widens_base" });
    expect(
      await refusal(
        service.create(caller("admin"), { ...base, derived_from: undefined }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "missing_field" });
    expect(
      await refusal(
        service.create(caller("admin"), { ...base, derived_from: "nowhere" }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "unknown_base" });
    expect(
      await refusal(
        service.create(caller("owner"), {
          name: "bare",
          model: "claude-sonnet-5",
          models: ["claude-sonnet-5"],
          tools: ["Read"],
          permission_mode: "default",
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "missing_field" });
    expect(writes).toEqual([]);
  });

  test("a display name this workspace already sees is name_taken", async () => {
    const { service } = setup();
    const request = {
      name: "narrow",
      derived_from: "seed",
      model: "claude-sonnet-5",
      models: ["claude-sonnet-5"],
      tools: ["Read"],
      permission_mode: "default" as const,
    };
    await service.create(caller("admin"), request);
    expect(
      await refusal(
        service.create(caller("admin"), { ...request, tools: ["Read"] }),
      ),
    ).toEqual({ code: "REVISION_CONFLICT", reason: "stale_previous" });
    expect(
      await refusal(
        service.create(caller("owner"), { ...REQUEST, name: "narrow" }),
      ),
    ).toEqual({ code: "REVISION_CONFLICT", reason: "name_taken" });
  });

  test("the next version names the latest as previous_id; anything else is a conflict", async () => {
    const { service } = setup();
    await service.create(caller("owner"), REQUEST);
    expect(await refusal(service.create(caller("owner"), REQUEST))).toEqual({
      code: "REVISION_CONFLICT",
      reason: "stale_previous",
    });
    expect(
      await refusal(
        service.create(caller("owner"), {
          ...REQUEST,
          previous_id: "seed",
        }),
      ),
    ).toEqual({ code: "REVISION_CONFLICT", reason: "stale_previous" });
    const v2 = await service.create(caller("owner"), {
      ...REQUEST,
      tools: ["Read"],
      previous_id: "op_coding_v1",
    });
    expect(v2.profile.id).toBe("op_coding_v2");
    expect(v2.profile.installation?.previous_id).toBe("op_coding_v1");
  });

  test("a first version may replace an imported ceiling, but not one that is no row", async () => {
    const { service } = setup();
    const made = await service.create(caller("owner"), {
      ...REQUEST,
      name: "remade",
      previous_id: "seed",
    });
    expect(made.profile.installation?.previous_id).toBe("seed");
    expect(
      await refusal(
        service.create(caller("owner"), {
          ...REQUEST,
          name: "other",
          previous_id: "nowhere",
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "unknown_previous" });
  });

  test("an id already an imported profile's is id_taken", async () => {
    const { service } = setup({
      rows: catalogRows({ seed: SEED, op_clash_v1: SEED }),
    });
    expect(
      await refusal(
        service.create(caller("owner"), { ...REQUEST, name: "clash" }),
      ),
    ).toEqual({ code: "REVISION_CONFLICT", reason: "id_taken" });
  });

  test("a member and an API key are 403 before anything is written; an admin retires and blocks nothing", async () => {
    const { service, writes } = setup();
    for (const who of [caller("member"), apiKey]) {
      expect((await refusal(service.create(who, REQUEST))).code).toBe(
        "FORBIDDEN",
      );
      expect((await refusal(service.options(who))).code).toBe("FORBIDDEN");
    }
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      expect((await refusal(service.retire(who, "seed"))).code).toBe(
        "FORBIDDEN",
      );
    }
    expect(writes).toEqual([]);
  });

  test("bypassPermissions is 400 while the installation's switch is off, and saves once it is on", async () => {
    const bypass = {
      ...REQUEST,
      permission_mode: "bypassPermissions" as const,
    };
    const off = setup();
    expect(await refusal(off.service.create(caller("owner"), bypass))).toEqual({
      code: "BAD_REQUEST",
      reason: "unattended_not_allowed",
    });
    expect(off.writes).toEqual([]);
    const on = setup({ allowUnattended: true });
    const saved = await on.service.create(caller("owner"), bypass);
    expect(saved.profile.permission_mode).toBe("bypassPermissions");
    expect(saved.profile.installation?.state).toBe("usable");
  });

  test("what the installation does not have is 400 naming it", async () => {
    const { service, writes } = setup();
    const cases: Array<[Partial<CreateInstallationProfileRequest>, string]> = [
      [{ connection_id: "elsewhere" }, "unknown_connection"],
      [{ runtime_kind: "pi_coding_agent" }, "runtime_not_installed"],
      [{ model: "claude-haiku-5" }, "model_not_in_models"],
    ];
    for (const [change, reason] of cases) {
      const refused = await refusal(
        service.create(caller("owner"), { ...REQUEST, ...change }),
      );
      expect([refused.code, refused.reason]).toEqual(["BAD_REQUEST", reason]);
    }
    expect(writes).toEqual([]);
  });
});

describe("a write whose re-read fails", () => {
  test("still answers what it committed: the new version usable, the retired one retired", async () => {
    const { service, catalog, reads } = setup();
    await catalog.workspace_profiles.refresh();
    reads.failing = true;
    const saved = await service.create(caller("owner"), REQUEST);
    expect(saved.profile.id).toBe("op_coding_v1");
    expect(saved.profile.installation).toMatchObject({
      state: "usable",
      connection_id: "main",
      version: 1,
    });
    const retired = await service.retire(caller("owner"), "seed");
    expect(retired.receipt_id).not.toBeNull();
    expect(retired.profile.installation?.state).toBe("retired");
  });
});

describe("a row whose definition no longer parses", () => {
  test("is neither listed nor retired, and nothing is written", async () => {
    const rows = catalogRows({ seed: SEED, broken: SEED }).map((row) =>
      row.id === "broken" ? { ...row, definition: { runtime_kind: 1 } } : row,
    );
    const { service, catalog } = setup({ rows });
    await catalog.workspace_profiles.refresh();
    expect(
      listCatalogProfiles(catalog, WORKSPACE).items.map((item) => item.id),
    ).toEqual(["seed"]);
    expect(
      (await refusal(service.retire(caller("owner"), "broken"))).code,
    ).toBe("NOT_FOUND");
    expect(rows.find((row) => row.id === "broken")?.retired_at).toBeNull();
  });
});

describe("retiring an installation ceiling", () => {
  test("retires once with a receipt, then answers null; an unknown id is 404", async () => {
    const { service } = setup();
    const retired = await service.retire(caller("owner"), "seed");
    expect(retired.receipt_id).not.toBeNull();
    expect(retired.profile.installation).toMatchObject({
      origin: "catalog",
      name: null,
      state: "retired",
      retired_by: USERS.owner,
    });
    expect((await service.retire(caller("owner"), "seed")).receipt_id).toBe(
      null,
    );
    expect((await refusal(service.retire(caller("owner"), "nope"))).code).toBe(
      "NOT_FOUND",
    );
  });

  test("a retired ceiling is no base for a new workspace version", async () => {
    const { service, versions } = setup();
    await service.retire(caller("owner"), "seed");
    expect(
      await refusal(
        versions.create(caller("admin"), {
          name: "narrow",
          base_profile_id: "seed",
          model: "claude-sonnet-5",
          models: ["claude-sonnet-5"],
          tools: ["Read"],
          permission_mode: "default",
        }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "retired" });
  });
});

describe("blocking an installation ceiling", () => {
  const NARROW = {
    name: "narrow",
    base_profile_id: "seed",
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5"],
    tools: ["Read"],
    permission_mode: "default" as const,
  };

  test("blocks once with a receipt and takes it out of what runs; unblocking restores it", async () => {
    const { service, catalog } = setup();
    const blocked = await service.setBlocked(caller("owner"), "seed", true);
    expect(blocked.receipt_id).not.toBeNull();
    expect(blocked.profile.installation).toMatchObject({
      state: "blocked",
      blocked_by: USERS.owner,
    });
    expect(Object.hasOwn(catalog.profiles, "seed")).toBe(false);
    expect(
      (await service.setBlocked(caller("owner"), "seed", true)).receipt_id,
    ).toBeNull();
    const unblocked = await service.setBlocked(caller("owner"), "seed", false);
    expect(unblocked.receipt_id).not.toBeNull();
    expect(unblocked.profile.installation).toMatchObject({
      state: "usable",
      blocked_by: null,
      blocked_at: null,
    });
    expect(Object.hasOwn(catalog.profiles, "seed")).toBe(true);
    expect(
      (await service.setBlocked(caller("owner"), "seed", false)).receipt_id,
    ).toBeNull();
    expect(
      (await refusal(service.setBlocked(caller("owner"), "nope", true))).code,
    ).toBe("NOT_FOUND");
  });

  test("a retired ceiling blocked reads blocked, and retired again once unblocked", async () => {
    const { service } = setup();
    await service.retire(caller("owner"), "seed");
    expect(
      (await service.setBlocked(caller("owner"), "seed", true)).profile
        .installation?.state,
    ).toBe("blocked");
    expect(
      (await service.setBlocked(caller("owner"), "seed", false)).profile
        .installation?.state,
    ).toBe("retired");
  });

  test("only the owner blocks or unblocks: an admin, a member and an API key are 403", async () => {
    const { service, rows } = setup();
    for (const who of [caller("admin"), caller("member"), apiKey]) {
      for (const blocked of [true, false]) {
        expect(
          (await refusal(service.setBlocked(who, "seed", blocked))).code,
        ).toBe("FORBIDDEN");
      }
    }
    expect(rows.map((row) => row.blocked_at)).toEqual([null]);
  });

  test("a blocked ceiling is no base for a new workspace version", async () => {
    const { service, versions } = setup();
    await service.setBlocked(caller("owner"), "seed", true);
    expect(await refusal(versions.create(caller("admin"), NARROW))).toEqual({
      code: "BAD_REQUEST",
      reason: "blocked",
    });
  });
});

describe("connections the installation settings hold", () => {
  const STORED: CatalogProfileConfig["provider"] = {
    kind: "anthropic",
    endpoint: "https://db.anthropic.invalid",
    auth: { kind: "api_key", stored: "connection:console_main" },
  };
  const SETTINGS: InstallationSettings = {
    generation: 3,
    connections: [{ id: "console_main", provider: STORED }],
    repositories: [],
    mcpServers: [],
    stored: new Map([["connection:console_main", "a-stored-provider-key"]]),
    invalid: [],
  };

  test("are options and run a ceiling no other connection names", async () => {
    const { service, catalog } = setup({
      fileConnections: {},
      settings: SETTINGS,
    });
    await catalog.workspace_profiles.refresh();
    const options = await service.options(caller("owner"));
    expect(options.connections).toEqual([
      { id: "console_main", kind: "anthropic", billing: "metered" },
    ]);
    const saved = await service.create(caller("owner"), {
      ...REQUEST,
      connection_id: "console_main",
    });
    expect(saved.profile.installation).toMatchObject({
      state: "usable",
      connection_id: "console_main",
    });
    expect(catalog.profiles.op_coding_v1?.provider).toMatchObject({
      endpoint: "https://db.anthropic.invalid",
      auth: { value: "a-stored-provider-key" },
    });
    expect(JSON.stringify(options)).not.toContain("a-stored-provider-key");
  });
});

describe("the options and the list", () => {
  test("options name connections without their endpoint, the runtimes' modes and the switch", async () => {
    const { service } = setup();
    const options = await service.options(caller("owner"));
    expect(options.connections).toEqual([
      { id: "main", kind: "anthropic", billing: "metered" },
    ]);
    expect(options.repositories).toBeUndefined();
    expect(options.unattended_allowed).toBe(false);
    expect(
      options.runtimes.find((r) => r.runtime_kind === "claude_agent_sdk")
        ?.permission_modes,
    ).toContain("auto");
    expect(JSON.stringify(options)).not.toContain("api.anthropic.invalid");
    expect(JSON.stringify(options)).not.toContain("PROVIDER_KEY");
  });

  test("a ceiling that does not run here is listed with why, from its stored definition", async () => {
    const elsewhere = {
      ...SEED,
      provider: { ...MAIN, endpoint: "https://elsewhere.invalid" },
    };
    const { catalog } = setup({
      rows: catalogRows({ seed: SEED, gone: elsewhere }),
    });
    await catalog.workspace_profiles.refresh();
    const listed = listCatalogProfiles(catalog, WORKSPACE).items;
    expect(
      listed.map((item) => [
        item.id,
        item.installation?.state,
        item.installation?.connection_id,
      ]),
    ).toEqual([
      ["gone", "connection_missing", null],
      ["seed", "usable", "main"],
    ]);
  });
});
