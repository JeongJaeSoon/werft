import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationId,
  type ConversationTopicId,
  type ConversationTurnId,
  conversationIdSchema,
} from "@werft-ai/contracts";
import type {
  ConversationToolTurn,
  PendingConversationRoute,
  SessionViewer,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { sessionVisibleTo } from "../musterrolle/index.ts";
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
import { rowsOf } from "../statement-rows.ts";
import { createPostgresConversationRoutes } from "../surface/conversation-routes.ts";
import { makeFixtureRelease, sessionPinColumns } from "../testing/spec-pins.ts";
import { createPostgresConversationReadToolStore } from "./conversation-read-tools.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";
import { adoptSessionParent } from "./session-parents.ts";

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
});
