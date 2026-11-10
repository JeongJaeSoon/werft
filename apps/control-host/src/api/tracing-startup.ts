import {
  createPostgresTelemetryIngestStore,
  type Database,
} from "@werft-ai/db";
import {
  endpointOnEgressAllowlist,
  type StructuredLogger,
  type TracingSettings,
} from "@werft-ai/observability";
import {
  LoggedDropCounter,
  postgresAttemptAuthenticator,
  postgresTurnTraceDirectory,
  valueMasker,
} from "../ingest/adapters.ts";
import { type IngestListener, startIngestListener } from "../ingest/start.ts";

const EGRESS_LISTS = ["EGRESS_PRIVATE_ALLOWLIST", "EGRESS_ALLOWLIST"] as const;

/**
 * Logs one warning when the collector's host is on a worker egress allowlist.
 * Workers reach the collector through the ingest listener, never directly, so
 * a collector on the list gives a compromised worker a route to it.
 * Returns whether it warned. Only the host and the list names are logged:
 * the endpoint may carry credentials in its path or query.
 */
export function warnCollectorOnEgressAllowlist(
  settings: TracingSettings | undefined,
  env: Readonly<Record<string, string | undefined>>,
  logger: Pick<StructuredLogger, "warn">,
): boolean {
  if (settings === undefined) return false;
  const lists = EGRESS_LISTS.filter((name) =>
    endpointOnEgressAllowlist(settings.endpoint, env[name]),
  );
  if (lists.length === 0) return false;
  logger.warn(
    "The OTLP collector host is on a worker egress allowlist; remove it, workers send spans through the ingest listener",
    {
      event: "tracing.collector_on_egress_allowlist",
      collector_host: new URL(settings.endpoint).hostname,
      allowlists: lists,
    },
  );
  return true;
}

/**
 * Opens the telemetry ingest listener and the collector sink behind it.
 * The SDK adapter is loaded here so an installation with tracing off never
 * imports it.
 */
export async function startTelemetryIngest(
  settings: TracingSettings,
  db: Database,
  logger: Pick<StructuredLogger, "warn">,
): Promise<IngestListener> {
  const { createOtelSpanSink } = await import("@werft-ai/observability/otel");
  const sink = createOtelSpanSink(settings);
  const store = createPostgresTelemetryIngestStore(db);
  const listener = startIngestListener({
    settings,
    authenticator: postgresAttemptAuthenticator(store),
    turns: postgresTurnTraceDirectory(store),
    sink,
    masker: valueMasker,
    drops: new LoggedDropCounter(logger),
  });
  return {
    get port() {
      return listener.port;
    },
    stop: (closeActiveConnections) => listener.stop(closeActiveConnections),
    get pendingRequests() {
      return listener.pendingRequests;
    },
    async close() {
      await listener.close();
      await sink.shutdown();
    },
  };
}
