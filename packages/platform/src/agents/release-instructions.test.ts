import { describe, expect, test } from "bun:test";
import { JUDGMENT_INSTRUCTIONS_MAX_BYTES } from "@werft-ai/contracts";
import type { CommittedTree } from "@werft-ai/runtime-core";
import {
  cutToBytes,
  type ReleaseInstructionsSource,
  snapshotReleaseInstructions,
} from "./release-instructions.ts";

const COMMIT = "c".repeat(40);
const READER = { ownerId: "workspace-1", agentId: "agent-1", actor: null };

const treeOf = (paths: Record<string, string>): CommittedTree => ({
  entry: async (path) =>
    paths[path] === undefined
      ? null
      : { mode: "100644", type: "blob", object: path },
  size: async (object) => new TextEncoder().encode(paths[object] ?? "").length,
  read: async (object) => paths[object] ?? "",
});

function sourceOf(
  paths: Record<string, string>,
  opened: string[] = [],
): ReleaseInstructionsSource {
  return {
    async open(repositoryId, runtime) {
      opened.push(`${repositoryId}:${runtime}`);
      return {
        kind: "tree",
        commit: COMMIT,
        files: ["AGENTS.md", "CLAUDE.md"],
        tree: treeOf(paths),
      };
    },
  };
}

describe("snapshotReleaseInstructions", () => {
  test("a release without a repository reads nothing", async () => {
    const opened: string[] = [];
    expect(
      await snapshotReleaseInstructions(
        sourceOf({}, opened),
        null,
        "claude_agent_sdk",
        READER,
      ),
    ).toEqual({ kind: "no_repository" });
    expect(opened).toEqual([]);
  });

  test("the file is read once, at the branch's commit, by the runtime's names", async () => {
    const opened: string[] = [];
    expect(
      await snapshotReleaseInstructions(
        sourceOf({ "CLAUDE.md": "답은 한국어로.\n" }, opened),
        "app",
        "claude_agent_sdk",
        READER,
      ),
    ).toEqual({
      kind: "text",
      repository_id: "app",
      commit: COMMIT,
      file: "CLAUDE.md",
      text: "답은 한국어로.\n",
      bytes: 21,
      truncated: false,
    });
    expect(opened).toEqual(["app:claude_agent_sdk"]);
    expect(
      await snapshotReleaseInstructions(
        sourceOf({}),
        "app",
        "claude_agent_sdk",
        READER,
      ),
    ).toEqual({ kind: "absent", repository_id: "app", commit: COMMIT });
  });

  test("a file past the judgment's share keeps its start, whole characters only", async () => {
    // 3 bytes a character: the cut lands one byte short of the limit.
    const long = "가".repeat(JUDGMENT_INSTRUCTIONS_MAX_BYTES);
    const snapshot = await snapshotReleaseInstructions(
      sourceOf({ "AGENTS.md": long }),
      "app",
      "claude_agent_sdk",
      READER,
    );
    if (snapshot.kind !== "text") throw new Error(snapshot.kind);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.bytes).toBe(JUDGMENT_INSTRUCTIONS_MAX_BYTES * 3);
    expect(snapshot.text).toBe("가".repeat(1365));
    // Exactly at the limit is whole.
    const fits = await snapshotReleaseInstructions(
      sourceOf({ "AGENTS.md": "a".repeat(JUDGMENT_INSTRUCTIONS_MAX_BYTES) }),
      "app",
      "claude_agent_sdk",
      READER,
    );
    expect(fits.kind === "text" && fits.truncated).toBe(false);
  });

  test("a cut never splits a character that takes more than one code point", () => {
    expect(cutToBytes("ab👍🏽", 9)).toBe("ab");
    expect(cutToBytes("ab👍🏽", 10)).toBe("ab👍🏽");
  });

  test("a file the rules refuse is recorded as refused", async () => {
    const snapshot = await snapshotReleaseInstructions(
      sourceOf({ "AGENTS.md": "a".repeat(64 * 1024 + 1) }),
      "app",
      "claude_agent_sdk",
      READER,
    );
    expect(snapshot).toEqual({
      kind: "refused",
      repository_id: "app",
      commit: COMMIT,
      reason: "it is larger than 65536 bytes",
    });
  });

  test("a read that fails, throws or hangs is read_failed, never a throw", async () => {
    const said: ReleaseInstructionsSource = {
      open: async () => ({ kind: "read_failed", reason: "not_on_github" }),
    };
    expect(
      await snapshotReleaseInstructions(
        said,
        "app",
        "claude_agent_sdk",
        READER,
      ),
    ).toEqual({
      kind: "read_failed",
      repository_id: "app",
      reason: "not_on_github",
    });
    const throwing: ReleaseInstructionsSource = {
      open: async () => ({
        kind: "tree",
        commit: COMMIT,
        files: ["AGENTS.md"],
        tree: {
          entry: async () => {
            throw new Error("GitHub tree read failed (502)");
          },
          size: async () => 0,
          read: async () => "",
        },
      }),
    };
    expect(
      await snapshotReleaseInstructions(
        throwing,
        "app",
        "claude_agent_sdk",
        READER,
      ),
    ).toEqual({
      kind: "read_failed",
      repository_id: "app",
      reason: "github_failed",
    });
    const hanging: ReleaseInstructionsSource = {
      open: () => new Promise(() => {}),
    };
    expect(
      await snapshotReleaseInstructions(
        hanging,
        "app",
        "claude_agent_sdk",
        READER,
        10,
      ),
    ).toEqual({
      kind: "read_failed",
      repository_id: "app",
      reason: "github_failed",
    });
  });
});
