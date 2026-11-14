// The platform metrics in the Prometheus text exposition format (0.0.4).
// Every name, label and help line lives here; apps/docs/content/docs/run-server/self-hosting/reference/metrics.mdx is
// their reference for operators.
import { type PlatformMetricsSnapshot, publicStatus } from "@werft-ai/db";

/** The one place the metric prefix is set (94S-1101, decision d95). */
export const METRIC_PREFIX = "werft";

/** Upper bounds of the turn-duration histogram; MAX_TURN_SECONDS defaults to 3600. */
export const TURN_DURATION_BUCKETS = [
  1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600,
] as const;

// Label values read from data (tool and model names) are cut to the first
// ones ever seen, so the series a collector holds stay bounded.
export const TOOL_LABEL_LIMIT = 100;
const MODEL_LABEL_LIMIT = 50;
export const OTHER = "other";

export type SessionState =
  | "ended"
  | "paused"
  | "recovery_required"
  | "awaiting_approval"
  | "awaiting_answer"
  | "running"
  | "queued"
  | "idle"
  | "failed";

const ENDED_ADMISSIONS = new Set(["stopping", "stopped", "closing", "closed"]);
const PAUSED_ADMISSIONS = new Set(["pausing", "paused"]);

/** The session's public status and the state the `sessions` gauge files it under. */
export function sessionState(
  row: PlatformMetricsSnapshot["sessions"][number],
): {
  state: SessionState;
  status: string;
} {
  const status = publicStatus(
    row.status,
    row.awaitingApproval || row.awaitingAnswer,
  );
  // Before the status test: a kill that cut a running turn leaves the session
  // `stopped` and still waiting on a recovery decision.
  if (row.admission === "recovery_required") {
    return { state: "recovery_required", status };
  }
  if (ENDED_ADMISSIONS.has(row.admission) || row.status === "stopped") {
    return { state: "ended", status };
  }
  if (PAUSED_ADMISSIONS.has(row.admission)) return { state: "paused", status };
  if (status === "needs_input") {
    return {
      state: row.awaitingApproval ? "awaiting_approval" : "awaiting_answer",
      status,
    };
  }
  return { state: status as SessionState, status };
}

/** `mcp__<server>__<tool>` names one server's tool; a server is one label value. */
export function toolLabel(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const rest = name.slice("mcp__".length);
  const end = rest.indexOf("__");
  return `mcp__${end < 0 ? rest : rest.slice(0, end)}`;
}

/**
 * Keeps the `limit` values seen first (ties by value) and maps the rest to
 * `other`. Rows are never deleted, so a value once kept stays kept and no
 * series moves into `other` later.
 */
export function firstSeen(
  seen: readonly { value: string; firstAt: Date }[],
  limit: number,
): (value: string) => string {
  const earliest = new Map<string, number>();
  for (const { value, firstAt } of seen) {
    const at = firstAt.getTime();
    earliest.set(value, Math.min(earliest.get(value) ?? at, at));
  }
  const kept = new Set(
    [...earliest]
      .sort(([a, at], [b, bt]) => at - bt || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, limit)
      .map(([value]) => value),
  );
  return (value) => (kept.has(value) ? value : OTHER);
}

type Labels = Record<string, string>;
type Sample = { suffix?: string; labels: Labels; value: number | string };
type Family = {
  name: string;
  type: "gauge" | "counter" | "histogram";
  help: string;
  samples: Sample[];
};

/** Sums samples whose labels became equal (folded names), keeping first order. */
class Tally {
  private readonly rows = new Map<string, { labels: Labels; value: bigint }>();
  add(labels: Labels, value: bigint) {
    const key = JSON.stringify(labels);
    const row = this.rows.get(key);
    if (row) row.value += value;
    else this.rows.set(key, { labels, value });
  }
  samples(scale = 0): Sample[] {
    return [...this.rows.values()].map(({ labels, value }) => ({
      labels,
      value: scale === 0 ? value.toString() : decimal(value, scale),
    }));
  }
}

// cost_usd is numeric(14, 6): summed as integer micro-dollars, so folding
// several models into `other` adds no float error.
function micros(text: string): bigint {
  const [whole = "0", fraction = ""] = text.split(".");
  return (
    BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6))
  );
}

function decimal(value: bigint, scale: number): string {
  const unit = 10n ** BigInt(scale);
  return `${value / unit}.${(value % unit).toString().padStart(scale, "0")}`;
}

