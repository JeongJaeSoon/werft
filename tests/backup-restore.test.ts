import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
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
  captureWorkspace,
  DEFAULT_WORKSPACE_CAPTURE_LIMITS,
  type WorkspaceCapture,
} from "../apps/worker/src/workspace-capture.ts";
import { backupPath } from "../scripts/lib/checkpoint-pins.ts";

/**
 * The refusal paths of scripts/restore.sh, exercised without Docker: the
 * schema gate compares a backup's applied migration list (as the drizzle
 * journal recorded it) with this checkout's migration files, and a bundle
 * whose checksums do not match its SHA256SUMS is refused before that. The
 * compose round trip itself is the E2E recorded on the PR.
 */

const repoRoot = join(import.meta.dir, "..");
const lib = join(repoRoot, "scripts/lib/backup-lib.sh");

type Journal = { entries: { tag: string; when: number }[] };

async function checkoutMigrations() {
  const journal = JSON.parse(
    await readFile(
      join(repoRoot, "packages/db/migrations/meta/_journal.json"),
      "utf8",
    ),
  ) as Journal;
  return Promise.all(
    journal.entries.map(async (entry) => ({
      hash: createHash("sha256")
        .update(
          await readFile(
            join(repoRoot, "packages/db/migrations", `${entry.tag}.sql`),
          ),
        )
        .digest("hex"),
      when: String(entry.when),
      tag: entry.tag,
    })),
  );
}

