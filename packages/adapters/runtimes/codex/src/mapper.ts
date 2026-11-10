import { randomUUID } from "node:crypto";
import type { SessionEvent, SessionEventPayload } from "@werft-ai/contracts";
import { codexEventCodec } from "@werft-ai/runtime-codex-codec";
import type { RuntimeEvent, TurnEnded } from "@werft-ai/runtime-core";

/** The names the engine's tools carry in events, approvals and the neutral tool call. */
export const COMMAND_TOOL = "exec_command";
export const FILE_CHANGE_TOOL = "apply_patch";

export type Item = { type: string; id: string } & Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function itemOf(params: Record<string, unknown>): Item | undefined {
  const item = record(params.item);
  return typeof item.type === "string" && typeof item.id === "string"
    ? (item as Item)
    : undefined;
}

/**
 * One v1 public event, with its neutral fields. The id is fresh per event:
 * nothing replays a Codex thread's events (a resume reads the rollout, not
 * the stream), so there is no earlier id for a repeat to collide with.
 */
function publicEvent(
  event: SessionEventPayload,
  inputs: readonly string[],
): RuntimeEvent {
  return {
    type: "public",
    event: {
      ...codexEventCodec.withNeutralFields(event),
      id: randomUUID(),
    } as SessionEvent,
    ...(inputs.length === 0 ? {} : { inputs }),
  };
}

function assistantEvent(
  block: Record<string, unknown>,
  inputs: readonly string[],
): RuntimeEvent {
  return publicEvent(
    {
      event: block.type === "tool_use" ? "tool_use" : "assistant",
      data: {
        type: "assistant",
        message: { role: "assistant", content: [block] },
      },
    } as SessionEventPayload,
    inputs,
  );
}

function toolResultEvent(
  id: string,
  text: string,
  isError: boolean,
  inputs: readonly string[],
): RuntimeEvent {
  return publicEvent(
    {
      event: "tool_result",
      data: {
        type: "tool_result",
        tool_use_id: id,
        content: [{ type: "text", text }],
        is_error: isError,
      },
    } as SessionEventPayload,
    inputs,
  );
}

function systemEvent(
  subtype: string,
  fields: Record<string, unknown>,
  inputs: readonly string[],
): RuntimeEvent {
  return publicEvent(
    {
      event: "system",
      data: { type: "system", subtype, ...fields },
    } as SessionEventPayload,
    inputs,
  );
}

/** The engine started its thread: the first thing a person's transcript shows. */
export function startedEvent(threadId: string, model: string): RuntimeEvent {
  return systemEvent("init", { session_id: threadId, model }, []);
}

function toolCall(
  item: Item,
  tool: string,
  input: Record<string, unknown>,
  inputs: readonly string[],
): RuntimeEvent[] {
  return [
    assistantEvent(
      { type: "tool_use", id: item.id, name: tool, input },
      inputs,
    ),
    { type: "tool.called", toolCallId: item.id, tool },
  ];
}

/**
 * The platform's name for an MCP tool, as the Claude engine names it. The
 * server and tool come from the engine's own fields, never split from a
 * joined name.
 */
export function mcpToolName(item: Item): string {
  return `mcp__${String(item.server)}__${String(item.tool)}`;
}

export function changePaths(item: Item): string[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return changes.flatMap((change) => {
    const path = record(change).path;
    return typeof path === "string" ? [path] : [];
  });
}

/**
 * The item a tool call starts as, before it is asked or run. For one call the
 * contract is: the public tool event, then `tool.called`, then (from the
 * run) `approval.requested`.
 */
export function itemStarted(
  item: Item,
  inputs: readonly string[],
): RuntimeEvent[] {
  if (item.type === "commandExecution") {
    return toolCall(
      item,
      COMMAND_TOOL,
      { command: item.command ?? null, cwd: item.cwd ?? null },
      inputs,
    );
  }
  if (item.type === "mcpToolCall") {
    const arguments_ = record(item.arguments);
    return toolCall(item, mcpToolName(item), arguments_, inputs);
  }
  if (item.type === "fileChange") {
    return toolCall(
      item,
      FILE_CHANGE_TOOL,
      { paths: changePaths(item) },
      inputs,
    );
  }
  return [];
}

const FAILED = new Set(["failed", "declined"]);

