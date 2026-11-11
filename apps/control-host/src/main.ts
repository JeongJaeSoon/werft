// The control host's one executable
//
//   bun run src/main.ts <api|metrics>
//   bun run src/main.ts <scheduler|reconciler|slack> [--once|--health|--serve]
//
// The role is named, never defaulted, so a container runs what its command
// says. `scheduler`, `reconciler` and `slack` are services: a supervised loop
// running passes in a child (pass-loop/). `--once` is one pass, `--serve` is
// the loop's child, and `--health` judges the status file the loop writes.
// Each role module is imported only when chosen: a process reads and
// validates only its own role's settings, and only the scheduler ever loads
// an execution backend.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { queueDatabaseUrl } from "./database-url.ts";
import type { PassLoopRoleName } from "./pass-loop/loop.ts";

const ROLES = ["api", "metrics", "scheduler", "reconciler", "slack"] as const;
const MODES = ["--once", "--health", "--serve"] as const;
type Role = (typeof ROLES)[number];
type Mode = (typeof MODES)[number] | undefined;

const USAGE =
  "usage: bun run src/main.ts <api|metrics> | <scheduler|reconciler|slack> [--once|--health|--serve]";

function parse(args: readonly string[]): { role: Role; mode: Mode } | string {
  const [role, mode, ...rest] = args;
  if (!(ROLES as readonly (string | undefined)[]).includes(role)) {
    return `${USAGE} (got ${role ?? "nothing"})`;
  }
  if (rest.length > 0) return `${USAGE} (got ${args.join(" ")})`;
  if (mode === undefined) return { role: role as Role, mode };
  if (
    role === "api" ||
    role === "metrics" ||
    !(MODES as readonly string[]).includes(mode)
  ) {
    return `${USAGE} (got ${args.join(" ")})`;
  }
  return { role: role as Role, mode: mode as Mode };
}

const parsed = parse(process.argv.slice(2));
if (typeof parsed === "string") {
  console.error(parsed);
  process.exit(2);
}
const { role, mode } = parsed;

if (role === "api") {
  // Serves until a signal stops it (api/shutdown.ts).
  await import("./api/server.ts");
} else if (role === "metrics") {
  const { serveMetrics } = await import("./metrics/server.ts");
  serveMetrics();
} else if (mode === "--health") {
  const { checkHealth } = await import("./pass-loop/health.ts");
  const { PASS_LOOP_ROLES } = await import("./pass-loop/loop.ts");
  const { healthy, reason } = await checkHealth(
    process.env,
    PASS_LOOP_ROLES[role],
  );
  (healthy ? console.log : console.error)(reason);
  process.exitCode = healthy ? 0 : 1;
} else if (mode === "--once") {
  let stop: AbortSignal | undefined;
  if (role === "scheduler") {
    // A signal stops the pass at its next safe point, the checks it makes
    // for a lost pass lock, so no reservation starts after it; a second one
    // is the default and ends the process.
    const controller = new AbortController();
    for (const name of ["SIGTERM", "SIGINT"] as const) {
      process.once(name, () =>
        controller.abort(new Error(`${name} received; the pass stopped early`)),
      );
    }
    stop = controller.signal;
  }
  process.exitCode = await runOnce(role, stop);
} else if (mode === "--serve") {
  const { servePasses } = await import("./pass-loop/loop.ts");
  servePasses((stop) => runOnce(role, stop), {
    stopsAtSafePoint: role === "scheduler",
  });
} else {
  process.exitCode = await supervise(role);
}

async function runOnce(
  role: PassLoopRoleName,
  stop: AbortSignal | undefined,
): Promise<number> {
  if (role === "reconciler") {
    // No SIGTERM handler: every write is a transaction re-judged under row
    // locks, so ending the pass anywhere loses nothing.
    const { main } = await import("./reconciler/main.ts");
    await main();
    return 0;
  }
  if (role === "slack") {
    // No SIGTERM handler either: an event claimed by a pass that ends early
    // is claimed again once its lease runs out.
    const { main, slackRoleStartup } = await import("./slack/main.ts");
    // Every pass, the loop's or one run by hand, passes the startup gate.
    await slackRoleStartup(process.env);
    await main();
    return 0;
  }
  const { exitCodeFor, main } = await import("./scheduler/main.ts");
  return exitCodeFor(
    await main(process.env, stop === undefined ? {} : { stop }),
  );
}

async function supervise(role: PassLoopRoleName): Promise<number> {
  const { PASS_LOOP_ROLES, passLoopConfigFromEnv, runPassLoop } = await import(
    "./pass-loop/loop.ts"
  );
  const { createLogger, logLevelFromEnv } = await import(
    "@werft-ai/observability"
  );
  const config = passLoopConfigFromEnv(process.env, PASS_LOOP_ROLES[role]);
  // Every pass child logs at this level; a typo stops the loop here, once.
  const level = logLevelFromEnv(process.env.LOG_LEVEL);
  let passEnv: Record<string, string> | undefined;
  // The passes would refuse a bad setting one by one; refuse it here, once.
  if (role === "scheduler") {
    const { assertPassOutlastsStop, schedulerConfigFromEnv } = await import(
      "./scheduler/config.ts"
    );
    const { QUOTA_PREFLIGHT_MARKER_ENV } = await import(
      "./scheduler/quota-preflight.ts"
    );
    const { execution } = schedulerConfigFromEnv(process.env);
    assertPassOutlastsStop(config.passTimeoutMs, execution);
    // The first pass of every loop probes the workspace quota afresh.
    const marker = `${config.statusFile}.quota-verified`;
    await rm(marker, { force: true });
    passEnv = { [QUOTA_PREFLIGHT_MARKER_ENV]: marker };
  } else if (role === "slack") {
    const { slackRoleStartup } = await import("./slack/main.ts");
    await slackRoleStartup(process.env);
  } else {
    const { reconcilerSettings } = await import("./reconciler/reconcile.ts");
    queueDatabaseUrl(process.env);
    reconcilerSettings(process.env);
  }
  const logger = createLogger({ level });
  if (role === "slack") {
    const { slackApiUrlWarnings } = await import("./api/slack-config.ts");
    for (const warning of slackApiUrlWarnings(process.env)) {
      logger.warn(warning, {});
    }
  }
  const shutdown = new AbortController();
  for (const name of ["SIGTERM", "SIGINT"] as const) {
    process.on(name, () => {
      if (!shutdown.signal.aborted) {
        logger.info(`${name} received; stopping the ${role} loop`);
      }
      shutdown.abort();
    });
  }
  const name = {
    scheduler: "Scheduler",
    reconciler: "Reconciler",
    slack: "Slack",
  }[role];
  logger.info(`${name} loop started`, {
    interval_ms: config.intervalMs,
    kill_grace_ms: config.killGraceMs,
    max_consecutive_failures: config.maxConsecutiveFailures,
    pass_timeout_ms: config.passTimeoutMs,
    status_file: config.statusFile,
  });
  return runPassLoop({
    name,
    command: [
      process.execPath,
      "run",
      join(import.meta.dir, "main.ts"),
      role,
      "--serve",
    ],
    ...(passEnv === undefined ? {} : { env: passEnv }),
    config,
    logger,
    signal: shutdown.signal,
  });
}
