import { describe, expect, test } from "bun:test";
import { startFakeResponsesServer } from "./fake-responses.ts";
import {
  planOf,
  replyFor,
  type ScriptedCall,
  specIdsIn,
} from "./scripted-responses.ts";

const spec = (value: Record<string, unknown>) =>
  `GATE-SPEC ${JSON.stringify(value)}`;
const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const output = (callId: string) => ({
  type: "function_call_output",
  call_id: callId,
  output: "ok",
});
const tools = [{ type: "function", name: "exec_command" }];

describe("scripted Responses API", () => {
  test("the number of tool outputs after the latest spec picks the step", () => {
    const first = spec({
      id: "a",
      steps: [{ tool: "t", input: {} }],
      final: "x",
    });
    expect(planOf([user(first)])?.step).toBe(0);
    expect(planOf([user(first), output("c1")])?.step).toBe(1);
  });

  test("a later prompt's spec wins over a replayed earlier one", () => {
    const items = [
      user(spec({ id: "a", steps: [], final: "x" })),
      output("c0"),
      user(spec({ id: "b", steps: [], final: "y" })),
    ];
    expect(planOf(items)).toMatchObject({ spec: { id: "b" }, step: 0 });
    expect(specIdsIn(items)).toEqual(["a", "b"]);
  });

  test("plays tool calls, then the final text, and reports the scripted usage", async () => {
    const recorded: ScriptedCall[] = [];
    const prompt = user(
      spec({
        id: "s",
        steps: [{ tool: "exec_command", input: { cmd: "echo hi" } }],
        final: "done",
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    );
    const first = await replyFor({ input: [prompt], tools }, recorded);
    expect(first.toolCalls?.[0]).toMatchObject({
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "echo hi" }),
    });
    expect(first.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
    const last = await replyFor(
      { input: [prompt, output("call_gate_s_0")], tools },
      recorded,
    );
    expect(last.text).toBe("done");
    expect(recorded.map((call) => [call.specId, call.step])).toEqual([
      ["s", 0],
      ["s", 1],
    ]);
  });

  test("an MCP tool is called inside its namespace, and the record shows what was offered and answered", async () => {
    const recorded: ScriptedCall[] = [];
    const prompt = user(
      spec({
        id: "m",
        steps: [{ tool: "mcp__github__request_push", input: {} }],
        final: "done",
      }),
    );
    const offered = [
      ...tools,
      {
        type: "namespace",
        name: "mcp__github",
        tools: [{ type: "function", name: "request_push" }],
      },
    ];
    const first = await replyFor({ input: [prompt], tools: offered }, recorded);
    expect(first.toolCalls?.[0]).toMatchObject({
      namespace: "mcp__github",
      name: "request_push",
    });
    await replyFor(
      { input: [prompt, output("call_gate_m_0")], tools: offered },
      recorded,
    );
    expect(recorded[0]?.tools).toEqual([
      "exec_command",
      "mcp__github/request_push",
    ]);
    expect(recorded[1]?.outputs).toEqual(["ok"]);
  });

  test("a server id ending in an underscore keeps its namespace whole", async () => {
    const prompt = user(
      spec({
        id: "u",
        steps: [{ tool: "mcp__foo___bar", input: {} }],
        final: "done",
      }),
    );
    const offered = [
      ...tools,
      {
        type: "namespace",
        name: "mcp__foo_",
        tools: [{ type: "function", name: "bar" }],
      },
    ];
    const reply = await replyFor({ input: [prompt], tools: offered }, []);
    expect(reply.toolCalls?.[0]).toMatchObject({
      namespace: "mcp__foo_",
      name: "bar",
    });
  });

  test("an MCP tool the request does not list is still called inside its namespace", async () => {
    const prompt = user(
      spec({
        id: "d",
        steps: [{ tool: "mcp__github__request_push", input: {} }],
        final: "done",
      }),
    );
    const reply = await replyFor({ input: [prompt], tools }, []);
    expect(reply.toolCalls?.[0]).toMatchObject({
      namespace: "mcp__github",
      name: "request_push",
    });
  });

  test("a request without tools never reads the spec", async () => {
    const recorded: ScriptedCall[] = [];
    const reply = await replyFor(
      { input: [user(spec({ id: "s", steps: [], final: "x" }))] },
      recorded,
      "side",
    );
    expect(reply.text).toBe("side");
    expect(recorded[0]?.specId).toBeNull();
  });

  test("served over HTTP with the usage on the wire", async () => {
    const recorded: ScriptedCall[] = [];
    const server = startFakeResponsesServer((request) =>
      replyFor(request.body, recorded),
    );
    try {
      const response = await fetch(`${server.url}/v1/responses`, {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          tools,
          input: [
            user(
              spec({
                id: "h",
                steps: [],
                final: "hi",
                usage: { input_tokens: 5, output_tokens: 2 },
              }),
            ),
          ],
        }),
      });
      const body = (await response.json()) as {
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(body.usage).toMatchObject({ input_tokens: 5, output_tokens: 2 });
    } finally {
      server.stop();
    }
  });
});
