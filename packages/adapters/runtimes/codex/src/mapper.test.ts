import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "@werft-ai/runtime-core";

import {
  addUsage,
  EMPTY_USAGE,
  type Item,
  itemCompleted,
  itemStarted,
  outcomeOf,
  turnEvents,
} from "./mapper.ts";

const command = (extra: Record<string, unknown> = {}): Item => ({
  type: "commandExecution",
  id: "call-1",
  command: "ls",
  cwd: "/work",
  ...extra,
});

function publicData(event: RuntimeEvent | undefined) {
  if (event?.type !== "public")
    throw new Error(`not a public event: ${event?.type}`);
  return {
    kind: event.event.event,
    data: event.event.data as Record<string, unknown>,
    id: event.event.id,
  };
}

describe("a tool call", () => {
  test("is the public tool event, then tool.called, in that order", () => {
    const [tool, called, ...rest] = itemStarted(command(), ["in-1"]);
    expect(rest).toEqual([]);
    const { kind, data } = publicData(tool);
    expect(kind).toBe("tool_use");
    expect(data.message).toMatchObject({
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "exec_command" }],
    });
    expect(called).toEqual({
      type: "tool.called",
      toolCallId: "call-1",
      tool: "exec_command",
    });
    expect(tool).toMatchObject({ inputs: ["in-1"] });
  });

  test("a file change is the apply_patch tool with the paths it touches", () => {
    const [tool, called] = itemStarted(
      {
        type: "fileChange",
        id: "p-1",
        changes: [{ path: "a.txt" }, { path: "b.txt" }],
      },
      [],
    );
    expect(called).toMatchObject({ tool: "apply_patch" });
    const block = (
      publicData(tool).data.message as { content: Array<{ input: unknown }> }
    ).content[0];
    expect(block?.input).toEqual({ paths: ["a.txt", "b.txt"] });
  });

  test("items that are not tools announce nothing", () => {
    expect(
      itemStarted({ type: "agentMessage", id: "m", text: "hi" }, []),
    ).toEqual([]);
  });

  test("a result carries the call id and its failure", () => {
    const ok = publicData(
      itemCompleted(
        command({ status: "completed", exitCode: 0, aggregatedOutput: "x\n" }),
        [],
      )[0],
    );
    expect(ok.kind).toBe("tool_result");
    expect(ok.data).toMatchObject({ tool_use_id: "call-1", is_error: false });
    const failed = publicData(
      itemCompleted(
        command({ status: "completed", exitCode: 2, aggregatedOutput: "" }),
        [],
      )[0],
    );
    expect(failed.data).toMatchObject({
      is_error: true,
      content: [{ text: "completed" }],
    });
    const declined = publicData(
      itemCompleted(command({ status: "declined" }), [])[0],
    );
    expect(declined.data).toMatchObject({ is_error: true });
  });
});

describe("messages", () => {
  test("an agent message is assistant text; an empty one is nothing", () => {
    const [event] = itemCompleted(
      { type: "agentMessage", id: "m", text: "hello" },
      ["in-1"],
    );
    expect(publicData(event).data.message).toMatchObject({
      content: [{ type: "text", text: "hello" }],
    });
    expect(
      itemCompleted({ type: "agentMessage", id: "m", text: "" }, []),
    ).toEqual([]);
  });

  test("reasoning is thinking", () => {
    const [event] = itemCompleted(
      { type: "reasoning", id: "r", summary: ["a", "b"], content: [] },
      [],
    );
    expect(publicData(event).data.message).toMatchObject({
      content: [{ type: "thinking", thinking: "a\nb" }],
    });
  });

  test("a user message names the input the engine attached it to", () => {
    expect(
      itemCompleted({ type: "userMessage", id: "u", clientId: "in-9" }, []),
    ).toEqual([{ type: "inputs.named", inputs: ["in-9"] }]);
    expect(itemCompleted({ type: "userMessage", id: "u" }, [])).toEqual([]);
  });

  test("an item the profile does not enable stays visible as an engine event", () => {
    const { kind, data } = publicData(
      itemCompleted({ type: "webSearch", id: "w" }, [])[0],
    );
    expect(kind).toBe("system");
    expect(data).toMatchObject({
      subtype: "sdk_event",
      native_type: "webSearch",
    });
  });

  test("every public event has an id of its own", () => {
    const a = publicData(
      itemCompleted({ type: "agentMessage", id: "m", text: "x" }, [])[0],
    ).id;
    const b = publicData(
      itemCompleted({ type: "agentMessage", id: "m", text: "x" }, [])[0],
    ).id;
    expect(a).not.toBe(b);
  });
});

describe("usage and turn end", () => {
  test("usage adds up request by request", () => {
    const one = addUsage(EMPTY_USAGE, {
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 3,
      reasoningOutputTokens: 1,
    });
    const two = addUsage(one, { inputTokens: 5, outputTokens: 2 });
    expect(two).toEqual({
      input_tokens: 15,
      cached_input_tokens: 4,
      output_tokens: 5,
      reasoning_output_tokens: 1,
    });
    expect(addUsage(two, "nonsense")).toEqual(two);
  });

  test("a completed turn is success and claims no spend", () => {
    const [result, ended] = turnEvents(
      "t-1",
      outcomeOf({ status: "completed" }),
      EMPTY_USAGE,
      ["in-1"],
    );
    expect(publicData(result).data).toMatchObject({
      subtype: "success",
      is_error: false,
      session_id: "t-1",
    });
    expect(ended).toMatchObject({
      type: "turn.ended",
      turn: {
        isError: false,
        abortedByStop: false,
        cost: { unknown: true },
        engineSessionId: "t-1",
        inputs: ["in-1"],
      },
    });
  });

  test("an interrupted turn is a stop, not a failure of the engine", () => {
    const [, ended] = turnEvents(
      "t-1",
      outcomeOf({ status: "interrupted" }),
      EMPTY_USAGE,
      [],
    );
    expect(ended).toMatchObject({
      turn: { isError: true, abortedByStop: true },
    });
  });

  test("a failed turn keeps the engine's reason and its HTTP status", () => {
    const outcome = outcomeOf({
      status: "failed",
      error: {
        message: "upstream said no",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
      },
    });
    expect(outcome).toEqual({
      status: "failed",
      error: { message: "upstream said no", httpStatus: 429 },
    });
    const [, ended] = turnEvents("t-1", outcome, EMPTY_USAGE, []);
    expect(ended).toMatchObject({
      turn: {
        isError: true,
        failure: { reason: "upstream said no", httpStatus: 429 },
      },
    });
  });

  test("a turn the engine gives no status is a failure", () => {
    expect(outcomeOf({})).toEqual({ status: "failed", error: null });
  });
});
