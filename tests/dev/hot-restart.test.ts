import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sameSnapshot,
  snapshot,
  workspaceRoots,
} from "../../scripts/dev/hot-restart.ts";

const script = join(import.meta.dir, "../../scripts/dev/hot-restart.ts");

describe("scripts/dev/hot-restart.ts", () => {
  let dir: string;
  // A package the app reaches only through another one.
  let src: string;

  const pkg = async (path: string, manifest: object) => {
    await mkdir(join(dir, path), { recursive: true });
    await writeFile(join(dir, path, "package.json"), JSON.stringify(manifest));
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hot-restart-"));
    await pkg(".", { workspaces: ["apps/*", "packages/*"] });
    await pkg("apps/app", {
      name: "app",
      dependencies: { p: "workspace:*", zod: "4.0.0" },
    });
    await pkg("apps/web", { name: "web", dependencies: { p: "workspace:*" } });
    await pkg("packages/p", { name: "p", dependencies: { q: "workspace:*" } });
    await pkg("packages/q", { name: "q" });
    await pkg("packages/unused", { name: "unused" });
    src = join(dir, "packages/q/src");
    await mkdir(join(src, "nested"), { recursive: true });
    await writeFile(join(src, "nested", "a.ts"), "export const a = 1;\n");
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  test("the roots are the app and the workspace packages its dependencies reach", () => {
    expect(
      workspaceRoots("apps/app", dir).map((root) => root.slice(dir.length + 1)),
    ).toEqual(["apps/app", "packages/p", "packages/q"]);
  });

  test("a snapshot holds source files and skips tests, testing/ and node_modules", async () => {
    for (const path of [
      "b.test.ts",
      "testing/t.ts",
      "node_modules/x/i.ts",
      "c.md",
    ]) {
      await mkdir(join(src, path, ".."), { recursive: true });
      await writeFile(join(src, path), "x");
    }
    await writeFile(join(src, "d.json"), "{}");
    const before = snapshot([src, join(dir, "missing")]);
    expect(
      [...before.keys()].map((path) => path.slice(src.length + 1)).sort(),
    ).toEqual(["d.json", "nested/a.ts"]);

    await writeFile(join(src, "b.test.ts"), "changed");
    expect(sameSnapshot(before, snapshot([src]))).toBe(true);
    await writeFile(join(src, "nested", "a.ts"), "export const a = 22;\n");
    expect(sameSnapshot(before, snapshot([src]))).toBe(false);
  });

  // Each start of the command appends a line; polling stands in for events,
  // which a temporary directory may not deliver either.
  function supervise(
    command: string,
    pollMs = "100",
    env: Record<string, string> = {},
  ) {
    return Bun.spawn(["bun", script, "apps/app", "--", "bun", "-e", command], {
      cwd: dir,
      env: {
        ...process.env,
        DEV_POLL_MS: pollMs,
        DEV_STOP_GRACE_MS: "2000",
        ...env,
      },
      stderr: "pipe",
      stdout: "ignore",
    });
  }
  // Lines are "<pid> <start time in ms>".
  const starts = async () =>
    (await readFile(join(dir, "starts"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
  const startTimes = async () =>
    (await starts()).map((line) => Number(line.split(" ")[1]));
  async function until(condition: () => Promise<boolean>, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(50);
    }
  }
  const record = (then: string) =>
    `const fs = require("node:fs"), starts = ${JSON.stringify(join(dir, "starts"))}; fs.appendFileSync(starts, process.pid + " " + Date.now() + "\\n"); ${then}`;
  // Reads the supervisor's log while it runs, so a test waits on what it did.
  function stderrOf(supervisor: ReturnType<typeof supervise>) {
    const decoder = new TextDecoder();
    const log = { text: "" };
    (async () => {
      for await (const chunk of supervisor.stderr) {
        log.text += decoder.decode(chunk, { stream: true });
      }
    })();
    return log;
  }
  const delays = (text: string) =>
    [...text.matchAll(/starting again in (\S+)s/g)].map((match) => match[1]);

  test("a changed file restarts the command, one outside its packages does not, and a stop ends it", async () => {
    const supervisor = supervise(
      record(
        'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)',
      ),
    );
    try {
      await until(async () => (await starts()).length === 1);
      await writeFile(join(dir, "packages/unused/x.ts"), "export {};\n");
      await writeFile(join(dir, "apps/web/x.ts"), "export {};\n");
      await Bun.sleep(600);
      expect(await starts()).toHaveLength(1);

      await writeFile(join(src, "nested", "a.ts"), "export const a = 2;\n");
      await until(async () => (await starts()).length === 2);
      const [first, second] = (await starts()).map((line) =>
        Number(line.split(" ")[0]),
      );
      expect(first).not.toBe(second);
      expect(() => process.kill(first as number, 0)).toThrow();

      supervisor.kill("SIGTERM");
      expect(await supervisor.exited).toBe(0);
      expect(() => process.kill(second as number, 0)).toThrow();
      expect(await new Response(supervisor.stderr).text()).toContain(
        "source changed; restarting",
      );
    } finally {
      supervisor.kill("SIGKILL");
    }
  }, 20_000);

  test("a stop that arrives while a restart waits for the old command starts nothing new", async () => {
    const supervisor = supervise(
      record(
        'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 800)); setInterval(() => {}, 1000)',
      ),
    );
    try {
      await until(async () => (await starts()).length === 1);
      await writeFile(join(src, "nested", "a.ts"), "export const a = 4;\n");
      await Bun.sleep(400);
      supervisor.kill("SIGTERM");
      expect(await supervisor.exited).toBe(0);
      await Bun.sleep(300);
      expect(await starts()).toHaveLength(1);
      expect(await new Response(supervisor.stderr).text()).toContain(
        "source changed; restarting",
      );
    } finally {
      supervisor.kill("SIGKILL");
    }
  }, 20_000);

  // A pass loop that gave up: no file changes, yet it is started again, the way
  // Docker's restart policy would outside dev.
  test("a command that exits on its own starts again after a doubling delay, and a long run resets it", async () => {
    // Three quick exits, then a run longer than the longest delay. A quick
    // exit only has to stay under that 10s, however loaded the machine.
    const supervisor = supervise(
      record(
        'process.on("SIGTERM", () => process.exit(3)); if (fs.readFileSync(starts, "utf8").split("\\n").length <= 4) process.exit(3); setTimeout(() => process.exit(3), 10_500)',
      ),
      "0",
      { DEV_RESTART_MIN_MS: "250", DEV_RESTART_MAX_MS: "10000" },
    );
    const log = stderrOf(supervisor);
    try {
      await until(async () => delays(log.text).length >= 4, 30_000);
      supervisor.kill("SIGTERM");
      expect(await supervisor.exited).toBe(3);
      expect(delays(log.text).slice(0, 4)).toEqual([
        "0.25",
        "0.5",
        "1",
        "0.25",
      ]);
      expect(log.text).toContain("exited with 3; starting again in 0.25s");
      // Each start waited its delay, however slow the machine.
      const times = await startTimes();
      for (const [i, ms] of [250, 500, 1000].entries()) {
        expect(
          (times[i + 1] as number) - (times[i] as number),
        ).toBeGreaterThanOrEqual(ms);
      }
    } finally {
      supervisor.kill("SIGKILL");
    }
  }, 45_000);

  // With both ends equal a reset gives the same delay, so only a delay that
  // grew past the longest can fail this.
  test("the delay never grows past the longest", async () => {
    const supervisor = supervise(
      record('process.on("SIGTERM", () => process.exit(3)); process.exit(3)'),
      "0",
      { DEV_RESTART_MIN_MS: "500", DEV_RESTART_MAX_MS: "500" },
    );
    const log = stderrOf(supervisor);
    try {
      await until(async () => delays(log.text).length >= 3);
      supervisor.kill("SIGTERM");
      expect(await supervisor.exited).toBe(3);
      expect(delays(log.text).slice(0, 3)).toEqual(["0.5", "0.5", "0.5"]);
    } finally {
      supervisor.kill("SIGKILL");
    }
  }, 20_000);

  test("a command that stays up after starting again stays up", async () => {
    // Exits on its first start only: the proxy that was briefly gone.
    const supervisor = supervise(
      record(
        'if (fs.readFileSync(starts, "utf8").split("\\n").length < 3) process.exit(1); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)',
      ),
      "0",
    );
    try {
      await until(async () => (await starts()).length === 2);
      await Bun.sleep(2500);
      expect(await starts()).toHaveLength(2);
      supervisor.kill("SIGTERM");
      expect(await supervisor.exited).toBe(0);
    } finally {
      supervisor.kill("SIGKILL");
    }
  }, 20_000);

  // The delay outlasts the test, so only the change can start it again. A
  // poll shorter than the 100ms settle delay must still get through.
  test("a change while the delay runs starts the command at once and resets the delay", async () => {
    const supervisor = supervise(record("process.exit(3)"), "50", {
      DEV_RESTART_MIN_MS: "60000",
      DEV_RESTART_MAX_MS: "120000",
    });
    const log = stderrOf(supervisor);
    try {
      await until(async () => delays(log.text).length === 1);
      await writeFile(join(src, "nested", "a.ts"), "export const a = 3;\n");
      await until(async () => delays(log.text).length === 2);
      expect(delays(log.text)).toEqual(["60", "60"]);
      expect(await starts()).toHaveLength(2);
      supervisor.kill("SIGTERM");
      expect(await supervisor.exited).toBe(3);
    } finally {
      supervisor.kill("SIGKILL");
    }
  }, 20_000);

  test("a stop while the delay runs starts nothing", async () => {
    // A delay longer than the test: the stop cannot lose a race to it.
    const supervisor = supervise(record("process.exit(3)"), "0", {
      DEV_RESTART_MIN_MS: "60000",
      DEV_RESTART_MAX_MS: "60000",
    });
    const log = stderrOf(supervisor);
    try {
      await until(async () => delays(log.text).length === 1);
      supervisor.kill("SIGTERM");
      expect(await supervisor.exited).toBe(3);
      expect(await starts()).toHaveLength(1);
    } finally {
      supervisor.kill("SIGKILL");
    }
  }, 20_000);

  test("a delay range a timer cannot hold is refused", async () => {
    for (const env of [
      { DEV_RESTART_MIN_MS: "0" },
      { DEV_RESTART_MIN_MS: "3000", DEV_RESTART_MAX_MS: "2000" },
      { DEV_RESTART_MAX_MS: "2147483648" },
    ]) {
      const supervisor = supervise(record(""), "0", env);
      expect(await supervisor.exited).toBe(2);
      expect(await starts()).toHaveLength(0);
    }
  }, 20_000);
});
