import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { ConversationTurnId } from "@werft-ai/contracts";
import type { SurfaceOutboxEntry } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import {
  conversationReplyDedupeKey,
  createPostgresConversationReplies,
} from "./conversation-replies.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

// v1-b/E1: a turn's "reply" decision posts its answer in its topic's thread,
// as a row of no session, everything on it read from the server's records.

let client: PGlite;
let db: Database;
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();
const SLACK_APP = crypto.randomUUID();
const PERSON = crypto.randomUUID();
const CONVERSATION = crypto.randomUUID();
const TEAM = "T0ACME";
const ROOM = "C0ROOM1";

beforeAll(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  // The rows a row names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0APP', $3)",
    [INSTALL, WORKSPACE, TEAM],
  );
  await client.query(
    "INSERT INTO slack_apps (id, workspace_id, kind, state, redirect_url, app_id, client_id, agent_id) VALUES ($1, $2, 'agent', 'created', 'https://console.example/slack', 'A0APP', 'client', $3)",
    [SLACK_APP, WORKSPACE, AGENT],
  );
  await client.query(
    "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'notes', 'Notes Agent', $3)",
    [AGENT, WORKSPACE, crypto.randomUUID()],
  );
  await client.query(
    "INSERT INTO users (id, email, display_name, locale) VALUES ($1, 'ada@example.com', 'Ada  Lovelace', 'ko')",
    [PERSON],
  );
  await client.query(
    "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', $4, $5)",
    [CONVERSATION, WORKSPACE, AGENT, TEAM, ROOM],
  );
}, 60_000);

afterAll(() => client.close());

let count = 0;
const nextTs = () => {
  count += 1;
  return `1700000000.${String(count).padStart(6, "0")}`;
};

/** A mention's turn, ended as given, in a topic whose thread is `threadTs`. */
async function turnOf(input: {
  threadTs: string | null;
  state?: "decided" | "no_decision" | "voided_by_delete";
  decision?: "reply" | "no_reply";
  answer?: string;
  requester?: string;
  source?: string;
}): Promise<ConversationTurnId> {
  const topic = crypto.randomUUID();
  const turn = crypto.randomUUID() as ConversationTurnId;
  await client.query(
    "INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ($1, $2, $3, $4, 'channel', $5, $6, $7)",
    // A topic Slack has not placed holds none of its Slack columns.
    input.threadTs === null
      ? [topic, WORKSPACE, AGENT, CONVERSATION, null, null, null]
      : [topic, WORKSPACE, AGENT, CONVERSATION, TEAM, ROOM, input.threadTs],
  );
  const state = input.state ?? "decided";
  const decision = state === "decided" ? (input.decision ?? "reply") : null;
  const source = input.source ?? input.threadTs ?? nextTs();
  await client.query(
    `INSERT INTO conversation_turns (id, workspace_id, agent_id, conversation_id, topic_id, origin, state, requester_kind, requester_id, decision, decision_reason, answer_text, sources, slack_installation_id, ended_at)
     VALUES ($1, $2, $3, $4, $5, 'm2', $6, 'user', $7, $8, $9, $10, $11, $12, now())`,
    [
      turn,
      WORKSPACE,
      AGENT,
      CONVERSATION,
      topic,
      state,
      input.requester ?? PERSON,
      decision,
      decision === null ? null : "asked",
      decision === "reply" ? (input.answer ?? "Here it is.") : null,
      JSON.stringify({
        direct: [{ team_id: TEAM, channel_id: ROOM, ts: source }],
        inherited: [],
      }),
      INSTALL,
    ],
  );
  return turn;
}

const outbox = () => createPostgresSlackOutboxStore(db);
const replies = () => createPostgresConversationReplies(db, outbox());

const rowsOfTurn = async (turnId: string) =>
  (
    await client.query<{
      kind: string;
      channel_id: string;
      thread_ts: string;
      session_id: string | null;
      session_link_id: string | null;
      conversation_turn_id: string;
      body: { text: string; locale?: string; requested_by?: string };
      dedupe_key: string;
    }>("SELECT * FROM slack_outbox WHERE conversation_turn_id = $1", [turnId])
  ).rows;

