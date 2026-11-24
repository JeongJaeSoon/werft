import { describe, expect, test } from "bun:test";
import {
  COMMITTED_INSTRUCTIONS_MAX_BYTES,
  type CommittedTree,
  firstCommittedInstructions,
  namedCommittedInstructions,
} from "./instruction-files.ts";

const FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** A tree of `path -> text`; a `{ link }` value is a symlink to it. */
function treeOf(
  paths: Record<string, string | { link: string }>,
): CommittedTree & { reads: string[] } {
  const reads: string[] = [];
  const blob = (path: string) => {
    const value = paths[path];
    return typeof value === "string" ? value : (value?.link ?? "");
  };
  return {
    reads,
    async entry(path) {
      const value = paths[path];
      if (value !== undefined) {
        return typeof value === "string"
          ? { mode: "100644", type: "blob", object: path }
          : { mode: "120000", type: "blob", object: path };
      }
      return Object.keys(paths).some((p) => p.startsWith(`${path}/`))
        ? { mode: "040000", type: "tree", object: path }
        : null;
    },
    size: async (object) => new TextEncoder().encode(blob(object)).length,
    async read(object) {
      reads.push(object);
      return blob(object);
    },
  };
}

describe("firstCommittedInstructions", () => {
  test("AGENTS.md wins over CLAUDE.md, and CLAUDE.md stands in when it is the only one", async () => {
    expect(
      await namedCommittedInstructions(
        treeOf({ "AGENTS.md": "a\n", "CLAUDE.md": "c\n" }),
        FILES,
      ),
    ).toEqual({ file: "AGENTS.md", found: { kind: "text", text: "a\n" } });
    expect(
      await namedCommittedInstructions(treeOf({ "CLAUDE.md": "c\n" }), FILES),
    ).toEqual({ file: "CLAUDE.md", found: { kind: "text", text: "c\n" } });
    expect(
      await namedCommittedInstructions(treeOf({ "README.md": "r" }), FILES),
    ).toEqual({ file: null, found: { kind: "absent" } });
  });

  test("a file that is only an @ line stands for the other file, once", async () => {
    const tree = treeOf({ "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "rules" });
    expect(
      await namedCommittedInstructions(tree, ["CLAUDE.md", "AGENTS.md"]),
    ).toEqual({
      file: "AGENTS.md",
      found: { kind: "text", text: "rules" },
    });
    // Two files importing each other: the second hop is not taken.
    const loop = treeOf({
      "CLAUDE.md": "@AGENTS.md",
      "AGENTS.md": "@CLAUDE.md",
    });
    expect(
      await firstCommittedInstructions(loop, ["CLAUDE.md", "AGENTS.md"]),
    ).toEqual({
      kind: "text",
      text: "@CLAUDE.md",
    });
  });

  test("a link is followed inside the tree and refused when it leaves it or names a directory", async () => {
    expect(
      await firstCommittedInstructions(
        treeOf({
          "AGENTS.md": { link: "docs/rules.md" },
          "docs/rules.md": "deep",
        }),
        FILES,
      ),
    ).toEqual({ kind: "text", text: "deep" });
    expect(
      await firstCommittedInstructions(
        treeOf({ "AGENTS.md": { link: "../outside.md" } }),
        FILES,
      ),
    ).toEqual({ kind: "refused", reason: "it links outside the repository" });
    expect(
      await firstCommittedInstructions(
        treeOf({ "AGENTS.md": { link: "docs" }, "docs/a.md": "x" }),
        FILES,
      ),
    ).toEqual({ kind: "refused", reason: "it is not a regular file" });
    expect(
      await firstCommittedInstructions(
        treeOf({ "AGENTS.md": { link: "AGENTS.md" } }),
        FILES,
      ),
    ).toEqual({
      kind: "refused",
      reason: "it links through too many symlinks",
    });
  });

  test("a file past the cap is refused before it is read, and a refused file is not passed over", async () => {
    const tree = treeOf({
      "AGENTS.md": "a".repeat(COMMITTED_INSTRUCTIONS_MAX_BYTES + 1),
      "CLAUDE.md": "fallback",
    });
    expect(await namedCommittedInstructions(tree, FILES)).toEqual({
      file: "AGENTS.md",
      found: {
        kind: "refused",
        reason: `it is larger than ${COMMITTED_INSTRUCTIONS_MAX_BYTES} bytes`,
      },
    });
    expect(tree.reads).toEqual([]);
  });

  test("a tree read that throws is the caller's to catch", async () => {
    const failing: CommittedTree = {
      entry: async () => {
        throw new Error("forge down");
      },
      size: async () => 0,
      read: async () => "",
    };
    await expect(firstCommittedInstructions(failing, FILES)).rejects.toThrow(
      "forge down",
    );
  });
});
