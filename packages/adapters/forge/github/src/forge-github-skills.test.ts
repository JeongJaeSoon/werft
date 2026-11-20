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
    ).toEqual({ id: repositoryId, fullName: "acme/skills" });
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

describe("reading what GitHub shows about a skill's branch, for auto-approve", () => {
  let guarded: number;
  let commit = "";
  const author = {
    contents: "write",
    metadata: "read",
    pull_requests: "write",
  } as const;
  afterAll(() => github.setPermissions(undefined));
  beforeAll(async () => {
    github.setPermissions({ ...author, administration: "read" });
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
  const protection = (ref: string, at: string | null) =>
    createGitHubSkillReader({ retryAfterBaseMs: 1 }).protection(
      app(),
      INSTALLATION,
      guarded,
      ref,
      at,
    );
  let body = 0;
  const pushed = () =>
    github.writeFiles("acme", "guarded", "main", {
      "skills/review/SKILL.md": `---\nname: review\n---\nReview ${++body}.\n`,
    });

  test("no rule is protection_missing; a ruleset, or classic protection read with administration, is the rule", async () => {
    expect(await protection("main", null)).toEqual({
      met: false,
      reason: "protection_missing",
    });
    github.setBranchRule("acme", "guarded", "main", "ruleset", 2);
    expect(await protection("main", null)).toEqual({
      met: true,
      rule: { kind: "ruleset", requiredReviews: 2 },
      pullRequest: null,
    });
    github.setBranchRule("acme", "guarded", "main", "ruleset", null);
    github.setBranchRule("acme", "guarded", "main", "branch_protection", 1);
    expect(await protection("refs/heads/main", null)).toEqual({
      met: true,
      rule: { kind: "branch_protection", requiredReviews: 1 },
      pullRequest: null,
    });
    // The author App's own permissions: classic protection answers 403.
    github.setPermissions(author);
    try {
      expect(await protection("main", null)).toEqual({
        met: false,
        reason: "protection_missing",
      });
    } finally {
      github.setPermissions({ ...author, administration: "read" });
      github.setBranchRule(
        "acme",
        "guarded",
        "main",
        "branch_protection",
        null,
      );
    }
  });

  test("a tag, a commit, a missing branch, or a short name a tag also has is not a branch", async () => {
    github.setBranchRule("acme", "guarded", "main", "ruleset", 1);
    github.setBranchRule("acme", "guarded", "release", "ruleset", 1);
    await github.setRef("acme", "guarded", "refs/tags/v1", commit);
    await github.setRef("acme", "guarded", "refs/heads/release", commit);
    await github.setRef("acme", "guarded", "refs/tags/release", commit);
    for (const ref of ["v1", "refs/tags/v1", commit, "gone", "release"]) {
      for (const at of [commit, null]) {
        expect(await protection(ref, at)).toEqual({
          met: false,
          reason: "not_branch",
        });
      }
    }
    expect(await protection("refs/heads/release", null)).toMatchObject({
      met: true,
    });
  });

  test("the commit needs a merged pull request whose reviewers' last reviews approve, not only its author's", async () => {
    github.setBranchRule("acme", "guarded", "main", "ruleset", 1);
    const pending = { met: false, reason: "no_reviewed_pull_request" } as const;
    const direct = await pushed();
    expect(await protection("main", direct)).toEqual(pending);

    const merged = async (
      reviews: {
        userId: number;
        state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
      }[],
      base = "main",
    ) => {
      const at = await pushed();
      const number = github.addMergedPull("acme", "guarded", {
        base,
        commit: at,
        authorId: 7,
        reviews,
      });
      return { at, number };
    };
    for (const reviews of [
      [],
      [{ userId: 7, state: "APPROVED" as const }],
      [
        { userId: 8, state: "APPROVED" as const },
        { userId: 9, state: "CHANGES_REQUESTED" as const },
      ],
      [
        { userId: 8, state: "APPROVED" as const },
        { userId: 8, state: "DISMISSED" as const },
      ],
    ]) {
      const { at } = await merged(reviews);
      expect(await protection("main", at)).toEqual(pending);
    }
    const elsewhere = await merged(
      [{ userId: 8, state: "APPROVED" }],
      "release",
    );
    expect(await protection("main", elsewhere.at)).toEqual(pending);

    const changed = await merged([
      { userId: 9, state: "CHANGES_REQUESTED" },
      { userId: 9, state: "APPROVED" },
      { userId: 8, state: "COMMENTED" },
    ]);
    expect(await protection("main", changed.at)).toEqual({
      met: true,
      rule: { kind: "ruleset", requiredReviews: 1 },
      pullRequest: changed.number,
    });

    const long = await merged([
      ...Array.from({ length: 150 }, () => ({
        userId: 10,
        state: "COMMENTED" as const,
      })),
      { userId: 8, state: "APPROVED" },
    ]);
    expect(await protection("refs/heads/main", long.at)).toMatchObject({
      met: true,
      pullRequest: long.number,
    });

    // More reviews than are read: one past the last page could request changes.
    const unread = await merged([
      { userId: 8, state: "APPROVED" },
      ...Array.from({ length: 999 }, () => ({
        userId: 10,
        state: "COMMENTED" as const,
      })),
      { userId: 9, state: "CHANGES_REQUESTED" },
    ]);
    expect(await protection("main", unread.at)).toEqual(pending);

    // A later page that cannot be read is not the end of the list.
    const lost = await merged([
      { userId: 8, state: "APPROVED" },
      ...Array.from({ length: 99 }, () => ({
        userId: 10,
        state: "COMMENTED" as const,
      })),
      { userId: 9, state: "CHANGES_REQUESTED" },
    ]);
    github.failNext(1, 404, /\/reviews\?(.*&)?page=2(&|$)/);
    try {
      expect(await protection("main", lost.at)).toEqual(pending);
      expect(
        github.apiRequests.filter(
          (one) =>
            one.path.includes(`/pulls/${lost.number}/reviews`) &&
            /[?&]page=2(&|$)/.test(one.path),
        ),
      ).toMatchObject([{ status: 404 }]);
    } finally {
      github.failNext(0, 500);
    }
  });

  test("GitHub failing is a check error, never a pass or a missing rule", async () => {
    github.setBranchRule("acme", "guarded", "main", "ruleset", 1);
    github.failNext(20, 500);
    try {
      const error = await protection("main", null).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(GitHubAppCheckError);
    } finally {
      github.failNext(0, 500);
    }
  });
});
