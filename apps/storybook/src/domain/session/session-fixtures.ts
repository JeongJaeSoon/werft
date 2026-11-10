import {
  eventToolCall,
  eventToolResult,
  presentTurnEvent,
  type SessionSummary,
  type TurnEventMessage,
  type TurnEventMessageKey,
} from "@werft-ai/contracts";
import type { TimelineEntry } from "@werft-ai/react/components";

/*
 * Short English copy for the session stories. The real wording lives in the
 * screen's dictionary; packages/ui only asks for it.
 */
const COPY: Record<TurnEventMessageKey, string> = {
  "sessions.status.queued": "Queued",
  "sessions.status.running": "Working",
  "sessions.status.needs_input": "Waiting for an answer",
  "sessions.status.idle": "Idle",
  "sessions.status.failed": "Failed",
  "sessions.status.stopped": "Stopped",
  "session.event.phase.interrupting": "Stopping",
  "session.event.phase.engine_stopped": "Engine stopped",
  "session.event.kind.status": "Status",
  "session.event.kind.system": "System",
  "session.event.kind.internal": "Internal",
  "session.event.kind.thinking": "Thinking",
  "session.event.kind.assistant": "Reply",
  "session.event.kind.toolUse": "Tool call",
  "session.event.kind.toolResult": "Tool result",
  "session.event.kind.permission": "Permission request",
  "session.event.kind.question": "Question",
  "session.event.kind.result": "Turn end",
  "session.event.kind.error": "Error",
  "session.event.error.modelNotAllowed":
    "Model requests for this session were blocked because {model} is no longer on its connection's model list",
  "session.event.error.modelConnectionRemoved":
    "Model requests for this session were blocked because the connection that served {model} is gone",
  "session.event.modelMigrated":
    "{from} left the allowed list, so the session moved to {to}",
  "session.event.init": "Session started",
  "session.event.vcsChanged": "Working tree changed",
  "session.event.thinkingTokens": "Thinking ({count})",
  "session.event.thought": "Thought",
  "session.event.toolResult": "{tool} result",
  "session.event.toolResult.unknown": "Tool result",
  "session.event.toolResult.ok": "succeeded",
  "session.event.toolResult.error": "failed",
  "session.event.toolResult.lines": "{count} lines",
  "session.event.result.success": "Turn complete",
  "session.event.result.other": "Turn ended ({subtype})",
  "session.event.result.tokens": "{count} tokens",
};

export function formatMessage({ key, params }: TurnEventMessage): string {
  return COPY[key].replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params?.[name] ?? ""),
  );
}

// Fixed ids and times, as in the other stories: no clocks, no randomness.
const START = Date.parse("2026-10-21T01:00:00.000Z");

type RawEvent = readonly [event: string, data: unknown, turnId?: string | null];

/** Raw events through presentTurnEvent, pairing tool results with calls. */
export function timelineEntries(events: readonly RawEvent[]): TimelineEntry[] {
  const toolNames = new Map<string, string>();
  return events.map(([event, data, turnId = "turn_01"], index) => {
    const call = eventToolCall(data);
    if (call) toolNames.set(call.id, call.name);
    const callId = eventToolResult(data)?.tool_call_id;
    return {
      id: `evt_${index}`,
      occurredAt: new Date(START + index * 4000).toISOString(),
      turnId,
      presentation: presentTurnEvent(
        { event, data },
        { toolName: callId ? toolNames.get(callId) : undefined },
      ),
    };
  });
}

// Events as the runtime's codec gives them: only the engine-neutral fields
// are read.
const STARTED: RawEvent = [
  "system",
  { engine_event: { name: "init", category: "started" } },
];
const THINKING_TICK: RawEvent = [
  "system",
  { engine_event: { name: "thinking_tokens", category: "thinking" } },
];
const toolUse = (id: string, input: Record<string, unknown>): RawEvent => [
  "tool_use",
  { tool_call: { id, name: "Bash", input } },
];
const toolResult = (id: string, text: string, isError = false): RawEvent => [
  "tool_result",
  { tool_result: { tool_call_id: id, is_error: isError, text } },
];
const turnEnd = (outcome: string, tokens: number | null = null): RawEvent => [
  "result",
  {
    turn: {
      outcome,
      is_error: false,
      terminal_reason: null,
      tokens,
    },
  },
];

export const TURN_EVENTS: readonly RawEvent[] = [
  ["status", { phase: "running" }],
  STARTED,
  THINKING_TICK,
  THINKING_TICK,
  THINKING_TICK,
  [
    "system",
    { engine_event: { name: "rate_limit_event", category: "internal" } },
  ],
  ["assistant", { thinking: "Run the tests first, then read the failure." }],
  toolUse("call_1", { command: "bun test", description: "Run the tests" }),
  toolResult("call_1", "12 pass\n0 fail\nRan 12 tests"),
  ["assistant", { text: "All 12 tests pass." }],
  turnEnd("success", 1540),
  ["status", { phase: "idle" }],
];

const MARKDOWN_REPLY = [
  "Two repositories are connected now.",
  "",
  "**werft-sandbox:** the sample pull request is open at https://example.com/pull/7.",
  "",
  "**agent-guard, agent-skills:** both linked in this turn.",
  "",
  "- Branch `feature/sample` was pushed",
  "- Checks: 3 of 3 passed ([run log](https://example.com/runs/1))",
  "",
  "| Repository | Result |",
  "| --- | --- |",
  "| werft-sandbox | opened |",
  "| agent-guard | linked |",
  "",
  "```sh",
  "git push origin feature/sample",
  "```",
].join("\n");

