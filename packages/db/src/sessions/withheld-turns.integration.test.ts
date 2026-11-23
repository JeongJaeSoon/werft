import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { clientMessageIdSchema } from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresConversationInputStore } from "../conversations/conversation-inputs.ts";
import { createPostgresConversationStore } from "../conversations/conversation-store.ts";
import { servedTitle } from "../conversations/deleted-sources.ts";
import { createPostgresSessionReader } from "../postgres-unit-of-work.ts";
import * as schema from "../schema.ts";
import {
  attempts,
  deletedSources,
  events,
  executions,
  pendingRequests,
  sessionEventArchives,
  sessions,
  turns,
  workspaces,
} from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import { createPostgresPendingRequests } from "./pending-requests.ts";
import { encodeArchiveChunk } from "./session-event-archives.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const TEAM = "T0WITHHELD";
const CHANNEL = "C0WITHHELD";
const MENTION = "1792800000.000100";
const place = { team_id: TEAM, channel_id: CHANNEL, ts: MENTION };
const DELETED_AT = new Date("2026-11-23T02:00:00.000Z");
const VIEWER = { userId: null, apiKeyId: null };

integration("turns withheld for a deleted Slack source on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "withheld_turns_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  // A Slack mention's turn, then a web follow-up that only inherits it, and
  // a parked question of the first turn.
  async function slackSession(titleSource: "derived" | "generated" | "user") {
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      title: titleSource === "user" ? "Named by a person" : "Secret ask",
      titleSource,
    });
    const [first, second] = await db
      .insert(turns)
      .values([
        {
          sessionId,
          sequence: 1,
          message: "Secret ask",
          status: "completed",
          channel: "slack",
          resultJson: { result: "Secret answer", usage: { output_tokens: 3 } },
          sources: { direct: [place], inherited: [] },
        },
        {
          sessionId,
          sequence: 2,
          message: "Follow-up",
          status: "completed",
          channel: "web",
          resultJson: { result: "Second answer" },
          sources: { direct: [], inherited: [place] },
        },
      ])
      .returning({ id: turns.id });
    if (!first || !second) throw new Error("turns not written");
    const executionId = `exec-${sessionId}`;
    await db.insert(executions).values({
      id: executionId,
      sessionId,
      backend: "local_docker",
      generation: 1,
      desiredState: "terminated",
      observedState: "terminated",
    });
    const attemptId = `attempt-${sessionId}`;
    await db.insert(attempts).values({
      id: attemptId,
      sessionId,
      executionId,
      leaseEpoch: 0,
      executionGeneration: 1,
      authRevision: 0,
      state: "exited",
      leaseExpiresAt: new Date(),
    });
    await db.insert(pendingRequests).values({
      requestId: `req-${sessionId}`,
      sessionId,
      turnId: first.id,
      attemptId,
      kind: "question",
      payload: { kind: "question", questions: [{ question: "Secret?" }] },
      inputHash: "h",
      parkedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const stored = await db
      .insert(events)
      .values([
        {
          sessionId,
          turnId: first.id,
          type: "assistant",
          payload: { type: "assistant", text: "Secret answer" },
        },
        {
          sessionId,
          turnId: first.id,
          type: "tool_use",
          payload: {
            type: "assistant",
            tool_call: { id: "tu-1", name: "Read", input: { path: "secret" } },
          },
        },
        {
          sessionId,
          turnId: first.id,
          type: "tool_result",
          payload: {
            tool_result: {
              tool_call_id: "tu-1",
              is_error: false,
              text: "Secret file",
            },
          },
        },
        {
          sessionId,
          turnId: first.id,
          type: "result",
          payload: {
            type: "result",
            subtype: "success",
            result: "Secret answer",
            turn: {
              outcome: "success",
              is_error: false,
              terminal_reason: null,
              tokens: 3,
            },
          },
        },
        {
          sessionId,
          type: "status",
          payload: { phase: "idle", title: "Secret ask" },
        },
        {
          sessionId,
          turnId: second.id,
          type: "assistant",
          payload: { type: "assistant", text: "Second answer" },
        },
      ])
      .returning();
    return { workspaceId, sessionId, stored };
  }

  async function deleteMention(workspaceId: string) {
    await db.insert(deletedSources).values({
      workspaceId,
      teamId: TEAM,
      channelId: CHANNEL,
      ts: MENTION,
      deletedAt: DELETED_AT,
    });
  }

  async function read(
    owner: string,
    sessionId: string,
    reader = createPostgresSessionReader(db),
  ) {
    const [listed, first, second, page, detail, list, pending] =
      await Promise.all([
        reader.listTurns(owner, sessionId, { limit: 10 }),
        reader.getTurn(owner, sessionId, "1"),
        reader.getTurn(owner, sessionId, "2"),
        reader.readEvents(owner, sessionId, {
          limit: 100,
          maxBytes: 1 << 20,
        }),
        reader.getSession(owner, sessionId),
        reader.listSessions(owner, { limit: 10 }, VIEWER),
        createPostgresPendingRequests(db).listOpen(owner, sessionId),
      ]);
    return {
      turns: listed?.items.map((turn) => ({
        message: turn.message,
        source_deleted_at: turn.source_deleted_at,
      })),
      results: [first?.result, second?.result],
      usage: first?.usage,
      events: page?.items.map(
        (frame): Record<string, unknown> => ({
          event: frame.event,
          turn_id: frame.data.turn_id,
          source_deleted_at: frame.data.source_deleted_at,
          data: frame.data.data,
        }),
      ),
      title: [detail?.title, detail?.title_deleted_at],
      listed: list.items.map((item) => [item.title, item.title_deleted_at]),
      pending: pending?.map((request) => request.request_id),
    };
  }

  const BEFORE_EVENTS = [
    {
      event: "assistant",
      turn_id: "1",
      source_deleted_at: undefined,
      data: { type: "assistant", text: "Secret answer" },
    },
    {
      event: "tool_use",
      turn_id: "1",
      source_deleted_at: undefined,
      data: {
        type: "assistant",
        tool_call: { id: "tu-1", name: "Read", input: { path: "secret" } },
      },
    },
    {
      event: "tool_result",
      turn_id: "1",
      source_deleted_at: undefined,
      data: {
        tool_result: {
          tool_call_id: "tu-1",
          is_error: false,
          text: "Secret file",
        },
      },
    },
    {
      event: "result",
      turn_id: "1",
      source_deleted_at: undefined,
      data: {
        type: "result",
        subtype: "success",
        result: "Secret answer",
        turn: {
          outcome: "success",
          is_error: false,
          terminal_reason: null,
          tokens: 3,
        },
      },
    },
    {
      event: "status",
      turn_id: null,
      source_deleted_at: undefined,
      data: { phase: "idle", title: "Secret ask" },
    },
    {
      event: "assistant",
      turn_id: "2",
      source_deleted_at: undefined,
      data: { type: "assistant", text: "Second answer" },
    },
  ];

  const deleted = DELETED_AT.toISOString();
  const AFTER_EVENTS = [
    {
      event: "assistant",
      turn_id: "1",
      source_deleted_at: deleted,
      data: { type: "assistant" },
    },
    {
      event: "tool_use",
      turn_id: "1",
      source_deleted_at: deleted,
      data: {
        type: "assistant",
        tool_call: { id: "tu-1", name: "Read", input: {} },
      },
    },
    {
      event: "tool_result",
      turn_id: "1",
      source_deleted_at: deleted,
      data: {
        tool_result: { tool_call_id: "tu-1", is_error: false, text: "" },
      },
    },
    {
      event: "result",
      turn_id: "1",
      source_deleted_at: deleted,
      data: {
        type: "result",
        subtype: "success",
        turn: {
          outcome: "success",
          is_error: false,
          terminal_reason: null,
          tokens: 3,
        },
      },
    },
    {
      event: "status",
      turn_id: null,
      source_deleted_at: undefined,
      data: { phase: "idle" },
    },
    // Turn 2 only inherited the message: read as it is.
    {
      event: "assistant",
      turn_id: "2",
      source_deleted_at: undefined,
      data: { type: "assistant", text: "Second answer" },
    },
  ];

  test("a deleted mention withholds its own turn's instruction, answer and tool results, not the turn that inherited it", async () => {
    const { workspaceId, sessionId } = await slackSession("derived");
    const before = await read(workspaceId, sessionId);
    expect(before).toEqual({
      turns: [
        { message: "Secret ask", source_deleted_at: null },
        { message: "Follow-up", source_deleted_at: null },
      ],
      results: ["Secret answer", "Second answer"],
      usage: { output_tokens: 3 },
      events: BEFORE_EVENTS,
      title: ["Secret ask", null],
      listed: [["Secret ask", null]],
      pending: [`req-${sessionId}`],
    });

    await deleteMention(workspaceId);
    expect(await read(workspaceId, sessionId)).toEqual({
      turns: [
        { message: "", source_deleted_at: deleted },
        { message: "Follow-up", source_deleted_at: null },
      ],
      results: [null, "Second answer"],
      usage: { output_tokens: 3 },
      events: AFTER_EVENTS,
      title: [null, deleted],
      listed: [[null, deleted]],
      pending: [],
    });
    // What is stored is kept: only an admin's delete removes it.
    const [kept] = await db
      .select({ message: turns.message, title: sessions.title })
      .from(turns)
      .innerJoin(sessions, eq(sessions.id, turns.sessionId))
      .where(sql`${turns.sessionId} = ${sessionId} AND ${turns.sequence} = 1`);
    expect(kept).toEqual({ message: "Secret ask", title: "Secret ask" });
    // A withheld title finds nothing by its words; the id still finds it.
    const reader = createPostgresSessionReader(db);
    expect(
      (
        await reader.listSessions(
          workspaceId,
          { limit: 10, q: "secret" },
          VIEWER,
        )
      ).items,
    ).toEqual([]);
    expect(
      (
        await reader.listSessions(
          workspaceId,
          { limit: 10, q: sessionId.slice(0, 8) },
          VIEWER,
        )
      ).items.map((item) => item.id),
    ).toEqual([sessionId]);
  });

  test("an archived event of the turn is withheld as one still stored", async () => {
    const { workspaceId, sessionId, stored } = await slackSession("derived");
    const archived = stored.slice(0, 4);
    const body = encodeArchiveChunk(
      archived.map((row) =>
        JSON.stringify({
          id: row.id,
          type: row.type,
          payload: row.payload,
          attempt_id: row.attemptId,
          turn_id: row.turnId,
          source_sequence: null,
          created_at: row.createdAt.toISOString(),
          occurred_at: null,
          neutral: null,
        }),
      ),
    );
    const last = archived.at(-1);
    const firstRow = archived[0];
    if (!last || !firstRow) throw new Error("no events");
    await db.insert(sessionEventArchives).values({
      sessionId,
      fromId: firstRow.id,
      throughId: last.id,
      objectKey: `session-archive/${sessionId}/withheld`,
      versionId: "v1",
      sha256: createHash("sha256").update(body).digest("hex"),
      eventCount: archived.length,
      bytes: body.length,
      lastCreatedAt: last.createdAt,
      lastOccurredAt: last.createdAt,
    });
    for (const row of archived) {
      await db.delete(events).where(eq(events.id, row.id));
    }
    const reader = createPostgresSessionReader(db, {
      archivedEvents: { get: async () => body },
    });
    expect((await read(workspaceId, sessionId, reader)).events).toEqual(
      BEFORE_EVENTS,
    );
    await deleteMention(workspaceId);
    expect((await read(workspaceId, sessionId, reader)).events).toEqual(
      AFTER_EVENTS,
    );
  });

  test("a generated title is withheld with the first message, a person's title is kept", async () => {
    const generated = await slackSession("generated");
    const named = await slackSession("user");
    const titles = async (session: { sessionId: string }) =>
      rowsOf<{ title: string | null }>(
        await db.execute(sql`
          SELECT ${servedTitle("s")} AS title FROM sessions s
          WHERE s.id = ${session.sessionId}::uuid`),
      ).map((row) => row.title);
    expect(await titles(generated)).toEqual(["Secret ask"]);
    expect(await titles(named)).toEqual(["Named by a person"]);
    await deleteMention(generated.workspaceId);
    await deleteMention(named.workspaceId);
    expect(await titles(generated)).toEqual([null]);
    expect(
      (await read(generated.workspaceId, generated.sessionId)).title,
    ).toEqual([null, deleted]);
    expect(await titles(named)).toEqual(["Named by a person"]);
    const kept = await read(named.workspaceId, named.sessionId);
    expect(kept.title).toEqual(["Named by a person", null]);
    // The person's title stays, and so does its status event's.
    expect(
      kept.events?.find((frame) => frame.event === "status")?.data,
    ).toEqual({ phase: "idle", title: "Secret ask" });
    expect(kept.turns?.[0]).toEqual({
      message: "",
      source_deleted_at: deleted,
    });
  });

  test("a web input whose Slack mirror was deleted withholds its turn, by the input it names", async () => {
    const workspaceId = randomUUID();
    const person = randomUUID();
    const agentId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
      [person, `${person}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [workspaceId, person],
    );
    const team = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, $4, 'agent', 'active')",
      [agentId, workspaceId, team, `agent-${agentId.slice(0, 8)}`],
    );
    const conversation = await createPostgresConversationStore(
      db,
    ).findOrCreateConversation({
      kind: "dm",
      workspaceId,
      agentId,
      personUserId: person,
    });
    const taken = await createPostgresConversationInputStore(db).takeWebInput({
      workspaceId,
      agentId,
      requesterUserId: person,
      conversationId: conversation.id,
      topicId: null,
      clientMessageId: clientMessageIdSchema.parse(randomUUID()),
      body: "Secret ask from the web",
    });
    if (taken.outcome !== "taken") throw new Error(taken.outcome);
    // The place its Slack mirror took, as a posted mirror leaves it.
    await pool.query(
      "UPDATE conversation_inputs SET slack_team_id = $2, slack_channel_id = $3, slack_ts = $4 WHERE id = $1",
      [taken.receipt.inputId, TEAM, CHANNEL, MENTION],
    );
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      title: "Secret ask from the web",
    });
    await db.insert(turns).values({
      sessionId,
      sequence: 1,
      message: "Secret ask from the web",
      status: "completed",
      channel: "web",
      resultJson: { result: "Secret answer" },
      sources: {
        direct: [{ input_id: taken.receipt.inputId }],
        inherited: [],
      },
    });
    const reader = createPostgresSessionReader(db);
    const turnOne = async () => {
      const turn = await reader.getTurn(workspaceId, sessionId, "1");
      const detail = await reader.getSession(workspaceId, sessionId);
      return [
        turn?.message,
        turn?.result,
        turn?.source_deleted_at,
        detail?.title,
      ];
    };
    expect(await turnOne()).toEqual([
      "Secret ask from the web",
      "Secret answer",
      null,
      "Secret ask from the web",
    ]);
    await deleteMention(workspaceId);
    expect(await turnOne()).toEqual(["", null, deleted, null]);
  });

  test("a session with no source is read as before", async () => {
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      title: "From the console",
    });
    await db.insert(turns).values({
      sessionId,
      sequence: 1,
      message: "From the console",
      status: "completed",
      channel: "web",
      resultJson: { result: "Answer" },
    });
    // A deleted message of the same workspace that this session never held.
    await deleteMention(workspaceId);
    const reader = createPostgresSessionReader(db);
    expect(
      (
        await reader.listTurns(workspaceId, sessionId, { limit: 10 })
      )?.items.map((turn) => [turn.message, turn.source_deleted_at]),
    ).toEqual([["From the console", null]]);
    expect((await reader.getTurn(workspaceId, sessionId, "1"))?.result).toBe(
      "Answer",
    );
    const detail = await reader.getSession(workspaceId, sessionId);
    expect([detail?.title, detail?.title_deleted_at]).toEqual([
      "From the console",
      null,
    ]);
  });
});
