import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  type AgentRelease,
  agentCardSchema,
  scopesForRole,
} from "@werft-ai/contracts";
import {
  createAgentService,
  resolveAgentRelease,
} from "../agents/agent-service.ts";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import type { AgentStore } from "../ports/agent-store.ts";
import { acceptAllCheckpoints } from "../ports/checkpoint-verifier.ts";
import type { InstallationProfileRecord } from "../ports/installation-profile-store.ts";
import type {
  ClaimInput,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import { createWorkerGateway } from "../workers/worker-gateway.ts";
import {
  allowedRun,
  type CatalogProfile,
  type CatalogProfileConfig,
  type CatalogRepository,
  catalogProfile,
  catalogProfileConfigSchema,
  profileFingerprint,
  providerUpstreamOf,
  resolveSessionCatalog,
  type SessionCatalogConfig,
  type WorkspaceProfileRecord,
  workspaceProfileRefusal,
} from "./catalog.ts";
import {
  type Connections,
  catalogImports,
  catalogRepositoryIds,
  catalogRows,
  createProfileRegistry,
  installationProfileSnapshot,
  profileCatalog,
  type SnapshotSources,
  withSeededInstallation,
} from "./profile-registry.ts";
import {
  createWorkspaceProfileService,
  createWorkspaceProfiles,
} from "./workspace-profiles.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000b1";
const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const VERSION = "019a0000-0000-7000-8000-0000000000a2";
const AT = new Date("2026-10-28T00:00:00.000Z");
const KEY = "catalog-provider-key";

const definition = (
  overrides: Record<string, unknown> = {},
): CatalogProfileConfig =>
  catalogProfileConfigSchema.parse({
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    models: ["claude-sonnet-5", "claude-haiku-5"],
    tools: ["Read"],
    permission_mode: "default",
    provider: {
      kind: "litellm",
      endpoint: "https://litellm.invalid",
      auth: { kind: "api_key", value_env: "PROVIDER_KEY" },
    },
    ...overrides,
  });

const OTHER_PROVIDER = {
  kind: "litellm",
  endpoint: "https://other.invalid",
  auth: { kind: "api_key", value_env: "OTHER_KEY" },
} as const;

const REPOSITORIES: Record<string, CatalogRepository> = {
  "sample-app": {
    url: "https://example.invalid/app.git",
    branch: "main",
    profiles: ["coding", "bypass"],
    auth: { kind: "github_app", registered: true },
  },
  docs: {
    url: "https://example.invalid/docs.git",
    branch: "trunk",
    profiles: ["coding"],
    auth: { kind: "github_app", registered: true },
  },
};

function sourcesOf(
  own: SessionCatalogConfig["profiles"],
  options: { connections?: Connections; allowUnattended?: boolean } = {},
): SnapshotSources<CatalogProfile> {
  return {
    connections:
      options.connections ??
      Object.fromEntries(
        Object.entries(own).map(([id, made]) => [id, made.provider]),
      ),
    allowUnattended: options.allowUnattended ?? false,
    runtimeSupported: () => true,
    materialize: (id, made) => {
      const profile = resolveSessionCatalog(
        { profiles: { [id]: made }, repositories: {} },
        () => KEY,
      ).profiles[id];
      if (!profile) throw new Error(`no ${id}`);
      return profile;
    },
  };
}

/** What the api's import writes, or a console row with `overrides`. */
function row(
  id: string,
  made: CatalogProfileConfig,
  overrides: Partial<InstallationProfileRecord> = {},
): InstallationProfileRecord {
  const [entry] = catalogImports({ [id]: made });
  if (!entry) throw new Error("no entry");
  return {
    id,
    name: null,
    version: 1,
    origin: "catalog",
    definition: JSON.parse(JSON.stringify(made)),
    permission_mode: made.permission_mode,
    fingerprint: entry.fingerprint,
    repository_ids: catalogRepositoryIds(REPOSITORIES)(id),
    github_app_repositories: "listed",
    previous_id: null,
    created_by: null,
    created_at: AT,
    retired_at: null,
    retired_by: null,
    blocked_at: null,
    blocked_by: null,
    ...overrides,
  };
}

const consoleRow = (
  id: string,
  made: CatalogProfileConfig,
  repositoryIds: string[],
) =>
  row(id, made, {
    origin: "console",
    name: id.replace(/^op_|_v\d+$/g, ""),
    repository_ids: repositoryIds,
    created_by: OWNER,
  });

function workspaceVersion(
  id: string,
  base: string,
  baseProfile: CatalogProfile,
): WorkspaceProfileRecord {
  return {
    id,
    workspace_id: WORKSPACE,
    name: id,
    version: 1,
    base_profile_id: base,
    base_fingerprint: profileFingerprint(baseProfile),
    model: baseProfile.model,
    models: [baseProfile.model],
    tools: [...baseProfile.tools],
    permission_mode: baseProfile.permission_mode,
    base_runtime_version: baseProfile.runtime_version,
    base_billing: "metered",
    base_repository_mode: "required",
    created_by: OWNER,
    created_at: AT,
    retired_by: null,
    retired_at: null,
  };
}

/** A replica: its own YAML and connections over shared rows. */
function replica(
  own: SessionCatalogConfig["profiles"],
  rows: {
    installation: InstallationProfileRecord[];
    workspace: WorkspaceProfileRecord[];
  },
  options: Parameters<typeof sourcesOf>[1] = {},
) {
  const registry = createProfileRegistry({
    workspaces: { listAll: async () => rows.workspace },
    installations: { listAll: async () => rows.installation },
    sources: sourcesOf(own, options),
  });
  return profileCatalog({ repositories: REPOSITORIES }, registry);
}

const stateOf = (
  catalog: ReturnType<typeof replica>,
  id: string,
): string | undefined => catalog.installation.get(id)?.state;

describe("installation profile snapshot", () => {
  test("a row runs its stored value, whatever this replica's YAML says", () => {
    const yaml = definition();
    const stored = definition({ tools: ["Read", "Grep"] });
    const snapshot = installationProfileSnapshot(sourcesOf({ coding: yaml }), [
      row("coding", stored),
      row("elsewhere", stored),
    ]);
    expect(snapshot.profiles.coding?.tools).toEqual(["Read", "Grep"]);
    expect(snapshot.profiles.elsewhere?.tools).toEqual(["Read", "Grep"]);
  });

  test("an id no row has runs nothing, though this replica's YAML has it", () => {
    const snapshot = installationProfileSnapshot(
      sourcesOf({ coding: definition() }),
      [],
    );
    expect(snapshot.profiles).toEqual({});
    expect(snapshot.installation.size).toBe(0);
  });

  test("a ceiling's own provider is no connection of its own", () => {
    const own = { coding: definition() };
    const rows = [row("coding", definition())];
    const without = installationProfileSnapshot(
      sourcesOf(own, { connections: { other: OTHER_PROVIDER } }),
      rows,
    );
    expect(without.installation.get("coding")?.state).toBe(
      "connection_missing",
    );
    expect(without.installation.get("coding")?.connection_id).toBeNull();
    expect(Object.keys(without.profiles)).toEqual([]);
    const listed = installationProfileSnapshot(
      sourcesOf(own, { connections: { main: definition().provider } }),
      rows,
    );
    expect(listed.installation.get("coding")?.state).toBe("usable");
    expect(listed.installation.get("coding")?.connection_id).toBe("main");
  });

  test("a row edited behind the table's back runs nothing", () => {
    const tampered = row("elsewhere", definition());
    tampered.definition = { ...definition(), tools: ["Bash"] };
    const unparsable = row("broken", definition());
    unparsable.definition = { model: 1 };
    const snapshot = installationProfileSnapshot(sourcesOf({}), [
      tampered,
      unparsable,
    ]);
    expect(snapshot.installation.get("elsewhere")?.state).toBe(
      "definition_drift",
    );
    expect(snapshot.installation.get("broken")?.state).toBe("definition_drift");
    expect(snapshot.profiles).toEqual({});
  });

  test("a runtime the worker image lacks is left out on this replica", () => {
    const sources = {
      ...sourcesOf({ coding: definition() }),
      runtimeSupported: () => false,
    };
    expect(
      installationProfileSnapshot(sources, [
        row("coding", definition()),
      ]).installation.get("coding")?.state,
    ).toBe("runtime_unsupported");
  });
});

describe("two replicas over one database", () => {
  test("under one connection file, different YAML sets resolve the same ids and revision", async () => {
    const a = definition();
    const b = definition({ provider: OTHER_PROVIDER });
    const connections = { main: a.provider, other: OTHER_PROVIDER };
    const rows = {
      installation: [row("a", a), row("b", b)],
      workspace: [],
    };
    const one = replica({ a }, rows, { connections });
    const two = replica({ a, b }, rows, { connections });
    await Promise.all([
      one.workspace_profiles.refresh(),
      two.workspace_profiles.refresh(),
    ]);
    expect(Object.keys(one.profiles).sort()).toEqual(["a", "b"]);
    expect(Object.keys(two.profiles).sort()).toEqual(["a", "b"]);
  });

  test("the replica lacking a provider leaves its id out", async () => {
    const a = definition();
    const b = definition({ provider: OTHER_PROVIDER });
    const rows = { installation: [row("a", a), row("b", b)], workspace: [] };
    const one = replica({ a }, rows);
    const two = replica({ a, b }, rows);
    await Promise.all([
      one.workspace_profiles.refresh(),
      two.workspace_profiles.refresh(),
    ]);
    expect(stateOf(one, "b")).toBe("connection_missing");
    expect(stateOf(two, "b")).toBe("usable");
  });

  test("a start on a ceiling whose connection has no key says where to add one", async () => {
    const a = definition();
    const b = definition({ provider: OTHER_PROVIDER });
    const rows = { installation: [row("a", a), row("b", b)], workspace: [] };
    const one = replica({ a }, rows);
    await one.workspace_profiles.refresh();
    const refusal = workspaceProfileRefusal(one, WORKSPACE, "b");
    expect(refusal?.state).toBe("connection_missing");
    expect(refusal?.message).toContain(
      "Settings > Agent connections > Model connections",
    );
    expect(workspaceProfileRefusal(one, WORKSPACE, "a")).toBeNull();
  });

  test("once read, the imported rows run what the YAML-only image ran", async () => {
    const own = { coding: definition() };
    const catalog = replica(own, {
      installation: catalogRows(own),
      workspace: [],
    });
    expect(catalog.profiles).toEqual({});
    await catalog.workspace_profiles.refresh();
    const yamlOnly = resolveSessionCatalog(
      { profiles: own, repositories: REPOSITORIES },
      () => KEY,
    );
    expect(catalog.profiles).toEqual(yamlOnly.profiles);
  });
});

function claimCapture() {
  const inputs: ClaimInput[] = [];
  const work = {
    claimAtomic: async (input: ClaimInput) => {
      inputs.push(input);
      return { outcome: "no_session" as const };
    },
  } as unknown as WorkerUnitOfWork;
  return { inputs, work };
}

async function claimOnce(
  catalog: ReturnType<typeof replica>,
): Promise<ClaimInput> {
  const { inputs, work } = claimCapture();
  const gateway = createWorkerGateway({
    work,
    catalog,
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 30_000,
    },
  });
  await gateway
    .bootstrapClaim(
      { kind: "bootstrap" },
      {
        execution_id: "e",
        execution_generation: 1,
        credential: { kind: "launch_nonce", nonce: "n" },
      },
    )
    .catch(() => undefined);
  const [input] = inputs;
  if (!input) throw new Error("no claim");
  return input;
}

