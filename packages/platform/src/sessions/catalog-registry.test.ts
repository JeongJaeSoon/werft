import { describe, expect, test } from "bun:test";
import type { CatalogRepositoryRow } from "../ports/catalog-repository-store.ts";
import {
  testConnection,
  testRepository,
  testToolCatalogs,
} from "../testing/catalog-fakes.ts";
import {
  createCatalogRegistry,
  latestReads,
  registryCatalog,
  withConsoleRepositories,
} from "./catalog-registry.ts";
import type { SettingsSnapshot } from "./installation-settings.ts";

const row = (id: string): CatalogRepositoryRow => ({
  id,
  github_repository_id: 1,
  owner: "acme",
  name: id,
  url: `https://github.com/acme/${id}.git`,
  branch: "main",
  source: "console",
  version: 1,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
});

function snapshot(
  generation: number,
  over: Partial<SettingsSnapshot> = {},
): SettingsSnapshot {
  return {
    generation,
    connections: { "conn-1": testConnection() },
    repositories: {},
    mcp_servers: {},
    left_out: [],
    unavailable_repositories: new Set(),
    ...over,
  };
}

const merge = (
  rows: readonly CatalogRepositoryRow[] | null,
  settings: SettingsSnapshot | null,
) => withConsoleRepositories(rows, settings?.repositories);

/** A registry over settings and rows the test changes between reads. */
function registryOver(initial: {
  settings: SettingsSnapshot;
  rows: CatalogRepositoryRow[] | null;
}) {
  const state = { ...initial, reads: 0 };
  const registry = createCatalogRegistry({
    settings: {
      read: async () => {
        state.reads += 1;
        return state.settings;
      },
    },
    repositories: { readCatalog: async () => state.rows },
  });
  return { registry, state };
}

describe("withConsoleRepositories", () => {
  test("the settings' repositories win; each console row they lack is the console App's", () => {
    const own = testRepository("app", "develop");
    expect(
      withConsoleRepositories([row("app"), row("docs")], { app: own }),
    ).toEqual({
      app: own,
      docs: {
        url: "https://github.com/acme/docs.git",
        branch: "main",
        auth: { kind: "github_app", registered: true },
      },
    });
    expect(withConsoleRepositories(null)).toEqual({});
  });
});

describe("the catalog a registry makes", () => {
  test("holds no connection before the first read, then the settings' connections", async () => {
    const { registry } = registryOver({ settings: snapshot(3), rows: null });
    const catalog = registryCatalog({ repositories: {} }, registry);
    expect(catalog.connections).toEqual({});
    expect(catalog.settings_generation).toBeUndefined();
    await catalog.refresh();
    expect(Object.keys(catalog.connections)).toEqual(["conn-1"]);
    expect(catalog.settings_generation).toBe(3);
  });

  test("keeps the same objects while nothing changed, so claim caches hold", async () => {
    const { registry, state } = registryOver({
      settings: snapshot(1),
      rows: [row("app")],
    });
    const catalog = registryCatalog(
      { repositories: {} },
      registry,
      merge,
    );
    await catalog.refresh();
    const [connections, repositories] = [
      catalog.connections,
      catalog.repositories,
    ];
    // A new read with equal content, under a new generation.
    state.settings = snapshot(2);
    state.rows = [row("app")];
    await catalog.refresh();
    expect(catalog.connections).toBe(connections);
    expect(catalog.repositories).toBe(repositories);
    expect(catalog.settings_generation).toBe(2);
    // A connection's models changing is a change.
    state.settings = snapshot(3, {
      connections: {
        "conn-1": testConnection({ models: ["claude-opus-5"] }),
      },
    });
    await catalog.refresh();
    expect(catalog.connections).not.toBe(connections);
    expect(catalog.connections["conn-1"]?.models).toEqual(["claude-opus-5"]);
  });

  test("merges the console's rows with the settings' repositories", async () => {
    const { registry } = registryOver({
      settings: snapshot(1, { repositories: { app: testRepository("app") } }),
      rows: [row("docs")],
    });
    const catalog = registryCatalog(
      { repositories: {} },
      registry,
      merge,
    );
    await catalog.refresh();
    expect(Object.keys(catalog.repositories).sort()).toEqual(["app", "docs"]);
  });

  test("carries the image's runtime versions and tool catalogs as given", () => {
    const { registry } = registryOver({ settings: snapshot(1), rows: null });
    const tool_catalogs = testToolCatalogs();
    const catalog = registryCatalog(
      {
        repositories: {},
        runtime_versions: { accepted: ["0.3.270"], current: ["0.3.270"] },
        tool_catalogs,
      },
      registry,
    );
    expect(catalog.runtime_versions?.accepted).toEqual(["0.3.270"]);
    expect(catalog.tool_catalogs).toBe(tool_catalogs);
  });
});

describe("latestReads", () => {
  test("a refresh within maxAgeMs of the last read reads nothing", async () => {
    let clock = 0;
    let reads = 0;
    const applied: number[] = [];
    const refresh = latestReads(
      async () => ++reads,
      (value) => applied.push(value),
      () => clock,
    );
    await refresh();
    clock = 5;
    await refresh(10);
    expect(reads).toBe(1);
    clock = 20;
    await refresh(10);
    expect(reads).toBe(2);
    expect(applied).toEqual([1, 2]);
  });

  test("a failed read keeps what was read before and is reported", async () => {
    let fail = false;
    const applied: string[] = [];
    const refresh = latestReads(
      async () => {
        if (fail) throw new Error("database down");
        return "ok";
      },
      (value) => applied.push(value),
      () => 0,
    );
    await refresh();
    fail = true;
    await expect(refresh()).rejects.toThrow("database down");
    expect(applied).toEqual(["ok"]);
  });
});
