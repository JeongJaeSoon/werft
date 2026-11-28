import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  enqueueModelCutNotices,
  enqueueSessionModelMoveNotices,
} from "./access-control/model-cut-notices.ts";
import type { Database } from "./queries.ts";
import { createPostgresSchedulerStore } from "./scheduler/scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  agentAdmins,
  agentReleases,
  agents,
  attempts,
  events,
  linkedAccounts,
  memberships,
  memberTeams,
  sessionLinks,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
  unassignedSessions,
  users,
  workspaces,
} from "./schema.ts";
import { holdIncompatibleBeforeLaunch } from "./sessions/restore-failures.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
} from "./testing/spec-pins.ts";
import {
  createPostgresWorkerUnitOfWork,
  moveSessionsToSuccessors,
} from "./worker-unit-of-work.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  // The rows seeded below are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

const NOW = new Date("2026-11-09T00:00:00Z");
const CHANNEL = "C0WORK";
const THREAD = "1700000000.000100";

type Person = {
  userId: string;
  slackUserId: string;
};

/**
 * One agent with a Slack app installed in team T1, one session of it, and a
 * way to add people: each gets a membership, a user (with a locale) and a
 * Slack account linked in T1.
 */
async function world(options: { installation?: "verified" | "pending" } = {}) {
  const workspaceId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const releaseId = `rel-${crypto.randomUUID()}`;
  const sessionId = crypto.randomUUID();
  const teamId = crypto.randomUUID();
  const appRowId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  const appId = `A${appRowId.slice(0, 8).toUpperCase()}`;
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
  await db.insert(memberTeams).values({
    id: teamId,
    workspaceId,
    name: "managers",
  });
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    managingTeamId: teamId,
    slug: `a-${agentId.slice(0, 8)}`,
    name: "agent",
  });
  await db.insert(agentReleases).values({
    id: releaseId,
    agentId,
    versionId: crypto.randomUUID(),
    cardSha256: "0".repeat(64),
    connectionId: TEST_CONNECTION_ID,
    ...releaseSpecColumns(),
    runtimeConfigSnapshot: {},
    effectiveTools: { tools: [], mcp: [] },
  });
  await db.insert(slackApps).values({
    id: appRowId,
    workspaceId,
    kind: "agent",
    agentId,
    state: "created",
    appId,
    clientId: `1.${appRowId.slice(0, 8)}`,
    redirectUrl: "https://example.invalid/slack/callback",
    eventsState: "verified",
  });
  const verified = (options.installation ?? "verified") === "verified";
  await db.insert(slackInstallations).values({
    id: installationId,
    workspaceId,
    appId,
    teamId: "T1",
    status: verified ? "verified" : "pending",
    ...(verified ? { botUserId: "UBOT", verifiedAt: NOW } : {}),
  });

  const person = async (
    label: string,
    flags: {
      locale?: "ko" | "ja" | "en";
      disabled?: boolean;
      link?: "active" | "revoked" | "none";
      tenant?: string;
    } = {},
  ): Promise<Person> => {
    const userId = crypto.randomUUID();
    const slackUserId = `U${label.toUpperCase()}`;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: label,
      locale: flags.locale ?? null,
    });
    await db.insert(memberships).values({
      workspaceId,
      userId,
      role: "member",
      ...(flags.disabled ? { disabledAt: NOW } : {}),
    });
    if ((flags.link ?? "active") !== "none") {
      await db.insert(linkedAccounts).values({
        id: crypto.randomUUID(),
        workspaceId,
        userId,
        provider: "slack",
        externalTenant: flags.tenant ?? "T1",
        externalUserId: slackUserId,
        ...(flags.link === "revoked"
          ? { status: "revoked", revokedReason: "unlinked", revokedAt: NOW }
          : { status: "active" }),
        verifiedVia: "slack_oidc",
        verifiedAt: NOW,
      });
    }
    return { userId, slackUserId };
  };
  const startSession = async (creator: Person | null) => {
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "owner-model-cut",
      repoUrl: "https://github.com/acme/app.git",
      branch: "main",
      repositoryId: "app",
      checkpointRevision: 1,
      workspaceId,
      ...sessionPinColumns(),
      agentReleaseId: releaseId,
      createdByUserId: creator?.userId ?? null,
    });
  };
  /** The session's Slack thread, as a mention that opened it leaves it. */
  const thread = async (
    startedBy: Person | null,
    flags: {
      role?: "primary" | "mirror";
      muted?: boolean;
      closed?: boolean;
      revoked?: boolean;
      reportMode?: "none";
      threadId?: string;
    } = {},
  ) => {
    const id = crypto.randomUUID();
    await db.insert(sessionLinks).values({
      id,
      workspaceId,
      ownerId: "owner-model-cut",
      sessionId,
      installationId,
      surfaceBindingId: crypto.randomUUID(),
      surfaceRef: `slack:T1:${CHANNEL}:${flags.threadId ?? THREAD}`,
      channelId: CHANNEL,
      threadId: flags.threadId ?? THREAD,
      openedByTs: flags.threadId ?? THREAD,
      agentId,
      releaseId,
      role: flags.role ?? "primary",
      muted: flags.muted ?? false,
      ...(flags.reportMode === undefined
        ? {}
        : { reportMode: flags.reportMode }),
      createdBy: startedBy?.userId ?? null,
      ...(flags.closed
        ? { closedAt: NOW, closedReason: "completed" as const }
        : {}),
      ...(flags.revoked ? { revokedAt: NOW } : {}),
    });
    return id;
  };
  const outbox = () => db.select().from(slackOutbox);
  return {
    workspaceId,
    agentId,
    sessionId,
    teamId,
    installationId,
    person,
    startSession,
    thread,
    outbox,
  };
}

