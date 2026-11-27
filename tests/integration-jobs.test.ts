import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assign,
  type IntegrationJob,
  matrix,
  readJobs,
  readJunit,
  shardFiles,
  verifyRun,
} from "../.github/scripts/integration-jobs.ts";
import { suiteFiles } from "../.github/scripts/test-files.ts";

const repo = join(import.meta.dir, "..");
const script = join(repo, ".github", "scripts", "integration-jobs.ts");

function job(
  domain: string,
  paths: string[],
  skips: IntegrationJob["skips"] = [],
  shards = 1,
): IntegrationJob {
  return { domain, paths, skips, shards };
}

/** An unsharded domain's one matrix entry. */
function entry(
  domain: string,
  postgres: boolean,
  localstack: boolean,
  docker: boolean,
) {
  return {
    domain,
    name: domain,
    shard: 1,
    shards: 1,
    postgres,
    localstack,
    docker,
  };
}

function workflow(entries: string): string {
  return `domains:
${entries}`;
}

async function run(args: string[]) {
  const child = Bun.spawn(["bun", script, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, lines: stdout.split("\n").filter(Boolean), stderr };
}

describe("integration-jobs.ts", () => {
  test("reads each matrix entry's domain, paths and declared skips", () => {
    expect(
      readJobs(
        workflow(`          - domain: db
            postgres: true
            localstack: false
            docker: false
            paths: [packages/db/]
          - domain: storage
            postgres: false
            localstack: true
            docker: false
            paths: [packages/storage/, tests/object-store.]
            skips:
              - file: packages/storage/src/a.test.ts
                test: only on macOS
`),
      ),
    ).toEqual([
      job("db", ["packages/db/"]),
      job(
        "storage",
        ["packages/storage/", "tests/object-store."],
        [{ file: "packages/storage/src/a.test.ts", test: "only on macOS" }],
      ),
    ]);
  });

  test("refuses a matrix entry that leaves a service flag or its paths out", () => {
    expect(() =>
      readJobs(
        workflow(`          - domain: db
            postgres: true
            docker: false
            paths: [packages/db/]
`),
      ),
    ).toThrow("db: localstack must be true or false");
    expect(() =>
      readJobs(
        workflow(`          - domain: db
            postgres: true
            localstack: false
            docker: false
            paths: []
`),
      ),
    ).toThrow("db: paths must be a non-empty list");
    expect(() => readJobs("domains: []\n")).toThrow("has no domains list");
    expect(() => readJobs("")).toThrow("has no domains list");
  });

  const declared = workflow(`          - domain: db
            postgres: true
            localstack: false
            docker: false
            paths: [packages/db/]
          - domain: storage
            postgres: false
            localstack: true
            docker: false
            paths: [packages/storage/]
          - domain: egress
            postgres: false
            localstack: false
            docker: true
            paths: [apps/egress-proxy/]
`);

  test("the matrix holds only the planned domains, in declaration order, with their services", () => {
    expect(matrix(declared, '["egress","db"]')).toEqual([
      entry("db", true, false, false),
      entry("egress", false, false, true),
    ]);
    expect(matrix(declared, '["storage"]')).toEqual([
      entry("storage", false, true, false),
    ]);
  });

  test("a sharded domain gives the matrix one entry per shard, each with the domain's services", () => {
    const sharded = workflow(`          - domain: db
            postgres: true
            localstack: false
            docker: false
            shards: 3
            paths: [packages/db/]
          - domain: egress
            postgres: false
            localstack: false
            docker: true
            paths: [apps/egress-proxy/]
`);
    expect(readJobs(sharded)[0]).toEqual(job("db", ["packages/db/"], [], 3));
    expect(matrix(sharded, '["db","egress"]')).toEqual([
      ...[1, 2, 3].map((shard) => ({
        domain: "db",
        name: `db ${shard}/3`,
        shard,
        shards: 3,
        postgres: true,
        localstack: false,
        docker: false,
      })),
      entry("egress", false, false, true),
    ]);
    for (const shards of ["0", "-1", "1.5", '"2"', "null"]) {
      expect(() =>
        readJobs(
          workflow(`          - domain: db
            postgres: true
            localstack: false
            docker: false
            shards: ${shards}
            paths: [packages/db/]
`),
        ),
      ).toThrow("db: shards must be a whole number of 1 or more");
    }
  });

  test("shards split a domain's files so that each runs in exactly one shard", () => {
    const owned = ["a", "b", "c", "d", "e"].map((n) => `${n}.test.ts`);
    expect([1, 2].map((shard) => shardFiles(owned, 2, shard))).toEqual([
      ["a.test.ts", "c.test.ts", "e.test.ts"],
      ["b.test.ts", "d.test.ts"],
    ]);
    expect(shardFiles(owned, 1, 1)).toEqual(owned);
    for (const shard of [0, 3, 1.5, Number.NaN]) {
      expect(() => shardFiles(owned, 2, shard)).toThrow(
        `no shard ${shard} of 2`,
      );
    }
    // Fewer files than shards would leave a shard empty, and `bun test`
    // with no path runs the whole suite.
    expect(() =>
      assign(["packages/db/a.test.ts"], [job("db", ["packages/db/"], [], 2)]),
    ).toThrow("db has 1 files for 2 shards");
  });

  test("the matrix refuses an empty, malformed, repeated or unknown plan", () => {
    for (const planned of ["[]", "", "null", "{}", '"db"', "[true]", "db"]) {
      expect(() => matrix(declared, planned)).toThrow(
        "planned domains must be a non-empty JSON array of names",
      );
    }
    expect(() => matrix(declared, '["db","db"]')).toThrow("name one twice");
    expect(() => matrix(declared, '["db","surface"]')).toThrow(
      "no integration domain named surface",
    );
  });

  test("gives every file to the one job whose prefix it starts with", () => {
    const assigned = assign(
      [
        "apps/control-host/a.test.ts",
        "packages/db/b.test.ts",
        "tests/c.test.ts",
      ],
      [
        job("api", ["apps/control-host/", "tests/c."]),
        job("db", ["packages/db/"]),
      ],
    );

    expect(Object.fromEntries(assigned)).toEqual({
      api: ["apps/control-host/a.test.ts", "tests/c.test.ts"],
      db: ["packages/db/b.test.ts"],
    });
  });

  test("gives a file under nested prefixes to the job with the longest one", () => {
    const assigned = assign(
      [
        "packages/db/src/a.test.ts",
        "packages/db/src/session-b.test.ts",
        "packages/db/src/sessions/c.test.ts",
      ],
      [
        job("db", ["packages/db/"]),
        job("sessions", ["packages/db/src/session"]),
      ],
    );

    expect(Object.fromEntries(assigned)).toEqual({
      db: ["packages/db/src/a.test.ts"],
      sessions: [
        "packages/db/src/session-b.test.ts",
        "packages/db/src/sessions/c.test.ts",
      ],
    });
    // A prefix every file of which a longer one took owns nothing.
    expect(() =>
      assign(
        ["packages/db/src/session-b.test.ts"],
        [
          job("db", ["packages/db/"]),
          job("sessions", ["packages/db/src/session"]),
        ],
      ),
    ).toThrow("db: packages/db/ matches no test file");
  });

  test("names every file that belongs to no job or to two, and every stale prefix or empty job", () => {
    expect(() =>
      assign(
        [
          "apps/control-host/a.test.ts",
          "apps/web/b.test.ts",
          "packages/db/c.test.ts",
        ],
        [
          job("api", ["apps/control-host/", "packages/db/"]),
          job("db", ["packages/db/", "packages/gone/"]),
          job("ui", ["packages/ui/"]),
        ],
      ),
    ).toThrow(
      [
        "apps/web/b.test.ts belongs to no integration job",
        "packages/db/c.test.ts belongs to api and db",
        "db: packages/gone/ matches no test file",
        "db has no files",
        "ui: packages/ui/ matches no test file",
        "ui has no files",
      ].join("\n"),
    );
    expect(() =>
      assign(["a.test.ts"], [job("a", ["a"]), job("a", ["b"])]),
    ).toThrow("domain a is declared twice");
    expect(() =>
      assign(
        ["a.test.ts"],
        [job("a", ["a"], [{ file: "b.test.ts", test: "x" }])],
      ),
    ).toThrow("a: declared skip in b.test.ts, which it does not run");
  });

  test("the declared domains give every file of the suite to exactly one job", async () => {
    const jobs = readJobs(
      await readFile(join(repo, ".github", "integration-domains.yml"), "utf8"),
    );
    const files = suiteFiles(repo);
    const assigned = assign(files, jobs);

    expect([...assigned.values()].flat().sort()).toEqual(files);

    // And each file of a sharded domain to exactly one of its shards.
    for (const { domain, shards } of jobs) {
      const owned = assigned.get(domain)!;
      const split = Array.from({ length: shards }, (_, i) =>
        shardFiles(owned, shards, i + 1),
      );
      expect(split.every((part) => part.length > 0)).toBe(true);
      expect(split.flat().sort()).toEqual([...owned].sort());
      expect(new Set(split.flat()).size).toBe(owned.length);
    }
  });

  test("prints the planned domains' matrix as one line of JSON, and fails on an unknown one", async () => {
    const planned = await run(["matrix", '["storage","sessions"]']);
    expect(planned.exitCode).toBe(0);
    expect(planned.lines).toHaveLength(1);
    expect(JSON.parse(planned.lines[0]!)).toEqual([
      entry("sessions", true, false, false),
      entry("storage", false, true, false),
    ]);
    const db = await run(["matrix", '["db"]']);
    expect(
      (JSON.parse(db.lines[0]!) as { name: string }[]).map((e) => e.name),
    ).toEqual(["db 1/3", "db 2/3", "db 3/3"]);
    const unknown = await run(["matrix", '["nope"]']);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.lines).toEqual([]);
    expect(unknown.stderr).toContain("no integration domain named nope");
  });

  test("prints a job's files as paths bun test takes literally, and refuses an unknown job", async () => {
    const shards = await Promise.all(
      ["1", "2", "3"].map((shard) => run(["files", "db", shard])),
    );
    for (const shard of shards) {
      expect(shard.exitCode).toBe(0);
      expect(shard.lines.length).toBeGreaterThan(0);
      expect(shard.lines.every((line) => line.startsWith("./"))).toBe(true);
    }
    expect(shards.flatMap((shard) => shard.lines)).toContain(
      "./packages/db/src/migrate.integration.test.ts",
    );

    const unknown = await run(["files", "nope", "1"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("no integration job named nope");
    for (const shard of ["0", "4", "x", "1.0"]) {
      const out = await run(["files", "db", shard]);
      expect(out.exitCode).toBe(2);
      expect(out.lines).toEqual([]);
    }
    const noShard = await run(["files", "db"]);
    expect(noShard.exitCode).toBe(2);
    expect(noShard.stderr).toContain("usage:");
  });

  test("reads bun's own junit report, skipped cases and escaped names included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "integration-jobs-"));
    try {
      await writeFile(
        join(dir, "a.test.ts"),
        `import { describe, test } from "bun:test";
describe("outer", () => {
  test("runs", () => {});
  test.skip('skips "quoted" <tags> & more', () => {});
});
describe.skip("off", () => {
  test("inside", () => {});
});
`,
      );
      const child = Bun.spawn(
        ["bun", "test", "--reporter=junit", "--reporter-outfile=out.xml"],
        { cwd: dir, stderr: "pipe", stdout: "pipe" },
      );
      expect(await child.exited).toBe(0);

      const cases = readJunit(await readFile(join(dir, "out.xml"), "utf8"));
      expect(cases).toEqual([
        { file: "a.test.ts", skipped: false, test: "runs" },
        {
          file: "a.test.ts",
          skipped: true,
          test: 'skips "quoted" <tags> & more',
        },
        { file: "a.test.ts", skipped: true, test: "inside" },
      ]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("fails a run that skipped what the job did not declare, or ran other files than it owns", () => {
    const storage = job(
      "storage",
      ["packages/storage/"],
      [{ file: "packages/storage/b.test.ts", test: "on macOS only" }],
    );
    const owned = ["packages/storage/a.test.ts", "packages/storage/b.test.ts"];

    expect(
      verifyRun(storage, owned, [
        { file: "packages/storage/a.test.ts", skipped: false, test: "x" },
        {
          file: "packages/storage/b.test.ts",
          skipped: true,
          test: "on macOS only",
        },
      ]),
    ).toEqual([]);
    expect(
      verifyRun(storage, owned, [
        { file: "packages/storage/a.test.ts", skipped: true, test: "x" },
        {
          file: "packages/storage/b.test.ts",
          skipped: false,
          test: "on macOS only",
        },
        { file: "packages/db/c.test.ts", skipped: false, test: "y" },
      ]),
    ).toEqual([
      "packages/db/c.test.ts ran but is not owned",
      "undeclared skip: packages/storage/a.test.ts > x",
      "declared skip did not skip: packages/storage/b.test.ts > on macOS only",
    ]);
    expect(
      verifyRun(storage, owned, [
        {
          file: "packages/storage/b.test.ts",
          skipped: true,
          test: "on macOS only",
        },
      ]),
    ).toEqual(["packages/storage/a.test.ts did not run"]);
  });
});
