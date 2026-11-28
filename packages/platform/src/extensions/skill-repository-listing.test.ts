import { describe, expect, test } from "bun:test";
import type {
  GitHubRepositoryTree,
  GitHubTreeEntry,
} from "./skill-git-sync.ts";
import {
  listSkillRepository,
  repositoryRootFiles,
  SKILL_REPOSITORY_LIMITS,
} from "./skill-repository-listing.ts";

const encoder = new TextEncoder();
const skillFile = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: What ${name} does.\n${extra}---\nBody.\n`;

/**
 * A tree built the way GitHub lists one: every directory as a `tree` entry
 * and every file as a `blob`, each blob's sha standing for its content.
 */
function treeOf(
  files: Record<
    string,
    | string
    | { mode?: string; type?: "blob" | "commit"; size?: number; text?: string }
  >,
) {
  const contents = new Map<string, Uint8Array>();
  const entries: GitHubTreeEntry[] = [];
  const dirs = new Set<string>();
  let next = 0;
  for (const [path, value] of Object.entries(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(parts.slice(0, i).join("/"));
    const file = typeof value === "string" ? { text: value } : value;
    const bytes = encoder.encode(file.text ?? "");
    next += 1;
    const sha = next.toString(16).padStart(40, "0");
    contents.set(sha, bytes);
    entries.push({
      path,
      mode: file.mode ?? "100644",
      type: file.type ?? "blob",
      sha,
      size: file.size ?? bytes.byteLength,
    });
  }
  for (const dir of dirs) {
    entries.push({
      path: dir,
      mode: "040000",
      type: "tree",
      sha: `tree:${dir}`,
      size: 0,
    });
  }
  const tree: GitHubRepositoryTree = {
    sha: "tree:",
    entries,
    truncated: false,
  };
  const asked: string[][] = [];
  const readBlobs = async (shas: string[]) => {
    asked.push(shas);
    return new Map(
      shas.flatMap((sha) => {
        const bytes = contents.get(sha);
        return bytes === undefined ? [] : [[sha, bytes] as const];
      }),
    );
  };
  const shaOf = (path: string) =>
    entries.find((entry) => entry.path === path)?.sha ?? "";
  return { tree, readBlobs, asked, shaOf, contents };
}

async function listed(files: Parameters<typeof treeOf>[0]) {
  const built = treeOf(files);
  const listing = await listSkillRepository(built.tree, built.readBlobs);
  if (listing.kind !== "listed") throw new Error(`listing ${listing.kind}`);
  return { ...built, entries: listing.entries };
}

describe("listing a skill repository", () => {
  test("every directory holding a SKILL.md is one entry, read by its frontmatter", async () => {
    const { entries, asked, shaOf } = await listed({
      "README.md": "top\n",
      LICENSE: "terms\n",
      "skills/pdf/SKILL.md": skillFile("pdf", "license: Apache-2.0\n"),
      "skills/pdf/scripts/fill.py": { mode: "100755", text: "print(1)\n" },
      "skills/notes/SKILL.md": skillFile("notes"),
      "skills/notes/reference.md": "ref\n",
      "docs/guide.md": "not a skill\n",
    });
    expect(entries).toEqual([
      {
        path: "skills/notes",
        name: "notes",
        description: "What notes does.",
        license: null,
        treeSha: "tree:skills/notes",
        fileCount: 2,
        totalBytes: skillFile("notes").length + 4,
        hasScripts: false,
        issues: [],
      },
      {
        path: "skills/pdf",
        name: "pdf",
        description: "What pdf does.",
        license: "Apache-2.0",
        treeSha: "tree:skills/pdf",
        fileCount: 2,
        totalBytes: skillFile("pdf", "license: Apache-2.0\n").length + 9,
        hasScripts: true,
        issues: [],
      },
    ]);
    // Only the SKILL.md files are fetched, in one call.
    expect(asked).toEqual([
      [shaOf("skills/pdf/SKILL.md"), shaOf("skills/notes/SKILL.md")],
    ]);
  });

  test("a SKILL.md at the root is the whole repository, under the root tree", async () => {
    const { entries } = await listed({
      "SKILL.md": skillFile("solo"),
      "notes.md": "n\n",
    });
    expect(entries).toMatchObject([
      { path: "", name: "solo", treeSha: "tree:", fileCount: 2, issues: [] },
    ]);
  });

  test("a block scalar description is read as an upload reads it", async () => {
    const { entries } = await listed({
      "skills/guide/SKILL.md":
        "---\nname: guide\ndescription: >\n  Folded over\n  two lines.\n---\nBody.\n",
    });
    expect(entries[0]).toMatchObject({
      name: "guide",
      description: "Folded over two lines.\n",
      issues: [],
    });
  });

  test("a symlink is refused by its mode and never fetched, the SKILL.md itself included", async () => {
    const { entries, asked, shaOf } = await listed({
      "skills/linked/SKILL.md": skillFile("linked"),
      "skills/linked/data.md": { mode: "120000", text: "../../secret" },
      "skills/alias/SKILL.md": { mode: "120000", text: "../linked/SKILL.md" },
    });
    expect(entries).toMatchObject([
      {
        path: "skills/alias",
        name: null,
        issues: [
          {
            path: "SKILL.md",
            code: "unsupported_entry_kind",
            message: "A symlink entry is not allowed.",
          },
        ],
      },
      {
        path: "skills/linked",
        name: "linked",
        issues: [{ path: "data.md", code: "unsupported_entry_kind" }],
      },
    ]);
    expect(asked).toEqual([[shaOf("skills/linked/SKILL.md")]]);
  });

  test("a submodule, a denied path, an engine manifest and a nested SKILL.md are refused on the tree", async () => {
    const { entries } = await listed({
      "a/SKILL.md": skillFile("a"),
      "a/vendor": { mode: "160000", type: "commit" },
      "b/SKILL.md": skillFile("b"),
      "b/hooks/run.sh": "x\n",
      "b/.mcp.json": "{}\n",
      "c/SKILL.md": skillFile("c"),
      "c/.claude-plugin/plugin.json": "{}\n",
      "d/SKILL.md": skillFile("d"),
      "d/inner/SKILL.md": skillFile("inner"),
    });
    const issues = Object.fromEntries(
      entries.map((entry) => [
        entry.path,
        entry.issues.map((issue) => `${issue.path} ${issue.code}`),
      ]),
    );
    expect(issues).toEqual({
      a: ["vendor unsupported_entry_kind"],
      b: ["hooks/run.sh denied_path", ".mcp.json denied_path"],
      c: [".claude-plugin/plugin.json engine_manifest"],
      d: ["inner/SKILL.md multiple_skills"],
      "d/inner": [],
    });
  });

  test("the skill limits are judged on the tree's sizes", async () => {
    const big = treeOf({
      "s/SKILL.md": skillFile("s"),
      "s/a.md": { size: 600 },
      "s/b.md": { size: 300 },
      "s/c.md": { size: 300 },
    });
    const listing = await listSkillRepository(big.tree, big.readBlobs, {
      maxFiles: 4,
      maxFileBytes: 512,
      maxTotalBytes: 1024,
    });
    if (listing.kind !== "listed") throw new Error(listing.kind);
    expect(
      listing.entries[0]?.issues.map((issue) => `${issue.path} ${issue.code}`),
    ).toEqual(["a.md file_too_large", " too_many_files", " bundle_too_large"]);
    expect(listing.entries[0]?.name).toBe("s");
  });

  test("a SKILL.md past 64 KiB is not fetched and its directory cannot be switched on", async () => {
    const { entries, asked } = await listed({
      "huge/SKILL.md": { size: SKILL_REPOSITORY_LIMITS.maxSkillFileBytes + 1 },
      "edge/SKILL.md": skillFile("edge").padEnd(
        SKILL_REPOSITORY_LIMITS.maxSkillFileBytes,
        "x",
      ),
    });
    expect(entries).toMatchObject([
      { path: "edge", name: "edge", issues: [] },
      {
        path: "huge",
        name: null,
        description: null,
        issues: [{ path: "SKILL.md", code: "file_too_large" }],
      },
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(1);
  });

  test("a SKILL.md that cannot be parsed, or names nothing usable, keeps its reasons", async () => {
    const { entries } = await listed({
      "a/SKILL.md": "no frontmatter\n",
      "b/SKILL.md": "---\nname: Not A Name\ndescription: d\n---\n",
      "c/SKILL.md": "---\nname: c\ndescription: d\nallowed-tools: Bash\n---\n",
      "d/SKILL.md": "---\nname: d\ndescription: d\n---\nRun !`id`.\n",
    });
    expect(
      entries.map((entry) => [
        entry.path,
        entry.name,
        entry.issues.map((issue) => issue.code),
      ]),
    ).toEqual([
      ["a", null, ["bad_frontmatter"]],
      ["b", null, ["bad_frontmatter"]],
      ["c", "c", ["disallowed_frontmatter_key"]],
      ["d", "d", ["dynamic_context"]],
    ]);
  });

  test("a blob GitHub does not answer leaves the directory unreadable", async () => {
    const built = treeOf({ "a/SKILL.md": skillFile("a") });
    const listing = await listSkillRepository(
      built.tree,
      async () => new Map(),
    );
    if (listing.kind !== "listed") throw new Error(listing.kind);
    expect(listing.entries[0]).toMatchObject({
      name: null,
      issues: [{ path: "SKILL.md", code: "missing_skill_file" }],
    });
  });

  test("a blob that is not the size the tree gave is not read", async () => {
    const { entries } = await listed({
      "a/SKILL.md": { size: 10, text: skillFile("a") },
    });
    expect(entries[0]).toMatchObject({
      name: null,
      issues: [{ path: "SKILL.md", code: "missing_skill_file" }],
    });
  });

  test("a NUL in a value, or in a line an issue quotes, is not kept", async () => {
    const { entries } = await listed({
      "a/SKILL.md": "---\nname: a\ndescription: a\0b\n---\nBody.\n",
      "b/SKILL.md": skillFile("b", "license: MIT\0\n"),
      "c/SKILL.md": skillFile("c", "no\0key\n"),
    });
    expect(entries).toMatchObject([
      {
        name: "a",
        description: null,
        issues: [
          {
            path: "SKILL.md",
            code: "bad_frontmatter",
            message: '"description" holds a NUL character.',
          },
        ],
      },
      { name: "b", license: null, issues: [{ code: "bad_frontmatter" }] },
      { name: "c", issues: [{ code: "bad_frontmatter" }] },
    ]);
    expect(JSON.stringify(entries)).not.toContain("\\u0000");
  });

  test("a lone surrogate, in a value or cut into an issue's text, is replaced", async () => {
    const { entries } = await listed({
      "a/SKILL.md": '---\nname: a\ndescription: "a\\ud800b"\n---\nBody.\n',
      // The line an issue quotes is cut at 60 units, inside the pair.
      "b/SKILL.md": skillFile("b", `${"x".repeat(59)}😀 tail\n`),
    });
    expect(entries[0]).toMatchObject({ description: "a\u{FFFD}b", issues: [] });
    expect(entries[1]?.issues).toHaveLength(1);
    expect(
      entries.flatMap((entry) => entry.issues).map(({ message }) => message),
    ).not.toContainEqual(expect.stringMatching(/\p{Cs}/u));
  });

  test("the same name in two directories is listed twice", async () => {
    const { entries } = await listed({
      "one/SKILL.md": skillFile("same"),
      "two/SKILL.md": skillFile("same"),
    });
    expect(entries.map((entry) => entry.name)).toEqual(["same", "same"]);
  });

  test("a repository with no SKILL.md lists nothing and fetches nothing", async () => {
    const { entries, asked } = await listed({ "README.md": "x\n" });
    expect(entries).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe("a repository past what a listing reads", () => {
  test("a skill directory's path is at most 1024 bytes; past it nothing is read", async () => {
    const at = (bytes: number) => ({
      [`${"p".repeat(bytes)}/SKILL.md`]: skillFile("a"),
    });
    expect(
      (await listed(at(SKILL_REPOSITORY_LIMITS.maxPathBytes))).entries,
    ).toHaveLength(1);
    const past = treeOf(at(SKILL_REPOSITORY_LIMITS.maxPathBytes + 1));
    expect(await listSkillRepository(past.tree, past.readBlobs)).toMatchObject({
      kind: "refused",
      issues: [{ code: "path_too_long" }],
    });
    expect(past.asked).toEqual([]);
    // Bytes, not characters, across several directories.
    const deep = (last: number) => ({
      [`${"가".repeat(170)}/${"나".repeat(170)}/${"p".repeat(last)}/SKILL.md`]:
        skillFile("a"),
    });
    expect((await listed(deep(2))).entries).toHaveLength(1);
    const over = treeOf(deep(3));
    expect((await listSkillRepository(over.tree, over.readBlobs)).kind).toBe(
      "refused",
    );
  });

  test("a tree GitHub cut short is refused before any content is read", async () => {
    const built = treeOf({ "a/SKILL.md": skillFile("a") });
    expect(
      await listSkillRepository(
        { ...built.tree, truncated: true },
        built.readBlobs,
      ),
    ).toMatchObject({ kind: "refused", issues: [{ code: "tree_truncated" }] });
    expect(built.asked).toEqual([]);
  });

  test("200 skill directories list; one more refuses the repository", async () => {
    const files = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `s${i}/SKILL.md`,
          skillFile(`s${i}`),
        ]),
      );
    const most = await listed(files(SKILL_REPOSITORY_LIMITS.maxSkills));
    expect(most.entries).toHaveLength(SKILL_REPOSITORY_LIMITS.maxSkills);
    const over = treeOf(files(SKILL_REPOSITORY_LIMITS.maxSkills + 1));
    expect(await listSkillRepository(over.tree, over.readBlobs)).toMatchObject({
      kind: "refused",
      issues: [{ code: "too_many_skills" }],
    });
    expect(over.asked).toEqual([]);
  });

  test("SKILL.md files past 4 MiB together refuse the repository, counting only the ones it would fetch", async () => {
    const each = SKILL_REPOSITORY_LIMITS.maxSkillFileBytes;
    const fits = SKILL_REPOSITORY_LIMITS.maxListingBytes / each;
    const files = (count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => [
          `s${i}/SKILL.md`,
          { size: each, text: skillFile(`s${i}`) },
        ]),
      );
    const most = await listed({
      ...files(fits),
      // Too large to fetch, so not counted.
      "huge/SKILL.md": { size: each + 1 },
    });
    expect(most.entries).toHaveLength(fits + 1);
    const over = treeOf(files(fits + 1));
    expect(await listSkillRepository(over.tree, over.readBlobs)).toMatchObject({
      kind: "refused",
      issues: [{ code: "listing_too_large" }],
    });
    expect(over.asked).toEqual([]);
  });
});

test("the root files are the blobs outside any directory, by name", () => {
  const { tree } = treeOf({
    NOTICE: "n\n",
    "LICENSE.txt": "l\n",
    "skills/pdf/SKILL.md": skillFile("pdf"),
    "skills/pdf/NOTICE": "inner\n",
    vendor: { mode: "160000", type: "commit" },
  });
  expect(repositoryRootFiles(tree)).toEqual(["LICENSE.txt", "NOTICE"]);
});
