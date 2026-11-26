import type {
  EngineEvent,
  EngineEventCategory,
  ToolCall,
  ToolResult,
  TurnEnd,
} from "./event.ts";

/*
 * Reads the engine-neutral fields of an event's data (event.ts), the only
 * fields a reader outside the runtime adapters may read. Each takes any
 * value, parsed or not, and returns null for a field that is absent or
 * malformed. Free of zod for the same reason as present-turn-event.
 */

// The field the control plane stores beside an event (`events.neutral`) when
// the event came from an attempt with no turn open and was put on the turn
// that attempt ended last: engine output between turns continues that turn.
// Read merged into the event's data, like every neutral field.
export const AFTER_TURN_FIELD = "after_turn";
export const BACKGROUND_TASKS_STOPPED_SUBTYPE = "background_tasks_stopped";
const STOPPED_BACKGROUND_COMMAND = /^[A-Za-z0-9._+-]{1,32}$/;
const MAX_STOPPED_BACKGROUND_COMMANDS = 16;

/**
 * The command names of a `background_tasks_stopped` event, or null for
 * anything else. The event arrives from a worker, so only names of that shape
 * are ever shown or handed to an engine.
 */
export function stoppedBackgroundCommands(data: unknown): string[] | null {
  const record = asRecord(data);
  if (
    record === null ||
    record.type !== "system" ||
    record.subtype !== BACKGROUND_TASKS_STOPPED_SUBTYPE ||
    !Array.isArray(record.commands)
  ) {
    return null;
  }
  return record.commands
    .filter(
      (name): name is string =>
        typeof name === "string" && STOPPED_BACKGROUND_COMMAND.test(name),
    )
    .slice(0, MAX_STOPPED_BACKGROUND_COMMANDS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The data with the neutral fields stored beside it (`events.neutral`) that
 * it lacks: a key the data holds itself is kept as it is.
 */
export function withStoredNeutralFields(
  data: unknown,
  neutral: unknown,
): unknown {
  const record = asRecord(data);
  const fields = asRecord(neutral);
  if (record === null || fields === null) return data;
  // The mark of an event that came after its turn is the control plane's
  // alone: there the stored field wins.
  const added = Object.entries(fields).filter(
    ([key]) => key === AFTER_TURN_FIELD || !(key in record),
  );
  return added.length === 0
    ? data
    : { ...record, ...Object.fromEntries(added) };
}

const CATEGORIES = new Set<string>([
  "started",
  "thinking",
  "workspace",
  "internal",
  "other",
] satisfies EngineEventCategory[]);

export function eventToolCall(data: unknown): ToolCall | null {
  const call = asRecord(asRecord(data)?.tool_call);
  if (
    typeof call?.id !== "string" ||
    call.id === "" ||
    typeof call.name !== "string" ||
    call.input === undefined
  ) {
    return null;
  }
  return { id: call.id, name: call.name, input: call.input };
}

export function eventText(data: unknown): string | null {
  const text = asRecord(data)?.text;
  return typeof text === "string" ? text : null;
}

export function eventThinking(data: unknown): string | null {
  const thinking = asRecord(data)?.thinking;
  return typeof thinking === "string" ? thinking : null;
}

export function eventToolResult(data: unknown): ToolResult | null {
  const result = asRecord(asRecord(data)?.tool_result);
  if (
    typeof result?.tool_call_id !== "string" ||
    result.tool_call_id === "" ||
    typeof result.text !== "string" ||
    !(typeof result.is_error === "boolean" || result.is_error === null)
  ) {
    return null;
  }
  return {
    tool_call_id: result.tool_call_id,
    is_error: result.is_error,
    text: result.text,
  };
}

export function eventEngineEvent(data: unknown): EngineEvent | null {
  const engine = asRecord(asRecord(data)?.engine_event);
  if (
    typeof engine?.name !== "string" ||
    typeof engine.category !== "string" ||
    !CATEGORIES.has(engine.category)
  ) {
    return null;
  }
  return {
    name: engine.name,
    category: engine.category as EngineEventCategory,
  };
}

export function eventTurnEnd(data: unknown): TurnEnd | null {
  const turn = asRecord(asRecord(data)?.turn);
  if (
    typeof turn?.outcome !== "string" ||
    turn.outcome === "" ||
    typeof turn.is_error !== "boolean" ||
    !(typeof turn.terminal_reason === "string" || turn.terminal_reason === null)
  ) {
    return null;
  }
  const tokens = typeof turn.tokens === "number" ? turn.tokens : null;
  return {
    outcome: turn.outcome,
    is_error: turn.is_error,
    terminal_reason: turn.terminal_reason,
    tokens,
  };
}
