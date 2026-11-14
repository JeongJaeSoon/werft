import { rename, writeFile } from "node:fs/promises";
import { integerSetting } from "@werft-ai/contracts/settings";

/**
 * Runs a role's passes in a child process, forever. This loop is what turns
 * a pass into a service: a pass that hangs is stopped and counted as a
 * failure, a run of failures ends the process so the restart policy engages,
 * and every pass leaves its outcome in a status file the healthcheck
 * (`health.ts`) reads. Passes run in a child rather than in-process, because
 * only a process can be killed whatever it is stuck in. Passes never overlap:
 * the next starts after the last one has answered or exited, killed or not.
 *
 * The child (`main.ts <role> --serve`, see `servePasses`) runs one pass per
 * IPC request and stays for the next, because starting bun and loading a
 * role's modules costs several times the pass itself and an idle loop would
 * spend most of a core on it (94S-944). Each pass still opens and ends its own
 * pool. A pass that fails, is stopped or times out takes its child with it, so
 * the next pass starts in a fresh process; a child that dies between passes is
 * a failure too. A command that exits after one pass (`--once`) works as well:
 * its exit code is the outcome.
 */

export type PassLoopConfig = {
  intervalMs: number;
  passTimeoutMs: number;
  // SIGTERM asks a pass to stop at its next safe point; SIGKILL after this.
  killGraceMs: number;
  maxConsecutiveFailures: number;
  statusFile: string;
};

/** One role's defaults; its settings are read from `${prefix}_*`. */
export type PassLoopRole = {
  prefix: string;
  intervalSec: number;
  passTimeoutSec: number;
  maxConsecutiveFailures: number;
  healthStaleSec: number;
  stopGraceSec: number;
  statusFile: string;
};

export const PASS_LOOP_ROLES = {
  // The reconciler keeps the original settings and status-file contract.
  reconciler: {
    prefix: "RECONCILER",
    intervalSec: 10,
    // Above the ~45s a frozen database takes to fail a pass on its own
    // (JOB_POOL_TIMEOUTS); this is the watchdog for everything else.
    passTimeoutSec: 60,
    maxConsecutiveFailures: 3,
    healthStaleSec: 90,
    // Every write is a transaction re-judged under row locks, so a pass
    // ended anywhere loses nothing; the grace only lets it roll back.
    stopGraceSec: 10,
    statusFile: "/tmp/reconciler-status.json",
  },
  scheduler: {
    prefix: "SCHEDULER",
    intervalSec: 5,
    // Above one worker's whole stop, EXECUTION_DOCKER_STOP_TIMEOUT_SEC plus
    // the request timeout; the scheduler refuses to start otherwise.
    passTimeoutSec: 180,
    maxConsecutiveFailures: 3,
    healthStaleSec: 200,
    // A stopped pass stops before the next reservation. A Docker stop cut
    // short here is not: the daemon carries it on, and the next pass
    // removes what it leaves.
    stopGraceSec: 30,
    statusFile: "/tmp/scheduler-status.json",
  },
  // SLACK_ROLE, not SLACK: the SLACK_* names belong to Slack settings.
  slack: {
    prefix: "SLACK_ROLE",
    intervalSec: 2,
    passTimeoutSec: 60,
    maxConsecutiveFailures: 3,
    healthStaleSec: 90,
    stopGraceSec: 10,
    statusFile: "/tmp/slack-status.json",
  },
} as const satisfies Record<string, PassLoopRole>;

export type PassLoopRoleName = keyof typeof PASS_LOOP_ROLES;

/**
 * A pass that found nothing it may do (another pass holds the scheduler's
 * lock) exits with this: neither a success, which would keep a blocked loop
 * looking healthy, nor a failure, which would restart a loop that is fine.
 * EX_TEMPFAIL from sysexits.h.
 */
export const PASS_SKIPPED_EXIT = 75;

/**
 * A pass that did all it could, but left a session it cannot help this pass:
 * a launch waiting out its backoff, one just given up on, a replacement
 * budget spent. Not a success, so health says so; not a failure
 * because a restart fixes none of it — the state is in the database — and
 * would stop scheduling for every other session while one crash-loops.
 * Next to PASS_SKIPPED_EXIT; sysexits.h has nothing that means this.
 */
