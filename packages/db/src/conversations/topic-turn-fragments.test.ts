import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationId,
  type ConversationTopicId,
  type ConversationTurnId,
  conversationRuntimeTurnSchema,
} from "@werft-ai/contracts";
import {
  type ConversationKey,
  createTopicSessionChecks,
  placeSource,
  storedSourceSet,
  topicTurnContexts,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { deleteConversationRecords } from "../surface/conversation-records.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import { createPostgresContextFragmentSource } from "./context-fragments.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";
import {
  beginConversationTurn,
  endConversationTurn,
} from "./conversation-turns.ts";

const TEAM = "T0TOPIC";
const CHANNEL = "C0TOPIC";
const OTHER_CHANNEL = "C0OTHER";

/**
 * A topic's earlier answers as context (a1/T4): the conversation turn rows
 * of that topic only, read through the fragment source, and what a live
 * topic session read checked for deletion at each turn.
 */
describe("topic turn fragments", () => {
  let client: PGlite;
  let db: Database;
  let workspaceId: string;
  let agentId: string;
  let personId: string;
  let otherPersonId: string;
  let conversationId: ConversationId;
  let topicId: ConversationTopicId;
  let tsCounter = 0;
  const ts = () => `1700000000.${String(++tsCounter).padStart(6, "0")}`;

  const place = (at: string, channel = CHANNEL) => ({
    teamId: TEAM,
    channelId: channel,
    ts: at,
  });
  const store = () => createPostgresConversationStore(db);
  const source = () => createPostgresContextFragmentSource(db);
  const channelKey = (channel = CHANNEL) => ({
    kind: "channel" as const,
    workspaceId,
    agentId,
    teamId: TEAM,
    channelId: channel,
  });
  async function topicOf(
    conversation: ConversationId,
    channel = CHANNEL,
  ): Promise<ConversationTopicId> {
    return (
      await store().findOrCreateThreadTopic(conversation, {
        teamId: TEAM,
        channelId: channel,
        threadTs: ts(),
      })
    ).id;
  }
  /** A turn of the topic that read `read` and ended with `answer`. */
  async function answered(input: {
    answer: string;
    read?: string;
    conversation?: ConversationId;
    topic?: ConversationTopicId;
    channel?: string;
    state?: "decided" | "no_decision" | "voided_by_delete";
  }): Promise<ConversationTurnId> {
    const begun = await beginConversationTurn(db, {
      workspaceId,
      agentId,
      conversationId: input.conversation ?? conversationId,
      topicId: input.topic ?? topicId,
      requester: { kind: "slack_user", id: "U0ASKER" },
      sources:
        input.read === undefined
          ? null
          : storedSourceSet({
              direct: [placeSource(place(input.read, input.channel))],
              inherited: [],
              overflow: false,
            }),
      releaseId: null,
      slackInstallationId: null,
      engagement: null,
    });
    if (begun.outcome !== "begun") throw new Error(begun.outcome);
    const state = input.state ?? "decided";
    await endConversationTurn(db, {
      turnId: begun.turnId,
      end:
        state === "decided"
          ? { state, decision: "reply", reason: null, answer: input.answer }
          : { state },
    });
    return begun.turnId;
  }
  const markDeleted = (at: string, channel = CHANNEL) =>
    client.query(
      "INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at, marked_at) VALUES ($1, $2, $3, $4, now(), now())",
      [workspaceId, TEAM, channel, at],
    );
  const answersIn = async (
    topic = topicId,
    key: ConversationKey = channelKey(),
  ) =>
    (await source().read(key, { topicId: topic })).fragments.flatMap((f) =>
      f.kind === "conversation_turn" ? [f.answer] : [],
    );
  const ref = () => ({ workspaceId, agentId, conversationId, topicId });

  beforeEach(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    workspaceId = randomUUID();
    agentId = randomUUID();
    personId = randomUUID();
    otherPersonId = randomUUID();
    await client.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );
    for (const id of [personId, otherPersonId]) {
      await client.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
        [id, `${id}@example.invalid`],
      );
      await client.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
        [workspaceId, id],
      );
    }
    const team = await fixtureTeam(db, workspaceId);
    await client.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, 'agent', 'agent', 'active')",
      [agentId, workspaceId, team],
    );
    conversationId = (await store().findOrCreateConversation(channelKey())).id;
    topicId = await topicOf(conversationId);
  }, 60_000);

  test("a topic's turn reads that topic's earlier answers, oldest first, with the sources they came from", async () => {
    const read = ts();
    const first = await answered({ answer: "first answer", read });
    await answered({ answer: "second answer" });

    const fragments = (
      await source().read(channelKey(), { topicId })
    ).fragments.filter((f) => f.kind === "conversation_turn");
    expect(
      fragments.map((f) => (f.kind === "conversation_turn" ? f.answer : null)),
    ).toEqual(["first answer", "second answer"]);
    expect(fragments[0]).toMatchObject({
      turnId: first,
      sources: [{ inputId: null, slack: place(read) }],
    });
    // Without a topic, a conversation's read has no turn answers.
    expect(
      (await source().read(channelKey())).fragments.filter(
        (f) => f.kind === "conversation_turn",
      ),
    ).toEqual([]);
  });

  test("another topic's turns, another channel's and another person's DM's are not read", async () => {
    await answered({ answer: "this topic" });
    const sibling = await topicOf(conversationId);
    await answered({ answer: "a sibling topic", topic: sibling });
    const otherChannel = (
      await store().findOrCreateConversation(channelKey(OTHER_CHANNEL))
    ).id;
    const otherTopic = await topicOf(otherChannel, OTHER_CHANNEL);
    await answered({
      answer: "another channel",
      conversation: otherChannel,
      topic: otherTopic,
    });
    const dmKey = (person: string) => ({
      kind: "dm" as const,
      workspaceId,
      agentId,
      personUserId: person,
    });
    const dm = (await store().findOrCreateConversation(dmKey(otherPersonId)))
      .id;
    const dmTopic = (
      await store().findOrCreateThreadTopic(dm, {
        teamId: TEAM,
        channelId: "D0OTHER",
        threadTs: ts(),
      })
    ).id;
    await answered({
      answer: "another person's DM",
      conversation: dm,
      topic: dmTopic,
    });

    expect(await answersIn()).toEqual(["this topic"]);
    // Asked under another conversation, a topic that is not its own reads nothing.
    expect(await answersIn(dmTopic, dmKey(personId))).toEqual([]);
    expect(await answersIn(otherTopic)).toEqual([]);
  });

  test("a turn whose source is deleted, one with no answer, and one an admin deleted are not read", async () => {
    const read = ts();
    await answered({ answer: "from a deleted message", read });
    await answered({ answer: "unused", state: "no_decision" });
    await answered({ answer: "unused", state: "voided_by_delete" });
    await answered({ answer: "kept" });
    await markDeleted(read);
    expect(await answersIn()).toEqual(["kept"]);

    expect(
      await deleteConversationRecords(db, {
        conversationId,
        by: `${personId}@example.invalid`,
      }),
    ).toMatchObject({ outcome: "deleted" });
    expect(await answersIn()).toEqual([]);
  });

  test("after its session is gone, a topic's turn starts from a context holding its earlier answer", async () => {
    await answered({ answer: "the deploy is at five" });
    const assembled = await topicTurnContexts(source()).assemble(ref(), {
      instructions: "",
      current: {
        inputId: null,
        body: "when was it?",
        sources: [],
        receivedAt: new Date(),
      },
    });
    expect(assembled).toMatchObject({
      outcome: "assembled",
      text: "[your earlier answer] the deploy is at five\n[now] when was it?",
    });
  });

  test("knows the agent's conversation by its id, and no other agent's", async () => {
    expect(await source().conversationOf(ref())).toEqual(channelKey());
    expect(
      await source().conversationOf({ ...ref(), agentId: randomUUID() }),
    ).toBeNull();
    expect(
      await source().conversationOf({
        ...ref(),
        conversationId: randomUUID() as ConversationId,
      }),
    ).toBeNull();
  });

  test("a live session that read a message deleted since is dropped, and the next turn's context lacks it", async () => {
    const read = ts();
    await answered({ answer: "about the message", read });
    let clock = 0;
    const checks = createTopicSessionChecks({
      contexts: topicTurnContexts(source()),
      now: () => clock,
    });
    const turnOf = (text: string) =>
      conversationRuntimeTurnSchema.parse({
        turn_id: randomUUID(),
        lease_id: randomUUID(),
        lease_expires_at: new Date().toISOString(),
        scope: {
          workspace_id: workspaceId,
          agent_id: agentId,
          conversation_id: conversationId,
          topic_id: topicId,
        },
        model: "claude-haiku-5",
        provider: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          auth: { kind: "egress_token", token: ["wec", "t"].join("_") },
        },
        call: { id: randomUUID(), max_tokens: 1_024 },
        input: { id: randomUUID(), text },
        fresh_input: { id: randomUUID(), text },
      });
    const serve = async (text: string) => {
      const turn = turnOf(text);
      const out = await checks.handOut(turn);
      checks.ended(turn.turn_id, true);
      return out;
    };

    const first = await serve("one");
    expect(first.topic_session).toBe("drop");
    expect(first.fresh_input.text).toContain("about the message");
    clock += 60_000;
    expect((await serve("two")).topic_session).toBe("keep");

    await markDeleted(read);
    clock += 60_000;
    const after = await serve("three");
    expect(after.topic_session).toBe("drop");
    expect(after.fresh_input.text).not.toContain("about the message");
    expect(after.fresh_input.text).toBe("[now] three");
  });
});
