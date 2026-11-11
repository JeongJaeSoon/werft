import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assign,
  type IntegrationJob,
  readJobs,
  readJunit,
  verifyRun,
} from "../.github/scripts/integration-jobs.ts";
import { suiteFiles } from "../.github/scripts/test-files.ts";

const repo = join(import.meta.dir, "..");
const script = join(repo, ".github", "scripts", "integration-jobs.ts");

function job(
  domain: string,
  paths: string[],
  skips: IntegrationJob["skips"] = [],
): IntegrationJob {
  return { domain, paths, skips };
}

function workflow(entries: string): string {
  return `jobs:
  integration-domain:
    strategy:
      matrix:
        include:
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
    expect(() => readJobs("jobs: {}\n")).toThrow("no integration-domain");
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

  test("the matrix in ci.yml gives every file of the suite to exactly one job", async () => {
    const jobs = readJobs(
      await readFile(join(repo, ".github", "workflows", "ci.yml"), "utf8"),
    );
    const files = suiteFiles(repo);
    const assigned = assign(files, jobs);

    expect([...assigned.values()].flat().sort()).toEqual(files);
  });

  test("prints a job's files as paths bun test takes literally, and refuses an unknown job", async () => {
    const db = await run(["files", "db"]);
    expect(db.exitCode).toBe(0);
    expect(db.lines.length).toBeGreaterThan(0);
    expect(db.lines.every((line) => line.startsWith("./"))).toBe(true);
    expect(db.lines).toContain("./packages/db/src/migrate.integration.test.ts");

    const unknown = await run(["files", "nope"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("no integration job named nope");
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
