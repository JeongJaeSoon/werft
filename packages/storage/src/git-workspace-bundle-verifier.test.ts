import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitBundle,
  createGitBundleChain,
  type GitBundleFixture,
  verifyBundleBytes,
} from "@werft-ai/testkit/git-bundle";

import {
  createGitWorkspaceBundleVerifier,
  DEFAULT_GIT_VERIFY_TIMEOUT_MS,
  DEFAULT_MAX_GIT_MEMORY_BYTES,
  defaultGitRunner,
  GIT_BUNDLE_VERIFIER_RULES,
  GIT_TIMEOUT_EXIT_CODE,
  type GitCommandOptions,
  type GitCommandRunner,
  gitVerifyTimeoutMs,
} from "./index.ts";

let tempRoot: string;
let bundle: GitBundleFixture;

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "verifier-test-"));
  bundle = await createGitBundle();
});

afterAll(async () => {
  await rm(tempRoot, { force: true, recursive: true });
});

/**
 * Same pack, different tip: the header claims a commit the pack never
 * delivered, which is exactly what the structural verifier cannot see.
 */
function withSwappedTip(fixture: GitBundleFixture): {
  bytes: Uint8Array;
  commit: string;
} {
  const text = new TextDecoder("latin1").decode(fixture.bytes);
  const headerEnd = text.indexOf("\n\n");
  const header = text.slice(0, headerEnd);
  const commit = "1".repeat(40);
  const swapped = header.replace(fixture.commit, commit);
  expect(swapped).not.toBe(header);
  const bytes = new Uint8Array(fixture.bytes);
  bytes.set(new TextEncoder().encode(swapped), 0);
  return { bytes, commit };
}

