import { expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dir, "../.github/scripts/image-cache-to.sh");
const write =
  "to=type=gha,scope=images-worker-amd64,mode=min,ignore-error=true\n";

type Checkout = (repo: string) => void;

function git(repo: string, args: string[], date?: string) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      ...(date ? { GIT_COMMITTER_DATE: date } : {}),
    },
  });
  expect(result.stderr.toString()).not.toContain("fatal:");
  expect(result.exitCode).toBe(0);
}

function commit(repo: string, path: string, date: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  appendFileSync(join(repo, path), `${date}\n`);
  git(repo, ["add", path]);
  git(repo, ["commit", "-qm", path], date);
}

// Inputs last changed on an earlier day.
const unchanged: Checkout = (repo) => {
  git(repo, ["init", "-q"]);
  commit(repo, "apps/worker/Dockerfile", "2026-11-20T00:00:00Z");
  commit(repo, "scripts/fetch-pinned.ts", "2026-11-20T00:00:00Z");
};

const changedAt =
  (path: string, date = "2026-11-28T03:24:56Z"): Checkout =>
  (repo) => {
    unchanged(repo);
    commit(repo, path, date);
  };

// A fake gh on PATH: answers GH_ANSWER, exits GH_EXIT, records its arguments.
// The script runs in a repository of its own, which `checkout` fills.
function run(
  answer: string,
  exit = 0,
  extra: Record<string, string> = {},
  checkout: Checkout = unchanged,
) {
  const dir = mkdtempSync(join(tmpdir(), "image-cache-to-"));
  try {
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >"${dir}/args"\n[ -n "\${GH_IGNORE_TERM:-}" ] && trap '' TERM\nsleep "\${GH_SLEEP:-0}"\nprintf '%s' "$GH_ANSWER"\nexit "$GH_EXIT"\n`,
    );
    chmodSync(gh, 0o755);
    const repo = join(dir, "repo");
    mkdirSync(repo);
    checkout(repo);
    const result = Bun.spawnSync(["bash", script], {
      cwd: repo,
      env: {
        // A checkout without a repository must not find one above it.
        GIT_CEILING_DIRECTORIES: dir,
        PATH: `${dir}:${process.env.PATH}`,
        APP: "worker",
        ARCH: "amd64",
        TODAY: "2026-11-28",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_REF: "refs/heads/main",
        GH_ANSWER: answer,
        GH_EXIT: String(exit),
        ...extra,
      },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      args: readFileSync(join(dir, "args"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a scope already written today on this ref is only read", () => {
  const result = run("2026-11-28T08:19:30Z");
  expect(result).toMatchObject({ exitCode: 0, stdout: "to=\n" });
  expect(result.args).toContain("key=index-images-worker-amd64-");
  expect(result.args).toContain("ref=refs/heads/main");
  expect(result.args).toContain("sort=created_at");
});

test("the first build of the day, or of a scope never written, writes it", () => {
  for (const answer of ["2026-11-27T23:59:59Z", ""])
    expect(run(answer)).toMatchObject({ exitCode: 0, stdout: write });
});

// The cache is a speed-up: a listing that fails writes as before and never
// fails the build, and the write itself ignores upload errors.
test("a failed cache listing writes as before and exits 0", () => {
  expect(run("HTTP 403", 1)).toMatchObject({ exitCode: 0, stdout: write });
});

test("an entry from before 00:30Z may be yesterday's key, so it writes", () => {
  expect(run("2026-11-28T00:04:00Z")).toMatchObject({
    exitCode: 0,
    stdout: write,
  });
  expect(run("2026-11-28T00:30:00Z")).toMatchObject({
    exitCode: 0,
    stdout: "to=\n",
  });
});

test("a listing that hangs is cut at LIST_TIMEOUT and writes as before", () => {
  const started = Date.now();
  const result = run("2026-11-28T08:00:00Z", 0, {
    GH_SLEEP: "30",
    LIST_TIMEOUT: "1",
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: write });
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("a listing that ignores TERM is killed and writes as before", () => {
  const started = Date.now();
  const result = run("2026-11-28T08:00:00Z", 0, {
    GH_SLEEP: "30",
    GH_IGNORE_TERM: "1",
    LIST_TIMEOUT: "1",
  });
  expect(result).toMatchObject({ exitCode: 0, stdout: write });
  expect(Date.now() - started).toBeLessThan(10_000);
});

// A pin changed hours after the day's entry was written.
test.each(["apps/worker/Dockerfile", "scripts/fetch-pinned.ts"])(
  "a day's entry older than a change of %s is written again",
  (path) => {
    expect(run("2026-11-28T00:39:50Z", 0, {}, changedAt(path))).toMatchObject({
      exitCode: 0,
      stdout: write,
    });
  },
);

test("an entry within 30 minutes of the change may hold the commit before it", () => {
  const changed = changedAt("apps/worker/Dockerfile");
  expect(run("2026-11-28T03:54:55Z", 0, {}, changed).stdout).toBe(write);
  expect(run("2026-11-28T03:55:00Z", 0, {}, changed).stdout).toBe("to=\n");
});

test("worker-codex is dated by the worker's Dockerfile", () => {
  expect(
    run(
      "2026-11-28T00:39:50Z",
      0,
      { APP: "worker-codex" },
      changedAt("apps/worker/Dockerfile"),
    ).stdout,
  ).toBe(write.replace("images-worker-", "images-worker-codex-"));
});

test("another image's Dockerfile or other source leaves the day's entry", () => {
  for (const path of ["apps/control-host/Dockerfile", "apps/worker/main.ts"])
    expect(run("2026-11-28T00:39:50Z", 0, {}, changedAt(path)).stdout).toBe(
      "to=\n",
    );
});

// A shallow checkout dates every file by its one commit.
test("a shallow checkout keeps the once-a-day rule", () => {
  const shallow: Checkout = (repo) => {
    const origin = join(repo, "..", "origin");
    mkdirSync(origin);
    changedAt("apps/worker/Dockerfile")(origin);
    git(repo, ["clone", "-q", "--depth=1", `file://${origin}`, "."]);
  };
  expect(run("2026-11-28T00:39:50Z", 0, {}, shallow).stdout).toBe("to=\n");
});