export const PASS_DEGRADED_EXIT = 76;

export type PassLoopEnvironment = Readonly<Record<string, string | undefined>>;

export function passLoopConfigFromEnv(
  environment: PassLoopEnvironment,
  role: PassLoopRole,
): PassLoopConfig {
  const intervalSec = setting(environment, role, "INTERVAL_SEC");
  const passTimeoutSec = setting(environment, role, "PASS_TIMEOUT_SEC");
  const maxConsecutiveFailures = setting(
    environment,
    role,
    "MAX_CONSECUTIVE_FAILURES",
  );
  const healthStaleSec = healthStaleSecFromEnv(environment, role);
  // Two successes can be a full pass apart plus the interval; a window no
  // longer than that reads a healthy loop as stale between them.
  if (healthStaleSec <= intervalSec + passTimeoutSec) {
    const name = (suffix: string) => `${role.prefix}_${suffix}`;
    throw new Error(
      `${name("HEALTH_STALE_SEC")} must be greater than ${name("INTERVAL_SEC")} + ${name("PASS_TIMEOUT_SEC")}`,
    );
  }
  return {
    intervalMs: intervalSec * 1000,
    passTimeoutMs: passTimeoutSec * 1000,
    killGraceMs: role.stopGraceSec * 1000,
    maxConsecutiveFailures,
    statusFile: statusFileFromEnv(environment, role),
  };
}

export function healthStaleSecFromEnv(
  environment: PassLoopEnvironment,
  role: PassLoopRole,
): number {
  return setting(environment, role, "HEALTH_STALE_SEC");
}

export function statusFileFromEnv(
  environment: PassLoopEnvironment,
  role: PassLoopRole,
): string {
  return environment[`${role.prefix}_STATUS_FILE`] ?? role.statusFile;
}

const DEFAULTS = {
  INTERVAL_SEC: "intervalSec",
  PASS_TIMEOUT_SEC: "passTimeoutSec",
  MAX_CONSECUTIVE_FAILURES: "maxConsecutiveFailures",
  HEALTH_STALE_SEC: "healthStaleSec",
} as const;

function setting(
  environment: PassLoopEnvironment,
  role: PassLoopRole,
  suffix: keyof typeof DEFAULTS,
): number {
  const name = `${role.prefix}_${suffix}`;
  return integerSetting(environment, name, {
    min: 1,
    default: role[DEFAULTS[suffix]],
  });
}

/** What the last passes did; the healthcheck and an operator read it. */
export type PassStatus = {
  loopStartedAt: string;
  passes: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  lastSkippedAt: string | null;
  // A pass that completed but reported a session it could not help. It
  // keeps the loop fresh like a success; lastSuccessAt stays clean passes only.
  lastDegradedAt: string | null;
  lastPassDurationMs: number | null;
  consecutiveFailures: number;
  // Set while a pass runs: past it, the pass is stuck until the kill lands.
  passDeadlineAt: string | null;
};

