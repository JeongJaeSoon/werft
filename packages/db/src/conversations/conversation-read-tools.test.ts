import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationDecision,
  type ConversationId,
  type ConversationReadTool,
  type ConversationRuntimeId,
  type ConversationTurnId,
  type ConversationTurnLeaseId,
  conversationCallKeySchema,
  conversationIdSchema,
  conversationRuntimeIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
  conversationTurnLeaseIdSchema,
  ENDED_SESSION_STATUSES,
} from "@werft-ai/contracts";
import {
  conversationTurnLimitReached,
  hashConversationCallToken,
  placeSource,
  type SourceKey,
  sourceSetOf,
  storedSourceSet,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresConversationCalls } from "../conversation-calls.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import {
  agents,
  channelContexts,
  conversations,
  conversationTopics,
  conversationTurnPermits,
  conversationTurns,
  deletedSources,
  sessionShares,
  sessions,
  slackInstallations,
  surfaceBindings,
  users,
  workspaces,
} from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import { createPostgresConversationReadToolStore } from "./conversation-read-tools.ts";
import { beginConversationTurn } from "./conversation-turns.ts";

const TEAM = "T0READ";
const at = (ts: string) => ({ teamId: TEAM, channelId: "C0OPEN", ts });

describe("the read tools' store on PostgreSQL", () => {
  let client: PGlite;
  let db: Database;
  const ws = randomUUID();
  const agentId = randomUUID();
  const installationId = randomUUID();
  const userId = randomUUID();
  // A public channel the agent is bound to, and one no binding names.
  const open = conversationIdSchema.parse(randomUUID());
  const unbound = conversationIdSchema.parse(randomUUID());
  let thread = 0;

  beforeAll(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    await db.insert(workspaces).values({ id: ws, slug: "ws-read", name: "ws" });
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "person",
    });
    await db.insert(agents).values({
      id: agentId,
      workspaceId: ws,
      managingTeamId: await fixtureTeam(db, ws),
      slug: "reader",
      name: "reader",
    });
    await db.insert(slackInstallations).values({
      id: installationId,
      workspaceId: ws,
      appId: "A0READ",
      teamId: TEAM,
    });
    await db.insert(surfaceBindings).values({
      id: randomUUID(),
      workspaceId: ws,
      agentId,
      surface: "slack",
      installationId,
      externalSurfaceId: "C0OPEN",
      surfaceKind: "public_channel",
      mode: "on",
      ceilingActions: [],
      ceilingDisclosure: "summary",
    });
    for (const [id, channelId] of [
      [open, "C0OPEN"],
      [unbound, "C0NONE"],
    ] as const) {
      await db.insert(channelContexts).values({
        id: randomUUID(),
        workspaceId: ws,
        teamId: TEAM,
        channelId,
      });
      await db.insert(conversations).values({
        id,
        workspaceId: ws,
        agentId,
        kind: "channel",
        teamId: TEAM,
        channelId,
      });
    }
  }, 60_000);

  afterAll(() => client.close());

  const store = () => createPostgresConversationReadToolStore(db);

  async function topicOf(conversationId: ConversationId) {
    const id = conversationTopicIdSchema.parse(randomUUID());
    thread += 1;
    const [row] = await db
      .select({ channelId: conversations.channelId })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    await db.insert(conversationTopics).values({
      id,
      workspaceId: ws,
      agentId,
      conversationId,
      conversationKind: "channel",
      slackTeamId: TEAM,
      slackChannelId: row?.channelId ?? null,
      slackThreadTs: `300.${String(thread).padStart(6, "0")}`,
    });
    return id;
  }

  /** A running turn of the conversation, leased to a runtime now. */
  async function leased(
    conversationId: ConversationId = open,
    options: {
      sources?: SourceKey[];
      leaseMs?: number;
      overflow?: boolean;
      requester?: { kind: string; id: string };
    } = {},
  ) {
    const topicId = await topicOf(conversationId);
    const turnId = conversationTurnIdSchema.parse(randomUUID());
    const leaseId = conversationTurnLeaseIdSchema.parse(randomUUID());
    const runtimeId = conversationRuntimeIdSchema.parse(randomUUID());
    await db.insert(conversationTurns).values({
      id: turnId,
      workspaceId: ws,
      agentId,
      conversationId,
      topicId,
      origin: "m2",
      state: "running",
      requesterKind: options.requester?.kind ?? "user",
      requesterId: options.requester?.id ?? userId,
      slackInstallationId: installationId,
      sources: storedSourceSet({
        direct: options.sources ?? [],
        inherited: [],
        overflow: options.overflow ?? false,
      }),
    });
    await db.insert(conversationTurnPermits).values({
      turnId,
      tokenHash: hashConversationCallToken(randomUUID()),
      rootKind: "user",
      requesterUserId: userId,
      connectionId: "conn-messages",
      path: "/v1/messages",
      model: "claude-haiku-4-5",
      maxTokens: 256,
      maxRequestBytes: 4_096,
      callKey: conversationCallKeySchema.parse(`turn-${turnId}:m2`),
      expiresAt: new Date(Date.now() + 180_000),
    });
    await db.execute(sql`
      INSERT INTO conversation_turn_queue (turn_id, input_id, attempt, topic_id,
        state, take_by, take_ms, lease_id, runtime_id, lease_expires_at)
      VALUES (${turnId}::uuid, ${randomUUID()}::uuid, 1, ${topicId}::uuid,
        'leased', now(), 0, ${leaseId}::uuid, ${runtimeId}::uuid,
        now() + make_interval(secs => ${(options.leaseMs ?? 150_000) / 1000}))`);
    return { turnId, leaseId, runtimeId, topicId, conversationId };
  }

  const admit = (
    turn: {
      turnId: ConversationTurnId;
      leaseId: ConversationTurnLeaseId;
      runtimeId: ConversationRuntimeId;
    },
    tool: ConversationReadTool = "read_turns",
  ) =>
    store().admit({
      turnId: turn.turnId,
      leaseId: turn.leaseId,
      runtimeId: turn.runtimeId,
      tool,
      now: new Date(),
    });

  const permitOf = async (turnId: ConversationTurnId) =>
    (
      await db
        .select()
        .from(conversationTurnPermits)
        .where(eq(conversationTurnPermits.turnId, turnId))
    )[0];

  describe("a turn's decision, written as its tool is called", () => {
    const decide = (
      turnId: ConversationTurnId,
      decision: ConversationDecision,
    ) => store().recordDecision({ turnId, decision });
    const end = (turnId: ConversationTurnId) =>
      createPostgresConversationCalls(db).endTurnAtomic({
        turnId,
        limitReached: (refusal, toolCallRefused) =>
          conversationTurnLimitReached(
            { outcome: "completed", text: "" },
            refusal,
            toolCallRefused,
          ),
      });
    const rowOf = async (turnId: ConversationTurnId) =>
      (
        await db
          .select({
            state: conversationTurns.state,
            decision: conversationTurns.decision,
            reason: conversationTurns.decisionReason,
            answer: conversationTurns.answerText,
            requesterKind: conversationTurns.requesterKind,
            requesterId: conversationTurns.requesterId,
            limit: conversationTurns.limitReached,
          })
          .from(conversationTurns)
          .where(eq(conversationTurns.id, turnId))
      )[0];
    const effects = async () => {
      const [row] = rowsOf<{ outbox: number; sessions: number; turns: number }>(
        await db.execute(sql`
          SELECT (SELECT count(*)::int FROM slack_outbox) AS outbox,
            (SELECT count(*)::int FROM sessions) AS sessions,
            (SELECT count(*)::int FROM turns) AS turns`),
      );
      return row;
    };
    const read = placeSource({ teamId: TEAM, channelId: "C0OPEN", ts: "41.0" });
    const DECISIONS: ConversationDecision[] = [
      {
        tool: "reply",
        body: "Ask <@U0OTHER>, who owns it.",
        reason: "asked who owns the deploy",
      },
      { tool: "route_to_task", task_id: randomUUID(), reason: "its task's" },
      { tool: "spawn_task", spec: "write the report", reason: "new work" },
      { tool: "no_reply", reason: "people talking to each other" },
    ];

    test("each of the four is the turn's record, with its reason and only a reply's body, and has no effect", async () => {
      const before = await effects();
      for (const decision of DECISIONS) {
        const turn = await leased(open, { sources: [read] });
        expect(await decide(turn.turnId, decision)).toEqual({
          outcome: "recorded",
          state: "decided",
        });
        expect(await rowOf(turn.turnId)).toEqual({
          state: "decided",
          decision: decision.tool,
          reason: decision.reason,
          answer: decision.tool === "reply" ? decision.body : null,
          // The server's value, whoever the reply's body names (G4).
          requesterKind: "user",
          requesterId: userId,
          limit: null,
        });
      }
      // a1: no post, no task, nothing put into a session.
      expect(await effects()).toEqual(before);
    });

    test("the turn's first decision is its record: no other decision, tool call or end changes it, and its end closes the permit", async () => {
      const none = await leased();
      expect((await end(none.turnId)).state).toBe("no_decision");
      expect(
        await decide(none.turnId, DECISIONS[3] as ConversationDecision),
      ).toEqual({ outcome: "turn_not_held" });
      const turn = await leased(open, { sources: [read] });
      const first = DECISIONS[3] as ConversationDecision;
      expect((await decide(turn.turnId, first)).outcome).toBe("recorded");
      expect(
        await decide(turn.turnId, DECISIONS[0] as ConversationDecision),
      ).toEqual({ outcome: "turn_not_held" });
      // No read or decision tool call after the turn's decision.
      expect(await admit(turn)).toEqual({ outcome: "not_holder" });
      const live = (await permitOf(turn.turnId))?.expiresAt.getTime() ?? 0;
      expect(live).toBeGreaterThan(Date.now());
      // Whatever its runtime reports of a decision, the end leaves the record.
      expect(await end(turn.turnId)).toMatchObject({
        ended: "already_ended",
        state: "decided",
      });
      expect(await rowOf(turn.turnId)).toMatchObject({
        state: "decided",
        decision: "no_reply",
        reason: first.reason,
      });
      expect(
        (await permitOf(turn.turnId))?.expiresAt.getTime() ?? 0,
      ).toBeLessThanOrEqual(Date.now());
    });

    test("two decisions of one turn at once: one is written, the other finds the turn ended", async () => {
      const turn = await leased(open, { sources: [read] });
      const both = await Promise.all([
        decide(turn.turnId, DECISIONS[0] as ConversationDecision),
        decide(turn.turnId, DECISIONS[3] as ConversationDecision),
      ]);
      expect(both.map((each) => each.outcome).sort()).toEqual([
        "recorded",
        "turn_not_held",
      ]);
    });

    test("a message the turn read, deleted before its decision is written, voids it (check spot ②)", async () => {
      const gone = placeSource({
        teamId: TEAM,
        channelId: "C0OPEN",
        ts: "42.0",
      });
      const turn = await leased(open, { sources: [read, gone] });
      await db.insert(deletedSources).values({
        workspaceId: ws,
        teamId: TEAM,
        channelId: "C0OPEN",
        ts: "42.0",
        deletedAt: new Date(),
      });
      expect(
        await decide(turn.turnId, DECISIONS[0] as ConversationDecision),
      ).toEqual({ outcome: "recorded", state: "voided_by_delete" });
      expect(await rowOf(turn.turnId)).toMatchObject({
        state: "voided_by_delete",
        decision: null,
        reason: null,
        answer: null,
      });
    });

    test("a turn whose sources overflowed is void on a delete in its channel since it began, and not on one before", async () => {
      await db.insert(deletedSources).values({
        workspaceId: ws,
        teamId: TEAM,
        channelId: "C0OPEN",
        ts: "43.0",
        deletedAt: new Date(),
        markedAt: new Date(Date.now() - 60_000),
      });
      const kept = await leased(open, { sources: [read], overflow: true });
      expect(
        await decide(kept.turnId, DECISIONS[3] as ConversationDecision),
      ).toMatchObject({ state: "decided" });
      const voided = await leased(open, { sources: [read], overflow: true });
      await db.insert(deletedSources).values({
        workspaceId: ws,
        teamId: TEAM,
        channelId: "C0OPEN",
        ts: "44.0",
        deletedAt: new Date(),
      });
      expect(
        await decide(voided.turnId, DECISIONS[3] as ConversationDecision),
      ).toMatchObject({ state: "voided_by_delete" });
    });

    test("no Slack or user path begins a turn as the operator's", async () => {
      const topicId = await topicOf(open);
      expect(() =>
        beginConversationTurn(db, {
          workspaceId: ws,
          agentId,
          conversationId: open,
          topicId,
          requester: { kind: "operator", id: "ops@host" } as never,
          sources: null,
          releaseId: null,
          slackInstallationId: null,
          engagement: null,
        }),
      ).toThrow(RangeError);
      expect(
        rowsOf(
          await db.execute(
            sql`SELECT 1 FROM conversation_turns WHERE topic_id = ${topicId}::uuid`,
          ),
        ),
      ).toEqual([]);
    });
  });

  test("admits the turn its runtime holds under its lease, with the server's place and thread", async () => {
    const turn = await leased();
    const admitted = await admit(turn);
    expect(admitted).toEqual({
      outcome: "admitted",
      turn: {
        turnId: turn.turnId,
        workspaceId: ws,
        agentId,
        conversationId: open,
        topicId: turn.topicId,
        requester: { kind: "user", id: userId },
        slackInstallationId: installationId,
        place: {
          kind: "channel",
          teamId: TEAM,
          channelId: "C0OPEN",
          private: false,
        },
        thread: {
          teamId: TEAM,
          channelId: "C0OPEN",
          ts: expect.stringMatching(/^300\./),
        },
      },
    });
    // A channel no binding names is held private.
    const other = await admit(await leased(unbound));
    expect(other.outcome === "admitted" && other.turn.place).toMatchObject({
      private: true,
    });
  });

  test("another runtime, another lease, an unknown turn or a lease that ran out is not admitted, and not counted", async () => {
    const turn = await leased();
    expect(
      await admit({
        ...turn,
        runtimeId: conversationRuntimeIdSchema.parse(randomUUID()),
      }),
    ).toEqual({ outcome: "not_holder" });
    expect(
      await admit({
        ...turn,
        leaseId: conversationTurnLeaseIdSchema.parse(randomUUID()),
      }),
    ).toEqual({ outcome: "not_holder" });
    expect(
      await admit({
        ...turn,
        turnId: conversationTurnIdSchema.parse(randomUUID()),
      }),
    ).toEqual({ outcome: "unknown_turn" });
    const ran = await leased(open, { leaseMs: -1_000 });
    expect(await admit(ran)).toEqual({ outcome: "lease_expired" });
    expect((await permitOf(turn.turnId))?.toolCalls).toBe(0);
  });

  test("two thread reads a turn, then none; a 429 closes them early", async () => {
    const turn = await leased();
    expect((await admit(turn, "read_thread")).outcome).toBe("admitted");
    expect((await admit(turn, "read_thread")).outcome).toBe("admitted");
    expect(await admit(turn, "read_thread")).toEqual({
      outcome: "thread_read_limit",
    });
    // Another tool still reads.
    expect((await admit(turn, "read_turns")).outcome).toBe("admitted");
    expect(await permitOf(turn.turnId)).toMatchObject({
      toolCalls: 4,
      threadReads: 2,
    });

    const limited = await leased();
    expect((await admit(limited, "read_thread")).outcome).toBe("admitted");
    await store().closeThreadReads(limited.turnId);
    expect(await admit(limited, "read_thread")).toEqual({
      outcome: "thread_read_limit",
    });
  });

  test("the thirteenth tool call is refused and counted, and the turn's end records the server's tool limit", async () => {
    const turn = await leased();
    const outcomes = [];
    for (let n = 0; n < 13; n++) outcomes.push((await admit(turn)).outcome);
    expect(outcomes.slice(0, 12).every((o) => o === "admitted")).toBe(true);
    expect(outcomes[12]).toBe("tool_call_limit");
    expect((await permitOf(turn.turnId))?.toolCalls).toBe(13);

    const ended = await createPostgresConversationCalls(db).endTurnAtomic({
      turnId: turn.turnId,
      limitReached: (refusal, toolCallRefused) =>
        conversationTurnLimitReached(
          { outcome: "completed", text: "answer" },
          refusal,
          toolCallRefused,
        ),
    });
    expect(ended).toMatchObject({
      ended: "recorded",
      limit: { limit: "tool_call_limit", by: "server" },
    });
    const [row] = await db
      .select({
        limitReached: conversationTurns.limitReached,
        by: conversationTurns.limitReachedBy,
      })
      .from(conversationTurns)
      .where(eq(conversationTurns.id, turn.turnId));
    expect(row).toEqual({ limitReached: "tool_call_limit", by: "server" });
  });

  test("what a tool read joins the running turn's direct sources; an ended turn's stay as they ended", async () => {
    const own = placeSource({ teamId: TEAM, channelId: "C0OPEN", ts: "1.0" });
    const read = placeSource({ teamId: TEAM, channelId: "C0OPEN", ts: "2.0" });
    const turn = await leased(open, { sources: [own] });
    await store().addDirectSources(turn.turnId, [read, own]);
    const sourcesOf = async (id: ConversationTurnId) =>
      sourceSetOf(
        (
          await db
            .select({ sources: conversationTurns.sources })
            .from(conversationTurns)
            .where(eq(conversationTurns.id, id))
        )[0]?.sources,
      );
    expect((await sourcesOf(turn.turnId)).direct).toEqual([own, read]);
    await db
      .update(conversationTurns)
      .set({ state: "no_decision", endedAt: new Date() })
      .where(eq(conversationTurns.id, turn.turnId));
    await store().addDirectSources(turn.turnId, [
      placeSource({ teamId: TEAM, channelId: "C0OPEN", ts: "3.0" }),
    ]);
    expect((await sourcesOf(turn.turnId)).direct).toEqual([own, read]);
  });

  test("lists the conversation's ended turns, newest first, leaving out one a deleted message went into", async () => {
    // A conversation of its own: the turns other tests ended are not listed.
    const listing = conversationIdSchema.parse(randomUUID());
    await db.insert(channelContexts).values({
      id: randomUUID(),
      workspaceId: ws,
      teamId: TEAM,
      channelId: "C0LIST",
    });
    await db.insert(conversations).values({
      id: listing,
      workspaceId: ws,
      agentId,
      kind: "channel",
      teamId: TEAM,
      channelId: "C0LIST",
    });
    const turn = await leased(listing);
    const kept = await leased(listing);
    const gone = await leased(listing, {
      sources: [placeSource({ teamId: TEAM, channelId: "C0LIST", ts: "9.0" })],
    });
    const elsewhere = await leased(unbound);
    for (const [ended, at] of [
      [kept, "2026-11-24T01:00:00.000Z"],
      [gone, "2026-11-24T02:00:00.000Z"],
      [elsewhere, "2026-11-24T03:00:00.000Z"],
    ] as const) {
      await db
        .update(conversationTurns)
        .set({
          state: "decided",
          decision: "reply",
          decisionReason: "asked",
          endedAt: new Date(at),
        })
        .where(eq(conversationTurns.id, ended.turnId));
    }
    await db.insert(deletedSources).values({
      workspaceId: ws,
      teamId: TEAM,
      channelId: "C0LIST",
      ts: "9.0",
      deletedAt: new Date(),
    });
    const admitted = await admit(turn);
    if (admitted.outcome !== "admitted") throw new Error(admitted.outcome);
    const records = await store().endedTurns({
      turn: admitted.turn,
      limit: 20,
    });
    expect(records.map((record) => record.turnId)).toEqual([kept.turnId]);
    expect(records[0]).toMatchObject({
      topicId: kept.topicId,
      decision: "reply",
      reason: "asked",
      endedAt: new Date("2026-11-24T01:00:00.000Z"),
    });
    expect(
      await store().deletedAmong(ws, [
        { teamId: TEAM, channelId: "C0LIST", ts: "9.0" },
        { teamId: TEAM, channelId: "C0LIST", ts: "8.0" },
      ]),
    ).toEqual([{ teamId: TEAM, channelId: "C0LIST", ts: "9.0" }]);
  });

  test("open tasks: a turn with no person sees none shared only with people; ended ones are not listed", async () => {
    const turn = await leased();
    const admitted = await admit(turn);
    if (admitted.outcome !== "admitted") throw new Error(admitted.outcome);
    const ids = {
      workspace: randomUUID(),
      mine: randomUUID(),
      ended: randomUUID(),
    };
    for (const id of Object.values(ids)) {
      await db.insert(sessions).values({
        id,
        ownerId: ws,
        workspaceId: ws,
        repoUrl: "https://example.invalid/repo.git",
        branch: "main",
        createdByUserId: userId,
        parentConversationId: open,
      });
    }
    await db
      .update(sessions)
      .set({ status: ENDED_SESSION_STATUSES[0] })
      .where(eq(sessions.id, ids.ended));
    await db.insert(sessionShares).values({
      sessionId: ids.mine,
      ownerId: ws,
      workspaceId: ws,
      scope: "private",
    });
    const listed = async (
      viewer: Parameters<ReturnType<typeof store>["openTasks"]>[0]["viewer"],
    ) =>
      (await store().openTasks({ turn: admitted.turn, viewer, limit: 20 }))
        .map((task) => task.sessionId)
        .sort();
    expect(await listed(null)).toEqual([ids.workspace]);
    expect(
      await listed({ userId, apiKeyId: null, privateChannels: [] }),
    ).toEqual([ids.workspace, ids.mine].sort());
  });

  test("open tasks: a made title comes with its first turn's sources; past its list it is withheld", async () => {
    const turn = await leased();
    const admitted = await admit(turn);
    if (admitted.outcome !== "admitted") throw new Error(admitted.outcome);
    const asked = at("701.000001");
    const made = (overflow: boolean) =>
      storedSourceSet({
        direct: [placeSource(asked)],
        inherited: [],
        overflow,
      });
    const ids = {
      derived: randomUUID(),
      overflowed: randomUUID(),
      given: randomUUID(),
    };
    for (const [id, titleSource, sources] of [
      [ids.derived, "derived", made(false)],
      [ids.overflowed, "derived", made(true)],
      [ids.given, "user", made(false)],
    ] as const) {
      await db.insert(sessions).values({
        id,
        ownerId: ws,
        workspaceId: ws,
        repoUrl: "https://example.invalid/repo.git",
        branch: "main",
        createdByUserId: userId,
        parentConversationId: open,
        title: `title ${titleSource}`,
        titleSource,
      });
      await db.insert(schema.turns).values({
        sessionId: id,
        sequence: 1,
        message: "the ask",
        status: "queued",
        sources,
      });
    }
    const tasks = new Map(
      (
        await store().openTasks({
          turn: admitted.turn,
          viewer: null,
          limit: 20,
        })
      ).map((task) => [task.sessionId, task]),
    );
    expect(tasks.get(ids.derived)).toMatchObject({
      title: "title derived",
      titleSources: [placeSource(asked)],
    });
    expect(tasks.get(ids.overflowed)).toMatchObject({
      title: null,
      titleSources: [],
    });
    // A title a person gave came from no message.
    expect(tasks.get(ids.given)).toMatchObject({
      title: "title user",
      titleSources: [],
    });
  });

  test("the topic's previous turn: the newest other one, with what its tools added", async () => {
    const first = await leased();
    const store_ = store();
    const ask = { workspaceId: ws, topicId: first.topicId };
    expect(await store_.previousTurn({ ...ask, turnId: first.turnId })).toBe(
      null,
    );
    const read = placeSource(at("702.000001"));
    await store_.addDirectSources(first.turnId, [read]);
    const second = conversationTurnIdSchema.parse(randomUUID());
    await db.insert(conversationTurns).values({
      id: second,
      workspaceId: ws,
      agentId,
      conversationId: open,
      topicId: first.topicId,
      origin: "m2",
      state: "running",
      requesterKind: "user",
      requesterId: userId,
      createdAt: new Date(Date.now() + 1_000),
    });
    expect(await store_.previousTurn({ ...ask, turnId: second })).toEqual({
      turnId: first.turnId,
      ended: false,
      sources: [read],
      overflow: false,
    });
    await db
      .update(conversationTurns)
      .set({ state: "no_decision", endedAt: new Date() })
      .where(eq(conversationTurns.id, first.turnId));
    expect((await store_.previousTurn({ ...ask, turnId: second }))?.ended).toBe(
      true,
    );
    // From the first turn's side, the newer one is the topic's other turn.
    expect(
      (await store_.previousTurn({ ...ask, turnId: first.turnId }))?.turnId,
    ).toBe(second);
  });
});
