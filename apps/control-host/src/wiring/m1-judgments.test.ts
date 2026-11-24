import { describe, expect, test } from "bun:test";
import type { ReleaseInstructions } from "@werft-ai/contracts";
import type { SessionCatalog } from "@werft-ai/platform";
import { m1ReleaseOf } from "./m1-judgments.ts";

const MODEL = "claude-haiku-4-5";
const COMMIT = "c".repeat(40);
const catalog = {
  connections: {
    "conn-anthropic": {
      provider: {
        kind: "anthropic",
        endpoint: "https://api.example.invalid",
        auth: { kind: "api_key", value: "k", ref: { stored: "c" } },
      },
      models: [MODEL],
    },
  },
} as unknown as Pick<SessionCatalog, "connections">;

const release = (
  instructions_snapshot: ReleaseInstructions | null,
  connection_id = "conn-anthropic",
) => ({
  id: "sha256:release",
  connection_id,
  runtime_config_snapshot: { model: MODEL },
  instructions_snapshot,
});

describe("m1ReleaseOf", () => {
  test("a release's instruction snapshot is what the judgment reads, cut as it was stored", () => {
    expect(
      m1ReleaseOf(
        catalog,
        release({
          kind: "text",
          repository_id: "app",
          commit: COMMIT,
          file: "AGENTS.md",
          text: "Answer only billing questions.",
          bytes: 6_000,
          truncated: true,
        }),
      ),
    ).toEqual({
      outcome: "ready",
      releaseId: "sha256:release",
      connectionId: "conn-anthropic",
      model: MODEL,
      instructions: "Answer only billing questions.",
    });
  });

  test("without a text snapshot the judgment has the fixed rules alone", () => {
    const snapshots: (ReleaseInstructions | null)[] = [
      null,
      { kind: "no_repository" },
      { kind: "absent", repository_id: "app", commit: COMMIT },
      { kind: "refused", repository_id: "app", commit: COMMIT, reason: "x" },
      { kind: "read_failed", repository_id: "app", reason: "github_failed" },
    ];
    for (const snapshot of snapshots) {
      expect(m1ReleaseOf(catalog, release(snapshot))).toMatchObject({
        outcome: "ready",
        instructions: "",
      });
    }
  });

  test("a release whose connection is gone is unavailable", () => {
    expect(m1ReleaseOf(catalog, release(null, "conn-gone"))).toEqual({
      outcome: "unavailable",
      releaseId: "sha256:release",
    });
  });
});
