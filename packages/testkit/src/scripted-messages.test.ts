import { describe, expect, test } from "bun:test";
import type { RecordedRequest } from "./fake-anthropic.ts";
import {
  CALL_SPEC_MARKER,
  type GateRequest,
  planOf,
  replyFor,
  SPEC_MARKER,
  specIdsIn,
} from "./scripted-messages.ts";

const spec = {
  id: "s1",
  steps: [
    { tool: "Bash", input: { command: "touch a" } },
    { tool: "Bash", input: { command: "touch b" } },
  ],
  final: "done",
};

function request(messages: unknown[], tools = [{ name: "Bash" }]) {
  return {
    body: { messages, tools },
    headers: {},
    path: "/v1/messages",
    signal: new AbortController().signal,
  } satisfies RecordedRequest;
}

const toolResult = (id: string) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
});

describe("scripted Messages API", () => {
  test("counts tool results after the spec to pick the next step", () => {
    const prompt = {
      role: "user",
      content: [
        { type: "text", text: `do it ${SPEC_MARKER}${JSON.stringify(spec)}` },
        { type: "text", text: "<system-reminder>{}</system-reminder>" },
      ],
    };
    expect(planOf([prompt])?.step).toBe(0);
    expect(
      planOf([prompt, { role: "assistant", content: [] }, toolResult("t0")])
        ?.step,
    ).toBe(1);
  });

  test("a message holding two prompts plays the later one", () => {
    const cutOff = { ...spec, id: "old", final: "slow", finalDelayMs: 300_000 };
    const merged = {
      role: "user",
      content: [
        { type: "text", text: `${SPEC_MARKER}${JSON.stringify(cutOff)}` },
        { type: "text", text: "[Request interrupted by user]" },
        { type: "text", text: `${SPEC_MARKER}${JSON.stringify(spec)}` },
      ],
    };
    expect(planOf([merged])).toEqual({ spec, step: 0 });
    expect(
      planOf([merged, { role: "assistant", content: [] }, toolResult("t0")])
        ?.step,
    ).toBe(1);
  });

  test("the engine's trailing text does not break the spec's JSON", () => {
    const text = `${SPEC_MARKER}${JSON.stringify(spec)}\n\n{"not":"spec"}`;
    expect(planOf([{ role: "user", content: text }])?.spec).toEqual(spec);
  });

  test("a spec with no complete object fails with the text that arrived", () => {
    // What a session gets when macOS bash 3.2 runs
    // ap_post … "$(body "GATE-SPEC {\"id\":…,\"steps\":…}")": brace expansion
    // turns that argument into one per member, and ap_post sends only the first.
    const text = `${SPEC_MARKER}"id":"a1-t1"`;
    expect(() => planOf([{ role: "user", content: text }])).toThrow(
      'unterminated GATE-SPEC, got: "id":"a1-t1"',
    );
  });

  test("walks the script to its final text", async () => {
    const recorded: GateRequest[] = [];
    const prompt = {
      role: "user",
      content: SPEC_MARKER + JSON.stringify(spec),
    };
    const first = await replyFor(request([prompt]), recorded);
    expect(first.content[0]).toMatchObject({
      type: "tool_use",
      id: "toolu_gate_s1_0",
      input: { command: "touch a" },
    });
    const last = await replyFor(
      request([prompt, {}, toolResult("a"), {}, toolResult("b")]),
      recorded,
    );
    expect(last).toEqual({
      content: [{ type: "text", text: "done" }],
      stopReason: "end_turn",
    });
    expect(recorded.map((entry) => entry.step)).toEqual([0, 2]);
  });

  test("records the tools in front of the model: offered undeferred, or referenced by a search result", async () => {
    const recorded: GateRequest[] = [];
    const prompt = {
      role: "user",
      content: SPEC_MARKER + JSON.stringify(spec),
    };
    const tools = [
      { name: "Bash" },
      { name: "ToolSearch" },
      { name: "mcp__github__request_push", defer_loading: true },
      { name: "mcp__github__open_pull_request", defer_loading: true },
    ];
    await replyFor(request([prompt], tools), recorded);
    const searched = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "a",
          content: [
            { type: "tool_reference", tool_name: "mcp__github__request_push" },
            { type: "text", text: "mcp__github__open_pull_request" },
          ],
        },
        // A reference outside a tool result loads nothing.
        { type: "tool_reference", tool_name: "mcp__github__open_pull_request" },
      ],
    };
    await replyFor(request([prompt, {}, searched], tools), recorded);
    expect(recorded.map((entry) => entry.tools)).toEqual([
      ["Bash", "ToolSearch"],
      ["Bash", "ToolSearch"],
    ]);
    expect(recorded.map((entry) => entry.found)).toEqual([
      [],
      ["mcp__github__request_push"],
    ]);
  });

  test("a probe says whether the request carried a text, which the prompt itself does not hold", async () => {
    const probed = 'Ask this server first.\nIt\'s "Werft".';
    const probe = Buffer.from(probed, "utf8").toString("base64");
    const prompt = {
      role: "user",
      content: `${SPEC_MARKER}${JSON.stringify({ ...spec, steps: [], probe })}`,
    };
    const carried = { ...request([prompt]) };
    const finalOf = async (body: Record<string, unknown>) =>
      (
        await replyFor(
          { ...carried, body: { ...carried.body, ...body } },
          [],
          "fallback",
        )
      ).content;
    expect(await finalOf({})).toEqual([
      { type: "text", text: "done [probe:missing]" },
    ]);
    // In the system prompt, or in a block the engine added to the messages.
    expect(
      await finalOf({ system: [{ type: "text", text: `a ${probed} b` }] }),
    ).toEqual([{ type: "text", text: "done [probe:found]" }]);
    expect(
      await finalOf({
        messages: [
          { role: "user", content: [{ type: "text", text: probed }] },
          prompt,
        ],
      }),
    ).toEqual([{ type: "text", text: "done [probe:found]" }]);
  });

  test("answers the fallback without a spec, or without tools", async () => {
    const recorded: GateRequest[] = [];
    const plain = await replyFor(
      request([{ role: "user", content: "hi" }]),
      recorded,
      "hello",
    );
    expect(plain.content).toEqual([{ type: "text", text: "hello" }]);
    const side = await replyFor(
      request(
        [{ role: "user", content: SPEC_MARKER + JSON.stringify(spec) }],
        [],
      ),
      recorded,
    );
    expect(side.content).toEqual([{ type: "text", text: "ok" }]);
    expect(recorded.map((entry) => entry.specId)).toEqual([null, null]);
  });

  test("a request without tools answers its last user message's call spec; one with tools ignores it", async () => {
    const recorded: GateRequest[] = [];
    const call = (id: string, reply: string) =>
      `judge this ${CALL_SPEC_MARKER}${JSON.stringify({ id, reply })} please`;
    const answered = await replyFor(
      request(
        [
          { role: "user", content: call("old", "stale") },
          { role: "assistant", content: "stale" },
          {
            role: "user",
            content: [
              { type: "text", text: call("c1", "<decision>quiet</decision>") },
            ],
          },
        ],
        [],
      ),
      recorded,
    );
    expect(answered.content).toEqual([
      { type: "text", text: "<decision>quiet</decision>" },
    ]);
    const withTools = await replyFor(
      request([{ role: "user", content: call("c2", "scripted") }]),
      recorded,
      "fallback",
    );
    expect(withTools.content).toEqual([{ type: "text", text: "fallback" }]);
    expect(recorded.map((entry) => entry.specId)).toEqual(["c1", null]);
  });

  test("lists every prompt's spec the conversation replays, oldest first", () => {
    const prompt = (id: string) =>
      SPEC_MARKER + JSON.stringify({ ...spec, id });
    const nested =
      SPEC_MARKER +
      JSON.stringify({
        ...spec,
        id: "outer",
        steps: [{ tool: "Agent", input: { prompt: prompt("inner") } }],
      });
    expect(
      specIdsIn([
        { role: "user", content: prompt("q1") },
        { role: "assistant", content: [{ type: "text", text: prompt("no") }] },
        toolResult("t0"),
        { role: "user", content: [{ type: "text", text: nested }] },
        { role: "user", content: prompt("q2") },
      ]),
    ).toEqual(["q1", "outer", "q2"]);
    expect(
      specIdsIn([
        { role: "user", content: `about ${SPEC_MARKER}{unterminated` },
        { role: "user", content: prompt("q3") },
      ]),
    ).toEqual(["q3"]);
    expect(specIdsIn([{ role: "user", content: "hi" }])).toEqual([]);
  });
});