/** A reply with bold, list, link, code and a table, drawn as Markdown. */
export const MARKDOWN_REPLY_EVENTS: readonly RawEvent[] = [
  ["status", { phase: "running" }],
  ["assistant", { text: MARKDOWN_REPLY }],
  turnEnd("success", 900),
  ["status", { phase: "idle" }],
];

/** Long enough to fold: shows its first blocks and a "Show more" button. */
export const LONG_REPLY_EVENTS: readonly RawEvent[] = [
  ["status", { phase: "running" }],
  [
    "assistant",
    {
      text: Array.from(
        { length: 30 },
        (_, index) =>
          `Step ${index + 1}: ${"the worker checked this part of the change and found nothing to fix. ".repeat(2)}`,
      ).join("\n\n"),
    },
  ],
  turnEnd("success", 1200),
  ["status", { phase: "idle" }],
];

export const FAILED_EVENTS: readonly RawEvent[] = [
  ["status", { phase: "running" }],
  toolUse("call_2", { command: "bun run build" }),
  toolResult("call_2", "error: Could not resolve './missing.ts'", true),
  ["error", { message: "The engine stopped before the turn finished." }],
  ["status", { phase: "failed" }],
];

/** The clock the turn stories count relative times from. */
export const TIMELINE_NOW = START + 12 * 60_000;

/**
 * Like `timelineEntries`, with each tool call and result carrying the
 * tool_use id (as session-detail.tsx would fill `toolCallId`) and the events
 * `stepMs` apart, so relative times and same-minute runs both show.
 */
export function pairedTimelineEntries(
  events: readonly RawEvent[],
  stepMs = 20_000,
): TimelineEntry[] {
  return timelineEntries(events).map((entry, index) => {
    const data = events[index]?.[1];
    const toolCallId =
      eventToolResult(data)?.tool_call_id ?? eventToolCall(data)?.id;
    return {
      ...entry,
      occurredAt: new Date(START + index * stepMs).toISOString(),
      ...(toolCallId ? { toolCallId } : {}),
    };
  });
}

const inTurn = (events: readonly RawEvent[], turnId: string | null) =>
  events.map(([event, data]): RawEvent => [event, data, turnId]);

/** A second turn: a permission wait, then a tool call that fails. */
export const WAIT_FAIL_EVENTS: readonly RawEvent[] = inTurn(
  [
    ["status", { phase: "running" }],
    ["question", { kind: "permission", tool: "Bash", input: {} }],
    toolUse("call_3", { command: "bun run build", description: "Build" }),
    toolResult("call_3", "error: Could not resolve './missing.ts'", true),
    ["assistant", { text: "The build cannot find a file." }],
    turnEnd("error_during_execution"),
    ["status", { phase: "failed" }],
  ],
  "turn_02",
);

/** Two turns covering every kind: what the user's capture asked for. */
export const TWO_TURN_EVENTS: readonly RawEvent[] = [
  ...TURN_EVENTS,
  ...WAIT_FAIL_EVENTS,
];

/** A call still waiting for its result. */
export const RUNNING_EVENTS: readonly RawEvent[] = inTurn(
  [
    ["status", { phase: "running" }],
    toolUse("call_4", { command: "bun test", description: "Run the tests" }),
  ],
  "turn_03",
);

/** Events from before the first turn carry no turn id. */
export const NO_TURN_EVENTS: readonly RawEvent[] = [
  ...inTurn([STARTED, ["status", { phase: "queued" }]], null),
  ...inTurn(
    [["assistant", { text: "Starting." }], turnEnd("success")],
    "turn_01",
  ),
];

/** A long thought and a long tool output, both folded under one line. */
export const LONG_DETAIL_EVENTS: readonly RawEvent[] = inTurn(
  [
    [
      "assistant",
      {
        thinking: Array.from(
          { length: 6 },
          (_, line) =>
            `Step ${line + 1}: read the failing test, then the module it imports, and check whether the fixture path changed in the last commit.`,
        ).join("\n"),
      },
    ],
    toolUse("call_5", { command: "bun test packages/react" }),
    toolResult(
      "call_5",
      Array.from(
        { length: 14 },
        (_, line) => `(pass) Timeline > case ${line + 1} [${line + 2}ms]`,
      ).join("\n"),
    ),
  ],
  "turn_01",
);

export const SESSION: SessionSummary = {
  id: "0192f0c4-7d3a-7b4e-9f00-00000000a001",
  title: null,
  agent: null,
  created_by: null,
  channel: null,
  slack_permalink: null,
  revision: 4,
  admission_state: "active",
  status: "running",
  runtime: {
    kind: "claude_agent_sdk",
    version: "0.2.1",
    connection_id: "anthropic-main",
    model: "claude-sonnet-4-5",
    permission_mode: "default",
  },
  model: "claude-sonnet-4-5",
  repository_id: "werft",
  repository: {
    id: "werft",
    full_name: "werft-ai/werft",
    branch: "main",
  },
  current_turn_id: "turn_01",
  queued_turn_count: 1,
  last_event_at: "2026-10-21T01:00:44.000Z",
  created_at: "2026-10-21T00:58:00.000Z",
  updated_at: "2026-10-21T01:00:44.000Z",
};

export const SESSION_ROW_MESSAGES = {
  status: (status: SessionSummary["status"]) =>
    COPY[`sessions.status.${status}`],
  admission: (state: SessionSummary["admission_state"]) =>
    ({
      active: "Active",
      pausing: "Pausing",
      paused: "Paused",
      resuming: "Resuming",
      stopping: "Ending",
      stopped: "Ended",
      recovery_required: "Needs recovery",
      closing: "Archiving",
      closed: "Archived",
    })[state],
  statusAxis: "Status",
  admissionAxis: "State",
  runtime: "Runtime",
  lastEvent: "Last event",
  created: "Created",
  queuedTurns: (count: number) => `${count} queued`,
  none: "None",
};
