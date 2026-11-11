import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { descendantsOf, spawnAppServer } from "./process.ts";

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

/**
 * Whether anything in the process group still runs. A killed process whose
 * parent is gone is reparented to PID 1, and where that is this test runner
 * (bun as a container's PID 1) nobody reaps it: it is dead, just still listed,
 * so on Linux a zombie does not count.
 */
function alive(group: number): boolean {
  try {
    process.kill(-group, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue;
    }
    // "pid (comm) state ppid pgrp ..." where comm may hold spaces and parens.
    const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(pgrp) === group && state !== "Z") return true;
  }
  return false;
}

// SIGKILL has no grace step; what is left is the kernel finishing the signal
// and the group's orphans being reaped, which a loaded host can delay.
async function groupGone(group: number, withinMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (alive(group) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return !alive(group);
}

describe("spawnAppServer", () => {
  test("an engine that exits leaving a child on its stdio is still settled, and the child ends", async () => {
    // The child inherits stdout/stderr, so the pipes stay open after `sh` is gone.
    const engine = spawnAppServer({
      command: "sh",
      args: ["-c", "sleep 30 & echo $! ; exit 0"],
      cwd: process.cwd(),
      env: ENV,
    });
    const settled = await Promise.race([
      engine.transport.closed.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 5_000)),
    ]);
    expect(settled).toBe("closed");
    expect(await groupGone(engine.pid as number)).toBe(true);
  }, 15_000);

  test("kill ends the engine and what it started", async () => {
    const engine = spawnAppServer({
      command: "sh",
      args: ["-c", "sleep 30 & sleep 30"],
      cwd: process.cwd(),
      env: ENV,
    });
    engine.kill();
    await engine.transport.closed;
    expect(await groupGone(engine.pid as number)).toBe(true);
  }, 15_000);

  test("the engine gets only the environment it is given", async () => {
    process.env.WORKER_ONLY_VARIABLE = "present-in-worker";
    try {
      const lines: string[] = [];
      const engine = spawnAppServer({
        command: "sh",
        args: ["-c", 'echo "[$WORKER_ONLY_VARIABLE]" >&2'],
        cwd: process.cwd(),
        env: ENV,
        onStderr: (line) => lines.push(line),
      });
      await engine.transport.closed;
      expect(lines).toEqual(["[]"]);
    } finally {
      delete process.env.WORKER_ONLY_VARIABLE;
    }
  });

  test("a setting the engine ignored is reported as a startup problem", async () => {
    const engine = spawnAppServer({
      command: "sh",
      args: [
        "-c",
        "echo 'WARN ignoring 1 unrecognized configuration setting' >&2",
      ],
      cwd: process.cwd(),
      env: ENV,
    });
    await engine.transport.closed;
    expect(engine.startupProblem()).toContain("ignored a setting");
  });
});

describe("descendantsOf", () => {
  test.skipIf(process.platform !== "linux")(
    "lists the processes below a pid on Linux",
    async () => {
      const engine = spawnAppServer({
        command: "sh",
        args: ["-c", "sleep 30 & sleep 30"],
        cwd: process.cwd(),
        env: ENV,
      });
      await new Promise((r) => setTimeout(r, 100));
      expect((engine.descendants() ?? []).length).toBeGreaterThan(0);
      engine.kill();
      await engine.transport.closed;
    },
  );

  // The same path answers where /proc is not there at all (macOS): the root's
  // task directory cannot be read, so the answer is "unknown", never "empty".
  test("a pid whose children cannot be read is unknown, not empty", () => {
    expect(descendantsOf(2 ** 22 + 12345)).toBeUndefined();
  });
});
