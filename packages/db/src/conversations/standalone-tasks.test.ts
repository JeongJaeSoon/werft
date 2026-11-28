import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationId,
  type ConversationTopicId,
  type ConversationTurnId,
  conversationIdSchema,
  TASK_CLOSING_DEFAULT,
  TASK_LIMITS_DEFAULT,
  TASK_OPEN_LIMIT_PER_AGENT,
  TASK_OPEN_LIMIT_PER_CONVERSATION,
  type TaskClosing,
} from "@werft-ai/contracts";
import type {
  ConversationToolTurn,
  PendingConversationRoute,
  SessionViewer,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { sessionVisibleTo } from "../access-control/index.ts";
import {
  APPEND_MESSAGE,
  conversationTurnInputScope,
} from "../postgres-unit-of-work.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import {
  agentReleases,
  memberships,
  sessionLinks,
  sessionShares,
  sessions,
  slackInstallations,
  surfaceBindings,
  turns,
  users,
} from "../schema.ts";
import { createPostgresTaskCloses } from "../sessions/task-close.ts";
import { openTaskLimit } from "../sessions/task-open.ts";
import { rowsOf } from "../statement-rows.ts";
import { createPostgresConversationRoutes } from "../surface/conversation-routes.ts";
import { makeFixtureRelease, sessionPinColumns } from "../testing/spec-pins.ts";
import { createPostgresConversationReadToolStore } from "./conversation-read-tools.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";
import { adoptSessionParent } from "./session-parents.ts";
import { syncHandOffClosing } from "./standalone-tasks.ts";

const TEAM = "T0DM3";
const SECRET = { current: new Uint8Array(32) } as never;