export function metricFamilies(snapshot: PlatformMetricsSnapshot): Family[] {
  const tool = firstSeen(
    snapshot.toolCalls.map((row) => ({
      value: toolLabel(row.name),
      firstAt: row.firstAt,
    })),
    TOOL_LABEL_LIMIT,
  );
  const model = firstSeen(
    snapshot.providerUsage.map((row) => ({
      value: row.model,
      firstAt: row.firstAt,
    })),
    MODEL_LABEL_LIMIT,
  );

  const sessions = new Tally();
  for (const row of snapshot.sessions) {
    const { state, status } = sessionState(row);
    sessions.add(
      { state, status, admission: row.admission },
      BigInt(row.count),
    );
  }

  const images = new Tally();
  for (const row of snapshot.sessionWorkerImages) {
    const { state } = sessionState({
      ...row,
      awaitingApproval: false,
      awaitingAnswer: false,
    });
    if (state !== "ended") images.add({ image: row.image }, BigInt(row.count));
  }

  const calls = new Tally();
  const results = new Tally();
  for (const row of snapshot.toolCalls) {
    const name = tool(toolLabel(row.name));
    calls.add({ tool: name }, BigInt(row.count));
    results.add({ tool: name, outcome: row.outcome }, BigInt(row.count));
  }

  const tokens = new Tally();
  const cost = new Tally();
  for (const row of snapshot.providerUsage) {
    const labels = { model: model(row.model), priced_by: row.pricedBy };
    for (const [kind, count] of [
      ["input", row.inputTokens],
      ["output", row.outputTokens],
      ["cache_read", row.cacheReadInputTokens],
      ["cache_creation", row.cacheCreationInputTokens],
    ] as const) {
      tokens.add({ ...labels, kind }, BigInt(count));
    }
    cost.add(labels, micros(row.costUsd));
  }

  const durations: Sample[] = [];
  for (const row of snapshot.settledTurns) {
    TURN_DURATION_BUCKETS.forEach((bound, i) => {
      durations.push({
        suffix: "_bucket",
        labels: { status: row.status, le: String(bound) },
        value: row.le[i] ?? 0,
      });
    });
    durations.push(
      {
        suffix: "_bucket",
        labels: { status: row.status, le: "+Inf" },
        value: row.timed,
      },
      { suffix: "_sum", labels: { status: row.status }, value: row.seconds },
      { suffix: "_count", labels: { status: row.status }, value: row.timed },
    );
  }

  return [
    {
      name: "sessions",
      type: "gauge",
      help: "Sessions by state, with the public status and the admission state it is read from.",
      samples: sessions.samples(),
    },
    {
      name: "sessions_by_worker_image",
      type: "gauge",
      help: "Sessions the `sessions` gauge does not count as ended, by the worker image their newest launch was pinned to. Sessions never launched are not counted.",
      samples: images.samples(),
    },
    {
      name: "turns_total",
      type: "counter",
      help: "Turns that ended completed, failed, interrupted or cancelled.",
      samples: snapshot.settledTurns.map((row) => ({
        labels: { status: row.status },
        value: row.count,
      })),
    },
    {
      name: "turn_duration_seconds",
      type: "histogram",
      help: "Wall-clock time from start to end of the turns in turns_total that started.",
      samples: durations,
    },
    {
      name: "turns_outcome_unknown",
      type: "gauge",
      help: "Turns whose execution went away before they ended, waiting on an operator's recovery decision.",
      samples: [{ labels: {}, value: snapshot.outcomeUnknownTurns }],
    },
    {
      name: "tool_calls_total",
      type: "counter",
      help: "Tool calls the engine made.",
      samples: calls.samples(),
    },
    {
      name: "tool_calls",
      type: "gauge",
      help: "Tool calls by their current outcome: ok, failed, denied (a person denied the permission request) or unknown (no result yet).",
      samples: results.samples(),
    },
    {
      name: "provider_tokens_total",
      type: "counter",
      help: "Provider tokens metered on calls, by model, pricing and kind.",
      samples: tokens.samples(),
    },
    {
      name: "provider_cost_usd_total",
      type: "counter",
      help: "Estimated provider cost in USD of metered calls, as the platform price table charged it (not Kubernetes infrastructure cost).",
      samples: cost.samples(6),
    },
    {
      name: "launch_queue_sessions",
      type: "gauge",
      help: "Sessions waiting for the scheduler to launch a worker.",
      samples: [{ labels: {}, value: snapshot.launchQueue.sessions }],
    },
    {
      name: "launch_queue_oldest_wait_seconds",
      type: "gauge",
      help: "How long the longest-waiting session in the launch queue has waited, 0 when it is empty.",
      samples: [{ labels: {}, value: snapshot.launchQueue.oldestWaitSeconds }],
    },
    {
      name: "input_queue_oldest_age_seconds",
      type: "gauge",
      help: "Age of the oldest visible input no worker has claimed, 0 when there is none.",
      samples: [{ labels: {}, value: snapshot.inputQueueOldestAgeSeconds }],
    },
  ];
}

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

export function renderMetrics(snapshot: PlatformMetricsSnapshot): string {
  const lines: string[] = [];
  for (const family of metricFamilies(snapshot)) {
    const name = `${METRIC_PREFIX}_${family.name}`;
    lines.push(
      `# HELP ${name} ${family.help}`,
      `# TYPE ${name} ${family.type}`,
    );
    for (const sample of family.samples) {
      const labels = Object.entries(sample.labels)
        .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
        .join(",");
      lines.push(
        `${name}${sample.suffix ?? ""}${labels ? `{${labels}}` : ""} ${sample.value}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