export type PassLoopLogger = {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

type PassOutcome =
  | { outcome: "succeeded" }
  | { outcome: "skipped" }
  | { outcome: "degraded" }
  | { outcome: "failed"; reason: string };

/**
 * Resolves with the process exit code: 1 once `maxConsecutiveFailures`
 * passes in a row failed, 0 when `signal` stopped the loop. On `signal` no
 * new pass starts and the running one is asked to stop (SIGTERM), then
 * killed once `killGraceMs` has passed.
 */
export async function runPassLoop(input: {
  name: string;
  command: readonly string[];
  /** Set for every pass on top of this process's own environment. */
  env?: Readonly<Record<string, string>>;
  config: PassLoopConfig;
  logger: PassLoopLogger;
  signal?: AbortSignal;
  now?: () => Date;
}): Promise<number> {
  const { name, command, config, logger, signal } = input;
  const env =
    input.env === undefined ? undefined : { ...Bun.env, ...input.env };
  const now = input.now ?? (() => new Date());
  const status: PassStatus = {
    loopStartedAt: now().toISOString(),
    passes: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    lastSkippedAt: null,
    lastDegradedAt: null,
    lastPassDurationMs: null,
    consecutiveFailures: 0,
    passDeadlineAt: null,
  };
  await writeStatus(config.statusFile, status, logger);
  let child: PassChild | undefined;
  try {
    while (!signal?.aborted) {
      status.passDeadlineAt = new Date(
        now().getTime() + config.passTimeoutMs,
      ).toISOString();
      await writeStatus(config.statusFile, status, logger);
      // A stop that arrived during the write must not start a pass: its abort
      // listener would be added after the event and never forward SIGTERM.
      if (signal?.aborted) break;
      const started = performance.now();
      let result: PassOutcome;
      if (child !== undefined && !running(child.process)) {
        result = {
          outcome: "failed",
          reason: `pass process ${endOf(child.process)} between passes`,
        };
        child = undefined;
      } else {
        child ??= spawnPassChild(command, env);
        result = await runPass(child, config, signal);
        if (!running(child.process)) child = undefined;
      }
      const durationMs = Math.round(performance.now() - started);
      // A pass cut short by shutdown is neither a success nor a failure.
      if (signal?.aborted) break;
      status.passDeadlineAt = null;
      status.passes += 1;
      status.lastPassDurationMs = durationMs;
      if (result.outcome === "succeeded") {
        status.lastSuccessAt = now().toISOString();
        status.consecutiveFailures = 0;
        logger.info(`${name} pass completed`, { duration_ms: durationMs });
      } else if (result.outcome === "degraded") {
        status.lastDegradedAt = now().toISOString();
        status.consecutiveFailures = 0;
        logger.warn(`${name} pass completed degraded`, {
          duration_ms: durationMs,
        });
      } else if (result.outcome === "skipped") {
        status.lastSkippedAt = now().toISOString();
        logger.warn(`${name} pass skipped; another pass holds the lock`, {
          duration_ms: durationMs,
        });
      } else {
        status.lastFailureAt = now().toISOString();
        status.lastFailureReason = result.reason;
        status.consecutiveFailures += 1;
        logger.error(`${name} pass failed`, {
          consecutive_failures: status.consecutiveFailures,
          duration_ms: durationMs,
          reason: result.reason,
        });
      }
      await writeStatus(config.statusFile, status, logger);
      if (status.consecutiveFailures >= config.maxConsecutiveFailures) {
        logger.error(`${name} giving up after consecutive failed passes`, {
          consecutive_failures: status.consecutiveFailures,
        });
        return 1;
      }
      await sleep(config.intervalMs, signal);
    }
    return 0;
  } finally {
    if (child !== undefined) await retire(child.process, config);
  }
}

type PassChild = {
  process: Bun.Subprocess;
  /**
   * Who hears the pass now running end: its answer, or the child's exit.
   * One exit reaction per child, not per pass, so a long-lived child does
   * not pile them up.
   */
  listen(listener: PassListener | undefined): void;
  /** Set once the child answered a pass: from then on it is serving. */
  serving: boolean;
};

type PassListener = (event: { message: unknown } | "exited") => void;

function spawnPassChild(
  command: readonly string[],
  env: Record<string, string | undefined> | undefined,
): PassChild {
  let listener: PassListener | undefined;
  const child = Bun.spawn([...command], {
    ...(env === undefined ? {} : { env }),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    serialization: "json",
    ipc: (message) => listener?.({ message }),
  });
  void child.exited.then(() => listener?.("exited"));
  return {
    process: child,
    listen: (next) => {
      listener = next;
    },
    serving: false,
  };
}

async function runPass(
  passChild: PassChild,
  config: PassLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PassOutcome> {
  const child = passChild.process;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), config.killGraceMs);
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, config.passTimeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  const ended = new Promise<{ message: unknown } | "exited">((resolve) => {
    passChild.listen(resolve);
    if (!running(child)) resolve("exited");
  });
  try {
    try {
      child.send(PASS_REQUEST);
    } catch {
      // Already gone: its exit below says how the pass went.
    }
    const event = await ended;
    if (event !== "exited" && !timedOut && !signal?.aborted) {
      passChild.serving = true;
      const code = answerCode(event.message);
      if (code === 0) return { outcome: "succeeded" };
      if (code === PASS_SKIPPED_EXIT) return { outcome: "skipped" };
      if (code === PASS_DEGRADED_EXIT) return { outcome: "degraded" };
      // `servePasses` exits on any other outcome rather than answering; a
      // child that answers one anyway does not get the next pass.
      stop();
      await child.exited;
      return {
        outcome: "failed",
        reason:
          code === undefined
            ? "pass process sent an answer that is not an exit code"
            : `pass exited with code ${code}`,
      };
    }
    // Exited, or stopped after answering: wait for the exit either way, so
    // the next pass never overlaps this child.
    const code = await child.exited;
    if (timedOut) {
      return {
        outcome: "failed",
        reason: `pass did not finish within ${config.passTimeoutMs / 1000}s and was killed`,
      };
    }
    if (child.signalCode !== null) {
      return { outcome: "failed", reason: `pass ended by ${child.signalCode}` };
    }
    // A serving child answers every pass it completes; one that exits with
    // a completed pass's code instead may have ended before it ran this one.
    if (
      passChild.serving &&
      event === "exited" &&
      (code === 0 || code === PASS_SKIPPED_EXIT || code === PASS_DEGRADED_EXIT)
    ) {
      return {
        outcome: "failed",
        reason: `pass process exited with code ${code} without answering`,
      };
    }
    if (code === 0) return { outcome: "succeeded" };
    if (code === PASS_SKIPPED_EXIT) return { outcome: "skipped" };
    if (code === PASS_DEGRADED_EXIT) return { outcome: "degraded" };
    return { outcome: "failed", reason: `pass exited with code ${code}` };
  } finally {
    passChild.listen(undefined);
    clearTimeout(deadline);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", stop);
  }
}