describe("the gateway's claim", () => {
  test("candidates, revision and settled ids come from the snapshot the claim read", async () => {
    const coding = definition();
    const rows = {
      installation: [row("coding", coding)],
      workspace: [] as WorkspaceProfileRecord[],
    };
    const catalog = replica({ coding }, rows);
    const wide = consoleRow("op_wide_v1", definition({ tools: ["Grep"] }), [
      "docs",
    ]);
    rows.installation.push(wide);
    // The claim reads the registry first, so a ceiling made elsewhere since
    // the gateway was built is a candidate of this claim.
    const input = await claimOnce(catalog);
    const pairs = input.runnable.map((pair) => [
      pair.profileId,
      pair.repositoryId,
    ]);
    expect(pairs).toContainEqual(["op_wide_v1", "docs"]);
    expect(pairs).not.toContainEqual(["op_wide_v1", "sample-app"]);
    expect(input.settledProfileIds.has("op_wide_v1")).toBe(true);
  });

  test("a console ceiling on a connection one replica lacks: that replica neither runs nor fails it", async () => {
    const coding = definition();
    const wide = consoleRow(
      "op_wide_v1",
      definition({ provider: OTHER_PROVIDER }),
      ["sample-app"],
    );
    const rows = {
      installation: [row("coding", coding), wide],
      workspace: [] as WorkspaceProfileRecord[],
    };
    const lacking = replica({ coding }, rows, {
      connections: { main: coding.provider },
    });
    const holding = replica({ coding }, rows, {
      connections: { main: coding.provider, other: OTHER_PROVIDER },
    });
    const [without, withIt] = [
      await claimOnce(lacking),
      await claimOnce(holding),
    ];
    expect(stateOf(lacking, "op_wide_v1")).toBe("connection_missing");
    expect(without.runnable.some((p) => p.profileId === "op_wide_v1")).toBe(
      false,
    );
    expect(without.settledProfileIds.has("op_wide_v1")).toBe(false);
    expect(
      withIt.runnable.some(
        (p) => p.profileId === "op_wide_v1" && p.repositoryId === "sample-app",
      ),
    ).toBe(true);
    expect(withIt.settledProfileIds.has("op_wide_v1")).toBe(true);
    // Both still settle the YAML profile: its failures are every replica's.
    expect(without.settledProfileIds.has("coding")).toBe(true);
  });

  test("a blocked ceiling and the versions over it are no candidate, but settled, so a claim fails their sessions", async () => {
    const coding = definition();
    const rows = {
      installation: [row("coding", coding)],
      workspace: [] as WorkspaceProfileRecord[],
    };
    const catalog = replica({ coding }, rows);
    await catalog.workspace_profiles.refresh();
    const base = catalogProfile(catalog, "coding");
    if (!base) throw new Error("no base");
    rows.workspace.push(workspaceVersion("ws_acme_narrow_v1", "coding", base));
    rows.installation[0] = row("coding", coding, {
      blocked_at: AT,
      blocked_by: OWNER,
    });
    await catalog.workspace_profiles.refresh();
    const claim = await claimOnce(catalog);
    expect(stateOf(catalog, "coding")).toBe("blocked");
    expect(Object.hasOwn(catalog.profiles, "coding")).toBe(false);
    expect(
      claim.runnable.filter((pair) =>
        ["coding", "ws_acme_narrow_v1"].includes(pair.profileId),
      ),
    ).toEqual([]);
    expect(claim.settledProfileIds.has("coding")).toBe(true);
    expect(claim.settledProfileIds.has("ws_acme_narrow_v1")).toBe(true);
  });

  test("an imported ceiling runs only on its repository_ids, whatever a repository lists", async () => {
    const coding = definition();
    const catalog = replica(
      { coding },
      {
        installation: [row("coding", coding, { repository_ids: ["docs"] })],
        workspace: [],
      },
    );
    const pairs = (await claimOnce(catalog)).runnable
      .filter((pair) => pair.profileId === "coding" && pair.policy !== true)
      .map((pair) => pair.repositoryId);
    expect(new Set(pairs)).toEqual(new Set(["docs"]));
    expect(REPOSITORIES["sample-app"]?.profiles).toContain("coding");
  });

  test("a row no import has filled runs on no repository", async () => {
    const coding = definition();
    const unfilled = replica(
      { coding },
      {
        installation: [row("coding", coding, { repository_ids: null })],
        workspace: [],
      },
    );
    const { runnable } = await claimOnce(unfilled);
    expect(
      runnable.filter(
        (pair) => pair.profileId === "coding" && pair.policy !== true,
      ),
    ).toEqual([]);
  });
});

