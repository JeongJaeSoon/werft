import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  type BootstrapClaimResponse,
  IMAGE_GIT_AUTHOR,
  type WorkerScope,
} from "@werft-ai/contracts";
import {
  ATTRIBUTION_PROBLEMS,
  type AttributionExpectation,
  type AttributionMismatch,
  rangeAttribution,
  type WorkerGatewayClient,
} from "@werft-ai/runtime-core";
import type { WorkerLogger } from "./worker-host.ts";

const run = promisify(execFile);

/** Where the image installs the repair tool (apps/worker/Dockerfile). */
export const REPAIR_TOOL_PATH = "/usr/local/bin/werft-repair-attribution";
const REPAIR_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 30_000;

/**
 * Every outcome that ran the tool carries the commits the server protected:
 * they were made under earlier claims, so they are neither remade nor judged
 * against this claim's values.
 */
type Ran = {
  protectedCommits: readonly string[];
  head?: string | undefined;
};

export type RepairOutcome =
  | ({ status: "clean" } & Ran)
  | ({ status: "repaired" } & Ran)
  /** Two of the session's commits are parents of one merge; nothing written. */
  | ({ status: "nested_merge" } & Ran)
  /** Not attempted: no tool, no server answer. The pushes' checks still hold. */
  | { status: "skipped"; reason: string }
  | ({ status: "failed"; detail: string } & Ran);

/**
 * What the claim asked this session's commits to carry, or null when it asked
 * for nothing checkable (a server without `git` or `git_author`). The server
 * keeps the same values for the push's own check.
 */
export function claimExpectation(
  claim: Pick<BootstrapClaimResponse, "session_id" | "git" | "git_author">,
): AttributionExpectation | null {
  if (claim.git === undefined || claim.git_author === undefined) return null;
  return {
    author: claim.git_author ?? IMAGE_GIT_AUTHOR,
    coAuthor: claim.git.co_author ?? null,
    agentSession: claim.git.session_url ?? claim.session_id,
  };
}

type CoAuthor = { name: string; email: string } | null;

const turnCoAuthors = new WeakMap<object, Map<string, CoAuthor>>();

export function noteTurnCoAuthor(claim: object, coAuthor: CoAuthor): void {
  const seen = turnCoAuthors.get(claim) ?? new Map<string, CoAuthor>();
  seen.set(
    coAuthor === null ? "" : `${coAuthor.name}\n${coAuthor.email}`,
    coAuthor,
  );
  turnCoAuthors.set(claim, seen);
}

/**
 * Every bundle a commit of this claim may carry: the claim's own, and one for
 * each co-author a turn named. The server keeps the same set for the push.
 */
export function claimExpectations(
  claim: Pick<
    BootstrapClaimResponse,
    "session_id" | "git" | "git_author" | "git_issued"
  >,
): AttributionExpectation[] {
  const base = claimExpectation(claim);
  if (base === null) return [];
  const issued = (claim.git_issued ?? []).map((bundle) => ({
    author: bundle.author,
    coAuthor: bundle.co_author,
    agentSession: bundle.agent_session,
  }));
  const turns = [...(turnCoAuthors.get(claim)?.values() ?? [])].map(
    (coAuthor) => ({ ...base, coAuthor }),
  );
  return [base, ...issued, ...turns];
}

/**
 * At a turn's end, with the checkpoint lease held and the engine stopped:
 * remakes this session's own commits whose attribution is wrong. The tool
 * (apps/worker/git-hooks/werft-repair-attribution) is plumbing only and writes
 * one ref update at the end, or nothing. Never throws: a repair that cannot
 * run leaves the commits for the request_push and push checks to refuse.
 */
