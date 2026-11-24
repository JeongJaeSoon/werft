import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_TOPIC_SESSION_IDLE_MS,
  type ConversationRuntimeTurn,
  type ConversationTurnId,
  conversationIdSchema,
  conversationRuntimeTurnSchema,
  conversationTopicIdSchema,
} from "@werft-ai/contracts";
import type {
  TopicRef,
  TopicTurnContext,
  TopicTurnContexts,
} from "./context-assembler.ts";
import type { SourceKey } from "./source-sets.ts";
import { createTopicSessionChecks } from "./topic-session-checks.ts";

const place = (ts: string): SourceKey => ({
  inputId: null,
  slack: { teamId: "T1", channelId: "C1", ts },
});
const scope = {
  workspace_id: crypto.randomUUID(),
  agent_id: crypto.randomUUID(),
  conversation_id: conversationIdSchema.parse(crypto.randomUUID()),
  topic_id: conversationTopicIdSchema.parse(crypto.randomUUID()),
};

function turnOf(topicId = scope.topic_id): ConversationRuntimeTurn {
  return conversationRuntimeTurnSchema.parse({
    turn_id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    lease_expires_at: "2026-11-24T00:02:30.000Z",
    scope: { ...scope, topic_id: topicId },
    model: "claude-haiku-5",
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "egress_token", token: ["wec", "t"].join("_") },
    },
    call: { max_tokens: 1_024, id: crypto.randomUUID() },
    input: { id: crypto.randomUUID(), text: "hi" },
    fresh_input: { id: crypto.randomUUID(), text: "hi" },
  });
}

/** Contexts whose sources and deleted places the test sets as it goes. */
function contexts() {
  const state = {
    sources: [place("1.1")] as SourceKey[],
    overflow: false,
    deleted: new Set<string>(),
    assembled: [] as TopicRef[],
    result: null as TopicTurnContext | "throw" | null,
    checkThrows: false,
  };
  const value: TopicTurnContexts = {
    async assemble(topic, input) {
      state.assembled.push(topic);
      if (state.result === "throw") throw new Error("database down");
      if (state.result !== null) return state.result;
      return {
        outcome: "assembled",
        text: `assembled: ${input.current.body}`,
        sources: { keys: state.sources, overflow: state.overflow },
      };
    },
    async anyDeleted(_workspaceId, sources) {
      if (state.checkThrows) throw new Error("database down");
      return sources.some((s) => state.deleted.has(s.slack?.ts ?? ""));
    },
  };
  return { state, value };
}

function setup() {
  let clock = 0;
  const c = contexts();
  const checks = createTopicSessionChecks({
    contexts: c.value,
    now: () => clock,
  });
  return {
    ...c,
    checks,
    tick: (ms: number) => {
      clock += ms;
    },
    /** One whole turn: handed out, then ended. */
    async serve(turn = turnOf(), completed = true) {
      const out = await checks.handOut(turn);
      checks.ended(turn.turn_id as ConversationTurnId, completed);
      return out;
    },
  };
}

describe("createTopicSessionChecks", () => {
  test("a topic's first turn starts anew from the context assembled as it is handed out", async () => {
    const s = setup();
    const turn = turnOf();
    const out = await s.checks.handOut(turn);
    expect(out.topic_session).toBe("drop");
    expect(out.fresh_input).toEqual({
      id: turn.fresh_input.id,
      text: "assembled: hi",
    });
    expect(out.input).toEqual(turn.input);
    expect(s.state.assembled).toEqual([
      {
        workspaceId: scope.workspace_id,
        agentId: scope.agent_id,
        conversationId: scope.conversation_id,
        topicId: scope.topic_id,
      },
    ]);
  });

  test("keeps the session within the idle time from the last turn's end, not past it", async () => {
    const s = setup();
    await s.serve();
    s.tick(CONVERSATION_TOPIC_SESSION_IDLE_MS - 1);
    expect((await s.serve()).topic_session).toBe("keep");
    s.tick(CONVERSATION_TOPIC_SESSION_IDLE_MS - 1);
    expect((await s.serve()).topic_session).toBe("keep");
    s.tick(CONVERSATION_TOPIC_SESSION_IDLE_MS);
    expect((await s.serve()).topic_session).toBe("drop");
  });

  test("drops the session once a source it read is deleted, even one only an earlier turn read", async () => {
    const s = setup();
    await s.serve();
    // The second turn's context no longer has 1.1, but the session still holds it.
    s.state.sources = [place("2.1")];
    expect((await s.serve()).topic_session).toBe("keep");
    s.state.deleted.add("1.1");
    expect((await s.serve()).topic_session).toBe("drop");
    // The new session read only 2.1: it goes on.
    expect((await s.serve()).topic_session).toBe("keep");
  });

  test("drops when what the session read is not known whole, or cannot be checked", async () => {
    const s = setup();
    s.state.overflow = true;
    await s.serve();
    expect((await s.serve()).topic_session).toBe("drop");
    s.state.overflow = false;
    await s.serve();
    s.state.checkThrows = true;
    expect((await s.serve()).topic_session).toBe("drop");
  });

  test("drops after a failed turn, and after a turn that never reported", async () => {
    const s = setup();
    await s.serve(turnOf(), false);
    expect((await s.serve()).topic_session).toBe("drop");
    await s.checks.handOut(turnOf());
    expect((await s.serve()).topic_session).toBe("drop");
  });

  test("a context it cannot assemble starts anew from the turn's own input alone", async () => {
    const s = setup();
    await s.serve();
    for (const result of [
      "throw" as const,
      { outcome: "unknown_conversation" as const },
      {
        outcome: "too_large" as const,
        reason: "current_post" as const,
        bytes: 1,
        capBytes: 0,
      },
    ]) {
      s.state.result = result;
      const out = await s.serve();
      expect(out.topic_session).toBe("drop");
      expect(out.fresh_input.text).toBe("hi");
    }
  });

  test("another topic's session is checked apart", async () => {
    const s = setup();
    await s.serve();
    const other = conversationTopicIdSchema.parse(crypto.randomUUID());
    expect((await s.serve(turnOf(other))).topic_session).toBe("drop");
    expect((await s.serve()).topic_session).toBe("keep");
    expect(s.checks.size).toBe(2);
    s.tick(CONVERSATION_TOPIC_SESSION_IDLE_MS);
    expect(s.checks.size).toBe(0);
  });
});
