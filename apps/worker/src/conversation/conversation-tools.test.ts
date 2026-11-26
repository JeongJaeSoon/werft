import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_TURN_DECISION_VALUES,
  conversationDecisionSchema,
  conversationTurnIdSchema,
  conversationTurnLeaseIdSchema,
} from "@werft-ai/contracts";
import {
  ConversationTools,
  DECISION_INPUT_SCHEMAS,
} from "./conversation-tools.ts";
import type { ConversationTurnSource } from "./turn-source.ts";

type Answer = Awaited<ReturnType<ConversationTurnSource["readTool"]>>;
type Decided = Awaited<ReturnType<ConversationTurnSource["decisionTool"]>>;

function tools(
  answer: () => Answer | Promise<Answer>,
  decide: () => Decided | Promise<Decided> = () => ({ outcome: "accepted" }),
) {
  const calls: unknown[] = [];
  const decisions: unknown[] = [];
  const t = new ConversationTools({
    async readTool(turn, tool) {
      calls.push({ turn, tool });
      return answer();
    },
    async decisionTool(turn, decision) {
      decisions.push({ turn, decision });
      return decide();
    },
  });
  return { t, calls, decisions };
}

const turn = {
  turn_id: conversationTurnIdSchema.parse(crypto.randomUUID()),
  lease_id: conversationTurnLeaseIdSchema.parse(crypto.randomUUID()),
};
const live = new AbortController().signal;
const ALL = CONVERSATION_TURN_DECISION_VALUES;
const callOf = (
  t: ConversationTools,
  key: string,
  name: string,
  input: Record<string, unknown> = {},
) => {
  const tool = t.server(key, ALL).tools.find((each) => each.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.call(live, input);
};

describe("ConversationTools", () => {
  test("gives each session the four read tools and the decision tools it was started with, in a fixed order, and nothing else", () => {
    const { t } = tools(() => ({ outcome: "read", text: "{}" }));
    const server = t.server("key-1", ALL);
    expect(server.name).toBe("conversation");
    expect(server.tools.map((tool) => tool.name)).toEqual([
      "read_thread",
      "read_channel_summary",
      "read_turns",
      "list_open_tasks",
      "reply",
      "route_to_task",
      "spawn_task",
      "no_reply",
    ]);
    // An agent requester's turn: no tool to hand on or start work.
    const agent = t.server("key-2", ["reply", "no_reply"]);
    expect(agent.tools.map((tool) => tool.name)).toEqual([
      "read_thread",
      "read_channel_summary",
      "read_turns",
      "list_open_tasks",
      "reply",
      "no_reply",
    ]);
    // Sessions given other tools are not the same server.
    expect(agent.binding).not.toBe(server.binding);
    // The read tools take nothing; each decision tool its own input.
    expect(
      server.tools.map((tool) => (tool.inputSchema === undefined ? 0 : 1)),
    ).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  test("each decision tool's schema names what the contract's decision takes, and nothing more", () => {
    const samples = {
      body: "Here it is.",
      task_id: crypto.randomUUID(),
      goal: "write the report",
      done_when: "the report is in the thread",
      reason: "asked",
    };
    // Fields a decision may leave out, each tool's own.
    const OPTIONAL: Partial<Record<string, string[]>> = {
      spawn_task: ["repository"],
    };
    for (const tool of ALL) {
      const schema = DECISION_INPUT_SCHEMAS[tool] as {
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual(
        [...schema.required, ...(OPTIONAL[tool] ?? [])].sort(),
      );
      const input = Object.fromEntries(
        schema.required.map((field) => [
          field,
          samples[field as keyof typeof samples],
        ]),
      );
      expect(conversationDecisionSchema.parse({ tool, ...input })).toEqual({
        tool,
        ...input,
      } as never);
      // One field short is not the contract's.
      for (const field of schema.required) {
        const { [field]: _, ...short } = input;
        expect(
          conversationDecisionSchema.safeParse({ tool, ...short }).success,
        ).toBe(false);
      }
    }
  });

  test("a call goes for the turn holding its session, and none while no turn does", async () => {
    const { t, calls } = tools(() => ({ outcome: "read", text: '{"read":1}' }));
    expect(await callOf(t, "key-1", "read_turns")).toEqual({
      text: "No turn is running in this session.",
      isError: true,
    });
    t.hold("key-1", turn);
    // Another session's tools do not reach this session's turn.
    expect((await callOf(t, "key-2", "read_turns")).isError).toBe(true);
    expect(await callOf(t, "key-1", "read_turns")).toEqual({
      text: '{"read":1}',
      isError: false,
    });
    t.release("key-1");
    expect((await callOf(t, "key-1", "read_turns")).isError).toBe(true);
    expect(calls).toEqual([{ turn, tool: "read_turns" }]);
  });

  test("a refusal, a turn no longer held, or an answer that did not arrive is an error the model goes on from", async () => {
    for (const [answer, text] of [
      [
        () => ({ outcome: "refused", reason: "thread_read_limit" }) as const,
        "Refused (thread_read_limit); go on with what else this turn has.",
      ],
      [
        () => ({ outcome: "turn_not_held" }) as const,
        "Refused (turn_not_held); go on with what else this turn has.",
      ],
      [
        () => {
          throw new Error("503 with a body that quotes a request");
        },
        "The read did not arrive; go on without it.",
      ],
    ] as const) {
      const { t } = tools(answer);
      t.hold("key-1", turn);
      expect(await callOf(t, "key-1", "read_thread")).toEqual({
        text,
        isError: true,
      });
    }
  });

  test("the first decision the control host accepts is the turn's, and another is refused here", async () => {
    const { t, decisions } = tools(() => ({ outcome: "read", text: "{}" }));
    t.hold("key-1", turn);
    expect(t.decision("key-1")).toBeUndefined();
    const reply = { body: "Here it is.", reason: "asked" };
    expect(await callOf(t, "key-1", "reply", reply)).toEqual({
      text: "Taken as this turn's decision. End the turn now, with no more tool calls.",
      isError: false,
    });
    expect(t.decision("key-1")).toEqual({ tool: "reply", ...reply });
    expect(
      (await callOf(t, "key-1", "no_reply", { reason: "changed my mind" }))
        .isError,
    ).toBe(true);
    expect(decisions).toEqual([
      { turn, decision: { tool: "reply", ...reply } },
    ]);
    // The next turn of the session starts with none.
    t.release("key-1");
    t.hold("key-1", turn);
    expect(t.decision("key-1")).toBeUndefined();
  });

  test("two decision calls of one message: the second is refused while the first is on its way", async () => {
    let arrive: (answer: Decided) => void = () => {};
    const { t, decisions } = tools(
      () => ({ outcome: "read", text: "{}" }),
      () =>
        new Promise<Decided>((resolve) => {
          arrive = resolve;
        }),
    );
    t.hold("key-1", turn);
    const first = callOf(t, "key-1", "no_reply", { reason: "quiet" });
    const second = await callOf(t, "key-1", "reply", {
      body: "x",
      reason: "y",
    });
    expect(second.isError).toBe(true);
    arrive({ outcome: "accepted" });
    expect((await first).isError).toBe(false);
    expect(t.decision("key-1")).toEqual({ tool: "no_reply", reason: "quiet" });
    expect(decisions).toHaveLength(1);
  });

  test("an input not of the tool's shape is not sent, and a refused decision is not the turn's", async () => {
    const { t, decisions } = tools(
      () => ({ outcome: "read", text: "{}" }),
      () => ({ outcome: "refused", reason: "tool_not_allowed" }),
    );
    t.hold("key-1", turn);
    for (const input of [
      {},
      { reason: "" },
      { reason: "r", body: "a field reply takes" },
    ]) {
      const answer = await callOf(t, "key-1", "no_reply", input);
      expect(answer.isError).toBe(true);
      expect(answer.text).not.toContain("a field reply takes");
    }
    expect(decisions).toEqual([]);
    expect(
      await callOf(t, "key-1", "spawn_task", {
        goal: "g",
        done_when: "d",
        reason: "r",
      }),
    ).toEqual({
      text: "Refused (tool_not_allowed); this is not the turn's decision.",
      isError: true,
    });
    expect(t.decision("key-1")).toBeUndefined();
  });
});
