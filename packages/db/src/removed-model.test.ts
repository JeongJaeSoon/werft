import { describe, expect, test } from "bun:test";
import type { ClaimCatalog } from "@werft-ai/platform";
import { sessionPinColumns } from "./testing/spec-pins.ts";
import { removedModelOf } from "./worker-unit-of-work.ts";

type Session = Parameters<typeof removedModelOf>[0];

const session = (over: Partial<Session> = {}): Session => ({
  runtimeSpec: sessionPinColumns("model-a").runtimeSpec,
  model: "model-a",
  repositoryMode: "none",
  repositoryId: null,
  repoUrl: null,
  branch: null,
  ...over,
});

const catalog = (connections: ClaimCatalog["connections"]): ClaimCatalog => ({
  connections,
  repositories: [],
  runtimeVersions: null,
});

describe("removedModelOf", () => {
  test("names the model when its connection still offers others but not it", () => {
    expect(
      removedModelOf(
        session(),
        catalog([{ id: "test-connection", models: ["model-b"] }]),
      ),
    ).toBe("model-a");
  });

  test("says nothing while the model is offered, or when the row names none", () => {
    const offered = catalog([
      { id: "test-connection", models: ["model-a", "model-b"] },
    ]);
    expect(removedModelOf(session(), offered)).toBeNull();
    expect(removedModelOf(session({ model: null }), offered)).toBeNull();
  });

  test("says nothing when the connection is not offered at all", () => {
    expect(removedModelOf(session(), catalog([]))).toBeNull();
    expect(
      removedModelOf(
        session(),
        catalog([{ id: "other-connection", models: ["model-b"] }]),
      ),
    ).toBeNull();
    // A session with no spec names no connection.
    expect(
      removedModelOf(
        session({ runtimeSpec: null }),
        catalog([{ id: "test-connection", models: ["model-b"] }]),
      ),
    ).toBeNull();
  });
});