export function itemCompleted(
  item: Item,
  inputs: readonly string[],
): RuntimeEvent[] {
  switch (item.type) {
    case "userMessage": {
      const named = typeof item.clientId === "string" ? [item.clientId] : [];
      return named.length === 0
        ? []
        : [{ type: "inputs.named", inputs: named }];
    }
    case "agentMessage":
      return typeof item.text === "string" && item.text !== ""
        ? [assistantEvent({ type: "text", text: item.text }, inputs)]
        : [];
    case "reasoning": {
      const parts = [item.summary, item.content].flatMap((list) =>
        Array.isArray(list) ? list.filter((s) => typeof s === "string") : [],
      );
      const text = parts.join("\n").trim();
      return text === ""
        ? []
        : [assistantEvent({ type: "thinking", thinking: text }, inputs)];
    }
    case "commandExecution": {
      const status = String(item.status);
      const failed =
        FAILED.has(status) ||
        (typeof item.exitCode === "number" && item.exitCode !== 0);
      const output =
        typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
      return [toolResultEvent(item.id, output || status, failed, inputs)];
    }
    case "mcpToolCall": {
      const failed =
        item.status === "failed" || record(item.error).message !== undefined;
      const message = record(item.error).message;
      const content = Array.isArray(record(item.result).content)
        ? (record(item.result).content as unknown[])
        : [];
      const text = content
        .flatMap((part) => {
          const value = record(part).text;
          return typeof value === "string" ? [value] : [];
        })
        .join("\n");
      return [
        toolResultEvent(
          item.id,
          typeof message === "string" ? message : text || String(item.status),
          failed,
          inputs,
        ),
      ];
    }
    case "fileChange": {
      const status = String(item.status);
      const paths = changePaths(item);
      return [
        toolResultEvent(
          item.id,
          `${status}: ${paths.join(", ")}`,
          FAILED.has(status),
          inputs,
        ),
      ];
    }
    default:
      // An item the profile does not enable (search, images, plans, …) is
      // kept visible as an engine event rather than dropped.
      return [systemEvent("sdk_event", { native_type: item.type }, inputs)];
  }
}

export type TurnUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export const EMPTY_USAGE: TurnUsage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
};

/** Adds one request's usage (`ThreadTokenUsage.last`) to the turn's. */
export function addUsage(total: TurnUsage, last: unknown): TurnUsage {
  const fields = record(last);
  const n = (key: string) =>
    typeof fields[key] === "number" ? (fields[key] as number) : 0;
  return {
    input_tokens: total.input_tokens + n("inputTokens"),
    cached_input_tokens: total.cached_input_tokens + n("cachedInputTokens"),
    output_tokens: total.output_tokens + n("outputTokens"),
    reasoning_output_tokens:
      total.reasoning_output_tokens + n("reasoningOutputTokens"),
  };
}

export type TurnOutcome = {
  status: string;
  error: { message: string; httpStatus?: number } | null;
};

export function outcomeOf(turn: Record<string, unknown>): TurnOutcome {
  const error = record(turn.error);
  const info = record(error.codexErrorInfo);
  const http = Object.values(info)
    .map((v) => record(v).httpStatusCode)
    .find((v) => typeof v === "number");
  return {
    status: typeof turn.status === "string" ? turn.status : "failed",
    error:
      typeof error.message === "string"
        ? {
            message: error.message,
            ...(typeof http === "number" ? { httpStatus: http } : {}),
          }
        : null,
  };
}

/** The turn's result as a public event and as the host's `turn.ended`. */
export function turnEvents(
  threadId: string,
  outcome: TurnOutcome,
  usage: TurnUsage,
  inputs: readonly string[],
): RuntimeEvent[] {
  const interrupted = outcome.status === "interrupted";
  const isError = outcome.status !== "completed";
  const subtype = !isError
    ? "success"
    : interrupted
      ? "interrupted"
      : "error_during_execution";
  const reason = outcome.error?.message ?? outcome.status;
  const ended: TurnEnded = {
    isError,
    abortedByStop: interrupted,
    budgetExceeded: false,
    ...(isError
      ? {
          failure: {
            reason,
            ...(outcome.error?.httpStatus === undefined
              ? {}
              : { httpStatus: outcome.error.httpStatus }),
          },
        }
      : {}),
    engineResult: {
      subtype,
      is_error: isError,
      terminal_reason: isError ? reason : null,
    },
    // The engine reports tokens, not money; the platform prices them where it
    // knows the model, so no spend is claimed here.
    cost: { countRestarted: false, unknown: true },
    usage,
    engineSessionId: threadId,
    inputs,
  };
  return [
    publicEvent(
      {
        event: "result",
        data: {
          type: "result",
          subtype,
          is_error: isError,
          session_id: threadId,
          usage,
          ...(isError ? { terminal_reason: reason } : {}),
        },
      } as SessionEventPayload,
      inputs,
    ),
    { type: "turn.ended", turn: ended },
  ];
}

export function warningEvent(
  message: string,
  inputs: readonly string[],
): RuntimeEvent {
  return systemEvent("warning", { message }, inputs);
}
