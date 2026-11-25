import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type ConversationId,
  conversationIdSchema,
  conversationInputIdSchema,
} from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresChannelSummaryStore } from "../conversations/channel-summaries.ts";
import { createPostgresContextFragmentSource } from "../conversations/context-fragments.ts";
import { createPostgresConversationStore } from "../conversations/conversation-store.ts";
import { lockedDeletedSource } from "../conversations/deleted-sources.ts";
import { lockSlackSourceMark } from "../conversations/index.ts";
import * as schema from "../schema.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import { newPartitionedSession } from "../testing/sessions.ts";
import { deleteConversationRecords } from "./conversation-records.ts";
import { createPostgresSlackSourceMarkStore } from "./slack-source-marks.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const TEAM = "T0ADM";

integration("admin delete of a conversation's records on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const admin = randomUUID();
  const member = randomUUID();
  const adminEmail = `admin-${admin.slice(0, 8)}@example.invalid`;
  let tsCounter = 1793000000;
  let seq = 0;
  let channelCounter = 0;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "conversation_records" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    for (const [id, email, role] of [
      [admin, adminEmail, "admin"],
      [member, `member-${member.slice(0, 8)}@example.invalid`, "member"],
    ]) {
      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
        [id, email],
      );
      await pool.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)",
        [workspaceId, id, role],
      );
    }
    const team = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, $4, 'agent', 'active')",
      [agentId, workspaceId, team, `agent-${agentId.slice(0, 8)}`],
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  const nextTs = () => {
    tsCounter += 1;
    return `${tsCounter}.000100`;
  };

  /** A channel conversation with one topic and a session whose input is a mention. */
  async function channel() {
    channelCounter += 1;
    const channelId = `C0ADM${channelCounter}`;
    const key = {
      kind: "channel" as const,
      workspaceId,
      agentId,
      teamId: TEAM,
      channelId,
    };
    const conversations = createPostgresConversationStore(db);
    const conversation = await conversations.findOrCreateConversation(key);
    const topic = await conversations.findOrCreateThreadTopic(conversation.id, {
      teamId: TEAM,
      channelId,
      threadTs: nextTs(),
    });
    return {
      key,
      channelId,
      conversationId: conversation.id,
      topicId: topic.id,
    };
  }
  type Channel = Awaited<ReturnType<typeof channel>>;

  /** A session of the workspace whose first turn has these sources. */
  async function sessionWith(sources: unknown) {
    const { sessionId } = await newPartitionedSession(db, "admin-delete");
    await pool.query("UPDATE sessions SET workspace_id = $1 WHERE id = $2", [
      workspaceId,
      sessionId,
    ]);
    const { rows } = await pool.query(
      "UPDATE turns SET sources = $1 WHERE session_id = $2 AND sequence = 1 RETURNING id",
      [JSON.stringify(sources), sessionId],
    );
    return { sessionId, turnId: Number(rows[0].id) };
  }

  /** A mention that became a session's turn, with its engagement row. */
  async function mention(place: Channel) {
    const ts = nextTs();
    const session = await sessionWith({
      direct: [{ team_id: TEAM, channel_id: place.channelId, ts }],
      inherited: [],
    });
    seq += 1;
    await pool.query(
      "INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq, slack_team_id, slack_channel_id, slack_ts, requester_kind, requester_id, turn_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'user', $9, $10)",
      [
        randomUUID(),
        workspaceId,
        agentId,
        place.topicId,
        seq,
        TEAM,
        place.channelId,
        ts,
        member,
        session.turnId,
      ],
    );
    await pool.query(
      "INSERT INTO conversation_engagements (workspace_id, agent_id, team_id, channel_id, ts, kind, session_id) VALUES ($1, $2, $3, $4, $5, 'mention', $6)",
      [workspaceId, agentId, TEAM, place.channelId, ts, session.sessionId],
    );
    return { ts, inputId: null, ...session };
  }

  /** An unmentioned message in the agent's buffer. */
  async function buffered(place: Channel) {
    const id = conversationInputIdSchema.parse(randomUUID());
    const ts = nextTs();
    seq += 1;
    await pool.query(
      "INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq, slack_team_id, slack_channel_id, slack_ts, requester_kind, requester_id, body, buffer_expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'slack_user', 'U0POSTER', 'lunch?', now() + interval '10 minutes')",
      [id, workspaceId, agentId, place.topicId, seq, TEAM, place.channelId, ts],
    );
    return { id, ts };
  }

  /** A summary line written from the mention's input. */
  async function summed(place: Channel, ts: string) {
    const { rows } = await pool.query(
      "SELECT id FROM conversation_inputs WHERE slack_channel_id = $1 AND slack_ts = $2",
      [place.channelId, ts],
    );
    const summaries = createPostgresChannelSummaryStore(db);
    const summaryPlace = {
      workspaceId,
      teamId: TEAM,
      channelId: place.channelId,
    };
    const current = await summaries.read(summaryPlace);
    const written = await summaries.append({
      place: summaryPlace,
      agentId,
      expectedVersion: current?.version ?? 0,
      lines: [
        {
          text: "Friday it is",
          sources: [{ inputId: rows[0].id, slack: null }],
        },
      ],
    });
    if (written.outcome !== "written") throw new Error(written.outcome);
  }

  const count = async (text: string, values: unknown[]) =>
    Number((await pool.query(text, values)).rows[0].n);
  const recordsLeft = async (place: Channel) => ({
    engagements: await count(
      "SELECT count(*) AS n FROM conversation_engagements WHERE channel_id = $1",
      [place.channelId],
    ),
    summaryLines: await count(
      "SELECT count(*) AS n FROM channel_summary_lines WHERE channel_id = $1",
      [place.channelId],
    ),
    summaries: await count(
      "SELECT count(*) AS n FROM channel_summaries WHERE channel_id = $1",
      [place.channelId],
    ),
    buffered: await count(
      "SELECT count(*) AS n FROM conversation_inputs WHERE slack_channel_id = $1 AND buffer_expires_at IS NOT NULL",
      [place.channelId],
    ),
  });
  const sessionRows = async () => ({
    sessions: await count("SELECT count(*) AS n FROM sessions", []),
    turns: await count("SELECT count(*) AS n FROM turns", []),
    inputs: await count(
      "SELECT count(*) AS n FROM conversation_inputs WHERE buffer_expires_at IS NULL",
      [],
    ),
    checkpoints: await count("SELECT count(*) AS n FROM checkpoints", []),
  });
  const stoppedAt = async (sessionId: string) =>
    (
      await pool.query("SELECT source_deleted_at FROM sessions WHERE id = $1", [
        sessionId,
      ])
    ).rows[0].source_deleted_at;
  const sendRefused = (sessionId: string, sources: unknown) =>
    db.transaction((tx) =>
      lockedDeletedSource(tx, {
        workspaceId,
        sessionId,
        sources,
        throughTurn: null,
      }),
    );
  const idOf = (id: string) => conversationIdSchema.parse(id) as ConversationId;

  test("removes the three records of the conversation, stops only the session holding a removed message, and keeps sessions, turns and inputs", async () => {
    const place = await channel();
    const own = await mention(place);
    await summed(place, own.ts);
    const held = await buffered(place);
    // A session of the channel that took the buffered message as context.
    const holderSources = {
      direct: [],
      inherited: [
        {
          input_id: held.id,
          team_id: TEAM,
          channel_id: place.channelId,
          ts: held.ts,
        },
      ],
    };
    const holder = await sessionWith(holderSources);
    const ownSources = {
      direct: [{ team_id: TEAM, channel_id: place.channelId, ts: own.ts }],
      inherited: [],
    };
    const other = await channel();
    const otherMention = await mention(other);
    await buffered(other);
    const before = await sessionRows();
    expect(await recordsLeft(place)).toEqual({
      engagements: 1,
      summaryLines: 1,
      summaries: 1,
      buffered: 1,
    });

    const result = await deleteConversationRecords(db, {
      conversationId: idOf(place.conversationId),
      by: adminEmail.toUpperCase(),
    });

    expect(result).toEqual({
      outcome: "deleted",
      workspaceId,
      counts: {
        engagements: 1,
        summaryLines: 1,
        buffered: 1,
        turns: 0,
        marked: 1,
      },
      sessionsStopped: [holder.sessionId],
    });
    expect(await recordsLeft(place)).toEqual({
      engagements: 0,
      summaryLines: 0,
      summaries: 0,
      buffered: 0,
    });
    // Another conversation keeps its records.
    expect(await recordsLeft(other)).toEqual({
      engagements: 1,
      summaryLines: 0,
      summaries: 0,
      buffered: 1,
    });
    expect(await sessionRows()).toEqual(before);
    // Only the buffered message is marked: the mention is its session's input.
    const marks = await pool.query(
      "SELECT ts, reason FROM deleted_sources WHERE channel_id = $1 ORDER BY ts",
      [place.channelId],
    );
    expect(marks.rows).toEqual([{ ts: held.ts, reason: "admin_deleted" }]);
    expect(await stoppedAt(holder.sessionId)).not.toBeNull();
    expect(await stoppedAt(own.sessionId)).toBeNull();
    expect(await stoppedAt(otherMention.sessionId)).toBeNull();
    expect(await sendRefused(holder.sessionId, holderSources)).toEqual({
      teamId: TEAM,
      channelId: place.channelId,
      ts: held.ts,
    });
    expect(await sendRefused(own.sessionId, ownSources)).toBeNull();
    // Nothing of the conversation is left to assemble.
    expect(
      await createPostgresContextFragmentSource(db).read(place.key),
    ).toEqual({ fragments: [], unreadable: 0, summaryVersion: 0 });

    const row = await pool.query(
      "SELECT records_deleted_by_user_id AS by, records_deleted_at IS NOT NULL AS at FROM conversations WHERE id = $1",
      [place.conversationId],
    );
    expect(row.rows).toEqual([{ by: admin, at: true }]);
    const receipts = await pool.query(
      "SELECT actor, target_ref, result FROM receipts WHERE operation = 'delete_conversation_records'",
    );
    expect(receipts.rows).toEqual([
      {
        actor: {
          principal: { kind: "user", id: admin },
          actor_user_id: admin,
          agent_id: null,
        },
        target_ref: {
          resource: { kind: "conversation", id: place.conversationId },
          workspace_id: workspaceId,
        },
        result: {
          conversation_id: place.conversationId,
          engagements: 1,
          summary_lines: 1,
          buffered: 1,
          turns: 0,
          marked: 1,
          by: "operator_cli",
        },
      },
    ]);

    // Again: nothing more goes, no second receipt, the same rows.
    const again = await deleteConversationRecords(db, {
      conversationId: idOf(place.conversationId),
      by: adminEmail,
    });
    expect(again).toEqual({
      outcome: "unchanged",
      workspaceId,
      counts: {
        engagements: 0,
        summaryLines: 0,
        buffered: 0,
        turns: 0,
        marked: 0,
      },
      sessionsStopped: [],
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM receipts WHERE operation = 'delete_conversation_records'",
        [],
      ),
    ).toBe(1);
    expect(await sessionRows()).toEqual(before);
  });

  test("keeps unmarked a message a turn took before its input row was written, and that session goes on", async () => {
    const place = await channel();
    const taken = await buffered(place);
    // Another agent's turn named the message; its input row comes later.
    const takerSources = {
      direct: [{ team_id: TEAM, channel_id: place.channelId, ts: taken.ts }],
      inherited: [],
    };
    const taker = await sessionWith(takerSources);

    const result = await deleteConversationRecords(db, {
      conversationId: idOf(place.conversationId),
      by: adminEmail,
    });

    expect(result).toMatchObject({
      outcome: "deleted",
      counts: {
        engagements: 0,
        summaryLines: 0,
        buffered: 1,
        turns: 0,
        marked: 0,
      },
      sessionsStopped: [],
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM deleted_sources WHERE channel_id = $1",
        [place.channelId],
      ),
    ).toBe(0);
    expect(await stoppedAt(taker.sessionId)).toBeNull();
    expect(await sendRefused(taker.sessionId, takerSources)).toBeNull();
  });

  test("starts again when PostgreSQL ends a deadlock by rolling it back", async () => {
    const place = await channel();
    const held = await buffered(place);
    // B holds the conversation, which the delete waits on with the
    // message's mark lock held; B then asks for that mark lock. The delete
    // waited first, so its deadlock check runs first and ends it.
    const b = await pool.connect();
    const bPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await b.query("BEGIN");
    await b.query("SELECT 1 FROM conversations WHERE id = $1 FOR SHARE", [
      place.conversationId,
    ]);
    const deleting = deleteConversationRecords(db, {
      conversationId: idOf(place.conversationId),
      by: adminEmail,
    });
    // Until the delete waits on B.
    while (
      Number(
        (
          await pool.query(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [bPid],
          )
        ).rows[0].n,
      ) === 0
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const bLock = await drizzle(b, { schema })
      .execute(
        lockSlackSourceMark({
          workspaceId,
          teamId: TEAM,
          channelId: place.channelId,
          ts: held.ts,
        }),
      )
      .then(
        () => "locked",
        () => "victim",
      );
    await b.query(bLock === "locked" ? "COMMIT" : "ROLLBACK");
    b.release();

    expect(bLock).toBe("locked");
    expect(await deleting).toMatchObject({
      outcome: "deleted",
      counts: {
        engagements: 0,
        summaryLines: 0,
        buffered: 1,
        turns: 0,
        marked: 1,
      },
    });
    expect((await recordsLeft(place)).buffered).toBe(0);
  }, 30_000);

  test("a dry run counts and changes nothing", async () => {
    const place = await channel();
    await mention(place);
    await buffered(place);
    const result = await deleteConversationRecords(db, {
      conversationId: idOf(place.conversationId),
      by: adminEmail,
      dryRun: true,
    });
    expect(result).toMatchObject({
      outcome: "dry_run",
      counts: {
        engagements: 1,
        summaryLines: 0,
        buffered: 1,
        turns: 0,
        marked: 1,
      },
    });
    expect(await recordsLeft(place)).toMatchObject({
      engagements: 1,
      buffered: 1,
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM deleted_sources WHERE channel_id = $1",
        [place.channelId],
      ),
    ).toBe(0);
  });

  test("refuses a member, a DM conversation and an unknown id, and changes nothing", async () => {
    const place = await channel();
    await buffered(place);
    expect(
      await deleteConversationRecords(db, {
        conversationId: idOf(place.conversationId),
        by: `member-${member.slice(0, 8)}@example.invalid`,
      }),
    ).toEqual({ outcome: "not_admin" });
    expect((await recordsLeft(place)).buffered).toBe(1);
    const dm = await createPostgresConversationStore(
      db,
    ).findOrCreateConversation({
      kind: "dm",
      workspaceId,
      agentId,
      personUserId: member,
    });
    expect(
      await deleteConversationRecords(db, {
        conversationId: idOf(dm.id),
        by: adminEmail,
      }),
    ).toEqual({ outcome: "dm_not_supported" });
    expect(
      await deleteConversationRecords(db, {
        conversationId: idOf(randomUUID()),
        by: adminEmail,
      }),
    ).toEqual({ outcome: "not_found" });
  });

  test("a Slack delete of a message an admin delete marked makes the mark Slack's", async () => {
    const place = await channel();
    const held = await buffered(place);
    await deleteConversationRecords(db, {
      conversationId: idOf(place.conversationId),
      by: adminEmail,
    });
    const at = new Date();
    expect(
      await createPostgresSlackSourceMarkStore(db).markDeleted({
        workspaceId,
        teamId: TEAM,
        channelId: place.channelId,
        ts: held.ts,
        at,
      }),
    ).toBe("recorded");
    const marks = await pool.query(
      "SELECT reason, deleted_at FROM deleted_sources WHERE channel_id = $1",
      [place.channelId],
    );
    expect(marks.rows).toEqual([{ reason: "slack_deleted", deleted_at: at }]);
    // A Slack mark stays Slack's on a redelivery.
    expect(
      await createPostgresSlackSourceMarkStore(db).markDeleted({
        workspaceId,
        teamId: TEAM,
        channelId: place.channelId,
        ts: held.ts,
        at,
      }),
    ).toBe("duplicate");
  });
});
