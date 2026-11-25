import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { ConversationTurnId } from "@werft-ai/contracts";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import {
  conversationReactionDedupeKey,
  createPostgresConversationReactions,
} from "./conversation-reactions.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

// v1-b/E2: a turn that took its message on puts one 👀 on the message that
// called it, as a reaction row; every decision is judged by the turn's record.

let client: PGlite;
let db: Database;
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();
const SLACK_APP = crypto.randomUUID();
const CONVERSATION = crypto.randomUUID();
const TEAM = "T0ACME";
const ROOM = "C0ROOM1";
const SCOPE = "reactions:write";

beforeAll(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await client.exec("SET session_replication_role = replica");
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0APP', $3)",
    [INSTALL, WORKSPACE, TEAM],
  );
  await client.query(
    "INSERT INTO slack_apps (id, workspace_id, kind, state, redirect_url, app_id, client_id, agent_id, bot_scopes) VALUES ($1, $2, 'agent', 'created', 'https://console.example/slack', 'A0APP', 'client', $3, $4)",
    [SLACK_APP, WORKSPACE, AGENT, ["chat:write", SCOPE]],
  );
  await client.query(
    "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'notes', 'Notes Agent', $3)",
    [AGENT, WORKSPACE, crypto.randomUUID()],
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

type Ending =
  | { state: "decided"; decision: string }
  | { state: "no_decision" }
  | { state: "voided_by_delete" };

/** A mention's turn ended as given, with the engagement of its message `ts`. */
async function turnOf(
  end: Ending,
  options: { ts?: string | null; installed?: boolean } = {},
): Promise<{ turnId: ConversationTurnId; ts: string }> {
  const topic = crypto.randomUUID();
  const turn = crypto.randomUUID() as ConversationTurnId;
  const ts = options.ts ?? nextTs();
  await client.query(
    "INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ($1, $2, $3, $4, 'channel', $5, $6, $7)",
    [topic, WORKSPACE, AGENT, CONVERSATION, TEAM, ROOM, ts],
  );
  const decision = end.state === "decided" ? end.decision : null;
  await client.query(
    `INSERT INTO conversation_turns (id, workspace_id, agent_id, conversation_id, topic_id, origin, state, requester_kind, requester_id, decision, decision_reason, answer_text, slack_installation_id, ended_at)
     VALUES ($1, $2, $3, $4, $5, 'm2', $6, 'user', $7, $8, $9, $10, $11, now())`,
    [
      turn,
      WORKSPACE,
      AGENT,
      CONVERSATION,
      topic,
      end.state,
      crypto.randomUUID(),
      decision,
      decision === null ? null : "asked",
      decision === "reply" ? "Here it is." : null,
      options.installed === false ? null : INSTALL,
    ],
  );
  if (options.ts !== null) {
    await client.query(
      "INSERT INTO conversation_engagements (workspace_id, agent_id, team_id, channel_id, ts, kind, conversation_turn_id) VALUES ($1, $2, $3, $4, $5, 'mention', $6) ON CONFLICT DO NOTHING",
      [WORKSPACE, AGENT, TEAM, ROOM, ts, turn],
    );
  }
  return { turnId: turn, ts };
}

const reactions = () =>
  createPostgresConversationReactions(
    db,
    createPostgresSlackOutboxStore(db),
    SCOPE,
  );

const rowsAt = async (ts: string) =>
  (
    await client.query<{
      kind: string;
      channel_id: string;
      thread_ts: string;
      session_id: string | null;
      conversation_turn_id: string | null;
      dedupe_key: string;
    }>(
      "SELECT * FROM slack_outbox WHERE kind = 'reaction' AND thread_ts = $1",
      [ts],
    )
  ).rows;

describe("a conversation turn's 👀", () => {
  test.each([
    ["reply", "enqueued"],
    ["spawn_task", "enqueued"],
    ["route_to_task", "enqueued"],
    ["no_reply", "none"],
  ] as const)("a %s decision: %s", async (decision, effect) => {
    const { turnId, ts } = await turnOf({ state: "decided", decision });
    expect(await reactions().react(turnId)).toBe(effect);
    expect(await rowsAt(ts)).toHaveLength(effect === "enqueued" ? 1 : 0);
  });

  test.each([
    { state: "no_decision" as const },
    { state: "voided_by_delete" as const },
  ])("a turn that ends $state puts none", async (end) => {
    const { turnId, ts } = await turnOf(end);
    expect(await reactions().react(turnId)).toBe("none");
    expect(await rowsAt(ts)).toEqual([]);
  });

  test("the row is one 👀 on the calling message, of no session, once per message", async () => {
    const { turnId, ts } = await turnOf({
      state: "decided",
      decision: "reply",
    });
    expect(await reactions().react(turnId)).toBe("enqueued");
    // Run again, or another turn of the same message: still one row.
    expect(await reactions().react(turnId)).toBe("duplicate");
    const rows = await rowsAt(ts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "reaction",
      channel_id: ROOM,
      thread_ts: ts,
      session_id: null,
      conversation_turn_id: null,
      dedupe_key: conversationReactionDedupeKey({
        teamId: TEAM,
        channelId: ROOM,
        ts,
      }),
    });
  });

  test("an install without reactions:write gets no row", async () => {
    await client.query("UPDATE slack_apps SET bot_scopes = $1 WHERE id = $2", [
      ["chat:write"],
      SLACK_APP,
    ]);
    const { turnId, ts } = await turnOf({
      state: "decided",
      decision: "reply",
    });
    expect(await reactions().react(turnId)).toBe("no_scope");
    // A scope list never read is no grant either.
    await client.query(
      "UPDATE slack_apps SET bot_scopes = NULL WHERE id = $1",
      [SLACK_APP],
    );
    expect(await reactions().react(turnId)).toBe("no_scope");
    expect(await rowsAt(ts)).toEqual([]);
    await client.query("UPDATE slack_apps SET bot_scopes = $1 WHERE id = $2", [
      ["chat:write", SCOPE],
      SLACK_APP,
    ]);
  });

  test("a turn no Slack message called, or with no installation, gets no row", async () => {
    const unplaced = await turnOf(
      { state: "decided", decision: "reply" },
      { ts: null },
    );
    expect(await reactions().react(unplaced.turnId)).toBe("no_message");
    const web = await turnOf(
      { state: "decided", decision: "reply" },
      { installed: false },
    );
    expect(await reactions().react(web.turnId)).toBe("no_message");
    expect(await rowsAt(web.ts)).toEqual([]);
  });
});
