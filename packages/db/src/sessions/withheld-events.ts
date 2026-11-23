import {
  eventToolCall,
  eventToolResult,
  PLATFORM_SYSTEM_SUBTYPE_VALUES,
  type SessionEventPayload,
} from "@werft-ai/contracts";

/** What a withheld turn's `error` event says in place of its own words. */
export const WITHHELD_ERROR_MESSAGE =
  "Withheld: this turn's Slack message was deleted";

const platformSubtypes: ReadonlySet<unknown> = new Set(
  PLATFORM_SYSTEM_SUBTYPE_VALUES,
);

/**
 * An event of a turn whose instruction Slack deleted, as a reader is
 * served it: what tells the turn's course is kept (kinds, tool call ids
 * and names, a result's usage and outcome), every word it read or wrote is
 * left out, an engine's free-form notes and reasons included. The
 * platform's own system events and status events (but a title) pass.
 */
export function withheldEventPayload(
  payload: SessionEventPayload,
): SessionEventPayload {
  switch (payload.event) {
    case "assistant":
    case "tool_use": {
      const call = eventToolCall(payload.data);
      return {
        event: payload.event,
        data: {
          type: "assistant",
          ...(payload.data.parent_tool_use_id === undefined
            ? {}
            : { parent_tool_use_id: payload.data.parent_tool_use_id }),
          ...(call === null
            ? {}
            : { tool_call: { id: call.id, name: call.name, input: {} } }),
        },
      };
    }
    case "tool_result": {
      const result = eventToolResult(payload.data);
      return {
        event: "tool_result",
        data:
          result === null
            ? {}
            : {
                tool_result: {
                  tool_call_id: result.tool_call_id,
                  is_error: result.is_error,
                  text: "",
                },
              },
      };
    }
    case "question":
      return { event: "question", data: { ...payload.data, input: {} } };
    case "system":
      return platformSubtypes.has(payload.data.subtype)
        ? payload
        : {
            event: "system",
            data: {
              type: "system",
              ...(payload.data.engine_event === undefined
                ? {}
                : { engine_event: payload.data.engine_event }),
            },
          };
    case "error":
      return {
        event: "error",
        data: {
          message: WITHHELD_ERROR_MESSAGE,
          ...(payload.data.code === undefined
            ? {}
            : { code: payload.data.code }),
        },
      };
    case "status": {
      if (payload.data.title === undefined) return payload;
      const { title: _title, ...data } = payload.data;
      return { event: "status", data };
    }
    case "result": {
      const { type, subtype, session_id, usage, runtime } = payload.data;
      const turn =
        payload.data.turn === undefined
          ? undefined
          : { ...payload.data.turn, terminal_reason: null };
      return {
        event: "result",
        data: Object.fromEntries(
          Object.entries({
            type,
            subtype,
            session_id,
            usage,
            turn,
            runtime,
          }).filter(([, value]) => value !== undefined),
        ) as typeof payload.data,
      };
    }
    default:
      return payload;
  }
}
