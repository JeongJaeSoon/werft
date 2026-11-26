import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineProcesses } from "./engine-processes.ts";

describe("EngineProcesses", () => {
  test("finds the descendants left under a live engine process", async () => {
    const procRoot = await mkdtemp(join(tmpdir(), "94s-481-proc-"));
    const workspace = await mkdtemp(join(tmpdir(), "94s-481-workspace-"));
    const children = async (pid: number, body: string) => {
      const task = join(procRoot, String(pid), "task", String(pid));
      await mkdir(task, { recursive: true });
      await writeFile(join(task, "children"), body);
    };
    try {
      await children(101, "103 102\n");
      await children(102, "104\n");
      await children(103, "");
      await children(104, "");
      const otherThread = join(procRoot, "101", "task", "201");
      await mkdir(otherThread, { recursive: true });
      await writeFile(join(otherThread, "children"), "105\n");
      await children(105, "");
      await mkdir(join(procRoot, "106"), { recursive: true });
      await symlink(workspace, join(procRoot, "106", "cwd"));
      const engines = new EngineProcesses(procRoot, workspace);
      engines.onSpawn(101);

      expect(await engines.descendants()).toEqual([102, 103, 104, 105, 106]);
    } finally {
      await rm(procRoot, { force: true, recursive: true });
      await rm(workspace, { force: true, recursive: true });
    }
  });

  test("names a process by its command alone, and passes over one that is gone", async () => {
    const procRoot = await mkdtemp(join(tmpdir(), "94s-2370-proc-"));
    try {
      for (const [pid, comm] of [
        [201, "sleep\n"],
        [202, "node\n"],
        [203, "node\n"],
        // A process names its own comm: nothing but a command name survives.
        [204, "x --token=abc $(rm)\n"],
      ] as const) {
        await mkdir(join(procRoot, String(pid)), { recursive: true });
        await writeFile(join(procRoot, String(pid), "comm"), comm);
      }
      const engines = new EngineProcesses(procRoot);

      expect(await engines.commands([201, 202, 203, 204, 999])).toEqual([
        "sleep",
        "node",
        "x--tokenabcrm",
      ]);
    } finally {
      await rm(procRoot, { force: true, recursive: true });
    }
  });

  test("signals what is still there and ignores what is not", () => {
    const engines = new EngineProcesses();
    // No such process: the signal is passed over, not thrown.
    expect(() => engines.signal([2_147_483_646], "SIGTERM")).not.toThrow();
  });

  test("reports exit only once every spawned engine is gone", async () => {
    const engines = new EngineProcesses();
    engines.onSpawn(101);
    engines.onSpawn(102);
    const waiting = engines.exited(1_000);

    engines.onExit(101);
    expect(engines.running).toEqual([102]);
    engines.onExit(102);

    expect(await waiting).toBe(true);
    expect(await engines.exited(0)).toBe(true);
  });

  test("gives up after the grace period while one is still running", async () => {
    const engines = new EngineProcesses();
    engines.onSpawn(101);

    expect(await engines.exited(10)).toBe(false);
    expect(engines.running).toEqual([101]);
  });

  test("kills a straggler for real", async () => {
    const engines = new EngineProcesses();
    const child = Bun.spawn(["sleep", "30"]);
    engines.onSpawn(child.pid);
    void child.exited.then(() => engines.onExit(child.pid));

    expect(await engines.exited(20)).toBe(false);
    engines.kill();

    expect(await engines.exited(2_000)).toBe(true);
    expect(child.signalCode).toBe("SIGKILL");
  });
});
