import { describe, expect, test } from "bun:test";
import {
  type ConversationId,
  type ConversationTopicId,
  type ConversationTurnId,
  channelSummaryLineIdSchema,
  scopeKeyOf,
} from "@werft-ai/contracts";
import type {
  ContextFragment,
  ContextFragmentSource,
} from "../ports/context-fragment-source.ts";
import type { ConversationKey } from "../ports/conversation-store.ts";
import {
  CONTEXT_CAP_BYTES,
  fitContext,
  renderContext,
  topicTurnContexts,
} from "./context-assembler.ts";

const W = "00000000-0000-4000-8000-0000000000a1";
const A = "00000000-0000-4000-8000-0000000000b1";
const key: ConversationKey = {
  kind: "channel",
  workspaceId: W,
  agentId: A,
  teamId: "T1",
  channelId: "C1",
};
const own = scopeKeyOf({
  kind: "channel",
  workspaceId: W,
  teamId: "T1",
  channelId: "C1",
});
const topic = {
  workspaceId: W,
  agentId: A,
  conversationId: "00000000-0000-4000-8000-0000000000d1" as ConversationId,
  topicId: "00000000-0000-4000-8000-0000000000e1" as ConversationTopicId,
};
const at = (minute: number) => new Date(Date.UTC(2026, 10, 24, 0, minute));
const place = (ts: string) => ({ teamId: "T1", channelId: "C1", ts });

const line: ContextFragment = {
  kind: "channel_summary_line",
  scope: own,
  sources: [{ inputId: null, slack: place("1.1") }],
  lineId: channelSummaryLineIdSchema.parse(
    "00000000-0000-4000-8000-000000000011",
  ),
  text: "the summary",
  writtenByAgentId: A,
  writtenAt: at(1),
};
const answer = (n: number, minute: number): ContextFragment => ({
  kind: "conversation_turn",
  scope: own,
  sources: [{ inputId: null, slack: place(`2.${n}`) }],
  turnId: `00000000-0000-4000-8000-00000000002${n}` as ConversationTurnId,
  answer: `answer ${n}`,
  endedAt: at(minute),
});
const now = {
  inputId: null,
  body: "what now?",
  sources: [],
  receivedAt: at(9),
};

function sourceOf(fragments: ContextFragment[]) {
  const asked: unknown[] = [];
  const deleted: unknown[] = [];
  const source: ContextFragmentSource = {
    read: async (conversation, options) => {
      asked.push({ conversation, options });
      return { fragments, unreadable: 0 };
    },
    conversationOf: async (ref) =>
      ref.conversationId === topic.conversationId ? key : null,
    recordsDeletedAt: async () => null,
    anyDeleted: async (workspaceId, sources) => {
      deleted.push({ workspaceId, sources });
      return true;
    },
  };
  return { source, asked, deleted };
}

describe("a topic's earlier answers in the context", () => {
  test("go after the engagements and before buffered posts, oldest first", () => {
    const result = fitContext({
      instructions: "",
      current: [now],
      fragments: [answer(2, 5), line, answer(1, 3)],
    });
    if (result.outcome !== "fitted") throw new Error(result.outcome);
    expect(result.fragments.map((f) => f.kind)).toEqual([
      "channel_summary_line",
      "conversation_turn",
      "conversation_turn",
    ]);
    expect(
      result.fragments.flatMap((f) =>
        f.kind === "conversation_turn" ? [f.answer] : [],
      ),
    ).toEqual(["answer 1", "answer 2"]);
    // What they came from is what the call came from.
    expect(result.sources.keys).toContainEqual({
      inputId: null,
      slack: place("2.1"),
    });
  });

  test("are cut oldest first, after the summary's back and before buffered posts", () => {
    const long = (n: number, minute: number): ContextFragment => ({
      ...(answer(n, minute) as Extract<
        ContextFragment,
        { kind: "conversation_turn" }
      >),
      answer: "x".repeat(CONTEXT_CAP_BYTES / 3),
    });
    const result = fitContext({
      instructions: "",
      current: [now],
      fragments: [long(1, 1), long(2, 2), long(3, 3)],
    });
    if (result.outcome !== "fitted") throw new Error(result.outcome);
    expect(
      result.fragments.map((f): string | null =>
        f.kind === "conversation_turn" ? f.turnId : null,
      ),
    ).toEqual([
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000023",
    ]);
  });
});

describe("renderContext", () => {
  test("lays out the instructions, the pieces in order and the current posts, within the cap", () => {
    const result = fitContext({
      instructions: "be brief",
      current: [now],
      fragments: [line, answer(1, 3)],
    });
    if (result.outcome !== "fitted") throw new Error(result.outcome);
    const text = renderContext(result);
    expect(text).toBe(
      [
        "be brief",
        "[channel summary] the summary",
        "[your earlier answer] answer 1",
        "[now] what now?",
      ].join("\n"),
    );
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(
      result.bytes,
    );
  });
});

describe("topicTurnContexts", () => {
  test("assembles the topic's context, its earlier answers asked for by its topic", async () => {
    const s = sourceOf([line, answer(1, 3)]);
    const assembled = await topicTurnContexts(s.source).assemble(topic, {
      instructions: "",
      current: now,
    });

    expect(assembled).toEqual({
      outcome: "assembled",
      text: [
        "[channel summary] the summary",
        "[your earlier answer] answer 1",
        "[now] what now?",
      ].join("\n"),
      sources: {
        keys: [
          { inputId: null, slack: place("1.1") },
          { inputId: null, slack: place("2.1") },
        ],
        overflow: false,
      },
    });
    expect(s.asked).toEqual([
      { conversation: key, options: { topicId: topic.topicId } },
    ]);
  });

  test("refuses a conversation that is not the agent's, and an input past the cap", async () => {
    const s = sourceOf([]);
    const contexts = topicTurnContexts(s.source);
    expect(
      await contexts.assemble(
        { ...topic, conversationId: crypto.randomUUID() as ConversationId },
        { instructions: "", current: now },
      ),
    ).toEqual({ outcome: "unknown_conversation" });
    expect(
      (
        await contexts.assemble(topic, {
          instructions: "x".repeat(CONTEXT_CAP_BYTES),
          current: now,
        })
      ).outcome,
    ).toBe("too_large");
  });

  test("asks about deleted sources only when there are some", async () => {
    const s = sourceOf([]);
    const contexts = topicTurnContexts(s.source);
    expect(await contexts.anyDeleted(W, [])).toBe(false);
    expect(s.deleted).toEqual([]);
    const sources = [{ inputId: null, slack: place("1.1") }];
    expect(await contexts.anyDeleted(W, sources)).toBe(true);
    expect(s.deleted).toEqual([{ workspaceId: W, sources }]);
  });
});
