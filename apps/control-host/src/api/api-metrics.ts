// Counts the api's answers to Slack's Events API requests in this process.
// The metrics role reads the database at scrape time, so it cannot count the
// answers given while the database was slow or down; this counter can.
import type { StructuredLogger } from "@werft-ai/observability";
import { METRIC_PREFIX } from "../metrics/families.ts";
import { metricsHandler, metricsPortFromEnv } from "../metrics/server.ts";

/** The codes the route answers; any other status is counted as `other`. */
export const SLACK_EVENT_RESPONSE_CODES = [
  "200",
  "400",
  "401",
  "408",
  "413",
  "429",
  "500",
  "503",
] as const;
const OTHER = "other";

export const SLACK_EVENT_RESPONSES_METRIC = `${METRIC_PREFIX}_slack_event_responses_total`;

export type SlackEventResponses = {
  count(status: number): void;
  /** The counter in the Prometheus text exposition format (0.0.4). */
  render(): string;
};

export function createSlackEventResponses(): SlackEventResponses {
  // Every code starts at 0, so a ratio over them has a series from the start.
  const counts = new Map<string, number>(
    [...SLACK_EVENT_RESPONSE_CODES, OTHER].map((code) => [code, 0]),
  );
  return {
    count(status) {
      const code = String(status);
      const key = counts.has(code) ? code : OTHER;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    render() {
      const name = SLACK_EVENT_RESPONSES_METRIC;
      return [
        `# HELP ${name} Answers to Slack Events API requests by HTTP status, since this api process started.`,
        `# TYPE ${name} counter`,
        ...[...counts].map(
          ([code, value]) => `${name}{code="${code}"} ${value}`,
        ),
        "",
      ].join("\n");
    },
  };
}

/**
 * The api's own /metrics listener, apart from the public and /internal ones:
 * open only when METRICS_PORT is set.
 */
export function serveApiMetrics(
  environment: Record<string, string | undefined>,
  responses: Pick<SlackEventResponses, "render">,
  logger: StructuredLogger,
  hostname?: string,
) {
  const port = metricsPortFromEnv(environment);
  if (port === undefined) return undefined;
  return Bun.serve({
    port,
    ...(hostname === undefined ? {} : { hostname }),
    fetch: metricsHandler(async () => responses.render(), logger),
  });
}
