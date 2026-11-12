import { expect } from "bun:test";
import { docker, serviceContainer } from "./docker.ts";
import type { EngineFixture } from "./engine.ts";

const SESSION_ID = /^[0-9a-f-]{36}$/;

/**
 * Runs git in the fake forge's repository. The glob must name exactly one
 * repository, so a leftover from an earlier crash fails loudly instead of
 * splitting git's arguments.
 */
async function forgeGit(
  engine: EngineFixture,
  args: string[],
): Promise<string> {
  const repo = `/tmp/testkit-fake-github-*/agent/${engine.repositoryId}.git`;
  return docker([
    "exec",
    await serviceContainer("fake-git"),
    "sh",
    "-c",
    `n=0; for d in ${repo}; do n=$((n+1)); dir=$d; done; [ "$n" = 1 ] || exit 3; exec git --git-dir="$dir" "$@"`,
    "sh",
    ...args,
  ]);
}

/** The commit the forge holds on the session's agent branch, or null. */
export async function forgeBranch(
  engine: EngineFixture,
  sessionId: string,
): Promise<string | null> {
  expect(sessionId).toMatch(SESSION_ID);
  const sha = (
    await forgeGit(engine, [
      "for-each-ref",
      "--format=%(objectname)",
      `refs/heads/agent/${sessionId}`,
    ])
  ).trim();
  return sha === "" ? null : sha;
}

/** A file's content at a commit the forge holds. */
export async function forgeFile(
  engine: EngineFixture,
  commit: string,
  file: string,
): Promise<string> {
  return (await forgeGit(engine, ["show", `${commit}:${file}`])).trim();
}

/**
 * How many push requests (receive-pack, its ref advertisement included) the
 * forge has received for the engine's repository, taken or refused. The fake
 * logs every git request, so a push that failed or was refused still counts.
 */
export async function forgePushRequests(
  engine: EngineFixture,
): Promise<number> {
  const out = await docker([
    "exec",
    await serviceContainer("fake-git"),
    "bun",
    "-e",
    'console.log(await (await fetch("http://127.0.0.1:3000/requests")).text())',
  ]);
  const listed = out.split("\n").find((line) => line.startsWith("["));
  if (listed === undefined) throw new Error("the forge listed no requests");
  const requests = JSON.parse(listed) as { path: string }[];
  // Every clone and fetch is here too: without one the log is not being read.
  expect(requests.length).toBeGreaterThan(0);
  return requests.filter(
    ({ path }) =>
      path.includes(`/${engine.repositoryId}.git/`) &&
      path.includes("git-receive-pack"),
  ).length;
}