/** The rows written, as the thread reads them. */
const posts = (rows: (typeof slackOutbox.$inferSelect)[]) =>
  rows.map((row) => ({
    kind: row.kind,
    channelId: row.channelId,
    threadTs: row.threadTs,
    sessionLinkId: row.sessionLinkId,
    slackUserId: row.slackUserId,
  }));

const errorEvents = (sessionId: string) =>
  db
    .select({ payload: events.payload })
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .then((rows) =>
      rows
        .map(({ payload }) => payload as Record<string, unknown>)
        .filter(({ code }) => code === "MODEL_NOT_ALLOWED"),
    );

describe("enqueueModelCutNotices", () => {
  test("tells the session's thread once, in the language of whoever started it, and no person directly", async () => {
    const w = await world();
    const creator = await w.person("creator", { locale: "ja" });
    const admin = await w.person("admin", { locale: "en" });
    await db.insert(agentAdmins).values({
      workspaceId: w.workspaceId,
      agentId: w.agentId,
      userId: admin.userId,
    });
    await w.startSession(creator);
    const link = await w.thread(creator);

    expect(
      await enqueueModelCutNotices(db, {
        sessionId: w.sessionId,
        model: "claude-opus-5-5",
      }),
    ).toBe(1);

    const rows = await w.outbox();
    expect(posts(rows)).toEqual([
      {
        kind: "model_notice",
        channelId: CHANNEL,
        threadTs: THREAD,
        sessionLinkId: link,
        slackUserId: null,
      },
    ]);
    const [row] = rows;
    expect(row?.sessionId).toBe(w.sessionId);
    expect(row?.installationId).toBe(w.installationId);
    expect(row?.agentId).toBe(w.agentId);
    expect(row?.body.text).toStartWith("セッションが止まりました。");
    expect(row?.body.text).toContain("claude-opus-5-5");
    expect(row?.body.locale).toBe("ja");
    expect(row?.dedupeKey).toBe(
      `model-not-allowed:${w.workspaceId}:${w.sessionId}:${link}`,
    );
  });

  test("a thread that is muted, silent, closed, revoked or only a mirror is no thread: nothing is written", async () => {
    for (const [index, flags] of [
      { muted: true },
      { reportMode: "none" as const },
      { closed: true },
      { revoked: true },
      { role: "mirror" as const },
    ].entries()) {
      const w = await world();
      const creator = await w.person(`creator${index}`);
      await w.startSession(creator);
      await w.thread(creator, flags);
      expect(
        await enqueueModelCutNotices(db, {
          sessionId: w.sessionId,
          model: "claude-opus-5-5",
        }),
      ).toBe(0);
      expect(await w.outbox()).toEqual([]);
    }
  });

  test("a session with no thread is told on the web only: the cut's error event, no row", async () => {
    const w = await world();
    const creator = await w.person("creator", { locale: "en" });
    await w.startSession(creator);
    await db.insert(attempts).values({
      id: "att-1",
      sessionId: w.sessionId,
      executionId: "exec-att-1",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 1,
      state: "running",
      leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
    });
    expect(
      await createPostgresWorkerUnitOfWork(db).recordModelCutAtomic({
        sessionId: w.sessionId,
        attemptId: "att-1",
        model: "claude-opus-5-5",
        cause: "model_removed",
      }),
    ).toEqual({ recorded: true });
    expect(await errorEvents(w.sessionId)).toEqual([
      expect.objectContaining({
        model: "claude-opus-5-5",
        cause: "model_removed",
      }),
    ]);
    expect(await w.outbox()).toEqual([]);
  });

  test("the cut's error event and its notice are written by the same call, once across attempts", async () => {
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
    await w.thread(creator);
    const attempt = async (id: string) =>
      db.insert(attempts).values({
        id,
        sessionId: w.sessionId,
        executionId: `exec-${id}`,
        leaseEpoch: 1,
        executionGeneration: 1,
        authRevision: 1,
        state: "running",
        leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
      });
    await attempt("att-1");
    await attempt("att-2");
    const work = createPostgresWorkerUnitOfWork(db);
    const cut = (attemptId: string) =>
      work.recordModelCutAtomic({
        sessionId: w.sessionId,
        attemptId,
        model: "claude-opus-5-5",
        cause: "model_removed",
      });
    expect(await cut("att-1")).toEqual({ recorded: true });
    // The proxy refuses every exchange of the attempt; only the first writes.
    expect(await cut("att-1")).toEqual({ recorded: false });
    expect(await w.outbox()).toHaveLength(1);
    // A later attempt cut for the same reason adds an event, not a second post.
    expect(await cut("att-2")).toEqual({ recorded: true });
    expect(await w.outbox()).toHaveLength(1);
    expect(await errorEvents(w.sessionId)).toHaveLength(2);
  });

  test("a call for an attempt the session does not have writes no notice", async () => {
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
    await w.thread(creator);
    expect(
      await createPostgresWorkerUnitOfWork(db).recordModelCutAtomic({
        sessionId: w.sessionId,
        attemptId: "no-such-attempt",
        model: "claude-opus-5-5",
        cause: "model_removed",
      }),
    ).toEqual({ recorded: false });
    expect(await w.outbox()).toEqual([]);
  });

  test("a connection that is gone says so in the event and the post, still naming the model", async () => {
    const w = await world();
    const creator = await w.person("creator", { locale: "en" });
    await w.startSession(creator);
    await w.thread(creator);
    await db.insert(attempts).values({
      id: "att-1",
      sessionId: w.sessionId,
      executionId: "exec-att-1",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 1,
      state: "running",
      leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
    });
    await createPostgresWorkerUnitOfWork(db).recordModelCutAtomic({
      sessionId: w.sessionId,
      attemptId: "att-1",
      model: "claude-opus-5-5",
      cause: "connection_removed",
    });
    expect(await errorEvents(w.sessionId)).toEqual([
      expect.objectContaining({
        model: "claude-opus-5-5",
        cause: "connection_removed",
      }),
    ]);
    const [post] = await w.outbox();
    expect(post?.body).toMatchObject({
      text: expect.stringMatching(/claude-opus-5-5.* is gone/),
    });
  });
});

