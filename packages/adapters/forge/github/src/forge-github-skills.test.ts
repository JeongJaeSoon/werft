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
