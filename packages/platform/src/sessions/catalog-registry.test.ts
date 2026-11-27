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
    judge_connections: {},
    repositories: {},
    mcp_servers: {},
    left_out: [],
    unavailable_repositories: new Set(),
    unavailable_connections: new Set(),
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
    const catalog = registryCatalog({ repositories: {} }, registry, merge);
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
    const catalog = registryCatalog({ repositories: {} }, registry, merge);
    await catalog.refresh();
    expect(Object.keys(catalog.repositories).sort()).toEqual(["app", "docs"]);
  });

  test("carries the image's runtime versions and tool catalogs as given", () => {
    const { registry } = registryOver({ settings: snapshot(1), rows: null });
    const tool_catalogs = testToolCatalogs();
    const catalog = registryCatalog(
      {
        repositories: {},
        runtime_versions: {
          accepted: [
            { kind: "claude_agent_sdk", engine: "claude", version: "0.3.270" },
          ],
        },
        tool_catalogs,
      },
      registry,
    );
    expect(catalog.runtime_versions?.accepted).toEqual([
      { kind: "claude_agent_sdk", engine: "claude", version: "0.3.270" },
    ]);
    expect(catalog.tool_catalogs).toBe(tool_catalogs);
  });
});

describe("latestReads", () => {
  test("a refresh with no age begins a read even when the clock stepped back", async () => {
    let clock = 100;
    let reads = 0;
    const pending: Array<() => void> = [];
    const refresh = latestReads(
      () =>
        new Promise<number>((resolve) => {
          reads += 1;
          pending.push(() => resolve(reads));
        }),
      () => {},
      () => clock,
    );
    const first = refresh(10_000);
    clock = 90;
    const second = refresh(0);
    expect(reads).toBe(2);
    for (const answer of pending) answer();
    await Promise.all([first, second]);
  });

  test("a refresh within maxAgeMs of the last read reads nothing", async () => {
    let clock = 0;
    let reads = 0;
    const applied: number[] = [];
    const refresh = latestReads(
      async () => ++reads,
      (value) => {
        applied.push(value);
      },
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
      (value) => {
        applied.push(value);
      },
      () => 0,
    );
    await refresh();
    fail = true;
    await expect(refresh()).rejects.toThrow("database down");
    expect(applied).toEqual(["ok"]);
  });
});

/** Settings reads the test answers one by one, over a generation it sets. */
function heldReads(generation: number) {
  const state = { generation, generationReads: 0 };
  const pending: Array<{
    resolve: (value: SettingsSnapshot) => void;
    reject: (error: unknown) => void;
  }> = [];
  const registry = createCatalogRegistry({
    generation: {
      read: async () => {
        state.generationReads += 1;
        return state.generation;
      },
    },
    settings: {
      read: () =>
        new Promise<SettingsSnapshot>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    },
  });
  const until = async (count: number) => {
    while (pending.length < count) await Bun.sleep(0);
  };
  return { registry, state, pending, until };
}

