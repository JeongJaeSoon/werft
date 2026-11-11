// The `metrics` role: GET /metrics computes every figure from the database
// at scrape time. It keeps no state, so one replica is one scrape target and
// a restart loses nothing.
import * as schema from "@werft-ai/db";
import { readPlatformMetrics } from "@werft-ai/db";
import { createEnforcedPool, JOB_POOL_TIMEOUTS } from "@werft-ai/db/pool";
import {
  createLogger,
  logLevelFromEnv,
  type StructuredLogger,
} from "@werft-ai/observability";
import {
  installationLimitsFromEnv,
  messageOf,
  type SessionBudget,
  sessionBudgetOf,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { renderMetrics, TURN_DURATION_BUCKETS } from "./families.ts";

const DEFAULT_METRICS_PORT = 9464;
const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

function metricsPort(environment: NodeJS.ProcessEnv): number {
  const raw = environment.METRICS_PORT;
  if (raw === undefined || raw === "") return DEFAULT_METRICS_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`METRICS_PORT must be a port number, not ${raw}`);
  }
  return port;
}

/**
 * The handler behind the listener. Scrapes that arrive while a read is
 * running share it, so two collectors cost one read; a failed read answers
 * 503 and the collector records the scrape as failed rather than stale data.
 */
export function metricsHandler(
  read: () => Promise<string>,
  logger: StructuredLogger,
): (request: Request) => Promise<Response> {
  let running: Promise<string> | undefined;
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (request.method !== "GET") {
      return new Response("method not allowed\n", { status: 405 });
    }
    if (pathname === "/healthz") return new Response("ok\n");
    if (pathname !== "/metrics") {
      return new Response("not found\n", { status: 404 });
    }
    running ??= read().finally(() => {
      running = undefined;
    });
    try {
      return new Response(await running, {
        headers: { "content-type": CONTENT_TYPE },
      });
    } catch (error) {
      logger.error("metrics read failed", {
        error: messageOf(error),
      });
      return new Response("metrics read failed\n", { status: 503 });
    }
  };
}

export function serveMetrics(environment: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = environment.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const port = metricsPort(environment);
  // The scheduler's budget, so the launch queue counts what it would launch.
  const budget: SessionBudget = sessionBudgetOf(
    installationLimitsFromEnv(environment),
  );
  const logger = createLogger({
    level: logLevelFromEnv(environment.LOG_LEVEL),
  });
  const pool = createEnforcedPool(
    databaseUrl,
    logger,
    "metrics",
    JOB_POOL_TIMEOUTS,
    { readOnly: true },
  );
  const db = drizzle(pool, { schema });
  const handler = metricsHandler(
    async () =>
      renderMetrics(
        await readPlatformMetrics(db, {
          budget,
          buckets: TURN_DURATION_BUCKETS,
        }),
      ),
    logger,
  );
  const server = Bun.serve({ port, fetch: handler });
  logger.info("metrics listening", { port: server.port });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void server
        .stop()
        .then(() => pool.end())
        .finally(() => process.exit(0));
    });
  }
}
