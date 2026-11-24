import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationId,
  type ConversationTopicId,
  clientMessageIdSchema,
} from "@werft-ai/contracts";
import { placeSource, storedSourceSet } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { deleteConversationRecords } from "../surface/conversation-records.ts";
import { purgeUnknownSlackSourceMarks } from "../surface/slack-source-marks.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import { createPostgresContextFragmentSource } from "./context-fragments.ts";
import { createPostgresConversationInputStore } from "./conversation-inputs.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";
import {
  beginConversationTurn,
  endConversationTurn,
  moveWebInputBodies,
  webInputBodyHash,
} from "./conversation-turns.ts";
import { inputTexts } from "./input-texts.ts";
import { dropBufferedInputs } from "./judgment-buffer.ts";

const TEAM = "T0TURNS";
const CHANNEL = "C0TURNS";
const THREAD = "1700000000.000100";

describe("conversation turns (0344)", () => {
  let client: PGlite;
  let db: Database;
  let workspaceId: string;
  let agentId: string;
  let adminId: string;
  let conversationId: ConversationId;
  let topicId: ConversationTopicId;

  const count = async (query: string, params: unknown[] = []) =>
    Number((await client.query<{ n: string }>(query, params)).rows[0]?.n ?? 0);
  const channelKey = () => ({
    kind: "channel" as const,
    workspaceId,
    agentId,
    teamId: TEAM,
    channelId: CHANNEL,
  });
  const place = (ts: string) => ({ teamId: TEAM, channelId: CHANNEL, ts });
  const sources = (...ts: string[]) =>
    storedSourceSet({
      direct: ts.map((t) => placeSource(place(t))),
      inherited: [],
      overflow: false,
    });
  const begin = (input: { sources?: string[]; engage?: string } = {}) =>
    beginConversationTurn(db, {
      workspaceId,
      agentId,
      conversationId,
      topicId,
      requester: { kind: "slack_user", id: "U0ASKER" },
      sources: input.sources === undefined ? null : sources(...input.sources),
      releaseId: null,
      slackInstallationId: null,
      engagement:
        input.engage === undefined
          ? null
          : { ...place(input.engage), kind: "mention" },
    });
  const begun = async (input: { sources?: string[]; engage?: string } = {}) => {
    const result = await begin(input);
    if (result.outcome !== "begun") throw new Error(result.outcome);
    return result.turnId;
  };
  // Marked an hour ago, so a purge with no retention judges it.
  const markDeleted = (ts: string) =>
    client.query(
      "INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at, marked_at) VALUES ($1, $2, $3, $4, now(), now() - interval '1 hour')",
      [workspaceId, TEAM, CHANNEL, ts],
    );
  async function buffer(ts: string, body: string): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq,
         slack_team_id, slack_channel_id, slack_ts, requester_kind, requester_id,
         body, buffer_expires_at)
       SELECT $1, $2, $3, $4, COALESCE(MAX(seq), 0) + 1, $5, $6, $7,
         'slack_user', 'U0POSTER', $8, now() + interval '10 minutes'
       FROM conversation_inputs WHERE topic_id = $4`,
      [id, workspaceId, agentId, topicId, TEAM, CHANNEL, ts, body],
    );
    return id;
  }
  async function call(turnId: string | null, callClass = "m2") {
    const id = randomUUID();
    await client.query(
      `INSERT INTO conversation_calls (id, workspace_id, agent_id, token_hash,
         root_kind, connection_id, path, model, max_tokens, max_request_bytes,
         expires_at, conversation_id, topic_id, call_class, call_key, attempt,
         conversation_turn_id)
       VALUES ($1::uuid, $2, $3, convert_to($9, 'UTF8'), 'none', 'conn',
         '/v1/messages', 'model', 100, 1000, now() + interval '1 minute',
         $4, $5, $6, $7, 1, $8)`,
      [
        id,
        workspaceId,
        agentId,
        conversationId,
        topicId,
        callClass,
        `${id}:${callClass}`,
        turnId,
        id,
      ],
    );
    return id;
  }

  beforeEach(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    workspaceId = randomUUID();
    agentId = randomUUID();
    adminId = randomUUID();
    await client.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );
    await client.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, 'admin@example.invalid', 'admin')",
      [adminId],
    );
    await client.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, adminId],
    );
    const team = await fixtureTeam(db, workspaceId);
    await client.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, 'agent', 'agent', 'active')",
      [agentId, workspaceId, team],
    );
    const store = createPostgresConversationStore(db);
    const conversation = await store.findOrCreateConversation(channelKey());
    conversationId = conversation.id;
    topicId = (
      await store.findOrCreateThreadTopic(conversationId, {
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs: THREAD,
      })
    ).id;
  }, 60_000);

  test("a turn's engagement points at it, and the FK refuses a turn that is not there", async () => {
    const turnId = await begun({ engage: "1700000000.000200" });
    const rows = await client.query<{ conversation_turn_id: string }>(
      "SELECT conversation_turn_id FROM conversation_engagements WHERE ts = '1700000000.000200'",
    );
    expect(rows.rows).toEqual([{ conversation_turn_id: turnId }]);
    await expect(
      client.query(
        "INSERT INTO conversation_engagements (workspace_id, agent_id, team_id, channel_id, ts, kind, conversation_turn_id) VALUES ($1, $2, $3, $4, '1700000000.000300', 'mention', $5)",
        [workspaceId, agentId, TEAM, CHANNEL, randomUUID()],
      ),
    ).rejects.toThrow(/conversation_engagements_conversation_turn_fk/);
  });

  test("one turn has many calls; only an m2 call names a turn", async () => {
    const turnId = await begun();
    await call(turnId);
    await call(turnId);
    expect(
      await count(
        "SELECT count(*) AS n FROM conversation_calls WHERE conversation_turn_id = $1",
        [turnId],
      ),
    ).toBe(2);
    await expect(call(turnId, "m1")).rejects.toThrow(
      /conversation_calls_conversation_turn_check/,
    );
  });

  test("a turn whose source or engaged message is deleted is not begun", async () => {
    await markDeleted("1700000000.000400");
    expect(await begin({ sources: ["1700000000.000400"] })).toEqual({
      outcome: "source_deleted",
    });
    expect(await begin({ engage: "1700000000.000400" })).toEqual({
      outcome: "source_deleted",
    });
    expect(await count("SELECT count(*) AS n FROM conversation_turns")).toBe(0);
  });

  test("a turn ends once, with its decision and answer", async () => {
    const turnId = await begun();
    expect(
      await endConversationTurn(db, {
        turnId,
        end: {
          state: "decided",
          decision: "reply",
          reason: "asked",
          answer: "the answer",
        },
      }),
    ).toBe("recorded");
    expect(
      await endConversationTurn(db, { turnId, end: { state: "no_decision" } }),
    ).toBe("already_ended");
    const [row] = (
      await client.query(
        "SELECT state, decision, decision_reason, answer_text FROM conversation_turns WHERE id = $1",
        [turnId],
      )
    ).rows;
    expect(row).toEqual({
      state: "decided",
      decision: "reply",
      decision_reason: "asked",
      answer_text: "the answer",
    });
  });

  test("the turn table holds no channel message's text", async () => {
    const text = "a buffered message only the input row holds";
    await buffer("1700000000.000500", text);
    const turnId = await begun({
      sources: ["1700000000.000500"],
      engage: "1700000000.000500",
    });
    await endConversationTurn(db, {
      turnId,
      end: {
        state: "decided",
        decision: "no_reply",
        reason: null,
        answer: null,
      },
    });
    const dump = JSON.stringify(
      (await client.query("SELECT * FROM conversation_turns")).rows,
    );
    expect(dump).not.toContain(text);
    expect(dump).toContain("1700000000.000500");
  });

  test("a message only a turn read keeps its delete mark past the purge", async () => {
    await begun({ sources: ["1700000000.000600"] });
    await markDeleted("1700000000.000600");
    await markDeleted("1700000000.000700");
    const purged = await purgeUnknownSlackSourceMarks(db, {
      limit: 10,
      dryRun: false,
      retentionMs: 0,
    });
    expect(purged.deleted).toBe(1);
    const left = await client.query<{ ts: string }>(
      "SELECT ts FROM deleted_sources",
    );
    expect(left.rows).toEqual([{ ts: "1700000000.000600" }]);
  });

  test("the buffer's purge leaves a topic a turn or call points at, and the turn's topic with it", async () => {
    const turnId = await begun();
    await call(turnId);
    const buffered = await buffer("1700000000.000800", "held");
    await db.transaction((tx) => dropBufferedInputs(tx, [buffered]));
    expect(
      await count(
        "SELECT count(*) AS n FROM conversation_topics WHERE id = $1",
        [topicId],
      ),
    ).toBe(1);
    const [row] = (
      await client.query(
        "SELECT topic_id FROM conversation_turns WHERE id = $1",
        [turnId],
      )
    ).rows;
    expect(row).toEqual({ topic_id: topicId });
  });

  test("an engagement through a turn is context, until its message is deleted", async () => {
    await begun({ engage: "1700000000.000900" });
    const source = createPostgresContextFragmentSource(db);
    const engagements = async () =>
      (await source.read(channelKey())).fragments.filter(
        (f) => f.kind === "engagement",
      );
    expect(await engagements()).toHaveLength(1);
    expect((await engagements())[0]).toMatchObject({
      target: { kind: "conversation_turn" },
    });
    await markDeleted("1700000000.000900");
    expect(await engagements()).toHaveLength(0);
  });

  test("an admin delete removes the conversation's turns, counts them, and a turn under way writes no result", async () => {
    const turnId = await begun({ engage: "1700000000.001000" });
    const callId = await call(turnId);
    const result = await deleteConversationRecords(db, {
      conversationId,
      by: "admin@example.invalid",
    });
    expect(result).toMatchObject({
      outcome: "deleted",
      counts: { engagements: 1, turns: 1 },
    });
    expect(await count("SELECT count(*) AS n FROM conversation_turns")).toBe(0);
    expect(
      await endConversationTurn(db, { turnId, end: { state: "no_decision" } }),
    ).toBe("gone");
    const [kept] = (
      await client.query(
        "SELECT conversation_turn_id FROM conversation_calls WHERE id = $1",
        [callId],
      )
    ).rows;
    expect(kept).toEqual({ conversation_turn_id: null });
    const fragments = (
      await createPostgresContextFragmentSource(db).read(channelKey())
    ).fragments;
    expect(fragments.filter((f) => f.kind === "engagement")).toHaveLength(0);
    const [receipt] = (
      await client.query<{ result: { turns: number } }>(
        "SELECT result FROM receipts WHERE operation = 'delete_conversation_records'",
      )
    ).rows;
    expect(receipt?.result.turns).toBe(1);
  });

  describe("web inputs", () => {
    let personId: string;
    let dmId: ConversationId;

    beforeEach(async () => {
      personId = randomUUID();
      await client.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, 'person@example.invalid', 'person')",
        [personId],
      );
      await client.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
        [workspaceId, personId],
      );
      dmId = (
        await createPostgresConversationStore(db).findOrCreateConversation({
          kind: "dm",
          workspaceId,
          agentId,
          personUserId: personId,
        })
      ).id;
    });

    const take = (key: string, body: string) =>
      createPostgresConversationInputStore(db).takeWebInput({
        workspaceId,
        agentId,
        requesterUserId: personId,
        conversationId: dmId,
        topicId: null,
        clientMessageId: clientMessageIdSchema.parse(key),
        body,
      });

    test("a web input's text goes to its one turn row, and a retry is told by the hash", async () => {
      const taken = await take("key-1", "hello there");
      if (taken.outcome !== "taken") throw new Error(taken.outcome);
      const inputId = taken.receipt.inputId;
      const [input] = (
        await client.query<{
          body: string | null;
          body_sha256: Uint8Array;
          conversation_turn_id: string;
        }>(
          "SELECT body, body_sha256, conversation_turn_id FROM conversation_inputs WHERE id = $1",
          [inputId],
        )
      ).rows;
      expect(input?.body).toBeNull();
      expect(
        Buffer.from(input?.body_sha256 ?? []).equals(
          webInputBodyHash("hello there"),
        ),
      ).toBe(true);
      const turns = await client.query(
        "SELECT id, origin, state, input_text, decision FROM conversation_turns",
      );
      expect(turns.rows).toEqual([
        {
          id: input?.conversation_turn_id,
          origin: "web_input",
          state: "received",
          input_text: "hello there",
          decision: null,
        },
      ]);
      expect((await inputTexts(db, [inputId])).get(inputId)).toBe(
        "hello there",
      );
      expect(await take("key-1", "hello there")).toMatchObject({
        outcome: "replayed",
        receipt: { inputId },
      });
      expect(await take("key-1", "hello there ")).toEqual({
        outcome: "body_mismatch",
      });
      expect(await count("SELECT count(*) AS n FROM conversation_turns")).toBe(
        1,
      );
    });

    test("the start pass moves each older web input's text to a turn row, and runs on none", async () => {
      expect(await moveWebInputBodies(db)).toEqual({ moved: 0, failed: [] });
      const first = await take("key-2", "opens the topic");
      if (first.outcome !== "taken") throw new Error(first.outcome);
      const oldId = randomUUID();
      await client.query(
        `INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq,
           requester_kind, requester_id, client_message_id, body, slack_mirror)
         VALUES ($1, $2, $3, $4, 2, 'user', $5, 'key-old', 'written before', 'not_target')`,
        [oldId, workspaceId, agentId, first.receipt.topicId, personId],
      );
      expect(await take("key-old", "written before")).toMatchObject({
        outcome: "replayed",
        receipt: { inputId: oldId },
      });
      expect(await moveWebInputBodies(db, { batch: 1 })).toEqual({
        moved: 1,
        failed: [],
      });
      expect(await moveWebInputBodies(db)).toEqual({ moved: 0, failed: [] });
      const [moved] = (
        await client.query<{
          body: string | null;
          body_sha256: Uint8Array;
          input_text: string;
        }>(
          `SELECT i.body, i.body_sha256, t.input_text FROM conversation_inputs i
           JOIN conversation_turns t ON t.id = i.conversation_turn_id
           WHERE i.id = $1`,
          [oldId],
        )
      ).rows;
      expect(moved?.body).toBeNull();
      expect(moved?.input_text).toBe("written before");
      expect(
        Buffer.from(moved?.body_sha256 ?? []).equals(
          webInputBodyHash("written before"),
        ),
      ).toBe(true);
      expect(await take("key-old", "written before")).toMatchObject({
        outcome: "replayed",
        receipt: { inputId: oldId },
      });
      expect(await take("key-old", "written after")).toEqual({
        outcome: "body_mismatch",
      });
      expect(await count("SELECT count(*) AS n FROM conversation_turns")).toBe(
        2,
      );
    });

    test("an admin delete leaves a web input's turn row with its input", async () => {
      const taken = await take("key-3", "kept");
      if (taken.outcome !== "taken") throw new Error(taken.outcome);
      await begun();
      await deleteConversationRecords(db, {
        conversationId,
        by: "admin@example.invalid",
      });
      expect(
        await count(
          "SELECT count(*) AS n FROM conversation_turns WHERE origin = 'web_input'",
        ),
      ).toBe(1);
    });
  });
});