describe("caughtUp", () => {
  test("before the first read it reads, and resolves on what it read", async () => {
    const { registry, pending, until } = heldReads(0);
    const caught = registry.caughtUp();
    await until(1);
    pending[0]?.resolve(snapshot(0));
    await caught;
    expect(registry.settings?.generation).toBe(0);
  });

  test("at the stored generation it reads nothing more", async () => {
    const { registry, pending, until } = heldReads(3);
    const first = registry.refresh();
    await until(1);
    pending[0]?.resolve(snapshot(3));
    await first;
    await registry.caughtUp();
    await registry.caughtUp();
    expect(pending).toHaveLength(1);
  });

  test("requests behind the same generation share one read", async () => {
    const { registry, state, pending, until } = heldReads(3);
    const first = registry.refresh();
    await until(1);
    pending[0]?.resolve(snapshot(3));
    await first;
    state.generation = 4;
    const caught = [
      registry.caughtUp(),
      registry.caughtUp(),
      registry.caughtUp(),
    ];
    await until(2);
    pending[1]?.resolve(snapshot(4));
    await Promise.all(caught);
    expect(pending).toHaveLength(2);
    expect(registry.settings?.generation).toBe(4);
  });

  test("a read begun before the generation rose is not taken for current: another follows", async () => {
    const { registry, state, pending, until } = heldReads(4);
    // Begun at generation 4, its snapshot opened before 5 committed.
    const early = registry.caughtUp();
    await until(1);
    state.generation = 5;
    const late = registry.caughtUp();
    pending[0]?.resolve(snapshot(4));
    await early;
    expect(registry.settings?.generation).toBe(4);
    // The late request saw 5: it begins a read of its own after the stale one.
    await until(2);
    pending[1]?.resolve(snapshot(5));
    await late;
    expect(registry.settings?.generation).toBe(5);
  });

  test("a read begun later that opened an older snapshot does not replace a newer one", async () => {
    const { registry, pending, until } = heldReads(5);
    const first = registry.refresh();
    const second = registry.refresh();
    await until(2);
    // The first read's snapshot opened after 5 committed, the second's
    // before: the first finishes first and a request resolves on it.
    pending[0]?.resolve(snapshot(5));
    await first;
    await registry.caughtUp();
    pending[1]?.resolve(snapshot(4));
    await second;
    expect(registry.settings?.generation).toBe(5);
    await registry.caughtUp();
    expect(pending).toHaveLength(2);
  });

  test("a declined read holds back no read begun before it", async () => {
    const { registry, pending, until } = heldReads(7);
    const reads = [registry.refresh(), registry.refresh(), registry.refresh()];
    await until(3);
    pending[0]?.resolve(snapshot(6));
    await reads[0];
    // Begun last, yet its snapshot opened first: declined.
    pending[2]?.resolve(snapshot(4));
    await reads[2];
    pending[1]?.resolve(snapshot(7));
    await reads[1];
    expect(registry.settings?.generation).toBe(7);
  });

  test("a read begun after the apply is taken even at a lower generation", async () => {
    const { registry, state, pending, until } = heldReads(5);
    const first = registry.refresh();
    await until(1);
    pending[0]?.resolve(snapshot(5));
    await first;
    // A restored database: the generation went back.
    state.generation = 2;
    const again = registry.refresh();
    await until(2);
    pending[1]?.resolve(snapshot(2));
    await again;
    expect(registry.settings?.generation).toBe(2);
  });

  test("a settings read that fails rejects with its own error; the next request reads again", async () => {
    const { registry, state, pending, until } = heldReads(1);
    const first = registry.refresh();
    await until(1);
    pending[0]?.resolve(snapshot(1));
    await first;
    state.generation = 2;
    const down = Object.assign(new Error("terminating connection"), {
      code: "57P01",
    });
    const failed = registry.caughtUp();
    await until(2);
    pending[1]?.reject(down);
    await expect(failed).rejects.toBe(down);
    // What was read before stays, for the claim's caches, but no request
    // resolved on it.
    expect(registry.settings?.generation).toBe(1);
    const again = registry.caughtUp();
    await until(3);
    pending[2]?.resolve(snapshot(2));
    await again;
    expect(registry.settings?.generation).toBe(2);
  });

  test("every request waiting on a shared read that fails rejects with its error", async () => {
    const { registry, state, pending, until } = heldReads(1);
    const first = registry.refresh();
    await until(1);
    pending[0]?.resolve(snapshot(1));
    await first;
    state.generation = 2;
    const down = new Error("terminating connection");
    const waiting = [
      registry.caughtUp(),
      registry.caughtUp(),
      registry.caughtUp(),
    ].map((caught) =>
      caught.then(
        () => "resolved",
        (error: unknown) => error,
      ),
    );
    await until(2);
    pending[1]?.reject(down);
    expect(await Promise.all(waiting)).toEqual([down, down, down]);
    expect(pending).toHaveLength(2);
  });

  test("a generation read that fails rejects, and reads no settings", async () => {
    const down = new Error("connection refused");
    const registry = createCatalogRegistry({
      generation: {
        read: async () => {
          throw down;
        },
      },
      settings: {
        read: async () => {
          throw new Error("not reached");
        },
      },
    });
    await expect(registry.caughtUp()).rejects.toBe(down);
  });

  test("a registry given no generation resolves at once", async () => {
    const { registry, state } = registryOver({
      settings: snapshot(1),
      rows: null,
    });
    await registry.caughtUp();
    expect(state.reads).toBe(0);
  });
});
