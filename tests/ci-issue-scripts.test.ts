import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scripts = join(import.meta.dir, "..", ".github", "scripts");

type Outcome = {
  calls: string[];
  exitCode: number;
  stderr: string;
  stdout: string;
};

/**
 * Runs a script with a fake `gh` first on PATH. The fake logs every invocation
 * to a file and answers from `replies`, keyed by the first words of the
 * invocation; an unmatched call exits 9 so a test never passes by accident.
 * A reply of `FAIL` makes that call fail the way an HTTP 502 does.
 */
/** A reply per call, in order; the last one repeats. */
type Replies = Record<string, string | string[]>;

async function run(
  script: string,
  args: string[],
  replies: Replies,
  env: Record<string, string> = {},
): Promise<Outcome> {
  const directory = await mkdtemp(join(tmpdir(), "ci-issue-"));
  const log = join(directory, "calls.log");
  const fakeGh = join(directory, "gh");
  const cases = Object.entries(replies)
    .map(([prefix, reply], index) => {
      const sequence = Array.isArray(reply) ? reply : [reply];
      const lines = sequence.map((line) => JSON.stringify(line)).join(" ");
      return `  "${prefix}"*) answer ${index} ${lines} ;;`;
    })
    .join("\n");
  await writeFile(
    fakeGh,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${log}"
# answer <case-index> <reply>...: the n-th call of a case gets its n-th reply.
answer() {
  local counter="${directory}/count.$1"
  shift
  local n
  n=$(cat "$counter" 2>/dev/null || echo 0)
  echo $((n + 1)) >"$counter"
  [ "$n" -ge "$#" ] && n=$(($# - 1))
  shift "$n"
  if [ "$1" = FAIL ]; then
    echo "gh: Server Error (HTTP 502)" >&2
    exit 1
  fi
  printf '%b\\n' "$1"
}
case "$*" in
${cases}
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`,
  );
  await chmod(fakeGh, 0o755);
  try {
    const process = Bun.spawn([join(scripts, script), ...args], {
      env: {
        ...Bun.env,
        GH_REPO: "octo/repo",
        // Scripts that ask a failed call again wait between attempts.
        GH_RETRY_DELAY: "0",
        ...env,
        PATH: `${directory}:${Bun.env.PATH}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    const calls = (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    return { calls, exitCode, stderr, stdout };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function bodyFile(): Promise<{
  path: string;
  dispose: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "ci-issue-body-"));
  const path = join(directory, "body.md");
  await writeFile(path, "<!-- marker -->\nsomething broke\n");
  return {
    path,
    dispose: () => rm(directory, { force: true, recursive: true }),
  };
}

describe("upsert-ci-issue.sh", () => {
  test("creates the issue when none is open under the label", async () => {
    const body = await bodyFile();
    try {
      const outcome = await run(
        "upsert-ci-issue.sh",
        [
          "ci-agent-sdk-compat-failure",
          "CI: agent-sdk-compat failed (non-blocking job)",
          body.path,
        ],
        {
          "label create": "",
          "issue list": [
            "[]",
            '[{"number":12,"title":"CI: agent-sdk-compat failed (non-blocking job)"}]',
          ],
          "issue create": "https://github.com/octo/repo/issues/12",
        },
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe(
        "created https://github.com/octo/repo/issues/12\n",
      );
      expect(
        outcome.calls.some((call) => call.startsWith("issue comment")),
      ).toBe(false);
      const create = outcome.calls.find((call) =>
        call.startsWith("issue create"),
      );
      expect(create).toContain("--label ci-agent-sdk-compat-failure");
      expect(create).toContain(
        "--title CI: agent-sdk-compat failed (non-blocking job)",
      );
    } finally {
      await body.dispose();
    }
  });

  test("comments on the open issue instead of opening a second one", async () => {
    const body = await bodyFile();
    try {
      const outcome = await run(
        "upsert-ci-issue.sh",
        [
          "ci-agent-sdk-compat-failure",
          "CI: agent-sdk-compat failed (non-blocking job)",
          body.path,
        ],
        {
          "label create": "",
          "issue list":
            '[{"number":12,"title":"CI: agent-sdk-compat failed (non-blocking job)"}]',
          "issue comment 12": "",
        },
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe("updated #12\n");
      expect(
        outcome.calls.some((call) => call.startsWith("issue create")),
      ).toBe(false);
    } finally {
      await body.dispose();
    }
  });

  test("looks the open issue up through the list endpoint, filtered by label", async () => {
    const body = await bodyFile();
    try {
      const outcome = await run(
        "upsert-ci-issue.sh",
        ["ci-missing-push-run", "CI: main tip has no push run", body.path],
        {
          "label create": "",
          "issue list": [
            "[]",
            '[{"number":7,"title":"CI: main tip has no push run"}]',
          ],
          "issue create": "https://github.com/octo/repo/issues/7",
        },
      );

      const list = outcome.calls.find((call) => call.startsWith("issue list"));
      expect(list).toContain("--label ci-missing-push-run");
      expect(list).toContain("--state open");
      expect(list).not.toContain("--search");
      // A ceiling on what gh fetches; below the real count it hides titles.
      expect(list).toContain("--limit 1000");
    } finally {
      await body.dispose();
    }
  });

  test("closes its own issue as a duplicate when a concurrent run created one first", async () => {
    const body = await bodyFile();
    try {
      // Empty on the first look; #12 (the other run's) is the oldest open one
      // by the time this run's #13 has landed.
      const outcome = await run(
        "upsert-ci-issue.sh",
        [
          "ci-agent-sdk-compat-failure",
          "CI: agent-sdk-compat failed (non-blocking job)",
          body.path,
        ],
        {
          "label create": "",
          "issue list": [
            "[]",
            '[{"number":12,"title":"CI: agent-sdk-compat failed (non-blocking job)"}]',
          ],
          "issue create": "https://github.com/octo/repo/issues/13",
          "issue close 13": "",
          "issue comment 12": "",
        },
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe("updated #12 (closed duplicate #13)\n");
      expect(
        outcome.calls.filter((call) => call.startsWith("issue close 13")),
      ).toHaveLength(1);
      expect(
        outcome.calls.filter((call) => call.startsWith("issue comment 12")),
      ).toHaveLength(1);
    } finally {
      await body.dispose();
    }
  });

  const openList =
    "issue list --repo octo/repo --label ci-missing-push-run --state open";
  const closedList =
    "issue list --repo octo/repo --label ci-missing-push-run --state closed";

  test("with --by-title, a closed issue of the same title is an acknowledgement", async () => {
    const body = await bodyFile();
    try {
      const outcome = await run(
        "upsert-ci-issue.sh",
        [
          "--by-title",
          "ci-missing-push-run",
          "CI: main tip 70139eb has no push run",
          body.path,
        ],
        {
          "label create": "",
          [openList]: "[]",
          [closedList]:
            '[{"number":39,"title":"CI: main tip 70139eb has no push run"},{"number":40,"title":"CI: main tip 70139eb has no push run"},{"number":50,"title":"CI: main tip 1111111 has no push run"}]',
        },
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe("acknowledged #40\n");
      expect(
        outcome.calls.some((call) => call.startsWith("issue create")),
      ).toBe(false);
      // The title match happens in jq, on the JSON gh returned; gh itself
      // only lists by label and state.
      const closed = outcome.calls.find((call) => call.startsWith(closedList));
      expect(closed).toContain("--json number,title");
      expect(closed).not.toContain("--jq");
      // Both lookups fetch up to the same ceiling; a lower one hides titles.
      expect(closed).toContain("--limit 1000");
      const open = outcome.calls.find((call) => call.startsWith(openList));
      expect(open).toContain("--limit 1000");
    } finally {
      await body.dispose();
    }
  });

  test("with --by-title, no matching closed title still creates the issue", async () => {
    const body = await bodyFile();
    try {
      const outcome = await run(
        "upsert-ci-issue.sh",
        [
          "--by-title",
          "ci-missing-push-run",
          "CI: main tip abcdef0 has no push run",
          body.path,
        ],
        {
          "label create": "",
          [openList]: [
            "[]",
            '[{"number":41,"title":"CI: main tip abcdef0 has no push run"}]',
          ],
          // A closed issue for another commit must not count.
          [closedList]:
            '[{"number":50,"title":"CI: main tip 1111111 has no push run"}]',
          "issue create": "https://github.com/octo/repo/issues/41",
        },
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe(
        "created https://github.com/octo/repo/issues/41\n",
      );
    } finally {
      await body.dispose();
    }
  });

  test("with --by-title, an open issue for another commit is not appended to", async () => {
    const body = await bodyFile();
    try {
      const outcome = await run(
        "upsert-ci-issue.sh",
        [
          "--by-title",
          "ci-missing-push-run",
          "CI: main tip abcdef0 has no push run",
          body.path,
        ],
        {
          "label create": "",
          [openList]: [
            '[{"number":41,"title":"CI: main tip 1111111 has no push run"}]',
            '[{"number":41,"title":"CI: main tip 1111111 has no push run"},{"number":42,"title":"CI: main tip abcdef0 has no push run"}]',
          ],
          [closedList]: "[]",
          "issue create": "https://github.com/octo/repo/issues/42",
        },
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe(
        "created https://github.com/octo/repo/issues/42\n",
      );
      expect(
        outcome.calls.some((call) => call.startsWith("issue comment")),
      ).toBe(false);
      expect(outcome.calls.some((call) => call.startsWith("issue close"))).toBe(
        false,
      );
    } finally {
      await body.dispose();
    }
  });

  test("without --by-title, closed issues are never consulted", async () => {
    const body = await bodyFile();
    try {
      const outcome = await run(
        "upsert-ci-issue.sh",
        [
          "ci-agent-sdk-compat-failure",
          "CI: agent-sdk-compat failed (non-blocking job)",
          body.path,
        ],
        {
          "label create": "",
          "issue list": [
            "[]",
            '[{"number":12,"title":"CI: agent-sdk-compat failed (non-blocking job)"}]',
          ],
          "issue create": "https://github.com/octo/repo/issues/12",
        },
      );

      expect(
        outcome.calls.some((call) => call.includes("--state closed")),
      ).toBe(false);
    } finally {
      await body.dispose();
    }
  });

  test("refuses a missing body file before touching GitHub", async () => {
    const outcome = await run(
      "upsert-ci-issue.sh",
      ["ci-agent-sdk-compat-failure", "title", "/nonexistent/body.md"],
      {},
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.calls).toEqual([]);
  });
});

describe("check-main-push-run.sh", () => {
  const oldCommit = (sha: string, parent = "") =>
    `${sha} 2026-09-22T14:27:16Z ${parent}`;
  const activity = "api repos/octo/repo/activity?ref=refs/heads/main";

  test("reports present when the commit has a push run of ci.yml", async () => {
    const outcome = await run("check-main-push-run.sh", ["10e58fb"], {
      "api repos/octo/repo/commits/10e58fb": oldCommit("10e58fb0000"),
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=10e58fb0000&per_page=1":
        "1 35688714425",
    });

    expect(outcome.exitCode).toBe(0);
    // The run id is what the agent-sdk-compat check reads next.
    expect(outcome.stdout).toBe("present 10e58fb 35688714425\n");
  });

  test("reports missing, with exit 1, when the commit was the tip and has no push run", async () => {
    const outcome = await run("check-main-push-run.sh", ["70139eb"], {
      "api repos/octo/repo/commits/70139eb": oldCommit(
        "70139eb0000",
        "10e58fb0000",
      ),
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=70139eb0000&per_page=1":
        "0 ",
      // The update that made it the tip was lost with its push event; the
      // next one left from it.
      [activity]: "pr_merge 70139eb0000 d6810ca0000",
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe("missing 70139eb\n");
  });

  test("reports coalesced, not missing, for a commit one push carried past the tip", async () => {
    const outcome = await run("check-main-push-run.sh", ["1583f5d"], {
      "api repos/octo/repo/commits/1583f5d": oldCommit(
        "1583f5d0000",
        "654a3380000",
      ),
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=1583f5d0000&per_page=1":
        "0 ",
      [activity]: [
        "pr_merge 95b0e7b0000 3c230800000\npr_merge 654a3380000 95b0e7b0000\npr_merge 760fd000000 654a3380000",
      ],
      "api repos/octo/repo/compare/1583f5d0000...95b0e7b0000": "ahead",
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("coalesced 1583f5d 95b0e7b\n");
  });

  test("walks up through commits that were never the tip to the push that carried them", async () => {
    const outcome = await run("check-main-push-run.sh", [], {
      "api repos/octo/repo/commits?sha=main&since=": [
        [
          oldCommit("ccccccc333", "bbbbbbb222"),
          oldCommit("bbbbbbb222", "aaaaaaa111"),
        ].join("\\n"),
      ],
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=ccccccc333&per_page=1":
        "1 333",
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=bbbbbbb222&per_page=1":
        "0 ",
      // aaaaaaa111 is outside the window, so its parent is asked for.
      "api repos/octo/repo/commits/aaaaaaa111 --jq .parents": "9999999000",
      [activity]: "pr_merge 9999999000 ccccccc333",
      "api repos/octo/repo/compare/bbbbbbb222...ccccccc333": "ahead",
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe(
      "present ccccccc 333\ncoalesced bbbbbbb ccccccc\n",
    );
    // Activity is read once, and only because a run was missing.
    expect(
      outcome.calls.filter((call) => call.startsWith(activity)),
    ).toHaveLength(1);
  });

  test("an update from the parent that does not contain the commit does not cover it", async () => {
    // aaaaaaa111 was the tip twice: it moved on to 999, a force push brought
    // main back, and the update that made bbbbbbb222 the tip was lost.
    const outcome = await run("check-main-push-run.sh", ["bbbbbbb"], {
      "api repos/octo/repo/commits/bbbbbbb": oldCommit(
        "bbbbbbb222",
        "aaaaaaa111",
      ),
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=bbbbbbb222&per_page=1":
        "0 ",
      [activity]:
        "force_push 9999999000 aaaaaaa111\npr_merge aaaaaaa111 9999999000",
      "api repos/octo/repo/compare/bbbbbbb222...9999999000": "diverged",
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe("missing bbbbbbb\n");
  });

  test("a failed compare exits 2 rather than judging the commit", async () => {
    const outcome = await run("check-main-push-run.sh", ["bbbbbbb"], {
      "api repos/octo/repo/commits/bbbbbbb": oldCommit(
        "bbbbbbb222",
        "aaaaaaa111",
      ),
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=bbbbbbb222&per_page=1":
        "0 ",
      [activity]: "pr_merge aaaaaaa111 ccccccc333",
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("the push that carried bbbbbbb");
  });

  test("a commit with no trace in the activity is missing", async () => {
    const outcome = await run("check-main-push-run.sh", ["bbbbbbb"], {
      "api repos/octo/repo/commits/bbbbbbb": oldCommit("bbbbbbb222"),
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=bbbbbbb222&per_page=1":
        "0 ",
      [activity]: "",
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe("missing bbbbbbb\n");
  });

  test("a failed activity lookup exits 2 rather than calling the commit missing", async () => {
    const outcome = await run("check-main-push-run.sh", ["bbbbbbb"], {
      "api repos/octo/repo/commits/bbbbbbb": oldCommit("bbbbbbb222"),
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=bbbbbbb222&per_page=1":
        "0 ",
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("activity of main");
  });

  test("judges every main commit in the lookback window when no sha is given", async () => {
    const outcome = await run("check-main-push-run.sh", [], {
      "api repos/octo/repo/commits?sha=main&since=": [
        `${oldCommit("bbbbbbb222")}\\n${oldCommit("aaaaaaa111")}`,
      ],
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=bbbbbbb222&per_page=1":
        "1 222",
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=aaaaaaa111&per_page=1":
        "0 ",
      [activity]: "pr_merge aaaaaaa111 bbbbbbb222",
    });

    // The tip is fine; the commit under it lost its run and is still reported.
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe("present bbbbbbb 222\nmissing aaaaaaa\n");
    const [window] = outcome.calls.filter((call) =>
      call.startsWith("api repos/octo/repo/commits?sha=main&since="),
    );
    expect(window).toMatch(
      /since=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z&per_page=100/,
    );
    expect(window).toContain("--paginate");
  });

  test("a failed lookup exits 2, distinct from missing, after the verdicts it did reach", async () => {
    // No reply is mapped for the second commit's runs query, so the fake gh
    // fails it the way a real API error would.
    const outcome = await run("check-main-push-run.sh", [], {
      "api repos/octo/repo/commits?sha=main&since=": [
        `${oldCommit("bbbbbbb222")}\\n${oldCommit("aaaaaaa111")}`,
      ],
      "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=bbbbbbb222&per_page=1":
        "1 222",
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toBe("present bbbbbbb 222\n");
    expect(outcome.stderr).toContain("GitHub API call failed");
  });

  test("an empty window is not an error", async () => {
    const outcome = await run("check-main-push-run.sh", [], {
      "api repos/octo/repo/commits?sha=main&since=": "",
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("");
  });

  test("does not judge a commit younger than the grace period", async () => {
    const justNow = new Date().toISOString();
    const outcome = await run("check-main-push-run.sh", ["fresh"], {
      "api repos/octo/repo/commits/fresh": `fresh0000 ${justNow}`,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("too-recent fresh00\n");
    expect(outcome.calls.some((call) => call.includes("/actions/"))).toBe(
      false,
    );
  });

  test("a zero grace period judges a fresh commit", async () => {
    const justNow = new Date().toISOString();
    const outcome = await run(
      "check-main-push-run.sh",
      ["fresh"],
      {
        "api repos/octo/repo/commits/fresh": `fresh0000 ${justNow}`,
        "api repos/octo/repo/actions/workflows/ci.yml/runs?event=push&head_sha=fresh0000&per_page=1":
          "0 ",
        [activity]: "pr_merge fresh0000 later0000",
      },
      { MIN_AGE_MINUTES: "0" },
    );

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe("missing fresh00\n");
  });
});

describe("check-agent-sdk-compat-job.sh", () => {
  const created = "2026-09-22T04:55:23Z";
  const runUrl = "https://github.com/octo/repo/actions/runs/555";
  const runQuery = "api repos/octo/repo/actions/runs/555 --jq";
  const jobsQuery =
    "api repos/octo/repo/actions/runs/555/jobs?filter=all&per_page=30";
  const issuesQuery = `api repos/octo/repo/issues?labels=ci-agent-sdk-compat-failure&state=all&since=${created}&per_page=100`;
  const commentsQuery = `api repos/octo/repo/issues/comments?since=${created}&per_page=100`;
  const completedRun = `completed ${created} ${runUrl} abc1234def`;
  const issue = (number: number, body: string) =>
    JSON.stringify({
      body,
      number,
      url: `https://api.github.com/repos/octo/repo/issues/${number}`,
    });
  const comment = (number: number, body: string) =>
    JSON.stringify({
      body,
      issue_url: `https://api.github.com/repos/octo/repo/issues/${number}`,
    });

  const failed = (conclusion: string, issues: string, comments: string) => ({
    [runQuery]: completedRun,
    [jobsQuery]: `jobs 4\\nagent-sdk-compat 1 completed ${conclusion}`,
    [issuesQuery]: issues,
    [commentsQuery]: comments,
  });

  test("a timed-out job that no issue names is unreported", async () => {
    const outcome = await run(
      "check-agent-sdk-compat-job.sh",
      ["555"],
      failed(
        "timed_out",
        `[${issue(12, "[run 554](https://github.com/octo/repo/actions/runs/554)")}]`,
        "[]",
      ),
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe(`unreported timed_out ${runUrl} abc1234def\n`);
    // Only what changed after the run began can name it; the list endpoints,
    // not search, and closed issues too.
    const jobs = outcome.calls.find((call) => call.startsWith(jobsQuery));
    expect(jobs).toContain("--paginate");
    expect(jobs).toContain('select(.name == "agent-sdk-compat")');
    expect(outcome.calls.some((call) => call.startsWith(issuesQuery))).toBe(
      true,
    );
    expect(outcome.calls.some((call) => call.startsWith(commentsQuery))).toBe(
      true,
    );
    expect(outcome.calls.some((call) => call.includes("search"))).toBe(false);
  });

  test("a failure the in-run step already opened an issue for is reported", async () => {
    const outcome = await run(
      "check-agent-sdk-compat-job.sh",
      ["555"],
      failed(
        "failure",
        `[${issue(12, `agent-sdk-compat failed ([run 555](${runUrl})).`)}]`,
        "[]",
      ),
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("reported failure\n");
  });

  test("a comment on a labelled issue, across pages, counts as reported", async () => {
    // Two pages of issues and of comments, printed back to back as gh
    // --paginate does; #13 may be closed, which acknowledges the run too.
    const outcome = await run(
      "check-agent-sdk-compat-job.sh",
      ["555"],
      failed(
        "cancelled",
        `[${issue(12, "older")}][${issue(13, "older still")}]`,
        `[${comment(12, "unrelated")}][${comment(13, `[run 555](${runUrl})`)}]`,
      ),
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("reported cancelled\n");
  });

  test("a comment naming the run on an unlabelled issue does not count", async () => {
    const outcome = await run(
      "check-agent-sdk-compat-job.sh",
      ["555"],
      failed("failure", `[${issue(12, "older")}]`, `[${comment(99, runUrl)}]`),
    );

    expect(outcome.stdout).toBe(`unreported failure ${runUrl} abc1234def\n`);
  });

  test("a longer run id that starts with this one does not count", async () => {
    const outcome = await run(
      "check-agent-sdk-compat-job.sh",
      ["555"],
      failed(
        "failure",
        `[${issue(12, "https://github.com/octo/repo/actions/runs/5551")}]`,
        "[]",
      ),
    );

    expect(outcome.stdout).toBe(`unreported failure ${runUrl} abc1234def\n`);
  });

  for (const conclusion of ["success", "skipped"]) {
    test(`a ${conclusion} job is ok without looking at issues`, async () => {
      const outcome = await run("check-agent-sdk-compat-job.sh", ["555"], {
        [runQuery]: completedRun,
        [jobsQuery]: `jobs 4\\nagent-sdk-compat 1 completed ${conclusion}`,
      });

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toBe(`ok ${conclusion}\n`);
    });
  }

  test("the newest attempt that ran the job is judged, across pages", async () => {
    // Attempt 3 reran only `integration`, so it has no agent-sdk-compat line;
    // attempt 1 failed and attempt 2 reran agent-sdk-compat and passed.
    const outcome = await run("check-agent-sdk-compat-job.sh", ["555"], {
      [runQuery]: completedRun,
      [jobsQuery]:
        "jobs 5\\nagent-sdk-compat 2 completed success\\nagent-sdk-compat 1 completed failure\\njobs 4",
    });

    expect(outcome.stdout).toBe("ok success\n");
  });

  test("a rerun of some other job does not bury an earlier agent-sdk-compat failure", async () => {
    // Attempt 2 reran only `integration`; the latest-only view would have no
    // agent-sdk-compat job and call it absent.
    const outcome = await run("check-agent-sdk-compat-job.sh", ["555"], {
      [runQuery]: completedRun,
      [jobsQuery]: "jobs 5\\nagent-sdk-compat 1 completed cancelled",
      [issuesQuery]: "[]",
      [commentsQuery]: "[]",
    });

    expect(outcome.stdout).toBe(`unreported cancelled ${runUrl} abc1234def\n`);
  });

  test("a 502 on the jobs listing is asked again before it counts", async () => {
    const outcome = await run("check-agent-sdk-compat-job.sh", ["555"], {
      [runQuery]: completedRun,
      [jobsQuery]: ["FAIL", "jobs 4\\nagent-sdk-compat 1 completed success"],
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("ok success\n");
    expect(
      outcome.calls.filter((call) => call.startsWith(jobsQuery)),
    ).toHaveLength(2);
  });

  test("a listing that keeps failing still ends the check with exit 2", async () => {
    const outcome = await run("check-agent-sdk-compat-job.sh", ["555"], {
      [runQuery]: completedRun,
      [jobsQuery]: "FAIL",
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("GitHub API call failed: runs/555/jobs");
    expect(
      outcome.calls.filter((call) => call.startsWith(jobsQuery)),
    ).toHaveLength(3);
  });

  test("a job still running is pending", async () => {
    const outcome = await run("check-agent-sdk-compat-job.sh", ["555"], {
      [runQuery]: `in_progress ${created} ${runUrl} abc1234def`,
      [jobsQuery]: "jobs 4\\nagent-sdk-compat 1 in_progress null",
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("pending in_progress\n");
  });

  test("a run whose other jobs ran but no agent-sdk-compat job predates the job", async () => {
    // Failed or not: a commit whose ci.yml had no agent-sdk-compat job gave no
    // harness signal to lose. Pages add up.
    const outcome = await run("check-agent-sdk-compat-job.sh", ["555"], {
      [runQuery]: completedRun,
      [jobsQuery]: "jobs 0\\njobs 1",
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("ok absent\n");
  });

  test("ci.yml still names the job agent-sdk-compat and links the run in its issue", async () => {
    // A rename would turn every run into `ok absent` without a word, and an
    // in-run issue without the run URL would be reported a second time.
    const workflow = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/^ {2}agent-sdk-compat:$/m);
    const job = workflow.slice(workflow.search(/^ {2}agent-sdk-compat:$/m));
    expect(job).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text
      "RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow text
    expect(job).toContain("[run ${GITHUB_RUN_ID}](${RUN_URL})");
  });

  test("a finished run with no jobs at all is a missing conclusion", async () => {
    const outcome = await run("check-agent-sdk-compat-job.sh", ["555"], {
      [runQuery]: completedRun,
      [jobsQuery]: "jobs 0",
      [issuesQuery]: "[]",
      [commentsQuery]: "[]",
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe(`unreported missing ${runUrl} abc1234def\n`);
  });

  test("an unfinished run without an agent-sdk-compat job yet is pending", async () => {
    const outcome = await run("check-agent-sdk-compat-job.sh", ["555"], {
      [runQuery]: `queued ${created} ${runUrl} abc1234def`,
      [jobsQuery]: "jobs 0",
    });

    expect(outcome.stdout).toBe("pending queued\n");
  });

  test("a failed lookup exits 2 and prints no verdict", async () => {
    // No reply for the comments query: the fake fails it like an API error.
    const outcome = await run("check-agent-sdk-compat-job.sh", ["555"], {
      [runQuery]: completedRun,
      [jobsQuery]: "jobs 4\\nagent-sdk-compat 1 completed failure",
      [issuesQuery]: "[]",
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toContain("GitHub API call failed");
  });

  test("refuses a run id that is not a number before touching GitHub", async () => {
    const outcome = await run("check-agent-sdk-compat-job.sh", ["55a"], {});

    expect(outcome.exitCode).toBe(2);
    expect(outcome.calls).toEqual([]);
  });
});
