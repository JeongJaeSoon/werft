import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What the Pages site is built from. Every run of pages.yml waits in one
// group, where GitHub keeps one waiting run and drops the rest, so the script
// must give the same answer whichever run is left to ask: these tests ask it
// as the run that survived, on a real git history with a fake `gh`.

const script = join(
  import.meta.dir,
  "..",
  ".github",
  "scripts",
  "pages-target.sh",
);

type Tags = Record<string, "c1" | "c2" | "c3" | "c4" | "side">;
type Commit = "c1" | "c2" | "c3" | "c4" | "c5" | "side";
type Run = {
  /** The ref and event the run was started on. */
  ref: string;
  event?: "push" | "workflow_dispatch";
  at: Exclude<Commit, "c5">;
  /**
   * The head commit of the newest manual run on main in the run list. c5 is
   * pushed to main while the script reads that list.
   */
  manual?: Commit;
  /** That manual run was started after this run, so the list names it first. */
  manualIsNewer?: boolean;
  listFails?: boolean;
  /** How many reads of the run list do not show this run, or the fix, yet. */
  lagging?: number;
  /** This run is a rerun: its attempt, and the attempt the list shows. */
  attempt?: number;
  listedAttempt?: number;
};
type History = Record<Commit, string>;

/**
 * main is c1 - c2 - c3 - c4; `side` branches off c1 and is never merged.
 * Tags are annotated, as the release makes them. The run list holds older
 * runs of other kinds around the ones a test names.
 */