describe("a conversation call's script", () => {
  test("asks for its steps' tool calls one per call, then gives its reply", async () => {
    const recorded: GateRequest[] = [];
    const prompt = `go ${CALL_SPEC_MARKER}${JSON.stringify({
      id: "loop",
      reply: "done",
      steps: [
        { tool: "Bash", input: { command: "a" } },
        { tool: "Bash", input: { command: "b" } },
      ],
    })}`;
    const first = await replyFor(
      request([{ role: "user", content: prompt }], []),
      recorded,
    );
    expect(first).toMatchObject({ stopReason: "tool_use" });
    const second = await replyFor(
      request([{ role: "user", content: prompt }, toolResult("t0")], []),
      recorded,
    );
    expect(second.content).toMatchObject([
      { type: "tool_use", name: "Bash", input: { command: "b" } },
    ]);
    const last = await replyFor(
      request(
        [{ role: "user", content: prompt }, toolResult("t0"), toolResult("t1")],
        [],
      ),
      recorded,
    );
    expect(last.content).toEqual([{ type: "text", text: "done" }]);
    expect(recorded.map((entry) => [entry.specId, entry.step])).toEqual([
      ["loop", 0],
      ["loop", 1],
      ["loop", 2],
    ]);
    // A later prompt of its own without a spec is answered by the fallback.
    const plain = await replyFor(
      request(
        [
          { role: "user", content: prompt },
          { role: "user", content: [{ type: "text", text: "plain" }] },
        ],
        [],
      ),
      recorded,
      "fallback",
    );
    expect(plain.content).toEqual([{ type: "text", text: "fallback" }]);
  });
});
