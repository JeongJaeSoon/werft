import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_TOPIC_SESSION_IDLE_MS,
  type ConversationRuntimeTurn,
  type ConversationTurnId,
  conversationIdSchema,
  conversationRuntimeTurnSchema,
  conversationTopicIdSchema,
} from "@werft-ai/contracts";
import type { ConversationTopicTurn } from "../ports/conversation-read-tool-store.ts";
import type {
  TopicRef,
  TopicTurnContext,
  TopicTurnContexts,
} from "./context-assembler.ts";
import { SOURCE_SET_LIMIT, type SourceKey } from "./source-sets.ts";
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
    call: { max_tokens: 1_024 },
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
    recordsDeletedAt: null as number | null | "throw",
  };
  const value: Pick<
    TopicTurnContexts,
    "assemble" | "recordsDeletedAt" | "anyDeleted"
  > = {
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
    async recordsDeletedAt() {
      if (state.recordsDeletedAt === "throw") throw new Error("database down");
      return state.recordsDeletedAt;
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
  // The turns' rows, oldest first, as every API process sees them.
  const rows: (ConversationTopicTurn & { topicId: string })[] = [];
  const rowOf = (turnId: ConversationTurnId) =>
    rows.find((row) => row.turnId === turnId);
  const checks = createTopicSessionChecks({
    contexts: c.value,
    turns: {
      async previousTurn({ topicId, turnId }) {
        const before = rows.filter(
          (row) => row.topicId === topicId && row.turnId !== turnId,
        );
        const last = before.at(-1);
        return last === undefined ? null : { ...last };
      },
    },
    now: () => clock,
  });
  const row = (turn: ConversationRuntimeTurn) =>
    rows.push({
      topicId: turn.scope.topic_id,
      turnId: turn.turn_id,
      ended: false,
      sources: [],
      overflow: false,
    });
  return {
    ...c,
    checks,
    rows,
    tick: (ms: number) => {
      clock += ms;
    },
    async handOut(turn: ConversationRuntimeTurn) {
      row(turn);
      return checks.handOut(turn);
    },
    /** What a turn's tools read, into its row. */
    read(turn: ConversationRuntimeTurn, keys: SourceKey[]) {
      const found = rowOf(turn.turn_id);
      if (found !== undefined) found.sources.push(...keys);
    },
    end(turn: ConversationRuntimeTurn, completed = true) {
      const found = rowOf(turn.turn_id);
      if (found !== undefined) found.ended = true;
      checks.ended(turn.turn_id, completed);
    },
    /** A turn another API process handed out and saw end. */
    elsewhere(turn = turnOf()) {
      row(turn);
      const found = rowOf(turn.turn_id);
      if (found !== undefined) found.ended = true;
    },
    /** One whole turn: handed out, then ended. */
    async serve(turn = turnOf(), completed = true) {
      const out = await this.handOut(turn);
      this.end(turn, completed);
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

  test("what a turn's tools read, in its row whichever process served them, is held by its session", async () => {
    const s = setup();
    const turn = turnOf();
    await s.handOut(turn);
    s.read(turn, [place("9.9")]);
    s.end(turn);
    expect((await s.serve()).topic_session).toBe("keep");
    // Two turns on, the session still holds what the first one's tools read.
    expect((await s.serve()).topic_session).toBe("keep");
    s.state.deleted.add("9.9");
    expect((await s.serve()).topic_session).toBe("drop");
    expect((await s.serve()).topic_session).toBe("keep");
  });

  test("drops after a later turn of the topic another API process handed out", async () => {
    const s = setup();
    await s.serve();
    s.elsewhere();
    expect((await s.serve()).topic_session).toBe("drop");
    expect((await s.serve()).topic_session).toBe("keep");
  });

  test("drops when the last turn's row is not ended, overflowed, or grows the session past its limit", async () => {
    const s = setup();
    const open = turnOf();
    await s.handOut(open);
    s.checks.ended(open.turn_id, true);
    expect((await s.serve()).topic_session).toBe("drop");

    const over = turnOf();
    await s.handOut(over);
    s.end(over);
    const row = s.rows.find((r) => r.turnId === over.turn_id);
    if (row !== undefined) row.overflow = true;
    expect((await s.serve()).topic_session).toBe("drop");

    const many = turnOf();
    await s.handOut(many);
    s.read(
      many,
      Array.from({ length: SOURCE_SET_LIMIT + 1 }, (_, i) =>
        place(`${i + 10}.0`),
      ),
    );
    s.end(many);
    expect((await s.serve()).topic_session).toBe("drop");
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

  test("drops on the turn whose context first overflows, not the one after", async () => {
    const s = setup();
    await s.serve();
    expect((await s.serve()).topic_session).toBe("keep");
    s.state.overflow = true;
    expect((await s.serve()).topic_session).toBe("drop");
  });

  test("drops once an admin deleted the conversation's records, or that cannot be read", async () => {
    const s = setup();
    await s.serve();
    // An operator's turns name no Slack place: only the delete itself tells.
    s.state.recordsDeletedAt = 5;
    expect((await s.serve()).topic_session).toBe("drop");
    expect((await s.serve()).topic_session).toBe("keep");
    s.state.recordsDeletedAt = "throw";
    expect((await s.serve()).topic_session).toBe("drop");
    expect((await s.serve()).topic_session).toBe("drop");
  });

  test("a turn that never reported is forgotten after the idle time", async () => {
    const s = setup();
    await s.handOut(turnOf());
    expect(s.checks.size).toBe(1);
    s.tick(CONVERSATION_TOPIC_SESSION_IDLE_MS);
    expect(s.checks.size).toBe(0);
  });

  test("drops after a failed turn, and after a turn that never reported", async () => {
    const s = setup();
    await s.serve(turnOf(), false);
    expect((await s.serve()).topic_session).toBe("drop");
    await s.handOut(turnOf());
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