describe("a session held as runtime_retired", () => {
  const hold = (
    sessionId: string,
    reason: "runtime_retired" | "incompatible_checkpoint",
    checkpointRevision = 1,
  ) =>
    holdIncompatibleBeforeLaunch(db, {
      sessionId,
      checkpointRevision,
      reason,
      detail: "only a retracted worker image restores it",
      now: NOW,
    });

  test("tells its thread, in the language of whoever started it", async () => {
    const w = await world();
    const creator = await w.person("creator", { locale: "ja" });
    await w.startSession(creator);
    const link = await w.thread(creator);

    expect(await hold(w.sessionId, "runtime_retired")).toBe("held");

    const rows = await w.outbox();
    expect(posts(rows)).toEqual([
      {
        kind: "model_notice",
        channelId: CHANNEL,
        threadTs: THREAD,
        sessionLinkId: link,
        slackUserId: null,
      },
    ]);
    expect(rows[0]?.body.text).toContain("worker イメージが撤回され");
    expect(rows[0]?.body.locale).toBe("ja");
  });

  test("an incompatible checkpoint, or a hold that finds the session moved on, tells nobody", async () => {
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
    await w.thread(creator);
    // Judged on a checkpoint the session has moved past: stale.
    expect(await hold(w.sessionId, "runtime_retired", 2)).toBe("stale");
    expect(await hold(w.sessionId, "incompatible_checkpoint")).toBe("held");
    // Held already: the same judgement again is stale.
    expect(await hold(w.sessionId, "runtime_retired")).toBe("stale");
    expect(await w.outbox()).toEqual([]);
  });

  test("held again on the same checkpoint after retry_restore tells nothing new; a later checkpoint tells again", async () => {
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
    await w.thread(creator);
    // What retry_restore leaves: the session launchable on its checkpoint.
    const retried = (checkpointRevision: number) =>
      db
        .update(sessions)
        .set({
          admissionState: "active",
          status: "idle",
          checkpointRevision,
          restoreFailureCount: 0,
          restoreFailureReason: null,
        })
        .where(eq(sessions.id, w.sessionId));
    expect(await hold(w.sessionId, "runtime_retired")).toBe("held");
    await retried(1);
    expect(await hold(w.sessionId, "runtime_retired")).toBe("held");
    expect(await w.outbox()).toHaveLength(1);
    await retried(2);
    expect(await hold(w.sessionId, "runtime_retired", 2)).toBe("held");
    expect(await w.outbox()).toHaveLength(2);
  });

  test("a session with no thread is held, its stop on the web, and no row is written", async () => {
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
    expect(await hold(w.sessionId, "runtime_retired")).toBe("held");
    const [session] = await db
      .select({ reason: sessions.restoreFailureReason })
      .from(sessions)
      .where(eq(sessions.id, w.sessionId));
    expect(session?.reason).toBe("runtime_retired");
    expect(await w.outbox()).toEqual([]);
  });
});

