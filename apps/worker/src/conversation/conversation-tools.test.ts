import { describe, expect, test } from "bun:test";
import {
  conversationTurnIdSchema,
  conversationTurnLeaseIdSchema,
} from "@werft-ai/contracts";
import { ConversationTools } from "./conversation-tools.ts";
import type { ConversationTurnSource } from "./turn-source.ts";

type Answer = Awaited<ReturnType<ConversationTurnSource["readTool"]>>;

function tools(answer: () => Answer | Promise<Answer>) {
  const calls: unknown[] = [];
  const t = new ConversationTools({
    async readTool(turn, tool) {
      calls.push({ turn, tool });
      return answer();
    },
  });
  return { t, calls };
}

const turn = {
  turn_id: conversationTurnIdSchema.parse(crypto.randomUUID()),
  lease_id: conversationTurnLeaseIdSchema.parse(crypto.randomUUID()),
};
const live = new AbortController().signal;
const callOf = (t: ConversationTools, key: string, name: string) => {
  const tool = t.server(key).tools.find((each) => each.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.call(live);
};

describe("ConversationTools", () => {
  test("gives each session the four read tools of the conversation server, in a fixed order", () => {
    const { t } = tools(() => ({ outcome: "read", text: "{}" }));
    const server = t.server("key-1");
    expect(server.name).toBe("conversation");
    expect(server.tools.map((tool) => tool.name)).toEqual([
      "read_thread",
      "read_channel_summary",
      "read_turns",
      "list_open_tasks",
    ]);
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
});