describe("a DM person's standalone sessions (v1-b/DM3)", () => {
  let client: PGlite;
  let db: Database;
  const ws = randomUUID();
  const person = randomUUID();
  const other = randomUUID();
  const installationId = randomUUID();
  const dmBinding = randomUUID();
  let agentId: string;
  let release: string;
  let otherRelease: string;
  let dm: ConversationId;
  let otherDm: ConversationId;
  let channel: ConversationId;
  let thread = 0;

  beforeAll(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    release = await makeFixtureRelease(db, { workspaceId: ws });
    otherRelease = await makeFixtureRelease(db, { workspaceId: ws });
    const [row] = await db
      .select({ agentId: agentReleases.agentId })
      .from(agentReleases)
      .where(eq(agentReleases.id, release));
    agentId = row?.agentId as string;
    for (const id of [person, other]) {
      await db.insert(users).values({
        id,
        email: `${id}@example.invalid`,
        passwordHash: "argon2id$placeholder",
        displayName: "person",
      });
      await db
        .insert(memberships)
        .values({ workspaceId: ws, userId: id, role: "member" });
    }
    await db.insert(slackInstallations).values({
      id: installationId,
      workspaceId: ws,
      appId: "A0DM3",
      teamId: TEAM,
    });
    await db.insert(surfaceBindings).values({
      id: dmBinding,
      workspaceId: ws,
      agentId,
      surface: "slack",
      installationId,
      surfaceKind: "dm",
      mode: "on",
      ceilingActions: [],
      ceilingDisclosure: "summary",
    });
    const store = createPostgresConversationStore(db);
    const dmOf = async (personUserId: string) =>
      conversationIdSchema.parse(
        (
          await store.findOrCreateConversation({
            kind: "dm",
            workspaceId: ws,
            agentId,
            personUserId,
          })
        ).id,
      );
    dm = await dmOf(person);
    otherDm = await dmOf(other);
    channel = conversationIdSchema.parse(
      (
        await store.findOrCreateConversation({
          kind: "channel",
          workspaceId: ws,
          agentId,
          teamId: TEAM,
          channelId: "C0DM3",
        })
      ).id,
    );
  }, 60_000);

  afterAll(() => client.close());

  async function session(
    options: {
      by?: string;
      release?: string;
      parent?: ConversationId;
      preview?: boolean;
      share?: "private" | "workspace";
    } = {},
  ) {
    const id = randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: ws,
      workspaceId: ws,
      repoUrl: "https://example.invalid/repo.git",
      branch: "main",
      createdByUserId: options.by ?? person,
      agentReleaseId: options.release ?? release,
      ...(options.parent === undefined
        ? {}
        : { parentConversationId: options.parent }),
      preview: options.preview ?? false,
      ...sessionPinColumns(),
    });
    await db.insert(sessionShares).values({
      sessionId: id,
      ownerId: ws,
      workspaceId: ws,
      scope: options.share ?? "private",
    });
    return id;
  }

  const toolTurn = (
    conversationId: ConversationId,
    place: ConversationToolTurn["place"],
    requester = person,
  ): ConversationToolTurn => ({
    turnId: randomUUID() as ConversationTurnId,
    workspaceId: ws,
    agentId,
    conversationId,
    topicId: randomUUID() as ConversationTopicId,
    requester: { kind: "user", id: requester },
    slackInstallationId: installationId,
    place,
    thread: null,
  });

  const listed = async (turn: ConversationToolTurn, viewerId = person) =>
    (
      await createPostgresConversationReadToolStore(db).openTasks({
        turn,
        viewer: { userId: viewerId, apiKeyId: null, privateChannels: [] },
        limit: 20,
      })
    ).map((task) => task.sessionId);

  const route = (
    sessionId: string,
    options: { requester?: string; dm?: boolean } = {},
  ): PendingConversationRoute => {
    thread += 1;
    const threadTs = `500.${String(thread).padStart(6, "0")}`;
    return {
      turnId: randomUUID() as ConversationTurnId,
      workspaceId: ws,
      agentId,
      conversationId: options.dm === false ? channel : dm,
      topicId: randomUUID() as ConversationTopicId,
      sessionId,
      thread: {
        installationId,
        slackAppId: null,
        teamId: TEAM,
        channelId: options.dm === false ? "C0DM3" : "D0DM3",
        threadTs,
        messageTs: threadTs,
      },
      requesterUserId: options.requester ?? person,
      subject: null,
      sources: null,
      dm:
        options.dm === false
          ? null
          : { personUserId: person, surfaceBindingId: dmBinding },
    };
  };

  const routes = () => createPostgresConversationRoutes(db, SECRET);
  const parentOf = async (id: string) =>
    (
      await db
        .select({ parent: sessions.parentConversationId })
        .from(sessions)
        .where(eq(sessions.id, id))
    )[0]?.parent;
  const openLinks = async (id: string) =>
    rowsOf<{ channel_id: string; thread_id: string; opened_by_ts: string }>(
      await db.execute(sql`
        SELECT channel_id, thread_id, opened_by_ts FROM session_links
        WHERE session_id = ${id}::uuid AND closed_at IS NULL`),
    );

  test("G1: the person's DM lists their standalone sessions; another person's, a channel's, a key's, a preview's and another agent's are not", async () => {
    const mine = await session();
    const theirs = await session({ by: other });
    const otherAgent = await session({ release: otherRelease });
    const preview = await session({ preview: true });
    const ended = await session();
    await db
      .update(sessions)
      .set({ status: "stopped" })
      .where(eq(sessions.id, ended));
    // A session ever linked is not standalone, parent or not: a revoked
    // link, or a closed one.
    const linked = async (
      link: { revokedAt: Date } | { closedAt: Date; closedReason: "completed" },
    ) => {
      const id = await session();
      await db.insert(sessionLinks).values({
        id: randomUUID(),
        workspaceId: ws,
        ownerId: ws,
        sessionId: id,
        installationId,
        surfaceBindingId: dmBinding,
        surfaceRef: `D0DM3:${id}`,
        channelId: "D0DM3",
        threadId: "9.0",
        openedByTs: "9.0",
        agentId,
        releaseId: release,
        ...link,
      });
      return id;
    };
    const revoked = await linked({ revokedAt: new Date() });
    const closed = await linked({
      closedAt: new Date(),
      closedReason: "completed",
    });
    const inDm = await listed(
      toolTurn(dm, { kind: "dm", personUserId: person }),
    );
    expect(inDm).toContain(mine);
    for (const id of [theirs, otherAgent, preview, ended, revoked, closed]) {
      expect(inDm).not.toContain(id);
    }
    // The other person's DM: their own, never this person's.
    const theirDm = await listed(
      toolTurn(otherDm, { kind: "dm", personUserId: other }, other),
      other,
    );
    expect(theirDm).toContain(theirs);
    expect(theirDm).not.toContain(mine);
    // A channel's main conversation never sees a standalone session.
    const inChannel = await listed(
      toolTurn(channel, {
        kind: "channel",
        teamId: TEAM,
        channelId: "C0DM3",
        private: false,
      }),
    );
    expect(inChannel).not.toContain(mine);
    // Someone else's turn in the person's DM sees none of the person's.
    expect(
      await listed(
        toolTurn(dm, { kind: "dm", personUserId: person }, other),
        other,
      ),
    ).not.toContain(mine);
  });

  test("G3: the effect finds a standalone session for the DM's own person alone", async () => {
    const mine = await session();
    const theirs = await session({ by: other });
    expect(await routes().openTask(route(mine))).toEqual({
      kind: "standalone",
    });
    expect(await routes().openTask(route(theirs))).toBe(null);
    expect(await routes().openTask(route(mine, { requester: other }))).toBe(
      null,
    );
    expect(await routes().openTask(route(mine, { dm: false }))).toBe(null);
  });

  test("binding links the DM thread and adopts the DM as parent; the thread is the task's then", async () => {
    const mine = await session();
    const r = route(mine);
    expect(await routes().bindStandalone(r)).toBe("bound");
    expect(await parentOf(mine)).toBe(dm);
    expect(await openLinks(mine)).toEqual([
      {
        channel_id: "D0DM3",
        thread_id: r.thread.threadTs,
        opened_by_ts: r.thread.messageTs,
      },
    ]);
    expect(await routes().openTask(r)).toEqual({
      kind: "linked",
      channelId: "D0DM3",
      threadTs: r.thread.threadTs,
      openedByTs: r.thread.messageTs,
    });
    // The same turn again (a run beside this one, or after a crash): its
    // own bind, not a second one. Another turn finds it no longer standalone.
    expect(await routes().bindStandalone(r)).toBe("bound");
    expect(await openLinks(mine)).toHaveLength(1);
    expect(await routes().bindStandalone(route(mine))).toBe("gone");
  });

  test("a thread another session holds is not taken, and nothing of the bind stays", async () => {
    const first = await session();
    const second = await session();
    const r = route(first);
    expect(await routes().bindStandalone(r)).toBe("bound");
    expect(await routes().bindStandalone({ ...r, sessionId: second })).toBe(
      "thread_taken",
    );
    expect(await parentOf(second)).toBe(null);
    expect(await openLinks(second)).toEqual([]);
  });

  test("an unhanded end takes the link and the parent back, unless an input went in by it", async () => {
    const mine = await session();
    const r = route(mine);
    expect(await routes().bindStandalone(r)).toBe("bound");
    // No turn row here: recorded by no run, the bind is still taken back.
    await routes().settle(r, "failed", null, null);
    expect(await openLinks(mine)).toEqual([]);
    expect(await parentOf(mine)).toBe(null);

    // Another message's input went in by the link meanwhile: it stays.
    const used = await session();
    const u = route(used);
    expect(await routes().bindStandalone(u)).toBe("bound");
    await db.insert(turns).values({
      sessionId: used,
      sequence: 1,
      message: "a reply in the DM thread",
      status: "queued",
    });
    await routes().settle(u, "failed", null, null);
    expect(await openLinks(used)).toHaveLength(1);

    const handed = await session();
    const h = route(handed);
    expect(await routes().bindStandalone(h)).toBe("bound");
    const receipt = randomUUID();
    await db.execute(sql`
      INSERT INTO receipts (id, owner_id, operation, target_ref)
      VALUES (${receipt}::uuid, ${ws}, ${APPEND_MESSAGE}, '{}'::jsonb)`);
    await db.execute(sql`
      INSERT INTO idempotency_keys (principal, operation, resource, key,
        payload_hash, receipt_id)
      VALUES (${ws}, ${APPEND_MESSAGE}, ${conversationTurnInputScope(handed)},
        ${h.turnId}, 'x', ${receipt}::uuid)`);
    await routes().settle(h, "refused", null, null);
    expect(await openLinks(handed)).toHaveLength(1);
    // A channel route never takes a link back.
    const channelLinked = await session();
    const c = route(channelLinked);
    expect(await routes().bindStandalone(c)).toBe("bound");
    await routes().settle({ ...c, dm: null }, "failed", null, null);
    expect(await openLinks(channelLinked)).toHaveLength(1);
    expect(await parentOf(handed)).toBe(dm);
  });

  test("a parent is adopted once: the same one is kept, another is never overwritten", async () => {
    const key = {
      kind: "dm" as const,
      workspaceId: ws,
      agentId,
      personUserId: person,
    };
    const fresh = await session();
    expect(await adoptSessionParent(db, fresh, key)).toBe("set");
    expect(await adoptSessionParent(db, fresh, key)).toBe("kept");
    const elsewhere = await session({ parent: channel });
    expect(await adoptSessionParent(db, elsewhere, key)).toBe("other");
    expect(await parentOf(elsewhere)).toBe(channel);
  });

  test("the DM parent sees no one new: the same people see a bound session as before", async () => {
    const privateOne = await session({ share: "private" });
    const visibleTo = async (userId: string) => {
      const viewer: SessionViewer = {
        userId,
        apiKeyId: null,
        privateChannels: [],
      };
      return (
        rowsOf<{ id: string }>(
          await db.execute(sql`
            SELECT sessions.id FROM sessions
            WHERE sessions.id = ${privateOne}::uuid
              AND ${sessionVisibleTo(db, viewer)}`),
        ).length === 1
      );
    };
    const before = [await visibleTo(person), await visibleTo(other)];
    expect(await routes().bindStandalone(route(privateOne))).toBe("bound");
    expect([await visibleTo(person), await visibleTo(other)]).toEqual(before);
    expect(before).toEqual([true, false]);
  });
  // 94S-2585: a hand-off's session is a task of the DM, under the closing
  // rules the DM's own tasks get.
  const closingOf = async (id: string) =>
    (
      await db
        .select({ closing: sessions.taskClosing })
        .from(sessions)
        .where(eq(sessions.id, id))
    )[0]?.closing;

  /** The route_to_task turn a hand-off of `r` settled routed, as written. */
  async function routedTurn(
    r: PendingConversationRoute,
    effect: "routed" | "voided" | null = "routed",
  ) {
    await db.execute(sql`
      INSERT INTO conversation_turns (id, workspace_id, agent_id,
        conversation_id, origin, state, requester_kind, requester_id,
        decision, routed_session_id, task_effect, slack_installation_id,
        ended_at)
      VALUES (${r.turnId}::uuid, ${ws}::uuid, ${agentId}::uuid,
        ${r.conversationId}::uuid, 'm2', 'decided', 'user',
        ${r.requesterUserId}, 'route_to_task', ${r.sessionId}::uuid,
        ${effect}, ${installationId}::uuid, now())`);
    await db.execute(sql`
      INSERT INTO conversation_engagements (workspace_id, agent_id, team_id,
        channel_id, ts, kind, conversation_turn_id)
      VALUES (${ws}::uuid, ${agentId}::uuid, ${TEAM}, ${r.thread.channelId},
        ${r.thread.messageTs}, 'mention', ${r.turnId}::uuid)`);
  }

  test("a bind gives the session the closing rules of the DM's tasks, and keeps rules already there", async () => {
    const mine = await session();
    expect(await closingOf(mine)).toBe(null);
    expect(await routes().bindStandalone(route(mine))).toBe("bound");
    expect(await closingOf(mine)).toEqual(TASK_CLOSING_DEFAULT);

    const own: TaskClosing = {
      eventRules: false,
      idleDays: 30,
      quietAfterLimitDays: 30,
    };
    const ruled = await session();
    await db
      .update(sessions)
      .set({ taskClosing: own })
      .where(eq(sessions.id, ruled));
    expect(await routes().bindStandalone(route(ruled))).toBe("bound");
    expect(await closingOf(ruled)).toEqual(own);

    // A bind refused writes none.
    const taken = await session();
    const r = route(taken);
    const holder = await session();
    expect(await routes().bindStandalone({ ...r, sessionId: holder })).toBe(
      "bound",
    );
    expect(await routes().bindStandalone(r)).toBe("thread_taken");
    expect(await closingOf(taken)).toBe(null);
  });

  test("an unhanded end takes the closing rules back with the parent; a kept bind keeps them", async () => {
    const mine = await session();
    const r = route(mine);
    expect(await routes().bindStandalone(r)).toBe("bound");
    await routes().settle(r, "voided", null, null);
    expect(await parentOf(mine)).toBe(null);
    expect(await closingOf(mine)).toBe(null);
    // Standalone again, and a task of no one.
    expect(await routes().openTask(route(mine))).toEqual({
      kind: "standalone",
    });

    const used = await session();
    const u = route(used);
    expect(await routes().bindStandalone(u)).toBe("bound");
    await db.insert(turns).values({
      sessionId: used,
      sequence: 1,
      message: "a reply in the DM thread",
      status: "queued",
    });
    await routes().settle(u, "failed", null, null);
    expect(await closingOf(used)).toEqual(TASK_CLOSING_DEFAULT);
  });

  test("the reconciler fills a routed hand-off left without rules and nothing else; it clears one taken back without them", async () => {
    // Bound by an image that wrote no rules, its turn settled routed.
    const old = await session();
    const o = route(old);
    expect(await routes().bindStandalone(o)).toBe("bound");
    await db
      .update(sessions)
      .set({ taskClosing: null })
      .where(eq(sessions.id, old));
    await routedTurn(o);
    // Bound alike, its turn voided, the bind kept (an input went in by it):
    // the DM's task all the same.
    const voided = await session();
    const v = route(voided);
    expect(await routes().bindStandalone(v)).toBe("bound");
    await db
      .update(sessions)
      .set({ taskClosing: null })
      .where(eq(sessions.id, voided));
    await routedTurn(v, "voided");
    // Bound alike, its turn not ended yet: its own run writes them.
    const inFlight = await session();
    const f = route(inFlight);
    expect(await routes().bindStandalone(f)).toBe("bound");
    await db
      .update(sessions)
      .set({ taskClosing: null })
      .where(eq(sessions.id, inFlight));
    await routedTurn(f, null);
    // A DM thread's session no hand-off made: linked, parented, no rules.
    const dmSession = await session({ parent: dm });
    await db.insert(sessionLinks).values({
      id: randomUUID(),
      workspaceId: ws,
      ownerId: ws,
      sessionId: dmSession,
      installationId,
      surfaceBindingId: dmBinding,
      surfaceRef: `D0DM3:${dmSession}`,
      channelId: "D0DM3",
      threadId: "7.0",
      openedByTs: "7.0",
      agentId,
      releaseId: release,
    });
    // A standalone session never handed to, and a task the DM opened.
    const untouched = await session();
    const own: TaskClosing = {
      eventRules: false,
      idleDays: 5,
      quietAfterLimitDays: 5,
    };
    const dmTask = await session({ parent: dm });
    await db
      .update(sessions)
      .set({
        taskClosing: own,
        taskInterpretation: {
          goal: "g",
          doneWhen: "d",
          limits: { ...TASK_LIMITS_DEFAULT },
        },
      })
      .where(eq(sessions.id, dmTask));
    // Rules and an interpretation, no parent and no link: a task as opened,
    // never a hand-off's.
    const unparented = await session();
    await db
      .update(sessions)
      .set({
        taskClosing: own,
        taskInterpretation: {
          goal: "g",
          doneWhen: "d",
          limits: { ...TASK_LIMITS_DEFAULT },
        },
      })
      .where(eq(sessions.id, unparented));
    // Taken back by an image that left its rules: no parent, no link.
    const takenBack = await session();
    await db
      .update(sessions)
      .set({ taskClosing: TASK_CLOSING_DEFAULT })
      .where(eq(sessions.id, takenBack));

    expect(
      await syncHandOffClosing(db, { dryRun: true, limit: 100 }),
    ).toMatchObject({ filled: 2 });
    expect(await closingOf(old)).toBe(null);
    const synced = await syncHandOffClosing(db, { dryRun: false, limit: 100 });
    expect(synced.filled).toBe(2);
    expect(synced.cleared).toBeGreaterThanOrEqual(1);
    expect(await closingOf(old)).toEqual(TASK_CLOSING_DEFAULT);
    expect(await closingOf(voided)).toEqual(TASK_CLOSING_DEFAULT);
    expect(await closingOf(inFlight)).toBe(null);
    expect(await closingOf(dmSession)).toBe(null);
    expect(await closingOf(untouched)).toBe(null);
    expect(await closingOf(dmTask)).toEqual(own);
    expect(await closingOf(unparented)).toEqual(own);
    expect(await closingOf(takenBack)).toBe(null);
    // Once each: the next pass finds nothing.
    expect(await syncHandOffClosing(db, { dryRun: false, limit: 100 })).toEqual(
      { filled: 0, cleared: 0 },
    );
  });

  test("a handed session is a task the time rules and its pull request close", async () => {
    const idle = await session();
    expect(await routes().bindStandalone(route(idle))).toBe("bound");
    const merged = await session();
    expect(await routes().bindStandalone(route(merged))).toBe("bound");
    // Paused: closeAtomic closes it with no drain. Idle past the 14 days.
    await db.execute(sql`
      UPDATE sessions SET admission_state = 'paused',
        created_at = now() - interval '15 days'
      WHERE id IN (${idle}::uuid, ${merged}::uuid)`);
    await db.execute(sql`
      UPDATE session_links SET created_at = now() - interval '15 days'
      WHERE session_id = ${idle}::uuid`);
    await db.execute(sql`UPDATE sessions SET created_at = now()
      WHERE id = ${merged}::uuid`);
    await db.execute(sql`
      INSERT INTO session_outcomes (id, owner_id, session_id, type, url,
        external_id, state, state_changed_at)
      VALUES (gen_random_uuid(), ${ws}, ${merged}::uuid, 'github_pull_request',
        'https://github.com/acme/app/pull/1', '1', 'merged', now())`);
    const closes = createPostgresTaskCloses(db);
    expect(await closes.closeOnPullRequests(100)).toBe(1);
    expect(await closes.closeOnTimeRules(100)).toBe(1);
    const reasons = rowsOf<{ id: string; reason: string | null }>(
      await db.execute(sql`
        SELECT id, task_closed_reason AS reason FROM sessions
        WHERE id IN (${idle}::uuid, ${merged}::uuid)`),
    );
    expect(
      Object.fromEntries(reasons.map((row) => [row.id, row.reason])),
    ).toEqual({ [idle]: "abandoned", [merged]: "completed" });
    // Its requester's close is a task's too.
    const asked = await session();
    expect(await routes().bindStandalone(route(asked))).toBe("bound");
    await db
      .update(sessions)
      .set({ admissionState: "paused" })
      .where(eq(sessions.id, asked));
    expect(
      await closes.close({
        principal: { ownerId: ws },
        sessionId: asked,
        reason: "completed",
      }),
    ).toBe("closed");
  });

  test("a pull request settled before the hand-off closes nothing; one settled after it does, and a DM's task counts its own as before", async () => {
    const pr = async (
      sessionId: string,
      n: string,
      state: "open" | "merged" | "closed",
      at: string,
    ) =>
      db.execute(sql`
        INSERT INTO session_outcomes (id, owner_id, session_id, type, url,
          external_id, state, state_changed_at, merged_at, closed_at)
        VALUES (gen_random_uuid(), ${ws}, ${sessionId}::uuid,
          'github_pull_request', ${`https://github.com/acme/app/pull/${n}`},
          ${n}, ${state}, ${at}::timestamptz,
          ${state === "merged" ? at : null}::timestamptz,
          ${state === "open" ? null : at}::timestamptz)`);
    const before = new Date(Date.now() - 60_000).toISOString();
    // Past the link by a second: the clock it is read on is the database's.
    const later = () => new Date(Date.now() + 1000).toISOString();
    const handed = await session();
    await pr(handed, "10", "merged", before);
    // An open one from before holds a later close back as a cancel.
    const held = await session();
    await pr(held, "20", "open", before);
    for (const id of [handed, held]) {
      expect(await routes().bindStandalone(route(id))).toBe("bound");
    }
    await db.execute(sql`
      UPDATE sessions SET admission_state = 'paused'
      WHERE id IN (${handed}::uuid, ${held}::uuid)`);
    const closes = createPostgresTaskCloses(db);
    expect(await closes.closeOnPullRequests(100)).toBe(0);
    await pr(held, "21", "closed", later());
    expect(await closes.closeOnPullRequests(100)).toBe(0);
    await pr(handed, "11", "merged", later());
    expect(await closes.closeOnPullRequests(100)).toBe(1);
    const reasonOf = async (id: string) =>
      (
        await db
          .select({ reason: sessions.taskClosedReason })
          .from(sessions)
          .where(eq(sessions.id, id))
      )[0]?.reason;
    expect(await reasonOf(handed)).toBe("completed");
    expect(await reasonOf(held)).toBe(null);

    // Seen late: merged on GitHub before the hand-off, saved after it.
    const late = await session();
    expect(await routes().bindStandalone(route(late))).toBe("bound");
    await db.execute(sql`
      INSERT INTO session_outcomes (id, owner_id, session_id, type, url,
        external_id, state, state_changed_at, merged_at)
      VALUES (gen_random_uuid(), ${ws}, ${late}::uuid, 'github_pull_request',
        'https://github.com/acme/app/pull/40', '40', 'merged', now(),
        ${before}::timestamptz)`);
    // Closed on GitHub after the hand-off, its state saved before it.
    const reclosed = await session();
    expect(await routes().bindStandalone(route(reclosed))).toBe("bound");
    await db.execute(sql`
      INSERT INTO session_outcomes (id, owner_id, session_id, type, url,
        external_id, state, state_changed_at, closed_at)
      VALUES (gen_random_uuid(), ${ws}, ${reclosed}::uuid,
        'github_pull_request', 'https://github.com/acme/app/pull/41', '41',
        'closed', ${before}::timestamptz, now())`);
    await db.execute(sql`
      UPDATE sessions SET admission_state = 'paused',
        task_closing = ${JSON.stringify(TASK_CLOSING_DEFAULT)}::jsonb
      WHERE id IN (${late}::uuid, ${reclosed}::uuid)`);
    // Reopened from the session, not refreshed yet: closed, no close time.
    const reopened = await session();
    expect(await routes().bindStandalone(route(reopened))).toBe("bound");
    await db.execute(sql`
      INSERT INTO session_outcomes (id, owner_id, session_id, type, url,
        external_id, state, state_changed_at, closed_at)
      VALUES (gen_random_uuid(), ${ws}, ${reopened}::uuid,
        'github_pull_request', 'https://github.com/acme/app/pull/42', '42',
        'closed', now(), NULL)`);
    await db.execute(sql`
      UPDATE sessions SET admission_state = 'paused'
      WHERE id = ${reopened}::uuid`);
    expect(await closes.closeOnPullRequests(100)).toBe(1);
    expect(await reasonOf(reopened)).toBe(null);
    expect(await reasonOf(late)).toBe(null);
    expect(await reasonOf(reclosed)).toBe("cancelled");

    // A DM's task counts every one of its pull requests, its link or not.
    const dmTask = await session({ parent: dm });
    await db.insert(sessionLinks).values({
      id: randomUUID(),
      workspaceId: ws,
      ownerId: ws,
      sessionId: dmTask,
      installationId,
      surfaceBindingId: dmBinding,
      surfaceRef: `D0DM3:${dmTask}`,
      channelId: "D0DM3",
      threadId: "8.0",
      openedByTs: "8.0",
      agentId,
      releaseId: release,
      createdAt: new Date(),
    });
    await db
      .update(sessions)
      .set({
        admissionState: "paused",
        taskClosing: TASK_CLOSING_DEFAULT,
        taskInterpretation: {
          goal: "g",
          doneWhen: "d",
          limits: { ...TASK_LIMITS_DEFAULT },
        },
      })
      .where(eq(sessions.id, dmTask));
    await pr(dmTask, "30", "closed", before);
    expect(await closes.closeOnPullRequests(100)).toBe(1);
    expect(await reasonOf(dmTask)).toBe("cancelled");
  });

  test("a hand-off taken back after the pull request pass chose it is not closed", async () => {
    const taken = await session();
    const r = route(taken);
    expect(await routes().bindStandalone(r)).toBe("bound");
    await db
      .update(sessions)
      .set({ admissionState: "paused" })
      .where(eq(sessions.id, taken));
    await db.execute(sql`
      INSERT INTO session_outcomes (id, owner_id, session_id, type, url,
        external_id, state, state_changed_at)
      VALUES (gen_random_uuid(), ${ws}, ${taken}::uuid, 'github_pull_request',
        'https://github.com/acme/app/pull/2', '2', 'merged', now())`);
    let dropped = false;
    // The close read the session as a task; before it takes the session's
    // lock, the hand-off's end takes it back.
    const racing = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== "transaction") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: Parameters<Database["transaction"]>) => {
          if (!dropped) {
            dropped = true;
            await routes().settle(r, "failed", null, null);
          }
          return target.transaction(...args);
        };
      },
    });
    expect(
      await createPostgresTaskCloses(racing).closeOnPullRequests(100),
    ).toBe(0);
    expect(dropped).toBe(true);
    expect(await closingOf(taken)).toBe(null);
    const [row] = await db
      .select({ admission: sessions.admissionState })
      .from(sessions)
      .where(eq(sessions.id, taken));
    expect(row?.admission).toBe("paused");
  });

  test("handed sessions count as the DM's open tasks: a hand-off goes past the limit, a new task then is refused", async () => {
    const limited = await createPostgresConversationStore(
      db,
    ).findOrCreateConversation({
      kind: "dm",
      workspaceId: ws,
      agentId,
      personUserId: other,
    });
    const limits = {
      conversation: TASK_OPEN_LIMIT_PER_CONVERSATION,
      agent: TASK_OPEN_LIMIT_PER_AGENT,
    };
    const atLimit = () =>
      db.transaction((tx) =>
        openTaskLimit(tx, {
          releaseId: release,
          conversationId: limited.id,
          limits,
        }),
      );
    // The other person's DM: tasks of the agent's other tests count toward
    // the agent's limit, so it is read by the conversation alone.
    const before = await atLimit();
    expect(before === null || before === "agent").toBe(true);
    const handOff = (sessionId: string): PendingConversationRoute => {
      const r = route(sessionId, { requester: other });
      return {
        ...r,
        conversationId: conversationIdSchema.parse(limited.id),
        dm: { personUserId: other, surfaceBindingId: dmBinding },
      };
    };
    for (let n = 0; n < TASK_OPEN_LIMIT_PER_CONVERSATION + 1; n++) {
      const id = await session({ by: other });
      expect(await routes().bindStandalone(handOff(id))).toBe("bound");
    }
    const open = rowsOf<{ n: number }>(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM sessions
        WHERE parent_conversation_id = ${limited.id}::uuid
          AND task_closing IS NOT NULL`),
    );
    expect(open[0]?.n).toBe(TASK_OPEN_LIMIT_PER_CONVERSATION + 1);
    expect(await atLimit()).toBe("conversation");
  });
});