describe("a launch that moves off a retracted worker image", () => {
  const RETRACTED = "sha256:retracted";
  const FIXED = "sha256:fixed";
  const schedulerStore = () =>
    createPostgresSchedulerStore(db, {
      sessionBudget: { costUsd: 1_000, tokens: null },
      connectForLock: async () => ({
        query: async (text: string) => ({
          rows: (await client.query<Record<string, unknown>>(text)).rows,
        }),
        release: () => undefined,
        on: () => undefined,
        off: () => undefined,
      }),
      logger: new StructuredLogger({ sinks: [new MemoryLogSink()] }),
    });
  /** Reserves a launch on `image`, then lets it end, as a finished turn does. */
  const launch = async (
    sessionId: string,
    image: string,
    retractedImages?: readonly string[],
  ) => {
    const store = schedulerStore();
    const stored = await store.reserveLaunch({
      backend: "local_docker",
      image,
      ...(retractedImages === undefined ? {} : { retractedImages }),
      now: NOW,
      resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pidsLimit: 256 },
      sessionId,
      slotLimit: 10,
    });
    if (stored === null) throw new Error("not reserved");
    await store.confirmExecutionGone(stored.executionId, NOW, null);
    return stored;
  };
  const replaced = (sessionId: string) =>
    db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .then((rows) =>
        rows
          .map(({ payload }) => payload as Record<string, unknown>)
          .filter(({ subtype }) => subtype === "worker_image_replaced"),
      );
  const signalled = async (sessionId: string) => {
    await db
      .insert(unassignedSessions)
      .values({ sessionId })
      .onConflictDoNothing();
  };

  test("records the move on the session and tells its thread, in the language of whoever started it", async () => {
    const w = await world();
    const creator = await w.person("creator", { locale: "ko" });
    await w.startSession(creator);
    const link = await w.thread(creator);
    await signalled(w.sessionId);
    await launch(w.sessionId, RETRACTED);
    await signalled(w.sessionId);
    const moved = await launch(w.sessionId, FIXED, [RETRACTED]);

    expect(await replaced(w.sessionId)).toEqual([
      {
        type: "system",
        subtype: "worker_image_replaced",
        from: RETRACTED,
        to: FIXED,
        reason: "retracted",
      },
    ]);
    const rows = await w.outbox();
    expect(posts(rows)).toEqual([
      {
        kind: "model_notice",
        channelId: CHANNEL,
        threadTs: THREAD,
        sessionLinkId: link,
        slackUserId: null,
      },
    ]);
    expect(rows[0]?.body.text).toContain("worker 이미지가 철회되어");
    expect(rows[0]?.body.locale).toBe("ko");
    expect(rows[0]?.dedupeKey).toContain(`:${moved.generation}:`);
  });

  test("a launch that is no move off a retracted image records and tells nothing", async () => {
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
    await w.thread(creator);
    // The first launch has no earlier image to move off.
    await signalled(w.sessionId);
    await launch(w.sessionId, RETRACTED, [RETRACTED]);
    // The same image again: nothing moved.
    await signalled(w.sessionId);
    await launch(w.sessionId, RETRACTED, [RETRACTED]);
    // Nothing retracted that this session ran.
    await signalled(w.sessionId);
    await launch(w.sessionId, FIXED, ["sha256:other"]);
    // Nothing retracted at all.
    await signalled(w.sessionId);
    await launch(w.sessionId, RETRACTED);
    await signalled(w.sessionId);
    await launch(w.sessionId, FIXED);

    expect(await replaced(w.sessionId)).toEqual([]);
    expect(await w.outbox()).toEqual([]);
  });

  test("one digest under another repository path is the same image", async () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
    await w.thread(creator);
    await signalled(w.sessionId);
    await launch(w.sessionId, `registry-a.invalid/worker@${digest}`);
    // Mirrored: the same image, pulled from another registry, moved nowhere.
    await signalled(w.sessionId);
    await launch(w.sessionId, `registry-b.invalid/worker@${digest}`, [
      `registry-b.invalid/worker@${digest}`,
    ]);
    expect(await replaced(w.sessionId)).toEqual([]);
    // Retracted under its mirror's path: leaving it is a move.
    await signalled(w.sessionId);
    await launch(w.sessionId, FIXED, [`registry-c.invalid/worker@${digest}`]);
    expect(await replaced(w.sessionId)).toEqual([
      expect.objectContaining({
        from: `registry-b.invalid/worker@${digest}`,
        to: FIXED,
      }),
    ]);
    expect(await w.outbox()).toHaveLength(1);
  });

  test("a session with no thread still records the move and writes no row", async () => {
    const w = await world();
    await w.startSession(null);
    await signalled(w.sessionId);
    await launch(w.sessionId, RETRACTED);
    await signalled(w.sessionId);
    await launch(w.sessionId, FIXED, [RETRACTED]);

    expect(await replaced(w.sessionId)).toHaveLength(1);
    expect(await w.outbox()).toEqual([]);
  });
});

