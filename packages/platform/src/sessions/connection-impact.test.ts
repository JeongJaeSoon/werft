import { describe, expect, test } from "bun:test";
import type { InstallationProfileRecord } from "../ports/installation-profile-store.ts";
import {
  type CatalogProfile,
  type CatalogProfileConfig,
  catalogProfileConfigSchema,
  catalogProviderSchema,
  profileFingerprint,
  resolveSessionCatalog,
  type WorkspaceProfileRecord,
} from "./catalog.ts";
import { connectionImpact } from "./connection-impact.ts";
import {
  type Connections,
  catalogImports,
  createProfileRegistry,
  profileCatalog,
} from "./profile-registry.ts";

const AT = new Date("2026-11-09T00:00:00.000Z");
const OWNER = "019a0000-0000-7000-8000-0000000000b1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000f2";

const provider = (auth: Record<string, string>, endpoint = "https://a.test") =>
  catalogProviderSchema.parse({
    kind: "litellm",
    endpoint,
    auth: { kind: "api_key", ...auth },
  });

const A = provider({ value_env: "KEY_A" });
const B = provider({ value_env: "KEY_B" }, "https://b.test");

const made = (over: CatalogProfileConfig["provider"]): CatalogProfileConfig =>
  catalogProfileConfigSchema.parse({
    runtime_kind: "claude_agent_sdk",
    runtime_version: "0.3.270",
    model: "claude-sonnet-5",
    tools: ["Read"],
    permission_mode: "default",
    provider: over,
  });

