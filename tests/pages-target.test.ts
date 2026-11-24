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
type Run = {
  /** The ref and event the run was started on. */
  ref: string;
  event?: "push" | "workflow_dispatch";
  at: keyof History;
  /** The head commit of the newest manual run on main in the run list. */
  manual?: keyof History;
  listFails?: boolean;
  /** How many reads of the run list do not show this run, or the fix, yet. */
  lagging?: number;
};
type History = Record<"c1" | "c2" | "c3" | "c4" | "side", string>;

/**
 * main is c1 - c2 - c3 - c4; `side` branches off c1 and is never merged.
 * Tags are annotated, as the release makes them.
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
    };
    for (const [name, at] of Object.entries(tags)) {
      git(origin, "tag", "-a", "-m", name, name, history[at]);
    }
    // As actions/checkout with fetch-depth: 0 leaves it: every branch and tag.
    const clone = join(directory, "clone");
    git(directory, "clone", "-q", origin, clone);
    git(clone, "checkout", "-q", "--detach", history[run.at]);

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
case "$*" in
  *branch=main*) [ "$reads" -le "\${FAKE_LAGGING}" ] || printf '%s' "\${FAKE_MANUAL}" ;;
  *)
    echo $((reads + 1)) >"${directory}/reads"
    [ "$reads" -lt "\${FAKE_LAGGING}" ] || printf '%s' "\${GITHUB_RUN_ID}"
    ;;
esac
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
        GITHUB_OUTPUT: output,
        PAGES_LIST_POLL_SECONDS: "0",
        FAKE_LAGGING: String(run.lagging ?? 0),
        FAKE_MANUAL: run.manual ? history[run.manual] : "",
        FAKE_LIST_FAILS: run.listFails ? "1" : "",
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
      expect(got.calls).toContain(
        "repos/octo/repo/actions/workflows/pages.yml/runs?event=workflow_dispatch&branch=main&per_page=1",
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
    "a manual run on main deploys its own commit, even before the run list shows it",
    () => {
      for (const manual of [undefined, "c3"] as const) {
        const got = ask(released, {
          ref: "refs/heads/main",
          event: "workflow_dispatch",
          at: "c4",
          manual,
        });
        expect(got).toMatchObject({ exitCode: 0, at: "c4", source: "main" });
      }
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
      const calls = got.calls.trim().split("\n");
      expect(calls.filter((call) => call.includes("per_page=30"))).toHaveLength(
        3,
      );
      expect(calls.at(-1)).toContain("branch=main");
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
      expect(got.stderr).toContain("does not show this run (4242)");
      expect(got.at).toBeUndefined();
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
