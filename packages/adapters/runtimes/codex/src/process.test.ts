import { describe, expect, test } from "bun:test";

import { descendantsOf, spawnAppServer } from "./process.ts";

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

function alive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
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
    const group = engine.pid as number;
    const deadline = Date.now() + 2_000;
    while (alive(group) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(alive(group)).toBe(false);
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
    expect(alive(engine.pid as number)).toBe(false);
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
