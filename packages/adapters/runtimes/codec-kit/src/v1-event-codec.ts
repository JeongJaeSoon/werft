import {
  type EngineEvent,
  PLATFORM_SYSTEM_SUBTYPE_VALUES,
  type RuntimeKind,
  type SessionEventPayload,
  type ToolCall,
  type ToolResult,
  type TurnEnd,
} from "@werft-ai/contracts";

import type { EventCodec } from "@werft-ai/runtime-core";

const PLATFORM_SUBTYPES = new Set<string>(PLATFORM_SYSTEM_SUBTYPE_VALUES);
const ENGINE_CATEGORIES: Record<string, EngineEvent["category"]> = {
  init: "started",
  thinking_tokens: "thinking",
  vcs_state_changed: "workspace",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// An adapter writes one content block per assistant or tool_use event.
function block(data: Record<string, unknown>): Record<string, unknown> | null {
  const content = asRecord(data.message)?.content;
  return Array.isArray(content) ? asRecord(content[0]) : null;
}

function assistantFields(data: Record<string, unknown>) {
  const b = block(data);
  if (b?.type === "text") return { text: str(b.text) ?? "" };
  if (b?.type === "thinking") return { thinking: str(b.thinking) ?? "" };
  const id = str(b?.id);
  if (b?.type === "tool_use" && id) {
    const call: ToolCall = {
      id,
      name: str(b.name) ?? "",
      input: b.input === undefined ? null : b.input,
    };
    return { tool_call: call };
  }
  return {};
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      const text = asRecord(item)?.text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

function toolResultFields(data: Record<string, unknown>) {
  const id = str(data.tool_use_id);
  if (!id) return {};
  const result: ToolResult = {
    tool_call_id: id,
    is_error: !("is_error" in data)
      ? false
      : typeof data.is_error === "boolean"
        ? data.is_error
        : null,
    text: resultText(data.content),
  };
  return { tool_result: result };
}

function tokens(usage: unknown): number | null {
  const fields = asRecord(usage);
  const counts = [fields?.input_tokens, fields?.output_tokens].filter(
    (value): value is number => typeof value === "number",
  );
  return counts.length > 0 ? counts.reduce((a, b) => a + b, 0) : null;
}

/**
 * The reader of the v1 public events an adapter's mapper writes
 * (`assistant`/`tool_use` with one content block, `tool_result` with a
 * `tool_use_id`, `result`, `system`): it adds the engine-neutral fields beside
 * them. `unknownSession` is what the mapper writes for an engine session it
 * did not learn the id of.
 */
export function createV1EventCodec(options: {
  kind: RuntimeKind;
  unknownSession: string;
}): EventCodec {
  const { kind, unknownSession } = options;

  function resultFields(data: Record<string, unknown>) {
    const turn: TurnEnd = {
      outcome: str(data.subtype) || "unknown",
      is_error: data.is_error === true,
      terminal_reason: str(data.terminal_reason) || null,
      tokens: tokens(data.usage),
    };
    const session = str(data.session_id);
    return {
      turn,
      runtime: {
        kind,
        session_ref: session && session !== unknownSession ? session : null,
      },
    };
  }

  function systemFields(data: Record<string, unknown>) {
    const subtype = str(data.subtype) ?? "";
    if (PLATFORM_SUBTYPES.has(subtype)) return {};
    const engine: EngineEvent =
      subtype === "sdk_event"
        ? { name: str(data.native_type) ?? subtype, category: "internal" }
        : { name: subtype, category: ENGINE_CATEGORIES[subtype] ?? "other" };
    return { engine_event: engine };
  }

  function neutralFields(event: SessionEventPayload): Record<string, unknown> {
    const data = asRecord(event.data);
    if (data === null) return {};
    switch (event.event) {
      case "assistant":
      case "tool_use":
        return assistantFields(data);
      case "tool_result":
        return toolResultFields(data);
      case "result":
        return resultFields(data);
      case "system":
        return systemFields(data);
      default:
        return {};
    }
  }

  return {
    kind,
    withNeutralFields(event) {
      const added = neutralFields(event);
      const data = event.data as Record<string, unknown>;
      const missing = Object.entries(added).filter(([key]) => !(key in data));
      if (missing.length === 0) return event;
      return {
        ...event,
        data: { ...data, ...Object.fromEntries(missing) },
      } as SessionEventPayload;
    },
  };
}
