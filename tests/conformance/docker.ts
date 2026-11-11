import { expect } from "bun:test";

/**
 * Reads of the stack under test that the public API does not give: container
 * labels, logs and the fake GitHub's repositories. The stack is the run's own
 * (`E2E_COMPOSE_PROJECT`, set by tests/e2e/run.sh), so no other stack on the
 * daemon is read.
 */
export async function docker(args: string[]): Promise<string> {
  const run = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // A container writes its log to both streams.
  const [out, err] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  if ((await run.exited) !== 0) {
    throw new Error(`docker ${args[0]} failed: ${err.trim()}`);
  }
  return `${out}\n${err}`;
}

/** The one running container of `service` in this run's compose project. */
export async function serviceContainer(service: string): Promise<string> {
  const project = process.env.E2E_COMPOSE_PROJECT;
  if (!project) throw new Error("E2E_COMPOSE_PROJECT is unset");
  const ids = (
    await docker([
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      `label=com.docker.compose.service=${service}`,
    ])
  )
    .split("\n")
    .filter((line) => line.trim() !== "");
  expect(ids.length).toBe(1);
  return ids[0] as string;
}
