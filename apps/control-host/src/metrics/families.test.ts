import { describe, expect, test } from "bun:test";
import type { PlatformMetricsSnapshot } from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  firstSeen,
  METRIC_PREFIX,
  metricFamilies,
  OTHER,
  renderMetrics,
  sessionState,
  TOOL_LABEL_LIMIT,
  toolLabel,
} from "./families.ts";
import { metricsHandler } from "./server.ts";

const T0 = Date.parse("2026-10-01T00:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

function snapshot(
  overrides: Partial<PlatformMetricsSnapshot> = {},
): PlatformMetricsSnapshot {
  return {
    sessions: [],
    settledTurns: [],
    outcomeUnknownTurns: 0,
    toolCalls: [],
    providerUsage: [],
    launchQueue: { sessions: 0, oldestWaitSeconds: 0 },
    inputQueueOldestAgeSeconds: 0,
    sessionWorkerImages: [],
    ...overrides,
  };
}

const row = (
  status: string,
  admission: string,
  awaiting: { approval?: boolean; answer?: boolean } = {},
) => ({
  status,
  admission,
  awaitingApproval: awaiting.approval ?? false,
  awaitingAnswer: awaiting.answer ?? false,
  count: 1,
});

const image = (
  image: string,
  status: string,
  admission: string,
  count: number,
) => ({ image, status, admission, count });

describe("session state", () => {
  test.each([
    [row("running", "active"), "running", "running"],
    [
      row("running", "active", { approval: true }),
      "awaiting_approval",
      "needs_input",
    ],
    [
      row("running", "active", { approval: true, answer: true }),
      "awaiting_approval",
      "needs_input",
    ],
    [row("idle", "active", { answer: true }), "awaiting_answer", "needs_input"],
    [row("queued", "active", { approval: true }), "queued", "queued"],
    [row("idle", "active"), "idle", "idle"],
    [row("failed", "active"), "failed", "failed"],
    [row("idle", "paused"), "paused", "idle"],
    [row("running", "pausing"), "paused", "running"],
    [row("idle", "resuming"), "idle", "idle"],
    [row("idle", "recovery_required"), "recovery_required", "idle"],
    [row("failed", "recovery_required"), "recovery_required", "failed"],
    // A terminate that cut a running turn: stopped, yet waiting on a decision.
    [row("stopped", "recovery_required"), "recovery_required", "stopped"],
    [row("stopped", "active"), "ended", "stopped"],
    [row("idle", "closed"), "ended", "idle"],
    [row("running", "stopping", { approval: true }), "ended", "needs_input"],
  ])("%o is %s", (input, state, status) => {
    expect(sessionState(input)).toEqual({ state, status } as never);
  });
});

describe("label values", () => {
  test("an MCP tool folds to its server", () => {
    expect(toolLabel("mcp__github__create_pull_request")).toBe("mcp__github");
    expect(toolLabel("mcp__my_server__do")).toBe("mcp__my_server");
    expect(toolLabel("mcp__bare")).toBe("mcp__bare");
    expect(toolLabel("Bash")).toBe("Bash");
  });

  test("the first values seen stay; later ones fold into other, and a busy newcomer does not displace them", () => {
    const seen = Array.from({ length: TOOL_LABEL_LIMIT + 1 }, (_, i) => ({
      value: `tool${String(i).padStart(3, "0")}`,
      firstAt: at(i),
    }));
    const before = firstSeen(seen, TOOL_LABEL_LIMIT);
    expect(before("tool000")).toBe("tool000");
    expect(before("tool099")).toBe("tool099");
    expect(before("tool100")).toBe(OTHER);
    // Later scrapes: new names arrive, none of them ever enters.
    const after = firstSeen(
      [...seen, { value: "late", firstAt: at(10_000) }],
      TOOL_LABEL_LIMIT,
    );
    for (const { value } of seen) expect(after(value)).toBe(before(value));
    expect(after("late")).toBe(OTHER);
  });
});

// Labels whose values come from a small set, or from the capped names.
const ALLOWED_LABELS: Record<string, string[]> = {
  sessions: ["state", "status", "admission"],
  sessions_by_worker_image: ["image"],
  turns_total: ["status"],
  turn_duration_seconds: ["status", "le"],
  turns_outcome_unknown: [],
  tool_calls_total: ["tool"],
  tool_calls: ["tool", "outcome"],
  provider_tokens_total: ["model", "priced_by", "kind"],
  provider_cost_usd_total: ["model", "priced_by"],
  launch_queue_sessions: [],
  launch_queue_oldest_wait_seconds: [],
  input_queue_oldest_age_seconds: [],
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("cardinality", () => {
  // A busy installation: many sessions, many distinct tool and model names.
  const busy = snapshot({
    sessions: Array.from({ length: 6 }, (_, i) =>
      row(
        ["queued", "running", "idle", "failed", "stopped", "running"][i] ??
          "idle",
        "active",
      ),
    ),
    settledTurns: [
      {
        status: "completed",
        count: 3,
        timed: 3,
        seconds: 12,
        le: [0, 1, 3, 3, 3, 3, 3, 3, 3, 3],
      },
    ],
    toolCalls: Array.from({ length: 300 }, (_, i) => ({
      name: i % 2 === 0 ? `tool-${i}` : `mcp__srv${i % 7}__op${i}`,
      outcome: "ok" as const,
      count: 1,
      firstAt: at(i),
    })),
    providerUsage: Array.from({ length: 80 }, (_, i) => ({
      model: `model-${i}`,
      pricedBy: "table" as const,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: "0.000001",
      firstAt: at(i),
    })),
  });

  test("every label is a known one and no value is an id", () => {
    for (const family of metricFamilies(busy)) {
      const allowed = ALLOWED_LABELS[family.name];
      expect(allowed, family.name).toBeDefined();
      for (const sample of family.samples) {
        for (const [key, value] of Object.entries(sample.labels)) {
          expect(allowed, `${family.name}.${key}`).toContain(key);
          expect(value, `${family.name}.${key}`).not.toMatch(UUID);
        }
      }
    }
  });

  test("tool and model series stay within their caps, other included", () => {
    const families = Object.fromEntries(
      metricFamilies(busy).map((family) => [family.name, family]),
    );
    const values = (name: string, label: string) =>
      new Set(families[name]?.samples.map((s) => s.labels[label]));
    expect(values("tool_calls_total", "tool").size).toBeLessThanOrEqual(
      TOOL_LABEL_LIMIT + 1,
    );
    expect(values("tool_calls_total", "tool").has(OTHER)).toBe(true);
    expect(values("provider_cost_usd_total", "model").size).toBe(51);
    // Folded calls are summed, not dropped.
    const total = families.tool_calls_total?.samples.reduce(
      (sum, s) => sum + Number(s.value),
      0,
    );
    expect(total).toBe(300);
  });
});

describe("exposition", () => {
  test("renders names under the one prefix, histogram series and exact cost sums", () => {
    const text = renderMetrics(
      snapshot({
        sessions: [row("running", "active", { approval: true })],
        settledTurns: [
          {
            status: "completed",
            count: 2,
            timed: 1,
            seconds: 42.5,
            le: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
          },
        ],
        outcomeUnknownTurns: 1,
        toolCalls: [
          { name: 'we"ird\\name', outcome: "denied", count: 2, firstAt: at(0) },
        ],
        providerUsage: [
          {
            model: "claude-sonnet-5",
            pricedBy: "table",
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 7,
            cacheCreationInputTokens: 3,
            costUsd: "0.100001",
            firstAt: at(0),
          },
          {
            model: "claude-sonnet-5",
            pricedBy: "fallback",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUsd: "12.5",
            firstAt: at(1),
          },
        ],
        launchQueue: { sessions: 2, oldestWaitSeconds: 17.25 },
        inputQueueOldestAgeSeconds: 3,
        sessionWorkerImages: [
          image("ghcr.io/x/worker@sha256:aa", "running", "active", 2),
          image("ghcr.io/x/worker@sha256:aa", "idle", "paused", 1),
          image("ghcr.io/x/worker@sha256:bb", "idle", "recovery_required", 1),
          // Ended either way: by status, and by admission.
          image("ghcr.io/x/worker@sha256:bb", "stopped", "active", 5),
          image("ghcr.io/x/worker@sha256:cc", "idle", "closed", 4),
        ],
      }),
    );
    const lines = text.trimEnd().split("\n");
    for (const line of lines) {
      if (line.startsWith("#")) continue;
      expect(line.startsWith(`${METRIC_PREFIX}_`), line).toBe(true);
    }
    expect(lines).toContain(
      'werft_sessions{state="awaiting_approval",status="needs_input",admission="active"} 1',
    );
    expect(lines).toContain("# TYPE werft_turn_duration_seconds histogram");
    expect(lines).toContain(
      'werft_turn_duration_seconds_bucket{status="completed",le="60"} 1',
    );
    expect(lines).toContain(
      'werft_turn_duration_seconds_bucket{status="completed",le="+Inf"} 1',
    );
    expect(lines).toContain(
      'werft_turn_duration_seconds_sum{status="completed"} 42.5',
    );
    expect(lines).toContain('werft_turns_total{status="completed"} 2');
    expect(lines).toContain(
      'werft_tool_calls{tool="we\\"ird\\\\name",outcome="denied"} 2',
    );
    expect(lines).toContain(
      'werft_provider_cost_usd_total{model="claude-sonnet-5",priced_by="fallback"} 12.500000',
    );
    expect(lines).toContain(
      'werft_provider_tokens_total{model="claude-sonnet-5",priced_by="table",kind="cache_read"} 7',
    );
    expect(lines).toContain("werft_launch_queue_oldest_wait_seconds 17.25");
    expect(lines).toContain("werft_input_queue_oldest_age_seconds 3");
    expect(
      lines.filter((line) =>
        line.startsWith("werft_sessions_by_worker_image{"),
      ),
    ).toEqual([
      'werft_sessions_by_worker_image{image="ghcr.io/x/worker@sha256:aa"} 3',
      'werft_sessions_by_worker_image{image="ghcr.io/x/worker@sha256:bb"} 1',
    ]);
    expect(text).toContain("not Kubernetes infrastructure cost");
  });

  test("costs folded into other add up to the micro-dollar", () => {
    const providerUsage = Array.from({ length: 52 }, (_, i) => ({
      model: `m${i}`,
      pricedBy: "table" as const,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: "0.100001",
      firstAt: at(i),
    }));
    expect(renderMetrics(snapshot({ providerUsage }))).toContain(
      'werft_provider_cost_usd_total{model="other",priced_by="table"} 0.200002',
    );
  });
});

describe("handler", () => {
  const logger = createLogger({ level: "error" });
  const get = (path: string) => new Request(`http://metrics${path}`);

  test("concurrent scrapes share one read", async () => {
    let reads = 0;
    let release: (text: string) => void = () => {};
    const handler = metricsHandler(() => {
      reads++;
      if (reads > 1) return Promise.resolve("x 2\n");
      return new Promise((resolve) => {
        release = resolve;
      });
    }, logger);
    const first = handler(get("/metrics"));
    const second = handler(get("/metrics"));
    release("x 1\n");
    const responses = await Promise.all([first, second]);
    expect(reads).toBe(1);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("version=0.0.4");
      expect(await response.text()).toBe("x 1\n");
    }
    await handler(get("/metrics"));
    expect(reads).toBe(2);
  });

  test("a failed read answers 503 and the next scrape reads again", async () => {
    let fail = true;
    const handler = metricsHandler(async () => {
      if (fail) throw new Error("database gone");
      return "x 1\n";
    }, logger);
    expect((await handler(get("/metrics"))).status).toBe(503);
    fail = false;
    expect((await handler(get("/metrics"))).status).toBe(200);
  });

  test("only /metrics and /healthz answer", async () => {
    const handler = metricsHandler(async () => "", logger);
    expect((await handler(get("/healthz"))).status).toBe(200);
    expect((await handler(get("/v1/sessions"))).status).toBe(404);
    expect(
      (await handler(new Request("http://metrics/metrics", { method: "POST" })))
        .status,
    ).toBe(405);
  });
});
