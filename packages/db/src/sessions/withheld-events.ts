import {
  eventToolCall,
  eventToolResult,
  type SessionEventPayload,
} from "@werft-ai/contracts";

/**
 * An event of a turn whose instruction Slack deleted, as a reader is
 * served it: what tells the turn's course is kept (kinds, tool call ids
 * and names, a result's usage and outcome), every word it read or wrote is
 * left out. Status, system and error events carry none and pass as they are.
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
    case "result": {
      const { type, subtype, session_id, usage, turn, runtime } = payload.data;
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