function ask(tags: Tags, run: Run) {
  const directory = mkdtempSync(join(tmpdir(), "pages-target-"));
  try {
    const git = (cwd: string, ...args: string[]) => {
      const out = Bun.spawnSync(
        [
          "git",
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.test",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "tag.gpgsign=false",
          ...args,
        ],
        { cwd, env: { PATH: process.env.PATH ?? "", HOME: directory } },
      );
      if (out.exitCode !== 0) throw new Error(out.stderr.toString());
      return out.stdout.toString().trim();
    };
    const origin = join(directory, "origin");
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    const commit = (message: string) => {
      git(origin, "commit", "-q", "--allow-empty", "-m", message);
      return git(origin, "rev-parse", "HEAD");
    };
    const c1 = commit("c1");
    git(origin, "checkout", "-q", "-b", "side");
    const side = commit("side");
    git(origin, "checkout", "-q", "main");
    const history: History = {
      c1,
      side,
      c2: commit("c2"),
      c3: commit("c3"),
      c4: commit("c4"),
      c5: "",
    };
    for (const [name, at] of Object.entries(tags)) {
      git(origin, "tag", "-a", "-m", name, name, history[at]);
    }
    // As actions/checkout with fetch-depth: 0 leaves it: every branch and tag.
    const clone = join(directory, "clone");
    git(directory, "clone", "-q", origin, clone);
    git(clone, "checkout", "-q", "--detach", history[run.at]);
    // c5 exists but is not on main yet: the fake gh pushes it while the script
    // reads the run list, after this checkout.
    history.c5 = commit("c5");
    git(origin, "update-ref", "refs/heads/main", history.c4);

    // "<id> <attempt> <event> <branch> <commit>", newest first, as the script's
    // --jq prints the list.
    const event = run.event ?? "push";
    const branch = run.ref.replace(/^refs\/(heads|tags)\//, "");
    const attempt = run.attempt ?? 1;
    const own = `4242 ${run.listedAttempt ?? attempt} ${event} ${branch} ${history[run.at]}`;
    const manual = run.manual
      ? [
          `${run.manualIsNewer ? 4300 : 4100} 1 workflow_dispatch main ${history[run.manual]}`,
        ]
      : [];
    const fresh = run.manualIsNewer ? [...manual, own] : [own, ...manual];
    const old = [
      `3003 1 workflow_dispatch v1.3.0 ${c1}`,
      `3002 1 push main ${history.c4}`,
      `3001 2 workflow_dispatch side ${side}`,
    ];

    const bin = join(directory, "bin");
    mkdirSync(bin);
    const calls = join(directory, "calls.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"${calls}"
if [ -n "\${FAKE_LIST_FAILS:-}" ]; then echo "gh: HTTP 502" >&2; exit 1; fi
# The list shows neither this run nor the fix until it has caught up.
reads=$(cat "${directory}/reads" 2>/dev/null || echo 0)
echo $((reads + 1)) >"${directory}/reads"
[ -z "\${FAKE_PUSH:-}" ] || git -C "${origin}" update-ref refs/heads/main "\${FAKE_PUSH}"
[ "$reads" -lt "\${FAKE_LAGGING}" ] || printf '%s\\n' "\${FAKE_FRESH}"
printf '%s\\n' "\${FAKE_OLD}"
`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const output = join(directory, "output");
    const out = Bun.spawnSync([script], {
      cwd: clone,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: directory,
        GH_REPO: "octo/repo",
        GITHUB_REF: run.ref,
        GITHUB_SHA: history[run.at],
        GITHUB_EVENT_NAME: run.event ?? "push",
        GITHUB_RUN_ID: "4242",
        GITHUB_RUN_ATTEMPT: String(attempt),
        GITHUB_OUTPUT: output,
        PAGES_LIST_POLL_SECONDS: "0",
        FAKE_LAGGING: String(run.lagging ?? 0),
        FAKE_FRESH: fresh.join("\n"),
        FAKE_OLD: old.join("\n"),
        FAKE_LIST_FAILS: run.listFails ? "1" : "",
        FAKE_PUSH: run.manual === "c5" ? history.c5 : "",
      },
    });
    const written = existsSync(output) ? readFileSync(output, "utf8") : "";
    const field = (name: string) =>
      new RegExp(`^${name}=(.*)$`, "m").exec(written)?.[1];
    const sha = field("sha");
    return {
      exitCode: out.exitCode,
      stdout: out.stdout.toString(),
      stderr: out.stderr.toString(),
      // The commit by its name in the history above.
      at: Object.entries(history).find(([, id]) => id === sha)?.[0],
      source: field("source"),
      calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const released: Tags = { "v1.3.0": "c1", "v1.4.0": "c2" };
const SLOW = 30_000;

describe("pages-target.sh", () => {
  test(
    "a run on the newest release tag deploys that release",
    () => {
      const got = ask(released, { ref: "refs/tags/v1.4.0", at: "c2" });
      expect(got.stderr).toBe("");
      expect(got).toMatchObject({ exitCode: 0, at: "c2", source: "v1.4.0" });
      // Every run of the workflow, all pages: this run may be far down.
      expect(got.calls).toContain(
        "api --paginate repos/octo/repo/actions/workflows/pages.yml/runs?per_page=100",
      );
    },
    SLOW,
  );

  // The v1.4.0 tag push was waiting and this later run replaced it.
  test(
    "a redeploy of an older tag ends on the newest release, not on the old one",
    () => {
      const got = ask(released, {
        ref: "refs/tags/v1.3.0",
        event: "workflow_dispatch",
        at: "c1",
      });
      expect(got).toMatchObject({ exitCode: 0, at: "c2", source: "v1.4.0" });
    },
    SLOW,
  );

  // The manual run on main (c3) was waiting and this tag push replaced it; the
  // run list still names its commit.
  test(
    "a tag pushed on an older commit does not drop a docs fix on main",
    () => {
      const got = ask(
        { ...released, "v1.3.1": "c1" },
        { ref: "refs/tags/v1.3.1", at: "c1", manual: "c3" },
      );
      expect(got).toMatchObject({ exitCode: 0, at: "c3", source: "main" });
    },
    SLOW,
  );

  test(
    "the next release takes the site back from the docs fix",
    () => {
      const got = ask(
        { ...released, "v1.5.0": "c4" },
        { ref: "refs/tags/v1.5.0", at: "c4", manual: "c3" },
      );
      expect(got).toMatchObject({ exitCode: 0, at: "c4", source: "v1.5.0" });
    },
    SLOW,
  );

  test(
    "a manual run on main deploys its own commit, or a newer manual run's",
    () => {
      const own = ask(released, {
        ref: "refs/heads/main",
        event: "workflow_dispatch",
        at: "c3",
      });
      expect(own).toMatchObject({ exitCode: 0, at: "c3", source: "main" });
      // A later one is already waiting behind this run.
      const newer = ask(released, {
        ref: "refs/heads/main",
        event: "workflow_dispatch",
        at: "c3",
        manual: "c4",
        manualIsNewer: true,
      });
      expect(newer).toMatchObject({ exitCode: 0, at: "c4", source: "main" });
    },
    SLOW,
  );

  test(
    "a manual run from before the release is history",
    () => {
      const got = ask(released, {
        ref: "refs/tags/v1.4.0",
        at: "c2",
        manual: "c1",
      });
      expect(got).toMatchObject({ exitCode: 0, at: "c2", source: "v1.4.0" });
    },
    SLOW,
  );

  test(
    "a prerelease, or a hotfix of an older line tagged later, changes nothing",
    () => {
      const tags: Tags = {
        ...released,
        "v1.3.5": "c3",
        "v1.5.0-rc.1": "c4",
      };
      for (const [ref, at] of [
        ["refs/tags/v1.5.0-rc.1", "c4"],
        ["refs/tags/v1.3.5", "c3"],
      ] as const) {
        const got = ask(tags, { ref, at });
        expect(got).toMatchObject({ exitCode: 0, at: "c2", source: "v1.4.0" });
      }
    },
    SLOW,
  );

  test(
    "a tag or a manual-run commit that is not on main is never deployed",
    () => {
      const got = ask(
        { ...released, "v9.0.0": "side" },
        { ref: "refs/tags/v9.0.0", at: "side", manual: "side" },
      );
      expect(got).toMatchObject({ exitCode: 0, at: "c2", source: "v1.4.0" });
      expect(got.stdout).toContain("v9.0.0 is not on main");
    },
    SLOW,
  );

  // The fix was replaced a moment ago and the list has not caught up.
  test(
    "reads the docs fix only once the run list shows this run",
    () => {
      const got = ask(
        { ...released, "v1.3.1": "c1" },
        { ref: "refs/tags/v1.3.1", at: "c1", manual: "c3", lagging: 2 },
      );
      expect(got).toMatchObject({ exitCode: 0, at: "c3", source: "main" });
      expect(got.calls.trim().split("\n")).toHaveLength(3);
    },
    SLOW,
  );

  test(
    "a run list that never shows this run fails the run",
    () => {
      const got = ask(released, {
        ref: "refs/tags/v1.4.0",
        at: "c2",
        manual: "c3",
        lagging: 99,
      });
      expect(got.exitCode).toBe(1);
      expect(got.stderr).toContain("does not show this run (4242, attempt 1)");
      expect(got.at).toBeUndefined();
    },
    SLOW,
  );

  // The list shows this run from its first attempt, which says nothing about
  // a fix started since.
  test(
    "a rerun trusts the run list only once it shows this attempt",
    () => {
      const tags: Tags = { ...released, "v1.3.1": "c1" };
      const rerun = {
        ref: "refs/tags/v1.3.1",
        at: "c1",
        manual: "c3",
      } as const;
      const stale = ask(tags, { ...rerun, attempt: 2, listedAttempt: 1 });
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr).toContain("attempt 2");
      const caught = ask(tags, { ...rerun, attempt: 2 });
      expect(caught).toMatchObject({ exitCode: 0, at: "c3", source: "main" });
    },
    SLOW,
  );

  // The fix reaches main, and its run is started, while this run reads the list.
  test(
    "a docs fix merged after this run started is fetched before it is judged",
    () => {
      const got = ask(released, {
        ref: "refs/tags/v1.4.0",
        at: "c2",
        manual: "c5",
      });
      expect(got).toMatchObject({ exitCode: 0, at: "c5", source: "main" });
    },
    SLOW,
  );

  test(
    "a run list that cannot be read fails the run instead of dropping the fix",
    () => {
      const got = ask(released, {
        ref: "refs/tags/v1.4.0",
        at: "c2",
        listFails: true,
      });
      expect(got.exitCode).toBe(1);
      expect(got.stderr).toContain("could not read the runs of pages.yml");
      expect(got.at).toBeUndefined();
    },
    SLOW,
  );

  test(
    "with no stable release and no manual run there is nothing to deploy",
    () => {
      const got = ask(
        { "v0.1.0-rc.1": "c2" },
        { ref: "refs/tags/v0.1.0-rc.1", at: "c2" },
      );
      expect(got.exitCode).toBe(1);
      expect(got.stderr).toContain("nothing to deploy");
      expect(got.at).toBeUndefined();
    },
    SLOW,
  );
});
