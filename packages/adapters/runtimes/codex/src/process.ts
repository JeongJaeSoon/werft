import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { RuntimeProcessObserver } from "@werft-ai/runtime-core";

import { type AppServerTransport, JsonlTransport } from "./transport.ts";

const STDERR_TAIL_BYTES = 4_096;
/** How long a closed app-server gets to leave before it is killed. */
const EXIT_GRACE_MS = 3_000;

/** What a run needs of the engine process; tests hand it a stand-in. */
export type AppServerHandle = {
  transport: AppServerTransport;
  /** Ends the process and everything it started, now. */
  kill(): void;
  /** Processes the engine started that are still running (Linux; empty where unreadable). */
  descendants(): readonly number[];
  /** Why the engine started badly, e.g. a setting it ignored. */
  startupProblem(): string | undefined;
};

export type AppServerProcess = AppServerHandle & {
  pid: number | undefined;
  /** Everything it wrote to stderr so far (tail), for tests and diagnostics. */
  stderr(): string;
};

/**
 * The processes below `pid`, read from `/proc/<pid>/task/*\/children`. A
 * kernel without that file reports none, which a checkpoint then takes as
 * quiet; the run's own tool tracking is the other half of the judgment.
 */
export function descendantsOf(pid: number): number[] {
  const found: number[] = [];
  const visit = (parent: number) => {
    let tasks: string[];
    try {
      tasks = readdirSync(`/proc/${parent}/task`);
    } catch {
      return;
    }
    for (const task of tasks) {
      let text: string;
      try {
        text = readFileSync(`/proc/${parent}/task/${task}/children`, "utf8");
      } catch {
        continue;
      }
      for (const child of text.split(/\s+/).filter(Boolean).map(Number)) {
        found.push(child);
        visit(child);
      }
    }
  };
  visit(pid);
  return found;
}

// The engine logs this once at start for a `-c` key it does not know.
const IGNORED_SETTING = /ignoring \d+ unrecognized configuration/i;

/**
 * Starts `codex app-server` with exactly the environment given: nothing is
 * inherited, so the worker's own variables never reach the engine.
 */
export function spawnAppServer(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  observer?: RuntimeProcessObserver | undefined;
  /** Gets each stderr line; the engine reports ignored settings there. */
  onStderr?: (line: string) => void;
}): AppServerProcess {
  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so what the engine's tools started can be ended
    // with it: killing only the engine leaves them running.
    detached: true,
  });
  let tail = "";
  let problem: string | undefined;
  let stderrBuffer = "";
  let stdoutBuffer = "";
  let transport!: JsonlTransport;
  transport = new JsonlTransport({
    write: (line) => {
      child.stdin.write(`${line}\n`);
    },
    end: () => {
      child.stdin.end();
      // An app-server whose input is closed leaves by itself; one that does
      // not is not waited for.
      const timer = setTimeout(() => kill(), EXIT_GRACE_MS);
      timer.unref();
      void transport.closed.then(() => clearTimeout(timer));
    },
  });
  const kill = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already gone.
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    for (;;) {
      const end = stdoutBuffer.indexOf("\n");
      if (end === -1) break;
      transport.receive(stdoutBuffer.slice(0, end));
      stdoutBuffer = stdoutBuffer.slice(end + 1);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
    stderrBuffer += chunk;
    for (;;) {
      const end = stderrBuffer.indexOf("\n");
      if (end === -1) break;
      const line = stderrBuffer.slice(0, end);
      if (IGNORED_SETTING.test(line)) {
        problem = "The Codex engine ignored a setting the platform relies on";
      }
      options.onStderr?.(line);
      stderrBuffer = stderrBuffer.slice(end + 1);
    }
  });
  // stdin closing under a write is the process leaving; `exit` says so.
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    transport.peerExited({ code: null, signal: null, stderr: error.message });
  });
  child.on("spawn", () => {
    if (child.pid !== undefined) options.observer?.onSpawn(child.pid);
  });
  child.on("close", (code, signal) => {
    // Whatever the engine's tools left behind goes with it.
    kill();
    if (child.pid !== undefined) {
      options.observer?.onExit?.(child.pid, code, signal);
    }
    transport.peerExited({ code, signal, stderr: tail });
  });
  return {
    transport,
    pid: child.pid,
    kill,
    stderr: () => tail,
    descendants: () =>
      child.pid === undefined ? [] : descendantsOf(child.pid),
    startupProblem: () => problem,
  };
}