export async function repairAttribution(input: {
  root: string;
  home: string;
  /** Absent outside the image. */
  tool: string | undefined;
  gateway: Partial<Pick<WorkerGatewayClient, "protectedCommits">>;
  scope: WorkerScope;
  /** A directory this call may write one file into. */
  spool: string;
  judged?: readonly string[];
  logger: WorkerLogger;
}): Promise<RepairOutcome> {
  const { tool, gateway } = input;
  if (tool === undefined) return { status: "skipped", reason: "no_tool" };
  if (gateway.protectedCommits === undefined) {
    return { status: "skipped", reason: "no_gateway_route" };
  }
  let commits: readonly string[];
  try {
    commits = (await gateway.protectedCommits(input.scope)).commits;
  } catch (error) {
    // An older server has no route; a failing one leaves the commits to the
    // pushes' checks. Remaking without the boundary could rewrite pushed
    // history, so there is no repair without it.
    return {
      status: "skipped",
      reason: `protected_commits: ${error instanceof Error ? error.name : "error"}`,
    };
  }
  const file = `${input.spool}/protected-commits`;
  await writeFile(
    file,
    `${[...commits, ...(input.judged ?? [])].join("\n")}\n`,
  );
  try {
    const { stdout } = await run(tool, [input.root, file], {
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: input.home,
        TMPDIR: input.spool,
        // Where git finds the system config, when it is not /etc/gitconfig.
        ...(process.env.GIT_CONFIG_SYSTEM === undefined
          ? {}
          : { GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM }),
      },
      timeout: REPAIR_TIMEOUT_MS,
    });
    const line = stdout.trim();
    const head = await run("git", ["rev-parse", "HEAD"], {
      cwd: input.root,
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
      timeout: GIT_TIMEOUT_MS,
    }).then(
      ({ stdout: tip }) => tip.trim(),
      () => undefined,
    );
    return line.startsWith("repaired ")
      ? { status: "repaired", protectedCommits: commits, head }
      : { status: "clean", protectedCommits: commits, head };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    if (failure.code === 2) {
      return { status: "nested_merge", protectedCommits: commits };
    }
    input.logger.warn("worker.attribution_repair.failed", {
      detail: (failure.stdout ?? "").trim().slice(0, 200),
    });
    return {
      status: "failed",
      detail: (failure.stdout ?? "").trim().slice(0, 200),
      protectedCommits: commits,
    };
  }
}

/**
 * The commits this workspace holds that no remote-tracking ref does, judged
 * against the claim's values. Advice for request_push: the worker shares a
 * container with the agent, and the push re-checks from what the server
 * issued. Empty when nothing is wrong, or when there is nothing to judge
 * against; a check that fails to run reports every problem on the tip.
 */
export async function workspaceMismatches(input: {
  root: string;
  tip: string;
  expectations: readonly AttributionExpectation[];
  stripEmails: readonly string[];
  /**
   * The server's protected commits, made under earlier claims whose values
   * this worker does not know. Null when the repair did not get them: with
   * no way to tell those commits apart, the push's own check judges alone.
   */
  protectedCommits: readonly string[] | null;
}): Promise<AttributionMismatch[]> {
  if (input.expectations.length === 0 || input.protectedCommits === null) {
    return [];
  }
  try {
    const git = async (args: readonly string[]) => {
      try {
        const { stdout } = await run(
          "git",
          [
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "log.showSignature=false",
            "-c",
            "gpg.program=/bin/false",
            "-c",
            "gpg.ssh.program=/bin/false",
            "-c",
            "gpg.x509.program=/bin/false",
            ...args,
          ],
          {
            cwd: input.root,
            env: {
              PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
              // A missing object must not start a fetch from a remote the
              // repository's config names; no transport is allowed here.
              GIT_NO_LAZY_FETCH: "1",
              GIT_ALLOW_PROTOCOL: "none",
              LC_ALL: "C",
            },
            maxBuffer: 16 * 1024 * 1024,
            timeout: GIT_TIMEOUT_MS,
          },
        );
        return { exitCode: 0, stdout };
      } catch (error) {
        return {
          exitCode: (error as { code?: number }).code ?? 1,
          stdout: "",
        };
      }
    };
    // Only the ones this repository holds can be excluded.
    const held: string[] = [];
    for (const sha of input.protectedCommits) {
      if (!/^[0-9a-f]{40}$/.test(sha)) continue;
      if ((await git(["cat-file", "-e", `${sha}^{commit}`])).exitCode === 0) {
        held.push(sha);
      }
    }
    const judged = await rangeAttribution(git, {
      tip: input.tip,
      not: ["--remotes", ...held],
      expectations: input.expectations,
      stripEmails: input.stripEmails,
      trailersOf: isolatedTrailers,
    });
    return judged.status === "ok" ? judged.mismatches : unverified(input.tip);
  } catch {
    return unverified(input.tip);
  }
}

/**
 * The trailer block git reads in `message`, parsed outside any repository and
 * with no config, as the commit hook does: the workspace's own `trailer.*`
 * settings cannot rename a key and hide a line. Null when git fails.
 */
async function isolatedTrailers(message: string): Promise<string | null> {
  try {
    const pending = run(
      "git",
      ["interpret-trailers", "--parse", "--no-divider"],
      {
        cwd: "/",
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_COUNT: "0",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        maxBuffer: 16 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
      },
    );
    pending.child.stdin?.end(message);
    return (await pending).stdout;
  } catch {
    return null;
  }
}

/**
 * A check that could not run is not a pass. The entry keeps the checkpoint
 * out of the protected list (see checkpoint-service protectedCommits), so the
 * next turn looks again, and request_push refuses until a check has run.
 */
function unverified(tip: string): AttributionMismatch[] {
  return [{ commit: tip, problems: [...ATTRIBUTION_PROBLEMS] }];
}