describe("enqueueSessionModelMoveNotices", () => {
  const move = { from: "claude-sonnet-5", to: "claude-sonnet-5-1" };

  test("tells the session's thread, in the language of whoever started it", async () => {
    const w = await world();
    const creator = await w.person("creator", { locale: "ko" });
    await w.startSession(creator);
    const link = await w.thread(creator);

    expect(
      await enqueueSessionModelMoveNotices(db, {
        sessionId: w.sessionId,
        ...move,
      }),
    ).toBe(1);

    const rows = await w.outbox();
    expect(posts(rows)).toEqual([
      {
        kind: "model_notice",
        channelId: CHANNEL,
        threadTs: THREAD,
        sessionLinkId: link,
        slackUserId: null,
      },
    ]);
    expect(rows[0]?.body.text).toContain("claude-sonnet-5-1(으)로 옮겼어요");
    expect(rows[0]?.body.locale).toBe("ko");
  });

  test("one move tells once; a later move of the same session tells again", async () => {
    const w = await world();
    const creator = await w.person("creator", { locale: "en" });
    await w.startSession(creator);
    await w.thread(creator);
    const moved = (to: string) =>
      enqueueSessionModelMoveNotices(db, {
        sessionId: w.sessionId,
        from: move.from,
        to,
      });
    expect(await moved(move.to)).toBe(1);
    expect(await moved(move.to)).toBe(0);
    expect(await moved("claude-sonnet-5-2")).toBe(1);
  });

  test("the claim's move writes the timeline event and the thread's notice together", async () => {
    const w = await world();
    const creator = await w.person("creator", { locale: "en" });
    await w.startSession(creator);
    await w.thread(creator);
    await db.insert(unassignedSessions).values({ sessionId: w.sessionId });

    expect(
      await moveSessionsToSuccessors(
        db,
        { partition: "default", sessionId: w.sessionId },
        {
          modelMoves: [{ connectionId: TEST_CONNECTION_ID, ...move }],
          now: NOW,
        },
      ),
    ).toBe(1);

    const [session] = await db
      .select({ model: sessions.model })
      .from(sessions)
      .where(eq(sessions.id, w.sessionId));
    expect(session?.model).toBe(move.to);
    const timeline = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, w.sessionId));
    expect(timeline.map((row) => row.payload)).toContainEqual(
      expect.objectContaining({ subtype: "model_migrated", ...move }),
    );
    const rows = await w.outbox();
    expect(rows.map((row) => row.channelId)).toEqual([CHANNEL]);
    expect(rows[0]?.body.text).toContain(`moved to ${move.to}`);
  });

  test("a session with no thread keeps the move on its timeline only", async () => {
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
    await db.insert(unassignedSessions).values({ sessionId: w.sessionId });
    await moveSessionsToSuccessors(
      db,
      { partition: "default", sessionId: w.sessionId },
      { modelMoves: [{ connectionId: TEST_CONNECTION_ID, ...move }], now: NOW },
    );
    const timeline = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, w.sessionId));
    expect(timeline.map((row) => row.payload)).toContainEqual(
      expect.objectContaining({ subtype: "model_migrated", ...move }),
    );
    expect(await w.outbox()).toEqual([]);
  });

  test("a claim that rolls back after the move leaves no notice behind", async () => {
    const w = await world();
    const creator = await w.person("creator", { locale: "en" });
    await w.startSession(creator);
    await w.thread(creator);
    await db.insert(unassignedSessions).values({ sessionId: w.sessionId });

    const rolledBack = new Error("claim rolled back");
    await expect(
      db.transaction(async (tx) => {
        await moveSessionsToSuccessors(
          tx,
          { partition: "default", sessionId: w.sessionId },
          {
            modelMoves: [{ connectionId: TEST_CONNECTION_ID, ...move }],
            now: NOW,
          },
        );
        expect(
          (await tx.select().from(slackOutbox)).map((row) => row.channelId),
        ).toEqual([CHANNEL]);
        throw rolledBack;
      }),
    ).rejects.toBe(rolledBack);

    const [session] = await db
      .select({ model: sessions.model })
      .from(sessions)
      .where(eq(sessions.id, w.sessionId));
    expect(session?.model).toBe(move.from);
    expect(
      await db.select().from(events).where(eq(events.sessionId, w.sessionId)),
    ).toEqual([]);
    expect(await w.outbox()).toEqual([]);
  });
});