const card = agentCardSchema.parse({
  role: "분석가",
  instructions: "요약한다.",
  model: "claude-sonnet-5",
  capabilities: { mcp: null, forbidden: [] },
});

function agentStore() {
  const releases = new Map<string, AgentRelease>();
  const detail = {
    agent: { id: AGENT, workspace_id: WORKSPACE },
  } as unknown as AgentDetail;
  const store = {
    get: async () => detail,
    findVersion: async () => ({
      id: VERSION,
      agent_id: AGENT,
      version_no: 1,
      card,
      content_sha256: "a".repeat(64),
      created_by: OWNER,
      created_at: AT.toISOString(),
    }),
    findRelease: async (_workspace: string, id: string) =>
      releases.get(id) ?? null,
    hasGitHubSettings: async () => false,
    insertRelease: async ({ release }: { release: AgentRelease }) => {
      const stored = {
        ...release,
        created_at: AT.toISOString(),
        approved_by: null,
        approved_at: null,
      };
      releases.set(release.id, stored);
      return { outcome: "created", release: stored };
    },
  } as unknown as AgentStore;
  return { store, releases };
}

const owner = callerFor(
  {
    kind: "user",
    id: OWNER,
    workspace_id: WORKSPACE,
    role: "owner",
    scopes: ["sessions:read", "sessions:write"],
  },
  { kind: "api" },
  crypto.randomUUID(),
);

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return (error as { code?: string }).code ?? "thrown";
  }
}

