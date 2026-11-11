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