describe("a conversation turn's reply decision", () => {
  test("enqueues its answer once, in the topic's thread, as no session's row", async () => {
    const threadTs = nextTs();
    const turnId = await turnOf({ threadTs, answer: "The **plan** is set." });
    expect(await replies().post(turnId)).toBe("enqueued");
    // Run again (a pass that died after enqueueing): still one row.
    expect(await replies().post(turnId)).toBe("duplicate");
    const rows = await rowsOfTurn(turnId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "conversation_reply",
      channel_id: ROOM,
      thread_ts: threadTs,
      session_id: null,
      session_link_id: null,
      dedupe_key: conversationReplyDedupeKey(turnId),
      body: {
        text: "The **plan** is set.",
        locale: "ko",
        requested_by: "Ada Lovelace",
      },
    });
  });

  test("goes to the turn's thread whatever channel the answer names (G3)", async () => {
    const threadTs = nextTs();
    const turnId = await turnOf({
      threadTs,
      answer: "Posting in <#C0OTHER9> instead: channel C0OTHER9",
    });
    await replies().post(turnId);
    expect(await rowsOfTurn(turnId)).toMatchObject([
      { channel_id: ROOM, thread_ts: threadTs },
    ]);
    // The claim reads the turn's conversation as the row's scope, so the
    // send's guard keeps no other channel (A3).
    const [claimed] = (
      await outbox().claim({ limit: 10, leaseMs: 60_000 })
    ).filter((row) => row.conversationTurnId === turnId);
    expect(claimed?.conversationScope).toEqual({
      kind: "channel",
      teamId: TEAM,
      channelId: ROOM,
    });
  });

  test("posts nothing for any other decision, none, or one a delete voided", async () => {
    for (const turn of [
      { decision: "no_reply" as const },
      { state: "no_decision" as const },
      { state: "voided_by_delete" as const },
    ]) {
      const turnId = await turnOf({ threadTs: nextTs(), ...turn });
      expect(await replies().post(turnId)).toBe("none");
      expect(await rowsOfTurn(turnId)).toEqual([]);
    }
  });

  test("a topic with no Slack thread gets no row: never the top of a channel", async () => {
    const turnId = await turnOf({ threadTs: null, source: nextTs() });
    expect(await replies().post(turnId)).toBe("no_thread");
    expect(await rowsOfTurn(turnId)).toEqual([]);
  });

  test("names no requester it cannot read", async () => {
    const turnId = await turnOf({
      threadTs: nextTs(),
      requester: crypto.randomUUID(),
    });
    await replies().post(turnId);
    const [row] = await rowsOfTurn(turnId);
    expect(row?.body).toEqual({ text: "Here it is." });
  });

  test("a source Slack deleted before the send voids the row: nothing goes out (check ③)", async () => {
    const threadTs = nextTs();
    const turnId = await turnOf({ threadTs });
    expect(await replies().post(turnId)).toBe("enqueued");
    await client.query(
      "INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at) VALUES ($1, $2, $3, $4, now())",
      [WORKSPACE, TEAM, ROOM, threadTs],
    );
    const claimed = (await outbox().claim({ limit: 10, leaseMs: 60_000 })).find(
      (row) => row.conversationTurnId === turnId,
    );
    if (claimed === undefined) throw new Error("the row was not claimed");
    expect(await outbox().beginSend(claimed)).toBe("voided_by_delete");
  });
});

describe("the table's conversation_reply rule", () => {
  const entry = (over: Partial<SurfaceOutboxEntry>): SurfaceOutboxEntry => ({
    workspaceId: WORKSPACE,
    agentId: AGENT,
    slackAppId: SLACK_APP,
    installationId: INSTALL,
    kind: "conversation_reply",
    channelId: ROOM,
    threadTs: nextTs(),
    slackUserId: null,
    sessionId: null,
    sessionLinkId: null,
    body: { text: "Done." },
    dedupeKey: `conversation_reply:${crypto.randomUUID()}`,
    conversationTurnId: crypto.randomUUID() as ConversationTurnId,
    ...over,
  });

  test("refuses a conversation reply with no thread_ts", async () => {
    await expect(outbox().enqueue(entry({ threadTs: "" }))).rejects.toThrow();
  });

  test("refuses one with a session, or with no turn, and a turn on another kind", async () => {
    for (const refused of [
      entry({ sessionId: crypto.randomUUID() }),
      entry({ conversationTurnId: null }),
      entry({ kind: "reply" }),
    ]) {
      await expect(outbox().enqueue(refused)).rejects.toThrow();
    }
  });
});
