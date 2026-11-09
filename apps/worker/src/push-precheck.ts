import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;

/** The platform's push tool as the engine names it. */
export const REQUEST_PUSH_TOOL = "mcp__github__request_push";

/** What `request_push` refuses at the call, before any intent is recorded. */
export const UNRELATED_HISTORY_ADVICE =
  "request_push refused before the call: unrelated_history. The commit to push shares no history with {base}, the branch of the target repository it would build on, so the push would be refused when the turn ends and its pull request cancelled. Commit on top of {base} (for example create the local branch from it) and call request_push again with that branch as source_ref.";

type Git = (
  args: readonly string[],
) => Promise<{ ok: boolean; code: number; out: string }>;

/**
 * The tool precheck the runtime runs before each call: only `request_push`
 * is judged, and only for one thing the workspace can tell at once, a commit
 * that shares no history with the remote's HEAD branch, the base the push
 * itself checks a new branch against. The push
 * itself checks again on the server with the remote's HEAD; this is advice
 * that saves a turn, never the gate. Whatever cannot be judged for sure (no
 * such ref, a shallow clone, git failing) lets the call through.
 */
export function createPushPrecheck(workspaceRoot: string) {
  const git: Git = async (args) => {
    try {
      const { stdout } = await run(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        {
          cwd: workspaceRoot,
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            // No transport: a missing object is an answer, not a fetch.
            GIT_NO_LAZY_FETCH: "1",
            GIT_ALLOW_PROTOCOL: "none",
            LC_ALL: "C",
          },
          maxBuffer: 1024 * 1024,
          timeout: GIT_TIMEOUT_MS,
        },
      );
      return { ok: true, code: 0, out: stdout };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return { ok: false, code: typeof code === "number" ? code : -1, out: "" };
    }
  };
  return async (
    tool: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (tool !== REQUEST_PUSH_TOOL) return null;
    const base = await unrelatedBase(git, input);
    return base === null
      ? null
      : UNRELATED_HISTORY_ADVICE.replaceAll("{base}", base);
  };
}

/**
 * The remote's HEAD branch the pushed commit shares no history with, or
 * null when it shares history with it, or when that cannot be told.
 */
async function unrelatedBase(
  git: Git,
  input: Record<string, unknown>,
): Promise<string | null> {
  const sourceRef = input.source_ref;
  const repositoryId = input.repository_id;
  if (sourceRef !== undefined && !isPlainName(sourceRef)) return null;
  if (repositoryId !== undefined && !isPlainName(repositoryId)) return null;
  const shallow = await git(["rev-parse", "--is-shallow-repository"]);
  if (!shallow.ok || shallow.out.trim() !== "false") return null;
  const rev =
    typeof sourceRef === "string" ? `refs/heads/${sourceRef}` : "HEAD";
  const tip = await git([
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${rev}^{commit}`,
  ]);
  if (!tip.ok) return null;
  // An attached repository is the remote of its catalog id; the session's
  // own is origin, whether or not the call names it.
  let remote = "origin";
  if (typeof repositoryId === "string") {
    const named = await git(["remote"]);
    if (!named.ok) return null;
    if (named.out.split("\n").includes(repositoryId)) remote = repositoryId;
  }
  // The push compares with the remote's HEAD, so only a ref known to be
  // that HEAD is judged against: a clone records it as
  // `refs/remotes/<remote>/HEAD`. An attached repository fetches only its
  // catalog branch, which may be unrelated to the default one, and a
  // workspace may not have kept the symref: nothing is judged then.
  const head = await git([
    "symbolic-ref",
    "--quiet",
    `refs/remotes/${remote}/HEAD`,
  ]);
  if (!head.ok) return null;
  const base = head.out.trim();
  if (!base.startsWith(`refs/remotes/${remote}/`)) return null;
  const common = await git(["merge-base", tip.out.trim(), base]);
  // Exit 1 is git's "no common ancestor"; anything else is not an answer.
  if (common.ok || common.code !== 1) return null;
  return base.slice("refs/remotes/".length);
}

/** A name git and the tool's schema both take, nothing an option could be. */
function isPlainName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9._/-]{1,200}$/.test(value) &&
    !value.startsWith("-")
  );
}
