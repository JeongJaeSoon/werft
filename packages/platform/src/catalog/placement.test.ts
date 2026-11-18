import { describe, expect, test } from "bun:test";
import {
  type ClaimCatalog,
  claimCatalogOf,
  placementRefusal,
  type SessionPlacement,
} from "./placement.ts";

const RUNTIME = { kind: "claude_agent_sdk", version: "1.0.0" };
const REPOSITORY = {
  id: "repo-a",
  url: "https://example.invalid/a.git",
  branch: "main",
};

const session = (over: Partial<SessionPlacement> = {}): SessionPlacement => ({
  connectionId: "conn-a",
  model: "model-a",
  runtime: RUNTIME,
  repository: REPOSITORY,
  ...over,
});

const runnable = (over: Partial<ClaimCatalog> = {}): ClaimCatalog => ({
  connections: [{ id: "conn-a", models: ["model-a", "model-b"] }],
  repositories: [{ ...REPOSITORY, repositoryId: REPOSITORY.id }],
  runtimeVersions: [RUNTIME],
  ...over,
});

describe("placementRefusal", () => {
  test("runs a session whose connection, model, runtime and repository are all held", () => {
    expect(placementRefusal(session(), runnable())).toBeNull();
    expect(
      placementRefusal(session({ repository: null }), runnable()),
    ).toBeNull();
    expect(
      placementRefusal(session(), runnable({ runtimeVersions: null })),
    ).toBeNull();
  });

  test("names the connection when it is gone, before anything else", () => {
    expect(
      placementRefusal(
        session({ connectionId: "conn-b", runtime: null }),
        runnable(),
      ),
    ).toBe("connection_missing");
    expect(placementRefusal(session({ connectionId: null }), runnable())).toBe(
      "connection_missing",
    );
  });

  test("names the model when its connection no longer offers it, unless the session follows a move off it", () => {
    const moved = runnable({
      connections: [{ id: "conn-a", models: ["model-b"] }],
    });
    expect(placementRefusal(session(), moved)).toBe("model_removed");
    expect(placementRefusal(session({ model: null }), runnable())).toBe(
      "model_removed",
    );
    const move = { connectionId: "conn-a", from: "model-a", to: "model-b" };
    expect(placementRefusal(session(), moved, [move])).toBeNull();
    expect(
      placementRefusal(session(), moved, [{ ...move, connectionId: "conn-b" }]),
    ).toBe("model_removed");
  });

  test("names the runtime when the images do not ship it", () => {
    expect(
      placementRefusal(
        session({ runtime: { ...RUNTIME, version: "0.9.0" } }),
        runnable(),
      ),
    ).toBe("runtime_unshipped");
    expect(placementRefusal(session({ runtime: null }), runnable())).toBe(
      "runtime_unshipped",
    );
  });

  test("names the repository when its row moved or was never in the catalog", () => {
    expect(
      placementRefusal(
        session({ repository: { ...REPOSITORY, branch: "other" } }),
        runnable(),
      ),
    ).toBe("repository_moved");
    expect(
      placementRefusal(
        session({ repository: { ...REPOSITORY, id: null } }),
        runnable(),
      ),
    ).toBe("repository_moved");
  });
});

describe("claimCatalogOf", () => {
  // Only the model lists are read from a connection.
  const connections = (models: string[]) =>
    ({ "conn-a": { models } }) as unknown as Parameters<
      typeof claimCatalogOf
    >[0]["connections"];

  test("follows a reload that replaces the connections", () => {
    const catalog = { connections: connections(["model-a"]), repositories: {} };
    expect(claimCatalogOf(catalog).runnable.connections).toEqual([
      { id: "conn-a", models: ["model-a"] },
    ]);
    catalog.connections = connections(["model-b"]);
    expect(claimCatalogOf(catalog).runnable.connections).toEqual([
      { id: "conn-a", models: ["model-b"] },
    ]);
  });
});