function releasesOver(catalog: ReturnType<typeof replica>, store: AgentStore) {
  const service = createAgentService({
    authorization: createAuthorizationPolicy(),
    store,
    catalog,
    credentials: { unboundRefs: async () => [] },
  });
  return {
    create: (profileId: string, repositoryId: string | null = "sample-app") =>
      service.createRelease(owner, AGENT, {
        version_id: VERSION,
        runtime_profile_id: profileId,
        ...(repositoryId === null ? {} : { repository_id: repositoryId }),
      }),
    resolve: (releaseId: string) =>
      resolveAgentRelease({ store, catalog }, WORKSPACE, releaseId),
  };
}

describe("releases and sessions over the registry", () => {
  test("a release made under the YAML resolves the same once the profile comes from its row", async () => {
    const coding = definition();
    const { store } = agentStore();
    const yaml = {
      ...withSeededInstallation(
        resolveSessionCatalog(
          { profiles: { coding }, repositories: REPOSITORIES },
          () => KEY,
        ),
      ),
      workspace_profiles: createWorkspaceProfiles({ listAll: async () => [] }),
    } as unknown as ReturnType<typeof replica>;
    const { release } = await releasesOver(yaml, store).create("coding");
    const fromRow = replica(
      {},
      { installation: [row("coding", coding)], workspace: [] },
      { connections: { main: coding.provider } },
    );
    await fromRow.workspace_profiles.refresh();
    expect(catalogProfile(fromRow, "coding")).toEqual(
      catalogProfile(yaml, "coding"),
    );
    expect(await releasesOver(fromRow, store).resolve(release.id)).toEqual(
      release,
    );
    const again = await releasesOver(fromRow, store).create("coding");
    expect(again.release.id).toBe(release.id);
  });

  test("a release whose model left resolves while the agent allows the move and is refused once it opted out", async () => {
    const families = {
      "claude-sonnet-5": { family: "sonnet", rank: 0 },
      "claude-sonnet-5-1": { family: "sonnet", rank: 1 },
    };
    const yamlOf = (coding: CatalogProfileConfig) =>
      ({
        ...withSeededInstallation(
          resolveSessionCatalog(
            { profiles: { coding }, repositories: REPOSITORIES },
            () => KEY,
          ),
        ),
        workspace_profiles: createWorkspaceProfiles({
          listAll: async () => [],
        }),
      }) as unknown as ReturnType<typeof replica>;
    const { store } = agentStore();
    const { release } = await releasesOver(
      yamlOf(definition({ model_families: families })),
      store,
    ).create("coding");
    const cut = yamlOf(
      definition({
        model: "claude-sonnet-5-1",
        models: ["claude-sonnet-5-1", "claude-haiku-5"],
        model_families: families,
      }),
    );
    const allowing = { ...store, autoModelMigration: async () => true };
    const optedOut = { ...store, autoModelMigration: async () => false };

    expect(
      (
        await resolveAgentRelease(
          { store: allowing, catalog: cut },
          WORKSPACE,
          release.id,
        )
      ).id,
    ).toBe(release.id);
    expect(
      await codeOf(
        resolveAgentRelease(
          { store: optedOut, catalog: cut },
          WORKSPACE,
          release.id,
        ),
      ),
    ).toBe("PROFILE_DIGEST_MISMATCH");
  });

  test("a console row put in directly runs a release, its own repositories only, on its connection's key", async () => {
    const coding = definition();
    const wide = consoleRow(
      "op_wide_v1",
      definition({ tools: ["Read", "Grep"] }),
      ["docs"],
    );
    const catalog = replica(
      { coding },
      { installation: [row("coding", coding), wide], workspace: [] },
    );
    await catalog.workspace_profiles.refresh();
    const { store } = agentStore();
    const releases = releasesOver(catalog, store);
    const { release } = await releases.create("op_wide_v1", "docs");
    expect(await releases.resolve(release.id)).toEqual(release);
    expect(await codeOf(releases.create("op_wide_v1", "sample-app"))).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(allowedRun(catalog, "op_wide_v1", "docs")).not.toBeNull();
    expect(allowedRun(catalog, "op_wide_v1", "sample-app")).toBeNull();
    const profile = catalogProfile(catalog, "op_wide_v1");
    if (!profile) throw new Error("no profile");
    expect(providerUpstreamOf(profile)).toEqual({
      url: "https://litellm.invalid",
      headers: [["x-api-key", KEY]],
    });
  });

  test("a retired ceiling takes no new release or version; its releases still start sessions", async () => {
    const coding = definition();
    const rows = {
      installation: [row("coding", coding)],
      workspace: [] as WorkspaceProfileRecord[],
    };
    const catalog = replica({ coding }, rows);
    await catalog.workspace_profiles.refresh();
    const base = catalogProfile(catalog, "coding");
    if (!base) throw new Error("no base");
    rows.workspace.push(workspaceVersion("ws_acme_narrow_v1", "coding", base));
    const { store } = agentStore();
    const before = await releasesOver(catalog, store).create("coding");
    rows.installation[0] = {
      ...row("coding", coding),
      retired_at: AT,
      retired_by: OWNER,
    };
    await catalog.workspace_profiles.refresh();
    const releases = releasesOver(catalog, store);
    expect(stateOf(catalog, "coding")).toBe("retired");
    expect(await codeOf(releases.create("coding"))).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(
      workspaceProfileRefusal(catalog, WORKSPACE, "ws_acme_narrow_v1")?.state,
    ).toBe("base_retired");
    expect(await releases.resolve(before.release.id)).toEqual(before.release);
    expect(
      workspaceProfileRefusal(catalog, WORKSPACE, "coding", {
        retiredAllowed: true,
      }),
    ).toBeNull();
  });

  test("a ceiling another replica retired takes no new version here, though this replica read it usable", async () => {
    const coding = definition();
    const rows = {
      installation: [row("coding", coding)],
      workspace: [] as WorkspaceProfileRecord[],
    };
    let clock = AT.getTime();
    const catalog = profileCatalog(
      { repositories: REPOSITORIES },
      createProfileRegistry({
        workspaces: { listAll: async () => rows.workspace },
        installations: { listAll: async () => rows.installation },
        sources: sourcesOf({ coding }),
        now: () => clock,
      }),
    );
    await catalog.workspace_profiles.refresh();
    rows.installation[0] = {
      ...row("coding", coding),
      retired_at: AT,
      retired_by: OWNER,
    };
    clock += 2_000;
    const writes: unknown[] = [];
    const versions = createWorkspaceProfileService({
      authorization: createAuthorizationPolicy(),
      store: {
        listAll: async () => [],
        async create(input) {
          writes.push(input);
          throw new Error("nothing is saved over a retired ceiling");
        },
        retire: async () => ({ outcome: "not_found" }),
      },
      catalog,
    });
    const manager = callerFor(
      {
        kind: "user",
        id: OWNER,
        workspace_id: WORKSPACE,
        role: "owner",
        scopes: [...scopesForRole("owner")],
      },
      { kind: "web" },
      crypto.randomUUID(),
    );
    const error = await versions
      .create(manager, {
        name: "narrow",
        base_profile_id: "coding",
        model: coding.model,
        models: [coding.model],
        tools: [],
        permission_mode: "default",
      })
      .then(
        () => null,
        (e: { details?: unknown }) => e.details,
      );
    expect(error).toMatchObject({ reason_code: "retired" });
    expect(writes).toEqual([]);
  });

  test("with the unattended switch off, a bypass ceiling and the version over it run nowhere", async () => {
    const bypass = definition({ permission_mode: "bypassPermissions" });
    const rows = {
      installation: [row("bypass", bypass)],
      workspace: [] as WorkspaceProfileRecord[],
    };
    const on = replica({ bypass }, rows, { allowUnattended: true });
    await on.workspace_profiles.refresh();
    const base = catalogProfile(on, "bypass");
    if (!base) throw new Error("no base");
    rows.workspace.push(workspaceVersion("ws_acme_bypass_v1", "bypass", base));
    await on.workspace_profiles.refresh();
    const { store } = agentStore();
    const made = await releasesOver(on, store).create("bypass");

    const off = replica({ bypass }, rows);
    await off.workspace_profiles.refresh();
    expect(stateOf(off, "bypass")).toBe("unattended_off");
    // agent-service: no new release, an old one resolves to nothing.
    const releases = releasesOver(off, store);
    expect(await codeOf(releases.create("bypass"))).toBe(
      "UNSUPPORTED_CAPABILITY",
    );
    expect(await codeOf(releases.resolve(made.release.id))).toBe(
      "PROFILE_DIGEST_MISMATCH",
    );
    // Sessions: neither id resolves to a run.
    expect(catalogProfile(off, "bypass")).toBeUndefined();
    expect(catalogProfile(off, "ws_acme_bypass_v1")).toBeUndefined();
    expect(allowedRun(off, "bypass", "sample-app")).toBeNull();
    // gateway: not a candidate, and left to a replica with the switch on.
    const claim = await claimOnce(off);
    expect(
      claim.runnable.filter((pair) =>
        ["bypass", "ws_acme_bypass_v1"].includes(pair.profileId),
      ),
    ).toEqual([]);
    expect(claim.settledProfileIds.has("bypass")).toBe(false);
    expect(claim.settledProfileIds.has("ws_acme_bypass_v1")).toBe(false);
  });
});