test("inputs git cannot date are written, and the job goes on", () => {
  for (const checkout of [
    () => {},
    (repo: string) => {
      git(repo, ["init", "-q"]);
      commit(repo, "README.md", "2026-11-20T00:00:00Z");
    },
  ])
    expect(run("2026-11-28T00:39:50Z", 0, {}, checkout)).toMatchObject({
      exitCode: 0,
      stdout: write,
    });
});

// origin/main one commit past HEAD, changing `path`.
const behindMain =
  (path: string): Checkout =>
  (repo) => {
    unchanged(repo);
    commit(repo, path, "2026-11-28T03:24:56Z");
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(repo, ["reset", "-q", "--hard", "HEAD~1"]);
  };

// Queued behind a pin change, or rerun: writing would store the old pins as a
// current entry.
test.each(["", "2026-11-27T23:00:00Z"])(
  "a main build behind a pin change never writes (latest entry %p)",
  (latest) => {
    expect(
      run(latest, 0, {}, behindMain("apps/worker/Dockerfile")),
    ).toMatchObject({ exitCode: 0, stdout: "to=\n" });
  },
);

// A scheduled build checks out one commit, so its origin/main starts as HEAD.
test("a shallow main build asks origin whether main has moved the inputs", () => {
  const shallowThenMoved: Checkout = (repo) => {
    const origin = join(repo, "..", "origin");
    mkdirSync(origin);
    unchanged(origin);
    git(origin, ["branch", "-M", "main"]);
    git(repo, ["clone", "-q", "--depth=1", `file://${origin}`, "."]);
    commit(origin, "apps/worker/Dockerfile", "2026-11-28T03:24:56Z");
  };
  expect(run("", 0, {}, shallowThenMoved)).toMatchObject({
    exitCode: 0,
    stdout: "to=\n",
  });
});

test("a main build behind other changes, or on another ref, still writes", () => {
  expect(run("", 0, {}, behindMain("apps/worker/main.ts")).stdout).toBe(write);
  expect(
    run(
      "",
      0,
      { GITHUB_REF: "refs/tags/v1.2.3" },
      behindMain("apps/worker/Dockerfile"),
    ).stdout,
  ).toBe(write);
});
