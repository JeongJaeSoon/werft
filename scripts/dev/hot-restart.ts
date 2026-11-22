/**
 * Development only (infra/compose.dev.yml): runs a command and restarts it
 * when a source file of a workspace app changes, so a saved file reaches a
 * running container without an image build.
 *
 *   bun scripts/dev/hot-restart.ts <app dir> -- <command>...
 *
 * Watched: the app's directory and every workspace package its
 * `dependencies` reach, read from the package.json files in the current
 * directory's workspace, so a package the app starts to use is watched too.
 *
 * File events come first and cost nothing while idle. Where none arrive (a
 * bind mount whose host does not pass them through, which is what the Mac
 * this was written on did, OrbStack and the host alike), a scan of mtimes and
 * sizes every DEV_POLL_MS (default 1000, 0 turns it off) finds the change.
 * A restart sends SIGTERM and waits DEV_STOP_GRACE_MS (default 30000) before
 * SIGKILL, so a pass loop stops at its safe point.
 *
 * A command that exits on its own starts again after a delay, as Docker's
 * restart policy would start the container outside dev: this process keeps the
 * container up, so that policy never sees the exit. A pass loop that gave up on
 * a dependency gone for a few seconds (a recreated egress proxy) thus comes
 * back without a save. The delay doubles from DEV_RESTART_MIN_MS (default 1000)
 * to DEV_RESTART_MAX_MS (default 30000) while the command keeps exiting within
 * the longest delay, so a crash on a half-written file costs one start per
 * longest delay, and a change starts it at once.
 */

import {
  type Dirent,
  readdirSync,
  readFileSync,
  statSync,
  watch,
} from "node:fs";
import { dirname, join } from "node:path";

const WATCHED = /\.(ts|tsx|json|sql)$/;
const SKIPPED_DIRS = new Set(["node_modules", "testing"]);

/** path → "mtime:size" of every watched source file under the roots. */
export function snapshot(roots: readonly string[]): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
      } else if (WATCHED.test(entry.name) && !entry.name.endsWith(".test.ts")) {
        try {
          const stat = statSync(path);
          files.set(path, `${stat.mtimeMs}:${stat.size}`);
        } catch {
          // Gone between the listing and the stat: the next scan sees it.
        }
      }
    }
  };
  for (const root of roots) walk(root);
  return files;
}

type Manifest = {
  name?: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
};
const manifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

/** The app's directory and those of the workspace packages it depends on. */
export function workspaceRoots(app: string, root = "."): string[] {
  const dirs = new Map<string, string>();
  for (const pattern of manifest(root).workspaces ?? []) {
    for (const file of new Bun.Glob(`${pattern}/package.json`).scanSync(root)) {
      const dir = join(root, dirname(file));
      const name = manifest(dir).name;
      if (name !== undefined) dirs.set(name, dir);
    }
  }
  const seen = new Set([join(root, app)]);
  const queue = [join(root, app)];
  for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
    for (const name of Object.keys(manifest(dir).dependencies ?? {})) {
      const dep = dirs.get(name);
      if (dep !== undefined && !seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...seen];
}

export function sameSnapshot(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [path, stamp] of a) if (b.get(path) !== stamp) return false;
  return true;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(
      `hot-restart: ${name} must be a non-negative integer, got "${raw}"`,
    );
    process.exit(2);
  }
  return value;
}

const log = (message: string) => console.error(`hot-restart: ${message}`);

async function main(args: string[]) {
  const separator = args.indexOf("--");
  if (separator !== 1 || separator === args.length - 1) {
    console.error(
      "usage: bun scripts/dev/hot-restart.ts <app dir> -- <command>...",
    );
    process.exit(2);
  }
  const roots = workspaceRoots(args[0] as string);
  const command = args.slice(separator + 1);
  log(`watching ${roots.join(", ")}`);
  const pollMs = intEnv("DEV_POLL_MS", 1000);
  const graceMs = intEnv("DEV_STOP_GRACE_MS", 30_000);
  const minDelayMs = intEnv("DEV_RESTART_MIN_MS", 1000);
  const maxDelayMs = intEnv("DEV_RESTART_MAX_MS", 30_000);
  // A timer above 2^31 - 1 ms fires after 1ms instead.
  if (minDelayMs < 1 || maxDelayMs < minDelayMs || maxDelayMs > 2 ** 31 - 1) {
    log(
      "DEV_RESTART_MIN_MS must be at least 1, and DEV_RESTART_MAX_MS at least that and at most 2147483647",
    );
    process.exit(2);
  }

  let child: Bun.Subprocess;
  // One scan at a time; events and the poll only ask for one.
  let queue = Promise.resolve();
  let pending: Timer | undefined;
  let shuttingDown = false;
  let delayMs = minDelayMs;
  let restart: Timer | undefined;
  const start = () => {
    clearTimeout(restart);
    restart = undefined;
    const startedAt = Date.now();
    const started = Bun.spawn(command, {
      stdio: ["ignore", "inherit", "inherit"],
    });
    void started.exited.then((code) => {
      if (child !== started || stopping.has(started) || shuttingDown) return;
      if (Date.now() - startedAt >= maxDelayMs) delayMs = minDelayMs;
      log(
        `exited with ${code ?? started.signalCode}; starting again in ${delayMs / 1000}s`,
      );
      restart = setTimeout(() => {
        restart = undefined;
        // Queued with the change checks, so a restart in flight is not doubled.
        queue = queue
          .then(() => {
            if (child === started && !shuttingDown) child = start();
          })
          .catch((error) => log(`restart failed: ${error}`));
      }, delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    });
    return started;
  };
  const stopping = new Set<Bun.Subprocess>();
  const stop = async (target: Bun.Subprocess) => {
    if (target.exitCode !== null || target.signalCode !== null)
      return target.exitCode;
    // A second SIGTERM would cut short the grace the first one started.
    if (stopping.has(target)) return target.exited;
    stopping.add(target);
    target.kill("SIGTERM");
    const timer = setTimeout(() => target.kill("SIGKILL"), graceMs);
    const code = await target.exited;
    clearTimeout(timer);
    return code;
  };

  let last = snapshot(roots);
  child = start();
  const check = async () => {
    const next = snapshot(roots);
    if (sameSnapshot(last, next)) return;
    last = next;
    log("source changed; restarting");
    // New code earns a fresh start rather than the old one's delay.
    delayMs = minDelayMs;
    await stop(child);
    if (!shuttingDown) child = start();
  };
  // Not a trailing debounce: a poll shorter than the delay would keep
  // pushing the check out forever.
  const schedule = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      queue = queue
        .then(check)
        .catch((error) => log(`restart failed: ${error}`));
    }, 100);
  };
  // Before the watches: on a loaded host setting them up can take seconds.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, async () => {
      shuttingDown = true;
      process.exit((await stop(child)) ?? 0);
    });
  }
  if (pollMs > 0) setInterval(schedule, pollMs);
  for (const root of roots) {
    try {
      watch(root, { recursive: true }, schedule);
    } catch {
      // A missing root is scanned as empty; the poll still covers the rest.
    }
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