describe("git workspace bundle verifier", () => {
  test("its policy names every limit, so the service's retry cooldown ends when one changes", () => {
    const policy = (
      options: Parameters<typeof createGitWorkspaceBundleVerifier>[0],
    ) => createGitWorkspaceBundleVerifier({ tempRoot, ...options }).policy;
    const base = policy({});
    expect(base).toBe(policy({ timeoutMs: DEFAULT_GIT_VERIFY_TIMEOUT_MS }));
    expect(policy({ timeoutMs: 1 })).not.toBe(base);
    expect(policy({ maxGitMemoryBytes: 1 })).not.toBe(base);
    expect(policy({ maxPackObjects: 1 })).not.toBe(base);
  });

  test("its version names the rules, every limit and the git that runs, and asks git once", async () => {
    const asked: string[][] = [];
    const answering =
      (stdout: string): GitCommandRunner =>
      async (args) => {
        asked.push([...args]);
        return { exitCode: 0, stderr: "", stdout };
      };
    const versionOf = (
      git: string,
      options: Parameters<typeof createGitWorkspaceBundleVerifier>[0] = {},
    ) =>
      createGitWorkspaceBundleVerifier({
        gitRunner: answering(git),
        tempRoot,
        ...options,
      }).version?.();
    const verifier = createGitWorkspaceBundleVerifier({
      gitRunner: answering("git version 2.47.1\n"),
      tempRoot,
    });
    const base = await verifier.version?.();
    expect(await verifier.version?.()).toBe(base);
    expect(asked).toEqual([["--version"]]);
    expect(JSON.parse(base ?? "null")).toEqual([
      GIT_BUNDLE_VERIFIER_RULES,
      verifier.policy,
      "git version 2.47.1",
    ]);
    expect(await versionOf("git version 2.47.1\n")).toBe(base);
    expect(await versionOf("git version 2.48.0\n")).not.toBe(base);
    expect(
      await versionOf("git version 2.47.1\n", { maxPackObjects: 1 }),
    ).not.toBe(base);
  });

  test("a git that would not say its version leaves no version, and is asked again", async () => {
    let failures = 1;
    const gitRunner: GitCommandRunner = async () =>
      failures-- > 0
        ? { exitCode: 127, stderr: "git: not found", stdout: "" }
        : { exitCode: 0, stderr: "", stdout: "git version 2.47.1\n" };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    await expect(verifier.version?.()).rejects.toThrow("git: not found");
    expect(await verifier.version?.()).toContain("git version 2.47.1");
  });

  test("the git on this host says its version", async () => {
    const version = await createGitWorkspaceBundleVerifier({
      tempRoot,
    }).version?.();
    expect(JSON.parse(version ?? "null")[2]).toMatch(/^git version \d/);
  });

  test("a bundle git wrote is restorable", async () => {
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    const verdict = await verifyBundleBytes(verifier, {
      bytes: bundle.bytes,
      commit: bundle.commit,
      key: "k",
    });
    expect(verdict).toEqual({ status: "restorable" });
  });

  test("a chain is restorable fetched in order, and its incremental bundle alone is not", async () => {
    const chain = await createGitBundleChain();
    const directory = await mkdtemp(join(tempRoot, "chain-"));
    const base = {
      bytes: chain.base.bytes.byteLength,
      key: "base",
      path: join(directory, "base.bundle"),
    };
    const tip = {
      bytes: chain.tip.bytes.byteLength,
      key: "tip",
      path: join(directory, "tip.bundle"),
    };
    await writeFile(base.path, chain.base.bytes);
    await writeFile(tip.path, chain.tip.bytes);
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });

    expect(
      await verifier.verify({
        ...tip,
        bases: [base],
        commit: chain.tip.commit,
      }),
    ).toEqual({ status: "restorable" });
    expect(
      await verifier.verify({ ...tip, commit: chain.tip.commit }),
    ).toMatchObject({ status: "unusable" });
    // The base's commit, which the chain has but the last link does not
    // check out: a restore of the last link would land somewhere else.
    expect(
      await verifier.verify({
        ...tip,
        bases: [base],
        commit: chain.base.commit,
      }),
    ).toMatchObject({
      status: "unusable",
      reason: `tip: Checkpoint bundle pins worktree ${chain.tip.commit}, not the manifest's ${chain.base.commit}`,
    });
    // The base must come first: the tip does not stand in for it.
    expect(
      await verifier.verify({
        ...base,
        bases: [tip],
        commit: chain.base.commit,
      }),
    ).toMatchObject({
      status: "unusable",
      reason: expect.stringContaining("tip: "),
    });
    await rm(directory, { force: true, recursive: true });
  });

  // The rule a restore applies (stageCheckpointBundle), so a checkpoint
  // finalize commits is one a restore checks out.
  test.each([
    [
      "without refs/checkpoint/worktree",
      ["refs/checkpoint/head", "refs/heads/main"],
      "Checkpoint bundle is missing refs/checkpoint/head or refs/checkpoint/worktree",
    ],
    [
      "with two branches",
      [
        "refs/checkpoint/head",
        "refs/checkpoint/worktree",
        "refs/heads/a",
        "refs/heads/b",
      ],
      "Checkpoint bundle carries refs a capture does not write: refs/heads/b",
    ],
    [
      "with a ref no capture writes",
      ["refs/checkpoint/head", "refs/checkpoint/worktree", "refs/tags/v1"],
      "Checkpoint bundle carries refs a capture does not write: refs/tags/v1",
    ],
  ])("a bundle %s is unusable", async (_, refs, reason) => {
    const odd = await createGitBundle({ refs });
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });

    expect(
      await verifyBundleBytes(verifier, {
        bytes: odd.bytes,
        commit: odd.commit,
        key: "k",
      }),
    ).toEqual({ status: "unusable", reason });
  });

  test("a rewritten header over a whole pack is unusable", async () => {
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    const swapped = withSwappedTip(bundle);
    const verdict = await verifyBundleBytes(verifier, { ...swapped, key: "k" });
    expect(verdict.status).toBe("unusable");
    if (verdict.status === "unusable") {
      expect(verdict.reason).toContain("git fetch failed");
    }
  });

  test("bytes that fail the structural gate never start git", async () => {
    const calls: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    const verdict = await verifyBundleBytes(verifier, {
      bytes: bundle.bytes,
      commit: "0".repeat(40),
      key: "k",
    });
    expect(verdict).toEqual({
      status: "unusable",
      reason: `git bundle does not offer ${"0".repeat(40)} as a ref tip`,
    });
    expect(calls).toEqual([]);
  });

  test("leaves no temp file or repository behind, on success or failure", async () => {
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    const before = await readdir(tempRoot);
    await verifyBundleBytes(verifier, {
      bytes: bundle.bytes,
      commit: bundle.commit,
      key: "k",
    });
    await verifyBundleBytes(verifier, { ...withSwappedTip(bundle), key: "k" });
    expect(await readdir(tempRoot)).toEqual(before);
  });

  test("git refusing the pack yields unusable, not a throw", async () => {
    const gitRunner: GitCommandRunner = async (args) =>
      args[0] === "init"
        ? { exitCode: 0, stderr: "", stdout: "" }
        : { exitCode: 128, stderr: "fatal: pack is corrupt\n", stdout: "" };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    const verdict = await verifyBundleBytes(verifier, {
      bytes: bundle.bytes,
      commit: bundle.commit,
      key: "k",
    });
    expect(verdict).toEqual({
      status: "unusable",
      reason: "git fetch failed with exit code 128: fatal: pack is corrupt",
    });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("an object size wider than git's size_t is a limit of that git, not a verdict", async () => {
    // What CI's git printed for a raised object count. A 32-bit
    // git says the same of a valid object over 4 GiB, so it is retried.
    const stderr =
      "fatal: object size too large for this platform\nerror: index-pack died\n";
    const gitRunner: GitCommandRunner = async (args) =>
      args[0] === "init"
        ? { exitCode: 0, stderr: "", stdout: "" }
        : { exitCode: 1, stderr, stdout: "" };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    const error = await verifyBundleBytes(verifier, {
      bytes: bundle.bytes,
      commit: bundle.commit,
      key: "k",
    }).then(
      () => undefined,
      (thrown: Error) => thrown,
    );
    // Named as a host fault, not as wording this code does not know.
    expect(error?.message).toBe(
      `git fetch failed with exit code 1: ${stderr.trim()}`,
    );
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("a runner that cannot start git throws, and still cleans up", async () => {
    const gitRunner: GitCommandRunner = async () => {
      throw new Error("spawn git ENOENT");
    };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    await expect(
      verifyBundleBytes(verifier, {
        bytes: bundle.bytes,
        commit: bundle.commit,
        key: "k",
      }),
    ).rejects.toThrow("spawn git ENOENT");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("a repository that will not initialise is a fault, not a verdict", async () => {
    const gitRunner: GitCommandRunner = async () => ({
      exitCode: 128,
      stderr: "fatal: cannot mkdir: No space left on device\n",
      stdout: "",
    });
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    await expect(
      verifyBundleBytes(verifier, {
        bytes: bundle.bytes,
        commit: bundle.commit,
        key: "k",
      }),
    ).rejects.toThrow("git init failed with exit code 128");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("a temp root that cannot be written throws instead of rejecting the bundle", async () => {
    const verifier = createGitWorkspaceBundleVerifier({
      tempRoot: join(tempRoot, "missing"),
    });
    await expect(
      verifyBundleBytes(verifier, {
        bytes: bundle.bytes,
        commit: bundle.commit,
        key: "k",
      }),
    ).rejects.toThrow("ENOENT");
  });

  test("git dying on the host rather than on the pack throws", async () => {
    for (const stderr of [
      "fatal: unable to write pack: No space left on device\n",
      "fatal: write error: Disk quota exceeded\n",
      "fatal: cannot fork() for git index-pack: Resource temporarily unavailable\n",
      "error: unable to open object pack directory: repo.git/objects/pack: Permission denied\nfatal: index-pack failed\n",
      "error: something this code has never seen\n",
    ]) {
      const gitRunner: GitCommandRunner = async (args) =>
        args[0] === "init"
          ? { exitCode: 0, stderr: "", stdout: "" }
          : { exitCode: 128, stderr, stdout: "" };
      const verifier = createGitWorkspaceBundleVerifier({
        gitRunner,
        tempRoot,
      });
      await expect(
        verifyBundleBytes(verifier, {
          bytes: bundle.bytes,
          commit: bundle.commit,
          key: "k",
        }),
      ).rejects.toThrow(stderr.trim().split("\n")[0] as string);
      expect(await readdir(tempRoot)).toEqual([]);
    }
  });

  test("a git killed by someone else's signal throws", async () => {
    const gitRunner: GitCommandRunner = async (args) =>
      args[0] === "init"
        ? { exitCode: 0, stderr: "", stdout: "" }
        : { exitCode: 128, signal: "SIGKILL", stderr: "", stdout: "" };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    await expect(
      verifyBundleBytes(verifier, {
        bytes: bundle.bytes,
        commit: bundle.commit,
        key: "k",
      }),
    ).rejects.toThrow("git fetch was killed by SIGKILL");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("an inherited alternate object store cannot vouch for a commit the pack lacks", async () => {
    // A second repository holds a commit the bundle never carried; with the
    // host's GIT_ALTERNATE_OBJECT_DIRECTORIES pointing at it, git would find
    // the commit there and the connectivity check would pass.
    const other = await createGitBundle({ message: "elsewhere" });
    const alternate = await mkdtemp(join(tempRoot, "alternate-"));
    await defaultGitRunner(["init", "--quiet", "--bare", "."], {
      cwd: alternate,
      env: {},
    });
    await writeFile(join(alternate, "other.bundle"), other.bytes);
    const unbundle = await defaultGitRunner(
      [
        "-c",
        "maintenance.auto=false",
        "fetch",
        "--quiet",
        "--no-tags",
        "other.bundle",
        `${other.ref}:refs/other`,
      ],
      { cwd: alternate, env: {} },
    );
    expect(unbundle.exitCode).toBe(0);
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const header = text.slice(0, text.indexOf("\n\n"));
    const bytes = new Uint8Array(bundle.bytes);
    bytes.set(
      new TextEncoder().encode(header.replace(bundle.commit, other.commit)),
      0,
    );
    const previous = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = join(alternate, "objects");
    try {
      const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
      const verdict = await verifyBundleBytes(verifier, {
        bytes,
        commit: other.commit,
        key: "k",
      });
      expect(verdict.status).toBe("unusable");
    } finally {
      if (previous === undefined) {
        delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      } else {
        process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = previous;
      }
      await rm(alternate, { force: true, recursive: true });
    }
  });

  test("a ref name git would refuse never reaches a refspec or stderr", async () => {
    for (const ref of [
      "refs/heads/permission denied",
      "refs/heads/main.",
      "refs/heads/main.lock",
      "refs/heads/.hidden",
      "refs/heads/a..b",
      "refs/heads/a@{b",
      "refs/heads/a~b",
      "refs/heads/a^b",
      "refs/heads/a:b",
      "refs/heads/a?b",
      "refs/heads/a*b",
      "refs/heads/a[b",
      "refs/heads/a\\b",
      "refs/heads/a\u0007b",
      "refs/heads//b",
      "refs/heads/",
      "main",
    ]) {
      const text = new TextDecoder("latin1").decode(bundle.bytes);
      const headerEnd = text.indexOf("\n\n");
      const header = text.slice(0, headerEnd).replace(bundle.ref, ref);
      const bytes = new Uint8Array(
        Buffer.concat([
          Buffer.from(header, "utf8"),
          bundle.bytes.subarray(headerEnd),
        ]),
      );
      const calls: string[][] = [];
      const gitRunner: GitCommandRunner = async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      const verifier = createGitWorkspaceBundleVerifier({
        gitRunner,
        tempRoot,
      });
      const verdict = await verifyBundleBytes(verifier, {
        bytes,
        commit: bundle.commit,
        key: "k",
      });
      expect(verdict).toEqual({
        status: "unusable",
        reason: `git bundle ref name is not one git would accept: ${JSON.stringify(ref)}`,
      });
      expect(calls).toEqual([]);
    }
  });

  test("ref names git bundles actually write pass the gate", async () => {
    for (const ref of [
      "refs/heads/main",
      "refs/heads/feature/x-1.2_y",
      "refs/heads/feature+foo",
      "refs/heads/기능/한글",
      "refs/heads/a@b#c=d,e;f",
      "refs/tags/v1.0.0",
      "HEAD",
    ]) {
      const text = new TextDecoder("latin1").decode(bundle.bytes);
      const headerEnd = text.indexOf("\n\n");
      const header = text.slice(0, headerEnd).replace(bundle.ref, ref);
      const bytes = new Uint8Array(
        Buffer.concat([
          Buffer.from(header, "utf8"),
          bundle.bytes.subarray(headerEnd),
        ]),
      );
      const calls: string[][] = [];
      const gitRunner: GitCommandRunner = async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      const verifier = createGitWorkspaceBundleVerifier({
        gitRunner,
        tempRoot,
      });
      await verifyBundleBytes(verifier, {
        bytes,
        commit: bundle.commit,
        key: "k",
      });
      expect(calls.map((args) => args[0])).toEqual([
        "init",
        "-c",
        "for-each-ref",
      ]);
    }
  });

  test("a filtered bundle is refused before git and by git alike", async () => {
    const source = await mkdtemp(join(tempRoot, "filtered-"));
    const env = {
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_AUTHOR_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
    };
    const run = async (...args: string[]) => {
      const result = await defaultGitRunner(args, { cwd: source, env });
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    };
    await run("init", "--quiet", "--initial-branch=main", ".");
    await writeFile(join(source, "file.txt"), "x\n");
    await run("add", "file.txt");
    await run("commit", "--quiet", "-m", "c");
    const commit = await run("rev-parse", "HEAD");
    const path = join(source, "filtered.bundle");
    await run(
      "bundle",
      "create",
      "--version=3",
      path,
      "--filter=blob:none",
      "main",
    );
    const bytes = new Uint8Array(await readFile(path));
    await rm(source, { force: true, recursive: true });

    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    expect(
      await verifyBundleBytes(verifier, { bytes, commit, key: "k" }),
    ).toEqual({
      status: "unusable",
      reason:
        "git bundle is filtered (filter=blob:none) and omits objects a restore needs",
    });
    // The gate exists for older or differently configured gits; this one
    // refuses the same pack on its own, which is what the gate stands in for.
    const repository = await mkdtemp(join(tempRoot, "repo-"));
    await defaultGitRunner(["init", "--quiet", "--bare", "."], {
      cwd: repository,
      env: {},
    });
    await writeFile(join(repository, "f.bundle"), bytes);
    const fetch = await defaultGitRunner(
      [
        "-c",
        "maintenance.auto=false",
        "fetch",
        "--quiet",
        "--no-tags",
        "f.bundle",
        "refs/heads/main:refs/verify/tip",
      ],
      { cwd: repository, env: {} },
    );
    await rm(repository, { force: true, recursive: true });
    expect(fetch.exitCode).not.toBe(0);
    expect(fetch.stderr).toContain("did not send all necessary objects");
  });

  test("a bundle recorded against HEAD, as `git bundle create … HEAD` writes it, is not a checkpoint a restore checks out", async () => {
    const source = await mkdtemp(join(tempRoot, "head-"));
    const env = {
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_AUTHOR_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
    };
    const run = async (...args: string[]) => {
      const result = await defaultGitRunner(args, { cwd: source, env });
      expect(result.exitCode).toBe(0);
      return result.stdout.trim();
    };
    await run("init", "--quiet", "--initial-branch=main", ".");
    await writeFile(join(source, "file.txt"), "x\n");
    await run("add", "file.txt");
    await run("commit", "--quiet", "-m", "c");
    const commit = await run("rev-parse", "HEAD");
    const path = join(source, "head.bundle");
    await run("bundle", "create", path, "HEAD");
    const bytes = new Uint8Array(await readFile(path));
    await rm(source, { force: true, recursive: true });
    expect(new TextDecoder("latin1").decode(bytes.subarray(0, 80))).toContain(
      `${commit} HEAD`,
    );

    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    expect(
      await verifyBundleBytes(verifier, { bytes, commit, key: "k" }),
    ).toEqual({
      status: "unusable",
      reason: "Checkpoint bundle carries refs a capture does not write: HEAD",
    });
  });

  test("a pack padded after its objects, with the trailer recomputed, is refused by git and reported as unusable", async () => {
    // Passes every byte-level check: the header is intact and the trailing
    // sha1 covers the padded body. Only index-pack notices.
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const packOffset = text.indexOf("\n\n") + 2;
    const body = Buffer.concat([
      bundle.bytes.subarray(packOffset, bundle.bytes.byteLength - 20),
      Buffer.from("JUNKJUNK"),
    ]);
    const bytes = new Uint8Array(
      Buffer.concat([
        bundle.bytes.subarray(0, packOffset),
        body,
        createHash("sha1").update(body).digest(),
      ]),
    );
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    const verdict = await verifyBundleBytes(verifier, {
      bytes,
      commit: bundle.commit,
      key: "k",
    });
    expect(verdict.status).toBe("unusable");
    if (verdict.status === "unusable") {
      expect(verdict.reason).toContain("git fetch failed");
    }
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("a pack whose object count was raised, with the trailer recomputed, is never restorable", async () => {
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const packOffset = text.indexOf("\n\n") + 2;
    const body = Buffer.from(
      bundle.bytes.subarray(packOffset, bundle.bytes.byteLength - 20),
    );
    body.writeUInt32BE(body.readUInt32BE(8) + 1, 8);
    const bytes = new Uint8Array(
      Buffer.concat([
        bundle.bytes.subarray(0, packOffset),
        body,
        createHash("sha1").update(body).digest(),
      ]),
    );
    // index-pack reads the recomputed trailer as the missing object, so what
    // it says depends on those twenty bytes, which differ with every fixture:
    // usually a premature end of the pack (unusable), but git 2.47 on Linux
    // sometimes aborts on `BUG: git-zlib.c:58: total_in mismatch` instead
    // ("index-pack died of signal 6"), where the bytes declare a huge object
    // the memory cap refuses the allocation ("Out of memory"), and where
    // the size header runs past size_t index-pack stops there ("object size
    // too large for this platform", ). All three are retryable throws.
    const verifier = createGitWorkspaceBundleVerifier({ tempRoot });
    const outcome = await verifyBundleBytes(verifier, {
      bytes,
      commit: bundle.commit,
      key: "k",
    }).then(
      (verdict) => verdict.status,
      (error: Error) => error.message,
    );
    expect(outcome).not.toBe("restorable");
    if (outcome !== "unusable") {
      expect(outcome).toMatch(
        /died of signal|Out of memory|too large for this platform/,
      );
    }
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("a pack declaring more objects than the ceiling is refused before git", async () => {
    const text = new TextDecoder("latin1").decode(bundle.bytes);
    const packOffset = text.indexOf("\n\n") + 2;
    const body = Buffer.from(
      bundle.bytes.subarray(packOffset, bundle.bytes.byteLength - 20),
    );
    body.writeUInt32BE(5_000_000, 8);
    const bytes = new Uint8Array(
      Buffer.concat([
        bundle.bytes.subarray(0, packOffset),
        body,
        createHash("sha1").update(body).digest(),
      ]),
    );
    const calls: string[][] = [];
    const gitRunner: GitCommandRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const verifier = createGitWorkspaceBundleVerifier({ gitRunner, tempRoot });
    expect(
      await verifyBundleBytes(verifier, {
        bytes,
        commit: bundle.commit,
        key: "k",
      }),
    ).toEqual({
      status: "unusable",
      reason:
        "git bundle declares 5000000 objects, over the 1000000 the control plane will index",
    });
    expect(calls).toEqual([]);
  });

  test("a git that outlives the timeout is killed and reported as a fault, not a verdict", async () => {
    // A stand-in git on PATH that never returns is the one way to make the
    // real runner wait; the init call still runs the real binary.
    const bin = join(tempRoot, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), "#!/bin/sh\n/bin/sleep 30\n", {
      mode: 0o755,
    });
    const verifier = createGitWorkspaceBundleVerifier({
      gitRunner: async (args, options) =>
        args[0] === "init"
          ? defaultGitRunner(args, options)
          : defaultGitRunner(args, {
              ...options,
              env: { ...options.env, PATH: bin },
              timeoutMs: 200,
            }),
      tempRoot,
    });
    const started = Date.now();
    await expect(
      verifyBundleBytes(verifier, {
        bytes: bundle.bytes,
        commit: bundle.commit,
        key: "k",
      }),
    ).rejects.toThrow(
      `git fetch failed with exit code ${GIT_TIMEOUT_EXIT_CODE}: git exceeded 200ms`,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    await rm(bin, { force: true, recursive: true });
    expect(await readdir(tempRoot)).toEqual([]);
  });

  test("every git call runs under the limits, sized from the bundle", async () => {
    const calls: { args: readonly string[]; options: GitCommandOptions }[] = [];
    const verifier = createGitWorkspaceBundleVerifier({
      gitRunner: async (args, options) => {
        calls.push({ args, options });
        return defaultGitRunner(args, options);
      },
      tempRoot,
    });
    expect(
      await verifyBundleBytes(verifier, {
        bytes: bundle.bytes,
        commit: bundle.commit,
        key: "k",
      }),
    ).toEqual({ status: "restorable" });
    expect(calls.map((call) => call.args[0])).toEqual([
      "init",
      "-c",
      "for-each-ref",
      "rev-list",
    ]);
    for (const { options } of calls) {
      expect(options.limits).toEqual({
        cpuSeconds: DEFAULT_GIT_VERIFY_TIMEOUT_MS / 1000,
        // Three objects: the index outweighs a bundle this small.
        fileSizeBytes: 1024 + 3 * 40 + 1024 * 1024,
        memoryBytes: DEFAULT_MAX_GIT_MEMORY_BYTES,
      });
      const { TMPDIR } = options.env;
      expect(TMPDIR?.startsWith(join(tempRoot, "bundle-verify-"))).toBe(true);
    }
    expect(calls[1]?.args.join(" ")).toContain("-c pack.threads=1");
  });

  test("the timeout and CPU limit grow with the bundle above the reference size", async () => {
    const MiB = 1024 * 1024;
    expect(gitVerifyTimeoutMs(0)).toBe(DEFAULT_GIT_VERIFY_TIMEOUT_MS);
    expect(gitVerifyTimeoutMs(256 * MiB)).toBe(60_000);
    expect(gitVerifyTimeoutMs(512 * MiB)).toBe(120_000);
    expect(gitVerifyTimeoutMs(1024 * MiB)).toBe(240_000);
    // The floor is the configured timeout, however small the bundle.
    expect(gitVerifyTimeoutMs(1, 90_000)).toBe(90_000);

    // What the verifier hands git for a bundle the service says is 512 MiB.
    const seen: GitCommandOptions[] = [];
    const verifier = createGitWorkspaceBundleVerifier({
      gitRunner: async (args, options) => {
        seen.push(options);
        return defaultGitRunner(args, options);
      },
      tempRoot,
    });
    // Outside `tempRoot`, which other tests expect the verifier to leave empty.
    const directory = await mkdtemp(join(tmpdir(), "verifier-budget-"));
    try {
      const path = join(directory, "workspace.bundle");
      await writeFile(path, bundle.bytes);
      await verifier.verify({
        bytes: 512 * MiB,
        commit: bundle.commit,
        key: "k",
        path,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const options of seen) {
      expect(options.timeoutMs).toBe(120_000);
      expect(options.limits?.cpuSeconds).toBe(120);
    }
  });

  test("a git or helper stopped by a resource limit throws, never unusable", async () => {
    // What git 2.47 on Linux prints when prlimit's caps bite: RLIMIT_AS as
    // index-pack's malloc failure, RLIMIT_FSIZE and RLIMIT_CPU as its death
    // by SIGXFSZ (25) or SIGKILL (9) reported by fetch.
    for (const stderr of [
      "fatal: Out of memory, malloc failed (tried to allocate 503316546 bytes)\nerror: index-pack died\n",
      "error: index-pack died of signal 25\nerror: index-pack died\n",
      "error: index-pack died of signal 9\nerror: index-pack died\n",
    ]) {
      const gitRunner: GitCommandRunner = async (args) =>
        args[0] === "init"
          ? { exitCode: 0, stderr: "", stdout: "" }
          : { exitCode: 1, stderr, stdout: "" };
      const verifier = createGitWorkspaceBundleVerifier({
        gitRunner,
        tempRoot,
      });
      await expect(
        verifyBundleBytes(verifier, {
          bytes: bundle.bytes,
          commit: bundle.commit,
          key: "k",
        }),
      ).rejects.toThrow(stderr.trim().split("\n")[0] as string);
      expect(await readdir(tempRoot)).toEqual([]);
    }
    // A helper killed after it had already complained is still a kill: the
    // complaint is not the reason git stopped.
    const complainedThenKilled = createGitWorkspaceBundleVerifier({
      gitRunner: async (args) =>
        args[0] === "init"
          ? { exitCode: 0, stderr: "", stdout: "" }
          : {
              exitCode: 1,
              stderr:
                "error: object 1234: badDate: invalid author/committer line - bad date\nerror: index-pack died of signal 25\nerror: index-pack died\n",
              stdout: "",
            },
      tempRoot,
    });
    await expect(
      verifyBundleBytes(complainedThenKilled, {
        bytes: bundle.bytes,
        commit: bundle.commit,
        key: "k",
      }),
    ).rejects.toThrow("died of signal 25");
    // The limit hitting git itself rather than a helper.
    for (const signal of ["SIGXFSZ", "SIGXCPU", "SIGKILL"]) {
      const verifier = createGitWorkspaceBundleVerifier({
        gitRunner: async (args) =>
          args[0] === "init"
            ? { exitCode: 0, stderr: "", stdout: "" }
            : { exitCode: 128, signal, stderr: "", stdout: "" },
        tempRoot,
      });
      await expect(
        verifyBundleBytes(verifier, {
          bytes: bundle.bytes,
          commit: bundle.commit,
          key: "k",
        }),
      ).rejects.toThrow(`git fetch was killed by ${signal}`);
    }
  });

  test("a bundle cannot pass its refusal off as a killed helper by echoing the words", async () => {
    // fsck quotes a rejected `.gitmodules` URL, and a config value can carry
    // an escaped newline, so the words can even start a line of their own.
    for (const echoed of [
      "error: object 1234: gitmodulesUrl: disallowed submodule url: -died of signal\n",
      "error: object 1234: gitmodulesUrl: disallowed submodule url: -x\nerror: index-pack died of signal 9\n",
    ]) {
      const verifier = createGitWorkspaceBundleVerifier({
        gitRunner: async (args) =>
          args[0] === "init"
            ? { exitCode: 0, stderr: "", stdout: "" }
            : {
                exitCode: 1,
                stderr: `${echoed}fatal: fsck error in packed object\nerror: index-pack died\n`,
                stdout: "",
              },
        tempRoot,
      });
      const verdict = await verifyBundleBytes(verifier, {
        bytes: bundle.bytes,
        commit: bundle.commit,
        key: "k",
      });
      expect(verdict.status).toBe("unusable");
    }
  });

  test("output cut short is not classified, even when what survived reads as a refusal", async () => {
    const verifier = createGitWorkspaceBundleVerifier({
      gitRunner: async (args) =>
        args[0] === "init"
          ? { exitCode: 0, stderr: "", stdout: "" }
          : {
              exitCode: 128,
              stderr: "error: object 1234: fsck error in packed object\n",
              stdout: "",
              truncated: true,
            },
      tempRoot,
    });
    await expect(
      verifyBundleBytes(verifier, {
        bytes: bundle.bytes,
        commit: bundle.commit,
        key: "k",
      }),
    ).rejects.toThrow("output cut short");
  });

  test.skipIf(process.platform !== "linux")(
    "on Linux an object bigger than the memory cap kills index-pack and throws",
    async () => {
      // Incompressible, so the bundle stays as big as the object and
      // index-pack has to hold all of it at once.
      const big = await createGitBundle({
        contents: new Uint8Array(randomBytes(16 * 1024 * 1024)),
      });
      const capped = createGitWorkspaceBundleVerifier({
        maxGitMemoryBytes: 16 * 1024 * 1024,
        tempRoot,
      });
      await expect(
        verifyBundleBytes(capped, {
          bytes: big.bytes,
          commit: big.commit,
          key: "k",
        }),
      ).rejects.toThrow("Out of memory");
      expect(await readdir(tempRoot)).toEqual([]);
      // Same bundle, default cap: the limit, not the bundle, was the cause.
      const roomy = createGitWorkspaceBundleVerifier({ tempRoot });
      expect(
        await verifyBundleBytes(roomy, {
          bytes: big.bytes,
          commit: big.commit,
          key: "k",
        }),
      ).toEqual({ status: "restorable" });
    },
    60_000,
  );
});