const PASS_REQUEST = { pass: true } as const;

function answerCode(message: unknown): number | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const { code } = message as { code?: unknown };
  return Number.isInteger(code) ? (code as number) : undefined;
}

function running(child: Bun.Subprocess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function endOf(child: Bun.Subprocess): string {
  return child.signalCode === null
    ? `exited with code ${child.exitCode}`
    : `ended by ${child.signalCode}`;
}

// The loop is ending with an idle child; it ends the same way a pass is stopped.
async function retire(
  child: Bun.Subprocess,
  config: PassLoopConfig,
): Promise<void> {
  if (!running(child)) return;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), config.killGraceMs);
  await child.exited;
  clearTimeout(killTimer);
}

/**
 * The child side (`main.ts <role> --serve`): one pass per request from
 * `runPassLoop`, answered with its exit code. A pass that fails, or that a
 * stop signal reached, ends the process with that code instead, so a pass
 * that went wrong leaves no state behind for the next one. `stopsAtSafePoint`
 * roles get the pass a signal that SIGTERM or SIGINT aborts, and a second
 * signal ends the process; the others keep the default, ending at once.
 */
export function servePasses(
  pass: (stop: AbortSignal | undefined) => Promise<number>,
  options: { stopsAtSafePoint: boolean },
): void {
  const send = process.send?.bind(process);
  if (send === undefined) {
    throw new Error("--serve runs under the pass loop only: no IPC channel");
  }
  let current: AbortController | undefined;
  let stopping = false;
  if (options.stopsAtSafePoint) {
    for (const name of ["SIGTERM", "SIGINT"] as const) {
      process.once(name, () => {
        if (current === undefined) process.exit(0);
        stopping = true;
        current.abort(new Error(`${name} received; the pass stopped early`));
      });
    }
  }
  process.on("message", async () => {
    current = options.stopsAtSafePoint ? new AbortController() : undefined;
    let code: number;
    try {
      code = await pass(current?.signal);
    } catch (error) {
      console.error(error);
      code = 1;
    }
    current = undefined;
    const reusable =
      code === 0 || code === PASS_SKIPPED_EXIT || code === PASS_DEGRADED_EXIT;
    if (stopping || !reusable) process.exit(code);
    send({ code });
  });
  // The loop is gone; nothing will ask for another pass.
  process.on("disconnect", () => process.exit(0));
}

// Written aside and renamed, so the healthcheck never reads half a file.
async function writeStatus(
  path: string,
  status: PassStatus,
  logger: PassLoopLogger,
): Promise<void> {
  const staging = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(staging, `${JSON.stringify(status)}\n`);
    await rename(staging, path);
  } catch (error) {
    // No crash: a status that stops updating already fails the healthcheck.
    logger.error("Pass status file could not be written", {
      error: error instanceof Error ? error.message : String(error),
      path,
    });
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