async function bash(
  script: string,
  cwd: string,
  env: Record<string, string> = {},
) {
  const handle = Bun.spawn(["bash", "-c", script], {
    cwd,
    env: { ...process.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    handle.exited,
    new Response(handle.stderr).text(),
    new Response(handle.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function withManifest(
  applied: { hash: string; when: string }[],
  run: (dir: string, manifest: string) => Promise<void>,
  version = 1,
  objects: Record<string, unknown> = { bucket: "claude-sessions", count: 0 },
) {
  const dir = await mkdtemp(join(tmpdir(), "backup-restore-"));
  try {
    const manifest = join(dir, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        version,
        schema: { head_tag: "fixture", applied },
        objects,
        repos: { bundled: [], empty: [] },
        source: { project: "fixture" },
      }),
    );
    await run(dir, manifest);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

const schemaCheck = (manifest: string) =>
  bash(`source "${lib}"; schema_check "${manifest}"`, repoRoot);

describe("restore schema gate", () => {
  test("expected_migrations lists the checkout's journal with drizzle's hashes", async () => {
    const expected = await checkoutMigrations();
    const result = await bash(`source "${lib}"; expected_migrations`, repoRoot);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(
      expected.map((entry) => `${entry.hash} ${entry.when} ${entry.tag}`),
    );
  });

  test("accepts a backup whose applied list is exactly this checkout's", async () => {
    await withManifest(await checkoutMigrations(), async (_dir, manifest) => {
      const result = await schemaCheck(manifest);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("backup matches checkout head");
    });
  });

  test("refuses a backup with one migration's hash changed", async () => {
    const applied = await checkoutMigrations();
    const last = applied.at(-1);
    if (!last) throw new Error("no migrations");
    applied[applied.length - 1] = { ...last, hash: "0".repeat(64) };
    await withManifest(applied, async (_dir, manifest) => {
      const result = await schemaCheck(manifest);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("differ from this checkout");
    });
  });

  test("refuses an older backup missing the newest migration", async () => {
    const applied = (await checkoutMigrations()).slice(0, -1);
    await withManifest(applied, async (_dir, manifest) => {
      expect((await schemaCheck(manifest)).exitCode).toBe(3);
    });
  });

  test("refuses a newer backup carrying a migration this checkout lacks", async () => {
    const applied = await checkoutMigrations();
    applied.push({ hash: "f".repeat(64), when: "1999999999999", tag: "x" });
    await withManifest(applied, async (_dir, manifest) => {
      expect((await schemaCheck(manifest)).exitCode).toBe(3);
    });
  });

  test("refuses a manifest of another format version", async () => {
    await withManifest(
      await checkoutMigrations(),
      async (_dir, manifest) => {
        expect((await schemaCheck(manifest)).exitCode).toBe(3);
      },
      2,
    );
  });
});

describe("a new backup's manifest", () => {
  const manifest = async () => {
    const result = await bash(
      `source "${lib}"
       docker() { return 0; }
       PROJECT=fixture PG_VERSION=16 HEAD_TAG=fixture PG_DB=sessions PG_USER=postgres
       BUCKET=claude-sessions ENDPOINT= OBJECT_COUNT=0 APPLIED_JSON='[]'
       IMAGES_JSON="$(manifest_images fixture)"
       backup_manifest`,
      repoRoot,
    );
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };

  test("names no git host, its repositories or its image", async () => {
    const written = await manifest();
    expect(Object.keys(written).sort()).toEqual([
      "created_at",
      "db",
      "images",
      "objects",
      "schema",
      "source",
      "version",
    ]);
    expect(Object.keys(written.images as object).sort()).toEqual([
      "api",
      "egress-proxy",
      "localstack",
      "postgres",
      "scheduler",
      "worker",
    ]);
  });
});

describe("restore.sh on an older manifest v1", () => {
  const restoreManifest = async (
    fields: Record<string, unknown>,
    run: (result: Awaited<ReturnType<typeof bash>>) => void,
  ) => {
    const dir = await mkdtemp(join(tmpdir(), "backup-restore-gitea-"));
    const bin = await mkdtemp(join(tmpdir(), "backup-restore-bin-"));
    try {
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({
          version: 1,
          schema: {
            head_tag: "fixture",
            applied: await checkoutMigrations(),
          },
          objects: { bucket: "claude-sessions", count: 0 },
          source: { project: "fixture", checkout_commit: "abc1234" },
          ...fields,
        }),
      );
      await bash(`source "${lib}"; write_checksums "${dir}"`, repoRoot);
      // An empty docker: no project exists, so --check-only runs to its end.
      await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      run(
        await bash(
          `PATH="${bin}:$PATH" scripts/restore.sh "${dir}" --into backup-restore-test --check-only`,
          repoRoot,
        ),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
      await rm(bin, { force: true, recursive: true });
    }
  };

  // One with Gitea data used to be refused with exit 3; its gitea/ and repos/
  // are not read now.
  test.each([
    [
      "Gitea data",
      {
        gitea: { version: "Gitea version 1.22", dir: "gitea" },
        repos: { bundled: [], empty: [], dir: "repos" },
      },
    ],
    ["`gitea: null`", { gitea: null, repos: { bundled: [], empty: [] } }],
    ["no `gitea` at all", {}],
  ])(
    "takes one with %s",
    async (_name, fields) => {
      await restoreManifest(fields, (result) => {
        expect(result.stderr).not.toContain("Gitea");
        expect(result.stderr).toContain("backup matches checkout head");
        expect(result.stderr).toContain("checks passed");
        expect(result.exitCode).toBe(0);
      });
    },
    30_000,
  );
});

describe("restore.sh preflight", () => {
  test("refuses a bundle whose files no longer match SHA256SUMS", async () => {
    await withManifest(await checkoutMigrations(), async (dir) => {
      await writeFile(join(dir, "db.sql"), "-- dump\n");
      const wrote = await bash(
        `source "${lib}"; write_checksums "${dir}" && verify_checksums "${dir}"`,
        repoRoot,
      );
      expect(wrote.exitCode).toBe(0);
      await writeFile(join(dir, "db.sql"), "-- edited\n");
      const result = await bash(
        `scripts/restore.sh "${dir}" --into backup-restore-test --check-only`,
        repoRoot,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SHA256SUMS mismatch");
    });
  });

  test("refuses a bundle with a file SHA256SUMS does not list", async () => {
    await withManifest(await checkoutMigrations(), async (dir) => {
      await bash(`source "${lib}"; write_checksums "${dir}"`, repoRoot);
      await writeFile(join(dir, "repos-extra.bundle"), "not listed\n");
      const result = await bash(
        `scripts/restore.sh "${dir}" --into backup-restore-test --check-only`,
        repoRoot,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("files present differ from SHA256SUMS");
    });
  });

  test("checks the schema before touching docker", async () => {
    const applied = (await checkoutMigrations()).slice(0, -1);
    await withManifest(applied, async (dir) => {
      await bash(`source "${lib}"; write_checksums "${dir}"`, repoRoot);
      const result = await bash(
        `PATH=/nonexistent:$PATH scripts/restore.sh "${dir}" --into backup-restore-test --check-only`,
        repoRoot,
      );
      expect(result.exitCode).toBe(3);
    });
  });

  test("rejects a project name compose could not scope volumes by", async () => {
    await withManifest(await checkoutMigrations(), async (dir) => {
      await bash(`source "${lib}"; write_checksums "${dir}"`, repoRoot);
      const result = await bash(
        `scripts/restore.sh "${dir}" --into "Bad Name" --check-only`,
        repoRoot,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("project name must match");
    });
  });
});

type FakeBucket = {
  readonly deleteMarkers?: number;
  readonly encryption?: string;
  readonly objectLock?: boolean;
  readonly retention?: boolean;
  readonly versioning?: "Enabled" | "Suspended";
  readonly versions?: number;
};

/**
 * Just enough of S3 for `check-target`, over HTTP so the production adapter
 * talks to it unchanged: the bucket's versioning, Object Lock and default
 * encryption, and its version listing. Anything else is answered 501 and
 * recorded, so a test can tell that nothing was written.
 */
function fakeS3(buckets: Record<string, FakeBucket>) {
  const requests: string[] = [];
  const xml = (body: string, status = 200) =>
    new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
      headers: { "content-type": "application/xml" },
      status,
    });
  const notFound = (code: string) =>
    xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, 404);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      const bucket = buckets[url.pathname.split("/")[1] ?? ""];
      if (request.method !== "GET" || bucket === undefined) {
        return new Response("not implemented", { status: 501 });
      }
      const ns = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"';
      if (url.searchParams.has("versioning")) {
        return xml(
          `<VersioningConfiguration ${ns}>${bucket.versioning ? `<Status>${bucket.versioning}</Status>` : ""}</VersioningConfiguration>`,
        );
      }
      if (url.searchParams.has("object-lock")) {
        return bucket.objectLock
          ? xml(
              `<ObjectLockConfiguration ${ns}><ObjectLockEnabled>Enabled</ObjectLockEnabled>${bucket.retention ? "<Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>1</Days></DefaultRetention></Rule>" : ""}</ObjectLockConfiguration>`,
            )
          : notFound("ObjectLockConfigurationNotFoundError");
      }
      if (url.searchParams.has("encryption")) {
        return bucket.encryption
          ? xml(
              `<ServerSideEncryptionConfiguration ${ns}><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>${bucket.encryption}</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`,
            )
          : notFound("ServerSideEncryptionConfigurationNotFoundError");
      }
      if (url.searchParams.has("versions")) {
        const entry = (tag: string, index: number) =>
          `<${tag}><Key>sessions/s/${tag}-${index}</Key><VersionId>v${index}</VersionId><IsLatest>true</IsLatest></${tag}>`;
        return xml(
          `<ListVersionsResult ${ns}><Name>b</Name><IsTruncated>false</IsTruncated>${Array.from(
            { length: bucket.versions ?? 0 },
            (_, i) => entry("Version", i),
          ).join("")}${Array.from(
            { length: bucket.deleteMarkers ?? 0 },
            (_, i) => entry("DeleteMarker", i),
          ).join("")}</ListVersionsResult>`,
        );
      }
      return new Response("not implemented", { status: 501 });
    },
  });
  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

const LOCKED: FakeBucket = {
  encryption: "AES256",
  objectLock: true,
  versioning: "Enabled",
};

describe("restore target bucket (--object-store env)", () => {
  let s3: ReturnType<typeof fakeS3>;

  beforeEach(() => {
    s3 = fakeS3({
      "claude-sessions": { ...LOCKED, versions: 3 },
      fresh: LOCKED,
      "has-marker": { ...LOCKED, deleteMarkers: 1 },
      "has-version": { ...LOCKED, versions: 1 },
      "no-lock": { encryption: "AES256", versioning: "Enabled" },
      retained: { ...LOCKED, retention: true },
    });
  });

  afterEach(() => s3.stop());

  const storeEnv = () => ({
    AWS_ACCESS_KEY_ID: "fixture-key-id",
    AWS_ENDPOINT_URL: s3.endpoint,
    AWS_REGION: "ap-northeast-1",
    AWS_SECRET_ACCESS_KEY: "fixture-key",
  });

  /** restore.sh --check-only into `bucket`, from a backup of `objects`. */
  async function restoreInto(
    bucket: string | undefined,
    objects: Record<string, unknown>,
  ) {
    let result: Awaited<ReturnType<typeof bash>> | undefined;
    await withManifest(
      await checkoutMigrations(),
      async (dir) => {
        await bash(`source "${lib}"; write_checksums "${dir}"`, repoRoot);
        result = await bash(
          `scripts/restore.sh "${dir}" --into backup-restore-test --check-only --object-store env${bucket === undefined ? "" : ` --bucket ${bucket}`}`,
          repoRoot,
          storeEnv(),
        );
      },
      1,
      objects,
    );
    if (result === undefined) throw new Error("restore.sh did not run");
    return result;
  }

  const writes = () =>
    s3.requests.filter((request) => !request.startsWith("GET "));

  test("refuses the bucket the backup was taken from, before asking the store anything", async () => {
    const result = await restoreInto("claude-sessions", {
      bucket: "claude-sessions",
      count: 0,
      endpoint: s3.endpoint.replace("127.0.0.1", "localhost"),
    });
    expect(result.stderr).toContain(
      "has the source installation's bucket name; restore only into a new, empty bucket of another name",
    );
    expect(result.exitCode).toBe(4);
    expect(s3.requests).toEqual([]);
  }, 30_000);

  test("the source's bucket name is refused at another endpoint too", async () => {
    const result = await restoreInto("claude-sessions", {
      bucket: "claude-sessions",
      count: 0,
      endpoint: "https://s3.ap-northeast-1.amazonaws.com",
    });
    expect(result.exitCode).toBe(4);
    expect(s3.requests).toEqual([]);
  }, 30_000);

  test("refuses a bucket with one delete marker, writing nothing", async () => {
    const result = await restoreInto("has-marker", {
      bucket: "claude-sessions",
      count: 0,
      endpoint: "http://127.0.0.1:4566",
    });
    expect(result.stderr).toContain(
      "bucket has-marker is not empty (it has object versions or delete markers)",
    );
    expect(result.exitCode).toBe(4);
    expect(
      s3.requests.some((r) => /^GET \/has-marker\/\?.*\bversions=/.test(r)),
    ).toBe(true);
    expect(writes()).toEqual([]);
  }, 30_000);

  test("refuses a bucket with one object version, writing nothing", async () => {
    const result = await restoreInto("has-version", {
      bucket: "claude-sessions",
      count: 0,
      endpoint: "http://127.0.0.1:4566",
    });
    expect(result.stderr).toContain("bucket has-version is not empty");
    expect(result.exitCode).toBe(4);
    expect(writes()).toEqual([]);
  }, 30_000);

  test("refuses a bucket without Object Lock", async () => {
    const result = await restoreInto("no-lock", {
      bucket: "claude-sessions",
      count: 0,
      endpoint: "http://127.0.0.1:4566",
    });
    expect(result.stderr).toContain(
      "bucket no-lock has versioning Enabled and Object Lock not configured; a restore needs both",
    );
    expect(result.exitCode).toBe(1);
    expect(writes()).toEqual([]);
  }, 30_000);

  test("refuses a bucket with a default retention, which would keep anything the restore wrote", async () => {
    const result = await restoreInto("retained", {
      bucket: "claude-sessions",
      count: 0,
    });
    expect(result.stderr).toContain(
      "bucket retained has an Object Lock default retention",
    );
    expect(result.exitCode).toBe(1);
    expect(writes()).toEqual([]);
  }, 30_000);

  test("needs --bucket", async () => {
    const result = await restoreInto(undefined, {
      bucket: "claude-sessions",
      count: 0,
    });
    expect(result.stderr).toContain("--object-store env needs --bucket");
    expect(result.exitCode).toBe(1);
    expect(s3.requests).toEqual([]);
  }, 30_000);

  test("accepts a new, empty, locked SSE-S3 bucket", async () => {
    const result = await bash(
      `bun run scripts/lib/object-store-cli.ts check-target --source-bucket claude-sessions`,
      repoRoot,
      { ...storeEnv(), S3_BUCKET: "fresh" },
    );
    expect(result.stderr).toContain(
      "bucket fresh is versioned, Object Lock, SSE-S3 and empty",
    );
    expect(result.exitCode).toBe(0);
    expect(writes()).toEqual([]);
  }, 30_000);
});

/**
 * backup.sh's preflight against a `docker` that answers only what it asks
 * before the first byte is copied: which services and installation-labelled
 * containers run. Everything else fails, as a dead daemon would.
 */
describe("backup object paths", () => {
  test("a key only maps to a path inside objects/", () => {
    expect(backupPath("/b/objects", "sessions/s/part-1")).toBe(
      "/b/objects/sessions/s/part-1",
    );
    for (const key of [
      "../db.sql",
      "a/../../db.sql",
      "/etc/x",
      "a//b",
      "./a",
      "",
    ]) {
      expect(() => backupPath("/b/objects", key)).toThrow("has no single path");
    }
  });
});

describe("backup.sh writers", () => {
  let dir: string;
  let out: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "backup-writers-"));
    out = join(dir, "backups");
    await mkdir(join(dir, "bin"));
    await writeFile(
      join(dir, "bin", "docker"),
      [
        "#!/bin/bash",
        "for last; do :; done",
        'case "$*" in',
        '  *" ps -q --status running "*) case " $FAKE_RUNNING " in *" $last "*) echo "cid-$last" ;; esac ;;',
        '  "volume inspect "*) [ -n "$FAKE_LEFT_VOLUME" ] ;;',
        '  "ps -q -a --filter label=com.docker.compose.project=fixture --filter label=com.docker.compose.service=scheduler")',
        '    [ -z "$FAKE_INSTALLATION" ] || echo cid-scheduler ;;',
        '  "ps -q --filter label=com.docker.compose.project=fixture --filter label=com.docker.compose.service="*)',
        '    service="$(printf %s "$last" | sed "s/.*=//")"',
        '    case " $FAKE_RUNNING " in *" $service "*) echo "cid-$service" ;; esac ;;',
        '  "inspect "*) printf "EXECUTION_INSTALLATION_ID=%s\\n" "$FAKE_INSTALLATION" ;;',
        '  "ps -q --filter label=werft.installation") [ -z "$FAKE_WORKERS_OF" ] || echo cid-worker ;;',
        '  "ps -q --filter label=werft.installation=$FAKE_WORKERS_OF") echo cid-worker ;;',
        '  "ps -q --filter label=werft.installation="*) ;;',
        '  *) echo "fake docker: no answer for: $*" >&2; exit 1 ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  const backup = (env: Record<string, string>, ...args: string[]) =>
    bash(
      `PATH="${join(dir, "bin")}:$PATH" scripts/backup.sh --project fixture --out "${out}" ${args.join(" ")}`,
      repoRoot,
      {
        FAKE_RUNNING: "postgres localstack",
        ...env,
      },
    );

  const written = async () => {
    try {
      return await readdir(out);
    } catch {
      return [];
    }
  };

  test("refuses while the api runs, before writing anything", async () => {
    const result = await backup({
      FAKE_RUNNING: "postgres localstack api scheduler",
    });
    expect(result.stderr).toContain(
      "writers are running: api scheduler; stop them first",
    );
    expect(result.exitCode).toBe(1);
    expect(await written()).toEqual([]);
  }, 30_000);

  test("does not wait for a git host", async () => {
    const result = await backup({ FAKE_RUNNING: "postgres localstack api" });
    expect(result.stderr).toContain("writers are running: api");
    expect(result.stderr).not.toContain("gitea-data");
  }, 30_000);

  // It used to warn that the volume was left out.
  test("says nothing of a Gitea volume left from an older stack", async () => {
    const result = await backup({
      FAKE_RUNNING: "postgres localstack api",
      FAKE_LEFT_VOLUME: "1",
    });
    expect(result.stderr).toContain("writers are running: api");
    expect(result.stderr).not.toContain("gitea-data");
  }, 30_000);

  test("refuses while the reconciler runs", async () => {
    const result = await backup({
      FAKE_RUNNING: "postgres localstack reconciler",
    });
    expect(result.stderr).toContain(
      "writers are running: reconciler; stop them first",
    );
    expect(result.exitCode).toBe(1);
    expect(await written()).toEqual([]);
  }, 30_000);

  test("refuses while a worker of the scheduler's installation runs", async () => {
    const result = await backup({
      FAKE_INSTALLATION: "inst-1",
      FAKE_WORKERS_OF: "inst-1",
    });
    expect(result.stderr).toContain(
      "writers are running: 1 worker container(s) of installation inst-1",
    );
    expect(result.exitCode).toBe(1);
    expect(await written()).toEqual([]);
  }, 30_000);

  test("with no scheduler container to name the installation, a worker of any installation counts", async () => {
    const result = await backup({ FAKE_WORKERS_OF: "someone-else" });
    expect(result.stderr).toContain(
      "1 worker container(s) of any installation (project 'fixture' names none)",
    );
    expect(result.exitCode).toBe(1);
  }, 30_000);

  test("--allow-running-writers warns and goes on; the failed run is left as .failed, never as a backup", async () => {
    const result = await backup(
      { FAKE_RUNNING: "postgres localstack api" },
      "--allow-running-writers",
    );
    expect(result.stderr).toContain("warning — writers are running: api");
    // The fake daemon cannot run pg_dump, so the run fails after the
    // directory was reserved.
    expect(result.exitCode).not.toBe(0);
    const names = await written();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^backup-\d{8}T\d{6}Z\.failed$/);
    expect(result.stderr).toContain(`what it wrote is in ${out}/${names[0]}`);
  }, 30_000);
});

describe("verify-restore bundle chain", () => {
  let dir: string;
  let root: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "verify-chain-"));
    root = join(dir, "workspace");
    await mkdir(root);
    await git("init", "--quiet", "--initial-branch=main");
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  // No global or system config: hooks a developer's git runs on commit have
  // no business in a throwaway workspace.
  async function git(...args: string[]) {
    const handle = Bun.spawn(["git", ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      handle.exited,
      new Response(handle.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  }

  async function commit(path: string, body: string) {
    await writeFile(join(root, path), body);
    await git("add", "--all");
    await git("commit", "--quiet", "-m", path);
  }

  /** The worker's own capture, on top of `earlier` the way a chain grows. */
  async function capture(
    ...earlier: WorkspaceCapture[]
  ): Promise<WorkspaceCapture> {
    const result = await captureWorkspace({
      root,
      bundlePath: join(dir, `${randomUUID()}.bundle`),
      signal: new AbortController().signal,
      ...(earlier.length === 0
        ? {}
        : {
            base: {
              maxBytes: DEFAULT_WORKSPACE_CAPTURE_LIMITS.maxBundleBytes,
              tips: earlier.flatMap(({ bundle }) => bundle.tips),
            },
          }),
    });
    if (result.status !== "captured") throw new Error(result.reason);
    return result.capture;
  }

  async function unbundle(commit: string, ...chain: WorkspaceCapture[]) {
    const repository = join(dir, `verify-${randomUUID()}.git`);
    expect(
      (await bash(`git init --quiet --bare "${repository}"`, dir)).exitCode,
    ).toBe(0);
    return bash(
      `source "${lib}"; unbundle_chain "${repository}" "${commit}" ${chain.map(({ bundle }) => `"${bundle.path}"`).join(" ")}`,
      repoRoot,
    );
  }

  test("an incremental bundle alone does not verify in an empty repository", async () => {
    await commit("a.txt", "a\n");
    const first = await capture();
    await commit("a.txt", "a, then b\n");
    const second = await capture(first);

    expect(second.bundle.incremental).toBe(true);
    const result = await unbundle(second.gitCommit, second);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      "bundle 1 of 1: git bundle verify rejected it",
    );
  });

  test("the chain applied base first verifies, and the last bundle's worktree ref is the checkpoint's commit", async () => {
    await commit("a.txt", "a\n");
    const first = await capture();
    await commit("a.txt", "a, then b\n");
    await writeFile(join(root, "a.txt"), "uncommitted\n");
    const second = await capture(first);

    expect(second.bundle.incremental).toBe(true);
    const result = await unbundle(second.gitCommit, first, second);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  // Both turns wrote only an
  // untracked file, which travels outside the bundle. So the second capture
  // changed nothing git tracks, and carries its refs as annotated tags over
  // commits the base has: the last bundle lists the tag, never the commit. A
  // restore peels refs/checkpoint/worktree; the verifier has to as well.
  test("verifies a capture that changed nothing tracked, whose worktree ref is a tag over a commit of its base", async () => {
    await commit("a.txt", "a\n");
    const first = await capture();
    const second = await capture(first);

    expect(second.bundle.incremental).toBe(true);
    expect(second.gitCommit).toBe(first.gitCommit);
    const result = await unbundle(second.gitCommit, first, second);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("refuses the chain out of order, or a commit other than the last bundle's worktree", async () => {
    await commit("a.txt", "a\n");
    const first = await capture();
    await commit("a.txt", "a, then b\n");
    const second = await capture(first);

    const reversed = await unbundle(second.gitCommit, second, first);
    expect(reversed.exitCode).toBe(1);
    expect(reversed.stdout).toContain("bundle 1 of 2");
    const stale = await unbundle(first.gitCommit, first, second);
    expect(stale.exitCode).toBe(1);
    expect(stale.stdout).toBe(
      `the last bundle's refs/checkpoint/worktree is ${second.gitCommit}, not ${first.gitCommit}\n`,
    );
  });
});
