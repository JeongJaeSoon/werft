import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubAppCheckError } from "@werft-ai/platform";
import { type FakeGitHub, startFakeGitHub } from "@werft-ai/testkit";
import { createGitHubSkillReader } from "./forge-github.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const INSTALLATION = 1;

let github: FakeGitHub;
let repositoryId: number;
let first: string;
beforeAll(async () => {
  github = await startFakeGitHub({ appId: 101, publicKey });
  await github.createRepository("acme", "skills", {
    "README.md": "top\n",
    "skills/review/SKILL.md": "---\nname: review\n---\nReview.\n",
    "skills/review/notes/checklist.md": "- one\n",
  });
  first = (await github.refs("acme", "skills"))["refs/heads/main"] ?? "";
  const app = { appId: 101, apiBase: github.origin, privateKey };
  const found = await createGitHubSkillReader().repository(
    app,
    INSTALLATION,
    "acme",
    "skills",
  );
  repositoryId = found?.id ?? 0;
});
afterAll(async () => {
  await github.stop();
});

const app = () => ({ appId: 101, apiBase: github.origin, privateKey });
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("reading a skill from GitHub with the App's installation", () => {
  test("finds a repository by owner and name, and nothing for one it cannot see", async () => {
    const reader = createGitHubSkillReader();
    expect(
      await reader.repository(app(), INSTALLATION, "acme", "skills"),
    ).toEqual({
      id: repositoryId,
      fullName: "acme/skills",
      ownerId: 5000,
      public: false,
      defaultBranch: "main",
      license: null,
    });
    expect(
      await reader.repository(app(), INSTALLATION, "acme", "missing"),
    ).toBeNull();
  });

  test("resolves a branch, a tag and a commit to the commit, by repository id", async () => {
    const reader = createGitHubSkillReader();
    await github.setRef("acme", "skills", "refs/tags/v1", first);
    expect(
      await reader.resolve(app(), INSTALLATION, repositoryId, "main"),
    ).toBe(first);
    expect(await reader.resolve(app(), INSTALLATION, repositoryId, "v1")).toBe(
      first,
    );
    expect(await reader.resolve(app(), INSTALLATION, repositoryId, first)).toBe(
      first,
    );
    expect(
      await reader.resolve(app(), INSTALLATION, repositoryId, "gone"),
    ).toBeNull();
    expect(github.apiRequests.at(-1)?.path).toBe(
      `/repositories/${repositoryId}/commits/gone`,
    );
  });

  test("reads every file under the path, named from the skill's own root", async () => {
    const read = await createGitHubSkillReader().read(
      app(),
      INSTALLATION,
      repositoryId,
      first,
      "skills/review",
    );
    if (read.kind !== "files") throw new Error(`read ${read.kind}`);
    expect(
      read.files
        .map((file) => ({ ...file, bytes: text(file.bytes) }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ).toEqual([
      {
        path: "notes/checklist.md",
        kind: "file",
        mode: 0o644,
        bytes: "- one\n",
      },
      {
        path: "SKILL.md",
        kind: "file",
        mode: 0o644,
        bytes: "---\nname: review\n---\nReview.\n",
      },
    ]);
  });

  test("a later commit is read as it is, and a path or commit that is not there is missing", async () => {
    const reader = createGitHubSkillReader();
    const next = await github.writeFiles("acme", "skills", "main", {
      "skills/review/SKILL.md": "---\nname: review\n---\nReview twice.\n",
      "skills/review/notes/checklist.md": null,
    });
    const read = await reader.read(
      app(),
      INSTALLATION,
      repositoryId,
      next,
      "skills/review",
    );
    if (read.kind !== "files") throw new Error(`read ${read.kind}`);
    expect(read.files.map((file) => [file.path, text(file.bytes)])).toEqual([
      ["SKILL.md", "---\nname: review\n---\nReview twice.\n"],
    ]);
    expect(
      await reader.read(app(), INSTALLATION, repositoryId, next, "skills/none"),
    ).toEqual({ kind: "missing" });
    expect(
      await reader.read(
        app(),
        INSTALLATION,
        repositoryId,
        "f".repeat(40),
        "skills/review",
      ),
    ).toEqual({ kind: "missing" });
  });

  test("a tree past the limits is refused before any file is read", async () => {
    const reader = createGitHubSkillReader({
      limits: { maxFiles: 2, maxFileBytes: 1024, maxTotalBytes: 4096 },
    });
    const before = github.apiRequests.length;
    expect(
      await reader.read(
        app(),
        INSTALLATION,
        repositoryId,
        first,
        "skills/review",
      ),
    ).toEqual({
      kind: "refused",
      issues: [
        {
          path: "",
          code: "too_many_files",
          message: "A skill holds at most 1 files",
        },
      ],
    });
    expect(
      github.apiRequests
        .slice(before)
        .some((request) => request.path.includes("/git/blobs/")),
    ).toBe(false);
    const small = createGitHubSkillReader({
      limits: { maxFiles: 10, maxFileBytes: 8, maxTotalBytes: 4096 },
    });
    expect(
      await small.read(
        app(),
        INSTALLATION,
        repositoryId,
        first,
        "skills/review",
      ),
    ).toMatchObject({
      kind: "refused",
      issues: [{ code: "file_too_large" }],
    });
    const tight = createGitHubSkillReader({
      limits: { maxFiles: 10, maxFileBytes: 1024, maxTotalBytes: 8 },
    });
    expect(
      await tight.read(
        app(),
        INSTALLATION,
        repositoryId,
        first,
        "skills/review",
      ),
    ).toMatchObject({
      kind: "refused",
      issues: [{ code: "bundle_too_large" }],
    });
    expect(
      github.apiRequests
        .slice(before)
        .some((request) => request.path.includes("/git/blobs/")),
    ).toBe(false);
  });

  test("GitHub refusing the installation token is a check error, not a missing ref", async () => {
    github.failTokens(true);
    try {
      const error = await createGitHubSkillReader({ retryAfterBaseMs: 1 })
        .resolve(app(), INSTALLATION, repositoryId, "main")
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GitHubAppCheckError);
    } finally {
      github.failTokens(false);
    }
  });
});

describe("reading a public repository the installation does not cover", () => {
  let other: FakeGitHub;
  let closedId: number;
  beforeAll(async () => {
    other = await startFakeGitHub({
      appId: 101,
      publicKey,
      installedOn: ["acme/installed"],
    });
    await other.createRepository("acme", "installed", { "README.md": "x\n" });
    await other.createRepository(
      "anthropics",
      "open",
      { "skills/pdf/SKILL.md": "---\nname: pdf\n---\nPDF.\n" },
      { private: false, ownerId: 4242, license: "Apache-2.0" },
    );
    closedId = await other.createRepository(
      "anthropics",
      "closed",
      { "skills/pdf/SKILL.md": "---\nname: pdf\n---\nPDF.\n" },
      { private: true },
    );
  });
  afterAll(async () => {
    await other.stop();
  });
  const otherApp = () => ({ appId: 101, apiBase: other.origin, privateKey });

  test("finds it by name and by id with its owner's id, and reads its ref, files and branch", async () => {
    const reader = createGitHubSkillReader();
    const open = await reader.repository(
      otherApp(),
      INSTALLATION,
      "anthropics",
      "open",
    );
    expect(open).toEqual({
      id: expect.any(Number),
      fullName: "anthropics/open",
      ownerId: 4242,
      public: true,
      defaultBranch: "main",
      license: "Apache-2.0",
    });
    const id = open?.id ?? 0;
    expect(await reader.repositoryById(otherApp(), INSTALLATION, id)).toEqual(
      open,
    );
    const head = (await other.refs("anthropics", "open"))["refs/heads/main"];
    expect(await reader.resolve(otherApp(), INSTALLATION, id, "main")).toBe(
      head ?? "",
    );
    const read = await reader.read(
      otherApp(),
      INSTALLATION,
      id,
      head ?? "",
      "skills/pdf",
    );
    if (read.kind !== "files") throw new Error(`read ${read.kind}`);
    expect(read.files.map((file) => [file.path, text(file.bytes)])).toEqual([
      ["SKILL.md", "---\nname: pdf\n---\nPDF.\n"],
    ]);
    expect(await reader.isBranch(otherApp(), INSTALLATION, id, "main")).toBe(
      true,
    );
  });

  test("a private repository it does not cover is not there, by name or by id", async () => {
    const reader = createGitHubSkillReader();
    expect(
      await reader.repository(otherApp(), INSTALLATION, "anthropics", "closed"),
    ).toBeNull();
    expect(
      await reader.repositoryById(otherApp(), INSTALLATION, closedId),
    ).toBeNull();
    expect(
      await reader.resolve(otherApp(), INSTALLATION, closedId, "main"),
    ).toBeNull();
  });

  test("a private repository it covers reads, and says it is not public", async () => {
    const found = await createGitHubSkillReader().repository(
      otherApp(),
      INSTALLATION,
      "acme",
      "installed",
    );
    expect(found).toMatchObject({ fullName: "acme/installed", public: false });
    expect(
      await createGitHubSkillReader().repositoryById(
        otherApp(),
        INSTALLATION,
        found?.id ?? 0,
      ),
    ).toEqual(found);
  });

  test("an internal repository it covers is not public, by name or by id", async () => {
    const reader = createGitHubSkillReader();
    other.setInternal("acme", "installed");
    try {
      const found = await reader.repository(
        otherApp(),
        INSTALLATION,
        "acme",
        "installed",
      );
      expect(found).toMatchObject({
        fullName: "acme/installed",
        public: false,
      });
      expect(
        await reader.repositoryById(otherApp(), INSTALLATION, found?.id ?? 0),
      ).toMatchObject({ public: false });
    } finally {
      other.setPrivate("acme", "installed", true);
    }
  });

  test("a license GitHub could not name reads as none", async () => {
    await other.createRepository(
      "anthropics",
      "unnamed",
      { "LICENSE.txt": "Some terms.\n" },
      { private: false, license: "NOASSERTION" },
    );
    expect(
      await createGitHubSkillReader().repository(
        otherApp(),
        INSTALLATION,
        "anthropics",
        "unnamed",
      ),
    ).toMatchObject({ license: null });
  });

  test("lists the whole tree of a commit in one read, with each entry's mode, kind and size", async () => {
    const reader = createGitHubSkillReader();
    const id =
      (await reader.repository(otherApp(), INSTALLATION, "anthropics", "open"))
        ?.id ?? 0;
    const head = await other.writeFiles("anthropics", "open", "main", {
      NOTICE: "Notices.\n",
      "skills/pdf/link.md": { symlink: "SKILL.md" },
    });
    const before = other.apiRequests.length;
    const tree = await reader.tree(otherApp(), INSTALLATION, id, head);
    expect(tree?.truncated).toBe(false);
    expect(tree?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(
      tree?.entries.map(({ path, mode, type, size }) => ({
        path,
        mode,
        type,
        size,
      })),
    ).toEqual([
      { path: "NOTICE", mode: "100644", type: "blob", size: 9 },
      { path: "skills", mode: "040000", type: "tree", size: 0 },
      { path: "skills/pdf", mode: "040000", type: "tree", size: 0 },
      { path: "skills/pdf/SKILL.md", mode: "100644", type: "blob", size: 23 },
      { path: "skills/pdf/link.md", mode: "120000", type: "blob", size: 8 },
    ]);
    expect(
      other.apiRequests
        .slice(before)
        .filter((request) => request.path.includes("/git/trees/")),
    ).toHaveLength(1);
    expect(
      await reader.tree(otherApp(), INSTALLATION, id, "0".repeat(40)),
    ).toBeNull();
  });

  test("reads blobs by sha in one call, leaving out one that is not there", async () => {
    const reader = createGitHubSkillReader();
    const id =
      (await reader.repository(otherApp(), INSTALLATION, "anthropics", "open"))
        ?.id ?? 0;
    const head = (await other.refs("anthropics", "open"))["refs/heads/main"];
    const tree = await reader.tree(otherApp(), INSTALLATION, id, head ?? "");
    const skill = tree?.entries.find(
      (entry) => entry.path === "skills/pdf/SKILL.md",
    );
    const gone = "f".repeat(40);
    const before = other.tokenRequests.length;
    const blobs = await reader.blobs(otherApp(), INSTALLATION, id, [
      skill?.sha ?? "",
      gone,
    ]);
    expect([...blobs.keys()]).toEqual([skill?.sha ?? ""]);
    expect(text(blobs.get(skill?.sha ?? "") ?? new Uint8Array())).toBe(
      "---\nname: pdf\n---\nPDF.\n",
    );
    expect(other.tokenRequests.length - before).toBe(1);
  });

  test("a tree entry git cannot hold, or a blob other than the one asked for, is not read", async () => {
    const reader = createGitHubSkillReader();
    const id =
      (await reader.repository(otherApp(), INSTALLATION, "anthropics", "open"))
        ?.id ?? 0;
    const head =
      (await other.refs("anthropics", "open"))["refs/heads/main"] ?? "";
    const real = await reader.tree(otherApp(), INSTALLATION, id, head);
    const root = real?.sha ?? "";
    const sha = "a".repeat(40);
    const file = {
      path: "SKILL.md",
      mode: "100644",
      type: "blob",
      sha,
    } as const;
    const answer = (tree: unknown[], of = root) =>
      other.answerNext(/^\/git\/trees\//, { sha: of, tree, truncated: false });
    // One entry as git holds it is read; each of the others is not.
    answer([{ ...file, size: 1 }]);
    expect(
      (await reader.tree(otherApp(), INSTALLATION, id, head))?.entries,
    ).toEqual([{ ...file, size: 1 }]);
    const trees: unknown[][] = [
      [{ ...file, size: -1 }],
      [{ ...file, size: "12" }],
      [file],
      [{ ...file, mode: undefined, size: 1 }],
      [{ ...file, mode: "160000", size: 1 }],
      [{ ...file, type: "commit", size: 1 }],
      [{ ...file, sha: "short", size: 1 }],
      [{ ...file, path: "a\0b", size: 1 }],
      [{ ...file, path: `a${String.fromCharCode(0xd800)}b`, size: 1 }],
      [
        { ...file, size: 1 },
        { ...file, size: 1 },
      ],
    ];
    for (const tree of trees) {
      answer(tree);
      await expect(
        reader.tree(otherApp(), INSTALLATION, id, head),
      ).rejects.toBeInstanceOf(GitHubAppCheckError);
    }
    // Another tree, another commit or another repository than the one asked.
    answer([], sha);
    await expect(
      reader.tree(otherApp(), INSTALLATION, id, head),
    ).rejects.toBeInstanceOf(GitHubAppCheckError);
    other.answerNext(/^\/git\/commits\//, { sha, tree: { sha: root } });
    await expect(
      reader.tree(otherApp(), INSTALLATION, id, head),
    ).rejects.toBeInstanceOf(GitHubAppCheckError);
    other.answerNext(/^$/, {
      id: id + 1,
      full_name: "anthropics/open",
      owner: { id: 1 },
      visibility: "public",
      default_branch: "main",
    });
    await expect(
      reader.repositoryById(otherApp(), INSTALLATION, id),
    ).rejects.toBeInstanceOf(GitHubAppCheckError);
    const skill =
      real?.entries.find((entry) => entry.path === "skills/pdf/SKILL.md")
        ?.sha ?? "";
    other.answerNext(/^\/git\/blobs\//, {
      sha: skill,
      encoding: "base64",
      content: Buffer.from("another file").toString("base64"),
    });
    await expect(
      reader.blobs(otherApp(), INSTALLATION, id, [skill]),
    ).rejects.toBeInstanceOf(GitHubAppCheckError);
    expect(
      (await reader.blobs(otherApp(), INSTALLATION, id, [skill])).size,
    ).toBe(1);
  });

  test("a tree GitHub cut short says so", async () => {
    const reader = createGitHubSkillReader();
    const id =
      (await reader.repository(otherApp(), INSTALLATION, "anthropics", "open"))
        ?.id ?? 0;
    const head = (await other.refs("anthropics", "open"))["refs/heads/main"];
    other.truncateTrees(true);
    try {
      expect(
        await reader.tree(otherApp(), INSTALLATION, id, head ?? ""),
      ).toMatchObject({ truncated: true });
    } finally {
      other.truncateTrees(false);
    }
  });
});

describe("whether a skill's ref is a branch, for auto-approve", () => {
  let guarded: number;
  let commit = "";
  beforeAll(async () => {
    await github.createRepository("acme", "guarded", {
      "skills/review/SKILL.md": "---\nname: review\n---\nReview.\n",
    });
    commit = (await github.refs("acme", "guarded"))["refs/heads/main"] ?? "";
    guarded =
      (
        await createGitHubSkillReader().repository(
          app(),
          INSTALLATION,
          "acme",
          "guarded",
        )
      )?.id ?? 0;
  });
  const isBranch = (ref: string) =>
    createGitHubSkillReader({ retryAfterBaseMs: 1 }).isBranch(
      app(),
      INSTALLATION,
      guarded,
      ref,
    );

  test("a branch is, by its short or its full name, whatever rules it has", async () => {
    expect(await isBranch("main")).toBe(true);
    expect(await isBranch("refs/heads/main")).toBe(true);
    expect(
      github.apiRequests.filter((one) =>
        /\/(rules|protection|pulls|reviews)\b/.test(one.path),
      ),
    ).toEqual([]);
  });

  test("a tag, a commit, a missing branch, or a short name a tag also has is not", async () => {
    await github.setRef("acme", "guarded", "refs/tags/v1", commit);
    await github.setRef("acme", "guarded", "refs/heads/release", commit);
    await github.setRef("acme", "guarded", "refs/tags/release", commit);
    for (const ref of ["v1", "refs/tags/v1", commit, "gone", "release"]) {
      expect(await isBranch(ref)).toBe(false);
    }
    expect(await isBranch("refs/heads/release")).toBe(true);
  });

  test("GitHub failing is a check error, never an answer", async () => {
    github.failNext(20, 500);
    try {
      const error = await isBranch("main").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GitHubAppCheckError);
    } finally {
      github.failNext(0, 500);
    }
  });
});