function row(
  id: string,
  definition: CatalogProfileConfig,
  overrides: Partial<InstallationProfileRecord> = {},
): InstallationProfileRecord {
  const [entry] = catalogImports({ [id]: definition });
  if (!entry) throw new Error("no entry");
  return {
    id,
    name: null,
    version: 1,
    origin: "catalog",
    definition: JSON.parse(JSON.stringify(definition)),
    permission_mode: definition.permission_mode,
    fingerprint: entry.fingerprint,
    repository_ids: [],
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

function workspaceVersion(
  id: string,
  base: string,
  baseProfile: CatalogProfile,
): WorkspaceProfileRecord {
  return {
    id,
    workspace_id: OTHER_WORKSPACE,
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

/** The registry's catalog over `rows`, the way the api reads it. */
async function catalogOf(
  rows: InstallationProfileRecord[],
  settings: { connections: Connections; aliases?: Connections },
  workspace: (
    profiles: Record<string, CatalogProfile>,
  ) => WorkspaceProfileRecord[] = () => [],
) {
  let profiles: Record<string, CatalogProfile> = {};
  const registry = createProfileRegistry({
    workspaces: { listAll: async () => workspace(profiles) },
    installations: { listAll: async () => rows },
    sources: {
      connections: settings.connections,
      connection_aliases: settings.aliases ?? {},
      allowUnattended: false,
      runtimeSupported: () => true,
      materialize: (id, definition) => {
        const profile = resolveSessionCatalog(
          { profiles: { [id]: definition }, repositories: {} },
          () => "provider-key-value",
        ).profiles[id];
        if (!profile) throw new Error(`no ${id}`);
        return profile;
      },
    },
  });
  await registry.refresh();
  profiles = registry.profiles as Record<string, CatalogProfile>;
  await registry.refresh();
  return profileCatalog({ repositories: {} }, registry);
}

const impactOf = (
  catalog: Awaited<ReturnType<typeof catalogOf>>,
  settings: { connections: Connections; aliases?: Connections },
  id: string,
) =>
  connectionImpact(
    catalog,
    {
      connections: settings.connections,
      connection_aliases: settings.aliases ?? {},
    },
    id,
  );

describe("the profiles left with no connection", () => {
  test("a profile on the connection is counted; one on another is not", async () => {
    const settings = { connections: { one: A, two: B } };
    const catalog = await catalogOf(
      [row("on-a", made(A)), row("on-b", made(B))],
      settings,
    );
    expect(impactOf(catalog, settings, "one")).toEqual({
      profile_ids: ["on-a"],
      current_profile_count: 1,
    });
    expect(impactOf(catalog, settings, "two")).toEqual({
      profile_ids: ["on-b"],
      current_profile_count: 1,
    });
  });

  test("a second connection holding the same provider keeps the profile running", async () => {
    // Both rows hold one provider: the profile's connection is the first id,
    // and ending either one alone leaves it a match.
    const settings = { connections: { first: A, second: A } };
    const catalog = await catalogOf([row("on-a", made(A))], settings);
    expect(catalog.installation.get("on-a")?.connection_id).toBe("first");
    expect(impactOf(catalog, settings, "first").profile_ids).toEqual([]);
    expect(impactOf(catalog, settings, "second").profile_ids).toEqual([]);
    // With the second gone, the first is the last holder.
    const alone = { connections: { first: A } };
    const onlyFirst = await catalogOf([row("on-a", made(A))], alone);
    expect(impactOf(onlyFirst, alone, "first").profile_ids).toEqual(["on-a"]);
  });

  test("a profile made before a move to a stored key goes with that connection", async () => {
    const stored = provider({ stored: "connection:one" });
    const settings = {
      connections: { one: stored },
      aliases: { one: A },
    };
    const catalog = await catalogOf([row("before-move", made(A))], settings);
    expect(catalog.installation.get("before-move")?.state).toBe("usable");
    expect(impactOf(catalog, settings, "one").profile_ids).toEqual([
      "before-move",
    ]);
    // Another connection that is not the alias leaves it where it is.
    const elsewhere = {
      connections: { one: stored, two: B },
      aliases: { one: A },
    };
    const other = await catalogOf([row("before-move", made(A))], elsewhere);
    expect(impactOf(other, elsewhere, "two").profile_ids).toEqual([]);
  });

  test("a version another workspace made counts like any other", async () => {
    const settings = { connections: { one: A } };
    const catalog = await catalogOf(
      [
        row("mine", made(A)),
        row("theirs", made(A), {
          origin: "console",
          name: "theirs",
          workspace_id: OTHER_WORKSPACE,
          derived_from: "mine",
        }),
      ],
      settings,
    );
    expect(impactOf(catalog, settings, "one")).toEqual({
      profile_ids: ["mine", "theirs"],
      current_profile_count: 2,
    });
  });

  test("a retired version is an id to look up but not a profile to count", async () => {
    const settings = { connections: { one: A } };
    const catalog = await catalogOf(
      [
        row("old", made(A), {
          retired_at: AT,
          retired_by: OWNER,
        }),
        row("new", made(A)),
      ],
      settings,
    );
    expect(impactOf(catalog, settings, "one")).toEqual({
      profile_ids: ["new", "old"],
      current_profile_count: 1,
    });
  });

  test("a profile already stopped is not counted: blocked, or with no connection", async () => {
    const settings = { connections: { one: A } };
    const catalog = await catalogOf(
      [
        row("blocked", made(A), { blocked_at: AT, blocked_by: OWNER }),
        row("lost", made(B)),
        row("live", made(A)),
      ],
      settings,
    );
    expect(catalog.installation.get("lost")?.state).toBe("connection_missing");
    expect(impactOf(catalog, settings, "one").profile_ids).toEqual(["live"]);
  });

  test("a row whose stored definition no longer matches its fingerprint is not counted", async () => {
    const settings = { connections: { one: A } };
    const drifted = row("drifted", made(A));
    drifted.definition = {
      ...(drifted.definition as Record<string, unknown>),
      tools: ["Bash"],
    };
    const catalog = await catalogOf([drifted, row("live", made(A))], settings);
    expect(catalog.installation.get("drifted")?.state).toBe("definition_drift");
    expect(impactOf(catalog, settings, "one")).toEqual({
      profile_ids: ["live"],
      current_profile_count: 1,
    });
  });

  test("a workspace version follows its base while it still resolves", async () => {
    const settings = { connections: { one: A } };
    const base = row("base", made(A));
    const catalog = await catalogOf(
      [base, row("other", made(A))],
      settings,
      (profiles) => {
        const baseProfile = profiles.base;
        return baseProfile
          ? [workspaceVersion("ws_v1", "base", baseProfile)]
          : [];
      },
    );
    expect(catalog.workspace_profiles.records.has("ws_v1")).toBe(true);
    expect(impactOf(catalog, settings, "one").profile_ids).toEqual([
      "base",
      "other",
      "ws_v1",
    ]);
  });

  test("a workspace version whose base changed is left out", async () => {
    const settings = { connections: { one: A } };
    const catalog = await catalogOf(
      [row("base", made(A))],
      settings,
      (profiles) => {
        const baseProfile = profiles.base;
        return baseProfile
          ? [
              {
                ...workspaceVersion("ws_v1", "base", baseProfile),
                base_fingerprint: "changed-since",
              },
            ]
          : [];
      },
    );
    expect(impactOf(catalog, settings, "one").profile_ids).toEqual(["base"]);
  });

  test("an id that holds nothing counts nothing", async () => {
    const settings = { connections: { one: A } };
    const catalog = await catalogOf([row("on-a", made(A))], settings);
    expect(impactOf(catalog, settings, "no-such")).toEqual({
      profile_ids: [],
      current_profile_count: 0,
    });
  });
});
