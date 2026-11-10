import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitPushInput, GitPushResult, Pushable } from "@werft-ai/platform";
import {
  DEFAULT_MAX_GIT_MEMORY_BYTES,
  defaultGitRunner,
  type GitCommandRunner,
  type GitResourceLimits,
  gitRefNameAcceptable,
  rangeAttribution,
} from "@werft-ai/storage";

const DEFAULT_GIT_PUSH_TIMEOUT_MS = 5 * 60_000;

/**
 * The git under the platform's push: a throwaway bare repository fed only the
 * checkpoint's bundles, and one push of `<commit>:<ref>`. That makes the
 * pinned commit the ref's tip, so every ancestor the remote does not hold yet
 * (the session's earlier, unpushed commits) goes up with it.
 *
 * The bundles were written by the agent, so nothing in them may run here.
 * The repository is bare (no checkout, so no filter, attribute, submodule or
 * fsmonitor ever applies), starts from no template (no hooks), and every git
 * reads no user or system config. A bundle carries refs and objects only, not
 * config.
 *
 * Errors carry exit codes and fixed wording only. What git prints comes in
 * part from the remote, and is not passed on.
 */
export function createGitPusher(
  options: {
    gitRunner?: GitCommandRunner;
    timeoutMs?: number;
    maxGitMemoryBytes?: number;
  } = {},
): Pushable {
  const gitRunner = options.gitRunner ?? defaultGitRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_PUSH_TIMEOUT_MS;
  const memoryBytes = options.maxGitMemoryBytes ?? DEFAULT_MAX_GIT_MEMORY_BYTES;

  return {
    async push(input: GitPushInput): Promise<GitPushResult> {
      const repository = join(input.directory, "repo.git");
      let chainBytes = 0;
      for (const bundle of input.bundles)
        chainBytes += (await stat(bundle)).size;
      const limits: GitResourceLimits = {
        cpuSeconds: Math.ceil(timeoutMs / 1000),
        fileSizeBytes: chainBytes + memoryBytes + 1024 * 1024,
        memoryBytes,
      };
      const baseEnv = {
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
        TMPDIR: input.directory,
      };
      const remoteEnv: Record<string, string> = {
        ...baseEnv,
        GIT_ALLOW_PROTOCOL: "http:https",
        GIT_CONFIG_COUNT: String(input.headers.length + 1),
        GIT_CONFIG_KEY_0: "http.followRedirects",
        GIT_CONFIG_VALUE_0: "false",
      };
      input.headers.forEach(([name, value], index) => {
        remoteEnv[`GIT_CONFIG_KEY_${index + 1}`] =
          `http.${input.remoteUrl}.extraHeader`;
        remoteEnv[`GIT_CONFIG_VALUE_${index + 1}`] = `${name}: ${value}`;
      });
      const git = (args: readonly string[], remote = false) => {
        const left = Math.min(timeoutMs, input.deadline - Date.now());
        if (left <= 0) throw new Error("the push ran past its deadline");
        return gitRunner(
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            ...args,
          ],
          {
            clearGitEnvironment: true,
            cwd: input.directory,
            env: remote ? remoteEnv : baseEnv,
            limits,
            timeoutMs: left,
          },
        );
      };
      const must = async (what: string, args: readonly string[]) => {
        const result = await git(args);
        if (result.exitCode !== 0) {
          throw new Error(`${what} failed with exit code ${result.exitCode}`);
        }
        return result.stdout;
      };

      await must("git init", [
        "init",
        "--quiet",
        "--bare",
        "--template=",
        repository,
      ]);
      const inRepo = (args: readonly string[]) => [
        "--git-dir",
        repository,
        ...args,
      ];
      for (const [index, bundle] of input.bundles.entries()) {
        const heads = await must(
          "git bundle list-heads",
          inRepo(["bundle", "list-heads", bundle]),
        );
        const refs = heads
          .split("\n")
          .map((line) => line.split(" ")[1])
          .filter((ref): ref is string => ref !== undefined && ref !== "");
        if (refs.some((ref) => !gitRefNameAcceptable(ref))) {
          throw new Error(`bundle ${index} names a ref git would not accept`);
        }
        await must(
          "git fetch",
          inRepo([
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "transfer.fsckObjects=true",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            bundle,
            ...refs.map((ref, at) => `${ref}:refs/push/${index}/${at}`),
          ]),
        );
      }
      const present = await git(
        inRepo(["cat-file", "-e", `${input.commit}^{commit}`]),
      );
      if (present.exitCode !== 0) {
        throw new Error("the bundle chain does not hold the pinned commit");
      }

      const checking =
        input.attribution !== undefined &&
        input.attribution.expectations.length > 0
          ? input.attribution
          : undefined;
      // A base ref the check cannot use must stop the push, not switch the
      // check off.
      if (checking !== undefined && !gitRefNameAcceptable(checking.baseRef)) {
        return refused(
          "attribution_mismatch",
          "the repository's base branch is not a usable ref for the attribution check",
        );
      }
      const listed = await git(
        inRepo([
          "ls-remote",
          "--symref",
          input.remoteUrl,
          "HEAD",
          input.ref,
          ...(checking === undefined ? [] : [checking.baseRef]),
        ]),
        true,
      );
      if (listed.exitCode !== 0) {
        return refused(
          "push_failed",
          `git ls-remote exited ${listed.exitCode}`,
        );
      }
      const remote = parseLsRemote(listed.stdout);
      if (remote.head === input.ref) {
        return refused("default_branch", "the target is the remote's HEAD");
      }
      const previousCommit = remote.refs.get(input.ref) ?? null;
      if (previousCommit === input.commit) {
        return { status: "pushed", previousCommit };
      }
      if (previousCommit !== null) {
        const ancestor = await git(
          inRepo(["merge-base", "--is-ancestor", previousCommit, input.commit]),
        );
        if (ancestor.exitCode !== 0) {
          return refused(
            "non_fast_forward",
            "the remote branch is not an ancestor of the pinned commit",
          );
        }
      } else if (remote.head !== null) {
        // A new branch must build on the repository it goes to: a session
        // working on several repositories could otherwise put one's content
        // into another. What the bundles already hold is not fetched again.
        if (!gitRefNameAcceptable(remote.head)) {
          return refused("push_failed", "the remote's HEAD is not a branch");
        }
        const fetched = await git(
          inRepo([
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "transfer.fsckObjects=true",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            input.remoteUrl,
            `+${remote.head}:refs/push/base`,
          ]),
          true,
        );
        if (fetched.exitCode !== 0) {
          return refused("push_failed", `git fetch exited ${fetched.exitCode}`);
        }
        const common = await git(
          inRepo(["merge-base", input.commit, "refs/push/base"]),
        );
        if (common.exitCode !== 0) {
          return refused(
            "unrelated_history",
            "the pinned commit shares no history with the remote's HEAD",
          );
        }
      }
      if (checking !== undefined) {
        // The tips the session's commits are told apart from, pinned by one
        // ls-remote so a branch that moves meanwhile changes nothing here:
        // the PR base, the default branch and the target as the remote has
        // them. What the bundles already hold is not fetched again.
        const tips = new Map<string, string>();
        const base = remote.refs.get(checking.baseRef);
        if (base !== undefined) tips.set("base", base);
        const defaultTip = remote.refs.get("HEAD");
        if (defaultTip !== undefined) tips.set("default", defaultTip);
        if (previousCommit !== null) tips.set("target", previousCommit);
        for (const [name, sha] of tips) {
          const held = await git(inRepo(["cat-file", "-e", `${sha}^{commit}`]));
          if (held.exitCode === 0) continue;
          const fetched = await git(
            inRepo([
              "-c",
              "fetch.fsckObjects=true",
              "-c",
              "transfer.fsckObjects=true",
              "fetch",
              "--quiet",
              "--no-tags",
              "--no-write-fetch-head",
              input.remoteUrl,
              `${sha}:refs/push/check/${name}`,
            ]),
            true,
          );
          if (fetched.exitCode !== 0) {
            return refused(
              "push_failed",
              `git fetch of the ${name} tip exited ${fetched.exitCode}`,
            );
          }
        }
        const judged = await rangeAttribution(
          async (args) => {
            const result = await git(inRepo(args));
            return {
              exitCode: result.exitCode,
              stdout: result.stdout,
              ...(result.truncated === true ? { truncated: true } : {}),
            };
          },
          {
            tip: input.commit,
            not: [...tips.values()],
            expectations: checking.expectations,
            stripEmails: checking.stripEmails,
          },
        );
        if (judged.status === "unreadable") {
          return refused(
            "attribution_mismatch",
            "the new commits could not be read for the attribution check",
          );
        }
        if (judged.mismatches.length > 0) {
          return {
            status: "refused",
            refusal: "attribution_mismatch",
            detail: `${judged.mismatches.length} of ${judged.checked} new commits lack the issued attribution`,
            mismatches: judged.mismatches,
          };
        }
      }
      const pushed = await git(
        inRepo([
          "push",
          "--porcelain",
          "--no-verify",
          "--no-follow-tags",
          "--no-recurse-submodules",
          input.remoteUrl,
          `${input.commit}:${input.ref}`,
        ]),
        true,
      );
      if (pushed.exitCode !== 0) {
        if (workflowsPermissionRefused(pushed.stdout)) {
          return {
            status: "refused",
            refusal: "push_failed",
            detail:
              "the remote refused a workflow change without workflows permission",
            reasonCode: "workflows_permission_missing",
          };
        }
        return /^!\t.*\[rejected\]/m.test(pushed.stdout)
          ? refused("non_fast_forward", "the remote rejected the update")
          : refused("push_failed", `git push exited ${pushed.exitCode}`);
      }
      return { status: "pushed", previousCommit };
    },
  };
}

/**
 * GitHub's porcelain line for a push an App token may not make:
 * `! <src>:<dst> [remote rejected] (refusing to allow a GitHub App to create
 * or update workflow `.github/workflows/x.yml` without `workflows` permission)`.
 * Only classified; the text itself is never kept.
 */
export function workflowsPermissionRefused(stdout: string): boolean {
  return /^!\t.*\[remote rejected\].*without `?workflows`? permission/m.test(
    stdout,
  );
}

function refused(
  refusal: Extract<GitPushResult, { status: "refused" }>["refusal"],
  detail: string,
): GitPushResult {
  return { status: "refused", refusal, detail };
}

/** `ls-remote --symref` output: where HEAD points, and each ref's commit. */
export function parseLsRemote(stdout: string): {
  head: string | null;
  refs: Map<string, string>;
} {
  let head: string | null = null;
  const refs = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [left, name] = line.split("\t");
    if (left === undefined || name === undefined) continue;
    if (left.startsWith("ref: ")) {
      if (name === "HEAD") head = left.slice("ref: ".length);
    } else if (/^[0-9a-f]{40}$/.test(left)) {
      refs.set(name, left);
    }
  }
  return { head, refs };
}
