import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  CONVERSATION_TURN_LEASE_MS,
  conversationCallKeySchema,
  conversationInputIdSchema,
  conversationRuntimeIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
  DEFAULT_SURFACE_CEILING,
  SLACK_EMERGENCY_STOP_TEXT,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  hashConversationCallToken,
  SecretKey,
  type SessionCatalog,
  type WorkerGateway,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresConversationCalls } from "./conversation-calls.ts";
import { createPostgresConversationStore } from "./conversations/conversation-store.ts";
import { createPostgresConversationTurnQueue } from "./conversations/conversation-turn-queue.ts";
import { stopChannelWork } from "./emergency-stop.ts";
import { createPostgresAgentIdentityStore } from "./musterrolle/agent-identities.ts";
import { createPostgresSurfaceBindingStore } from "./musterrolle/surface-bindings.ts";
import {
  CREATE_SESSION,
  createPostgresSessionUnitOfWork,
  SESSIONS_RESOURCE,
} from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import { decideRecoveryAtomic, resumeAtomic } from "./recovery-control.ts";
import * as schema from "./schema.ts";
import {
  agents,
  conversationTurns,
  memberships,
  receipts,
  sessions,
  slackApps,
  slackOutbox,
  surfaceBindings,
  turns,
  users,
  workspaces,
} from "./schema.ts";
import { createPostgresSessionLinkStore } from "./session-links.ts";
import { emergencyStopHolds } from "./surface/emergency-stop-hold.ts";
import {
  registerSlackInstallation,
  verifySlackInstallation,
} from "./surface/slack-installations.ts";
import { createPostgresSlackOutboxStore } from "./surface/slack-outbox.ts";
import { commitCheckpoint } from "./testing/checkpoints.ts";
import { conversationTurnQueueFixture } from "./testing/conversation-turn-queue.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { testWorkerGateway, workerOf } from "./testing/gateway.ts";
import { launchSession } from "./testing/launches.ts";
import { claimedSession } from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

// An emergency stop of one Slack channel: what runs there stops at once, what
// was about to be posted is not, and only a person goes on afterwards.

const OWNER = testCaller("00000000-0000-4000-8000-00000000000c");
const CATALOG: SessionCatalog = testSessionCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "provider-key",
      ref: { stored: "connection:test-connection" },
    },
  },
  models: ["claude-sonnet-5"],
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});
const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };
const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];
const CHANNEL = "C0STOP";

let client: PGlite;
let db: Database;
let gateway: WorkerGateway;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  gateway = testWorkerGateway(db, CATALOG);
});

afterEach(async () => {
  await client.close();
});

const store = () => createPostgresSurfaceBindingStore(db);

async function person(workspaceId: string, role: WorkspaceRole) {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.invalid`,
    passwordHash: "argon2id$placeholder",
    displayName: `the ${role}`,
  });
  await db.insert(memberships).values({ workspaceId, userId, role });
  const caller = callerFor(
    {
      kind: "user",
      id: userId,
      workspace_id: workspaceId,
      role,
      scopes: [...scopesForRole(role)],
    },
    { kind: "web" },
    randomUUID(),
  );
  return Object.assign(caller, { userId });
}

/**
 * A running first turn ("first input") of a session whose parent is the
 * agent's private channel, and posts waiting to go to it and to another.
 */
async function stage(options: { checkpoint?: boolean } = {}) {
  const worker = await claimedSession(db, gateway, OWNER);
  const next = await gateway.nextInput(worker.principal, worker.scope);
  if (!next.input) throw new Error("no input delivered");
  // A pause stands on a committed checkpoint: the restore point a resume
  // goes back to.
  if (options.checkpoint !== false) {
    const { kind: _kind, ...fence } = worker.principal as Extract<
      typeof worker.principal,
      { kind: "session" }
    >;
    const committed = await commitCheckpoint(db, {
      checkpoint: {
        revision: 0,
        manifest_ref: "s3://bucket/stop-0.json",
        manifest_sha256: "a".repeat(64),
      },
      fence,
      now: new Date(),
      sessionId: worker.sessionId,
      turnId: null,
    });
    if (committed.outcome !== "committed") throw new Error(committed.outcome);
  }
  const workspaceId = randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
  const owner = await person(workspaceId, "owner");
  const admin = await person(workspaceId, "admin");
  const member = await person(workspaceId, "member");
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    managingTeamId: await fixtureTeam(db, workspaceId),
    slug: "notes",
    name: "notes",
  });
  const key = { appId: "A0STOP", teamId: "T0STOP" };
  const appRowId = randomUUID();
  await db.insert(slackApps).values({
    id: appRowId,
    workspaceId,
    kind: "agent",
    agentId,
    state: "created",
    appId: key.appId,
    clientId: "1.stop",
    redirectUrl: "https://example.invalid/slack/callback",
    eventsState: "verified",
  });
  await registerSlackInstallation(db, { ...key, workspaceId });
  await verifySlackInstallation(db, { ...key, botUserId: "B0BOT" });
  const linked = await createPostgresAgentIdentityStore(db).link({
    principal: owner,
    workspaceId,
    agentId,
    key,
    credentialRef: "slack-bot-stop",
    managerRoles: MANAGERS,
  });
  if (linked.outcome !== "linked") throw new Error(linked.outcome);
  const installationId = linked.identity.installationId;
  const bound = await store().set({
    principal: owner,
    workspaceId,
    agentId,
    channelId: CHANNEL,
    channelKind: "public_channel",
    mode: "on",
    home: false,
    ceiling: DEFAULT_SURFACE_CEILING,
    managerRoles: MANAGERS,
  });
  if (bound.outcome !== "set") throw new Error(bound.outcome);
  const conversation = await createPostgresConversationStore(
    db,
  ).findOrCreateConversation({
    kind: "channel",
    workspaceId,
    agentId,
    teamId: key.teamId,
    channelId: CHANNEL,
  });
  await db
    .update(sessions)
    .set({ workspaceId, parentConversationId: conversation.id })
    .where(eq(sessions.id, worker.sessionId));
  for (const channelId of [CHANNEL, "C0ELSE"]) {
    await db.insert(slackOutbox).values({
      id: randomUUID(),
      workspaceId,
      agentId,
      slackAppId: appRowId,
      installationId,
      kind: "reply",
      channelId,
      threadTs: "100.000100",
      body: { text: "a reply on its way" } as never,
      dedupeKey: `reply:${channelId}`,
    });
  }
  return {
    worker,
    workspaceId,
    owner,
    admin,
    member,
    agentId,
    installationId,
    bindingId: bound.binding.id,
  };
}

type Stage = Awaited<ReturnType<typeof stage>>;

const stop = (s: Stage, principal: Caller, reason = "a leak suspected") =>
  store().emergencyStop({
    principal,
    workspaceId: s.workspaceId,
    agentId: s.agentId,
    bindingId: s.bindingId,
    reason,
    text: SLACK_EMERGENCY_STOP_TEXT,
    managerRoles: MANAGERS,
  });

const turnOn = (s: Stage, principal: Caller, reason?: string) =>
  store().set({
    principal,
    workspaceId: s.workspaceId,
    agentId: s.agentId,
    channelId: CHANNEL,
    channelKind: "public_channel",
    mode: "on",
    home: false,
    ceiling: DEFAULT_SURFACE_CEILING,
    managerRoles: MANAGERS,
    ...(reason === undefined ? {} : { reason }),
  });

async function sessionOf(sessionId: string) {
  const [row] = await db
    .select({
      admissionState: sessions.admissionState,
      pauseReason: sessions.pauseReason,
      revision: sessions.revision,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!row) throw new Error("no session");
  return row;
}

const turnsOf = (sessionId: string) =>
  db
    .select({
      sequence: turns.sequence,
      status: turns.status,
      reason: turns.terminalReason,
      prepended: turns.prependedTurn,
      skipped: turns.prependSkipReason,
    })
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(asc(turns.sequence));

/** The fenced worker's execution is seen gone, so the pause settles. */
async function executionGone(worker: Stage["worker"]) {
  await createPostgresWorkerUnitOfWork(db).confirmExecutionGoneAtomic({
    executionId: worker.executionId,
    now: new Date(),
  });
}

/**
 * Input from the session's owner. The session leaves the workspace the stop
 * found it in first, as a session from before workspaces has none: its
 * fixture agent is no one's to use there, and the stop still holds by agent
 * and channel.
 */
const send = async (
  s: Stage,
  input: { message: string } | { continueTurn: number },
) => {
  await db
    .update(sessions)
    .set({ workspaceId: null })
    .where(eq(sessions.id, s.worker.sessionId));
  return createPostgresSessionUnitOfWork(db).appendInputAtomic({
    principal: { ...OWNER, requestId: randomUUID() },
    sessionId: s.worker.sessionId,
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    ...("message" in input
      ? { message: input.message }
      : { message: "", continueTurn: input.continueTurn }),
    limits: LIMITS,
  });
};

const resume = async (sessionId: string) =>
  resumeAtomic(db, {
    principal: { ...OWNER, requestId: randomUUID() },
    sessionId,
    idempotencyKey: randomUUID(),
    payloadHash: randomUUID(),
    expectedRevision: (await sessionOf(sessionId)).revision,
    now: new Date(),
  });

async function nextWorker(sessionId: string) {
  const { executionId, generation, nonce } = await launchSession(db, {
    sessionId,
  });
  const claimed = await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: executionId,
      execution_generation: generation,
      credential: { kind: "launch_nonce", nonce },
    },
  );
  return workerOf(claimed, executionId);
}

async function delivered(worker: Awaited<ReturnType<typeof nextWorker>>) {
  const next = await gateway.nextInput(worker.principal, worker.scope);
  if (!next.input) throw new Error("no input delivered");
  return next.input;
}

/** A new worker restores the session a resume left resuming. */
async function restored(sessionId: string) {
  const worker = await nextWorker(sessionId);
  await gateway.ready(worker.principal, {
    ...worker.scope,
    restored_revision: 0,
  });
  return worker;
}

/** Stopped, the execution gone, turned on again, resumed and restored. */
async function stoppedAndBack(s: Stage) {
  expect((await stop(s, s.admin)).outcome).toBe("stopped");
  await executionGone(s.worker);
  expect((await turnOn(s, s.admin, "checked")).outcome).toBe("set");
  expect((await resume(s.worker.sessionId)).outcome).toBe("accepted");
  return restored(s.worker.sessionId);
}

describe("an emergency stop of a channel", () => {
  test("mid model call: the turn is cut, the session pauses, the channel's posts are cancelled and the stop line queued", async () => {
    const s = await stage();
    const stopped = await stop(s, s.admin);
    expect(stopped).toMatchObject({
      outcome: "stopped",
      stopped: { sessions: 1, turns: 1, posts: 1 },
      binding: {
        mode: "off",
        emergencyStop: {
          stoppedBy: { userId: s.admin.userId, name: "the admin" },
          reason: "a leak suspected",
        },
      },
    });
    expect(await turnsOf(s.worker.sessionId)).toMatchObject([
      { sequence: 1, status: "failed", reason: "emergency_stopped" },
    ]);
    expect(await sessionOf(s.worker.sessionId)).toMatchObject({
      admissionState: "pausing",
      pauseReason: "emergency_stopped",
    });
    const posts = await db
      .select({
        kind: slackOutbox.kind,
        channelId: slackOutbox.channelId,
        status: slackOutbox.status,
        errorCode: slackOutbox.errorCode,
        body: slackOutbox.body,
      })
      .from(slackOutbox)
      .where(eq(slackOutbox.workspaceId, s.workspaceId))
      .orderBy(asc(slackOutbox.seq));
    expect(posts).toEqual([
      {
        kind: "reply",
        channelId: CHANNEL,
        status: "failed",
        errorCode: "emergency_stopped",
        body: { text: "a reply on its way" } as never,
      },
      {
        kind: "reply",
        channelId: "C0ELSE",
        status: "pending",
        errorCode: null,
        body: { text: "a reply on its way" } as never,
      },
      {
        kind: "emergency_stop_notice",
        channelId: CHANNEL,
        status: "pending",
        errorCode: null,
        body: { text: SLACK_EMERGENCY_STOP_TEXT } as never,
      },
    ]);
    // The fenced worker's result is not taken.
    const late = await gateway
      .finalize(s.worker.principal, {
        ...s.worker.scope,
        turn_id: "1",
        finalize_key: `${s.worker.scope.attempt_id}:1`,
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: null,
      })
      .then(
        () => "taken",
        () => "refused",
      );
    expect(late).toBe("refused");
    expect(await turnsOf(s.worker.sessionId)).toMatchObject([
      { status: "failed", reason: "emergency_stopped" },
    ]);
  });

  test("the receipt says who, when, which channel and why; a second stop is refused", async () => {
    const s = await stage();
    const stopped = await stop(s, s.admin);
    if (stopped.outcome !== "stopped") throw new Error(stopped.outcome);
    const [receipt] = await db
      .select({
        operation: receipts.operation,
        actor: receipts.actor,
        targetRef: receipts.targetRef,
        result: receipts.result,
        createdAt: receipts.createdAt,
      })
      .from(receipts)
      .where(eq(receipts.id, stopped.receiptId));
    expect(receipt).toMatchObject({
      operation: "emergency_stop_surface_binding",
      actor: { actor_user_id: s.admin.userId },
      result: {
        reason: "a leak suspected",
        stopped: { sessions: 1, turns: 1, posts: 1 },
      },
    });
    expect(JSON.stringify(receipt?.targetRef)).toContain(s.bindingId);
    expect(receipt?.createdAt).toBeInstanceOf(Date);
    expect((await stop(s, s.admin)).outcome).toBe("already_stopped");
  });

  test("a member who manages nothing cannot stop it", async () => {
    const s = await stage();
    expect((await stop(s, s.member)).outcome).not.toBe("stopped");
    expect(await turnsOf(s.worker.sessionId)).toMatchObject([
      { status: "running" },
    ]);
    const [binding] = await db
      .select({
        mode: surfaceBindings.mode,
        at: surfaceBindings.emergencyStoppedAt,
      })
      .from(surfaceBindings)
      .where(eq(surfaceBindings.id, s.bindingId));
    expect(binding).toEqual({ mode: "on", at: null });
  });

  test("turning the channel on asks a reason and records the stop it ends", async () => {
    const s = await stage();
    await stop(s, s.admin);
    expect((await turnOn(s, s.owner)).outcome).toBe("reason_required");
    const on = await turnOn(s, s.owner, "checked, nothing leaked");
    if (on.outcome !== "set") throw new Error(on.outcome);
    expect(on.binding).toMatchObject({ mode: "on", emergencyStop: null });
    const [receipt] = await db
      .select({ result: receipts.result })
      .from(receipts)
      .where(eq(receipts.id, on.receiptId));
    expect(receipt?.result).toMatchObject({
      reason: "checked, nothing leaked",
      emergency_stop_ended: {
        stopped_by_user_id: s.admin.userId,
        reason: "a leak suspected",
      },
    });
  });
});

describe("going on after an emergency stop", () => {
  test("no resume while the channel is stopped; after it is on, a resume starts nothing by itself", async () => {
    const s = await stage();
    await stop(s, s.admin);
    await executionGone(s.worker);
    expect(await sessionOf(s.worker.sessionId)).toMatchObject({
      admissionState: "paused",
      pauseReason: "emergency_stopped",
    });
    expect((await resume(s.worker.sessionId)).outcome).toBe(
      "emergency_stopped",
    );
    expect((await turnOn(s, s.admin, "checked")).outcome).toBe("set");
    expect((await resume(s.worker.sessionId)).outcome).toBe("accepted");
    await restored(s.worker.sessionId);
    expect(await sessionOf(s.worker.sessionId)).toMatchObject({
      admissionState: "active",
      pauseReason: null,
    });
    // Nothing queued: the cut turn waits for a person's [Continue].
    expect(await turnsOf(s.worker.sessionId)).toHaveLength(1);
  });

  test("[Continue] runs the cut-off input again", async () => {
    const s = await stage();
    const back = await stoppedAndBack(s);
    const continued = await send(s, { continueTurn: 1 });
    expect(continued.outcome).toBe("accepted");
    const input = await delivered(back);
    expect(input.message).toBe("first input");
  });

  test("the next message is not given the stopped turn's input, and the skip is recorded", async () => {
    const s = await stage();
    const worker = await stoppedAndBack(s);
    const sent = await send(s, { message: "second input" });
    expect(sent.outcome).toBe("accepted");
    const first = await delivered(worker);
    expect(first.message).toBe("second input");
    expect(await delivered(worker)).toEqual(first);
    const [second] = await db
      .select({
        prepended: turns.prependedTurn,
        skipped: turns.prependSkipReason,
      })
      .from(turns)
      .where(
        and(eq(turns.sessionId, s.worker.sessionId), eq(turns.sequence, 2)),
      );
    expect(second).toEqual({ prepended: 1, skipped: "emergency_stopped" });
  });

  test("a session with no checkpoint yet is not paused, and takes no input until the channel is on", async () => {
    const s = await stage({ checkpoint: false });
    expect(await stop(s, s.admin)).toMatchObject({
      outcome: "stopped",
      stopped: { sessions: 1, turns: 1 },
    });
    await executionGone(s.worker);
    expect(await sessionOf(s.worker.sessionId)).toMatchObject({
      admissionState: "active",
      pauseReason: null,
    });
    for (const input of [{ message: "meanwhile" }, { continueTurn: 1 }]) {
      expect((await send(s, input)).outcome).toBe("emergency_stopped");
    }
    expect(await turnsOf(s.worker.sessionId)).toHaveLength(1);
    expect((await turnOn(s, s.admin, "checked")).outcome).toBe("set");
    expect((await send(s, { continueTurn: 1 })).outcome).toBe("accepted");
  });
});

describe("what an emergency stop leaves the channel", () => {
  test("a conversation turn leased in the channel is never taken: its queue entry ends failed", async () => {
    const fixture = await conversationTurnQueueFixture(db);
    const queue = createPostgresConversationTurnQueue(
      db,
      SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY"),
    );
    const turn = await fixture.turn();
    const now = new Date();
    await queue.enqueue(turn, {
      inputId: conversationInputIdSchema.parse(randomUUID()),
      attempt: 1,
      takeBy: new Date(now.getTime() + 30_000),
      now,
    });
    const taken = await queue.lease({
      runtimeId: conversationRuntimeIdSchema.parse(randomUUID()),
      now,
      leaseMs: CONVERSATION_TURN_LEASE_MS,
    });
    expect(taken?.turn_id).toBe(turn.turn_id);
    // The channel's install, in the team of the turn's conversation.
    const [channel] = await db
      .select({ teamId: schema.conversations.teamId })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.agentId, turn.scope.agent_id),
          eq(schema.conversations.channelId, "C0QUEUE"),
        ),
      );
    if (!channel?.teamId) throw new Error("no channel conversation");
    const installationId = randomUUID();
    await db.insert(schema.slackInstallations).values({
      id: installationId,
      workspaceId: turn.scope.workspace_id,
      appId: "A0QUEUE",
      teamId: channel.teamId,
    });

    const counts = await db.transaction((tx) =>
      stopChannelWork(
        tx as unknown as Database,
        {
          workspaceId: turn.scope.workspace_id,
          agentId: turn.scope.agent_id,
          installationId,
          channelId: "C0QUEUE",
          installationIds: [installationId],
        },
        { now, attempt: 0 },
      ),
    );
    expect(counts).toEqual({ sessions: 0, turns: 1, posts: 0 });
    const [row] = await db
      .select({ state: conversationTurns.state })
      .from(conversationTurns)
      .where(eq(conversationTurns.id, turn.turn_id));
    // A web input's turn keeps its record; only its run is gone.
    expect(row).toEqual({ state: "received" });
    expect(await queue.outcome(turn.turn_id, now)).toEqual({
      outcome: "failed",
      reason: "emergency_stopped",
    });
  });

  test("nothing queued after the stop goes to the channel but the line that says so", async () => {
    const s = await stage();
    await stop(s, s.admin);
    const [notice] = await db
      .select({ slackAppId: slackOutbox.slackAppId })
      .from(slackOutbox)
      .where(eq(slackOutbox.kind, "emergency_stop_notice"));
    if (!notice) throw new Error("no notice");
    await db.insert(slackOutbox).values({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      agentId: s.agentId,
      slackAppId: notice.slackAppId,
      installationId: s.installationId,
      kind: "reply",
      channelId: CHANNEL,
      threadTs: "100.000200",
      body: { text: "a late reply" } as never,
      dedupeKey: "reply:late",
    });
    const claimed = await createPostgresSlackOutboxStore(db).claim({
      limit: 10,
      leaseMs: 30_000,
    });
    expect(claimed.map((row) => [row.kind, row.channelId]).sort()).toEqual([
      ["emergency_stop_notice", CHANNEL],
      ["reply", "C0ELSE"],
    ]);
  });
});

describe("work that meets an emergency stop as it runs", () => {
  test("a session made as the stop ran is stopped as it joins the channel", async () => {
    const s = await stage();
    const late = await claimedSession(db, gateway, OWNER);
    const next = await gateway.nextInput(late.principal, late.scope);
    if (!next.input) throw new Error("no input delivered");
    expect((await stop(s, s.admin)).outcome).toBe("stopped");
    const [made] = await db
      .select({ releaseId: sessions.agentReleaseId })
      .from(sessions)
      .where(eq(sessions.id, late.sessionId));
    if (!made?.releaseId) throw new Error("no release");
    const links = createPostgresSessionLinkStore(db);
    // The link's release need not be the agent's here: not what is tested.
    await client.exec("SET session_replication_role = replica");
    const { link } = await links.reserve({
      workspaceId: s.workspaceId,
      installationId: s.installationId,
      surfaceBindingId: s.bindingId,
      surfaceRef: `${CHANNEL}:200.000100`,
      channelId: CHANNEL,
      threadId: "200.000100",
      openedByTs: "200.000100",
      agentId: s.agentId,
      releaseId: made.releaseId,
      createdBy: s.owner.userId,
    });
    await client.exec("SET session_replication_role = DEFAULT");
    await links.attachSession(link.id, late.sessionId);
    expect(await turnsOf(late.sessionId)).toMatchObject([
      { sequence: 1, status: "failed", reason: "emergency_stopped" },
    ]);
  });

  test("a conversation turn written after the stop is refused", async () => {
    const s = await stage();
    const [conversation] = await db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.agentId, s.agentId));
    if (!conversation) throw new Error("no conversation");
    const issue = () => {
      const turnId = conversationTurnIdSchema.parse(randomUUID());
      return createPostgresConversationCalls(db).issueTurnPermitAtomic({
        turnId,
        tokenHash: hashConversationCallToken(randomUUID()),
        workspaceId: s.workspaceId,
        agentId: s.agentId,
        conversationId: conversation.id as never,
        topicId: conversationTopicIdSchema.parse(randomUUID()),
        requester: { kind: "operator", id: "ops@host" },
        releaseId: null,
        root: { kind: "key", keyKind: "operator", createdByUserId: null },
        connectionId: "conn-messages",
        path: "/v1/messages",
        model: "claude-sonnet-5",
        maxTokens: 256,
        maxRequestBytes: 4_096,
        callKey: conversationCallKeySchema.parse(`turn-${turnId}:m2`),
        ttlMs: 180_000,
      });
    };
    // Another app's install in the same team binds the channel too.
    const second = { appId: "A0SECOND", teamId: "T0STOP" };
    await registerSlackInstallation(db, {
      ...second,
      workspaceId: s.workspaceId,
    });
    await verifySlackInstallation(db, { ...second, botUserId: "B0SECOND" });
    const linked = await createPostgresAgentIdentityStore(db).link({
      principal: s.owner,
      workspaceId: s.workspaceId,
      agentId: s.agentId,
      key: second,
      credentialRef: "slack-bot-second",
      managerRoles: MANAGERS,
    });
    if (linked.outcome !== "linked") throw new Error(linked.outcome);
    const bound = await turnOn(s, s.owner);
    if (bound.outcome !== "set") throw new Error(bound.outcome);
    expect(bound.binding.id).not.toBe(s.bindingId);
    // Before the stop the channel takes it as far as its topic.
    expect((await issue()).outcome).toBe("unknown_conversation");
    await stop(s, s.admin);
    expect((await issue()).outcome).toBe("channel_stopped");
    // Either of the two bindings holding the stop holds the channel.
    const unstop = (id: string) =>
      db
        .update(surfaceBindings)
        .set({
          emergencyStoppedAt: null,
          emergencyStoppedBy: null,
          emergencyStopReason: null,
        })
        .where(eq(surfaceBindings.id, id));
    await unstop(s.bindingId);
    expect((await issue()).outcome).toBe("channel_stopped");
    await unstop(bound.binding.id);
    expect((await issue()).outcome).toBe("unknown_conversation");
  });

  test("a send under way when the stop came is not tried again, and what waited is cancelled as the channel is turned on", async () => {
    const s = await stage();
    const outbox = createPostgresSlackOutboxStore(db);
    const claimed = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    const sending = claimed.find((row) => row.channelId === CHANNEL);
    if (!sending) throw new Error("nothing claimed for the channel");
    expect(await outbox.beginSend(sending)).not.toBe(false);
    await stop(s, s.admin);
    const [notice] = await db
      .select({ slackAppId: slackOutbox.slackAppId })
      .from(slackOutbox)
      .where(eq(slackOutbox.kind, "emergency_stop_notice"));
    if (!notice) throw new Error("no notice");
    await db.insert(slackOutbox).values({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      agentId: s.agentId,
      slackAppId: notice.slackAppId,
      installationId: s.installationId,
      kind: "reply",
      channelId: CHANNEL,
      threadTs: "100.000300",
      body: { text: "written while stopped" } as never,
      dedupeKey: "reply:meanwhile",
    });
    expect((await turnOn(s, s.admin, "checked")).outcome).toBe("set");
    // Slack's answer to the send comes only now, the channel on again.
    await outbox.settle(sending, {
      status: "pending",
      errorCode: "ratelimited",
      retryInMs: 1_000,
    });
    const rows = await db
      .select({
        key: slackOutbox.dedupeKey,
        status: slackOutbox.status,
        errorCode: slackOutbox.errorCode,
      })
      .from(slackOutbox)
      .where(eq(slackOutbox.channelId, CHANNEL))
      .orderBy(asc(slackOutbox.seq));
    expect(rows.filter((row) => row.key.startsWith("reply:"))).toEqual([
      {
        key: `reply:${CHANNEL}`,
        status: "failed",
        errorCode: "emergency_stopped",
      },
      {
        key: "reply:meanwhile",
        status: "failed",
        errorCode: "emergency_stopped",
      },
    ]);
  });
});

describe("a session that meets an emergency stop as it is made", () => {
  test("a Slack message to a stopped channel opens no session", async () => {
    const s = await stage();
    const late = await claimedSession(db, gateway, OWNER);
    const [made] = await db
      .select({ releaseId: sessions.agentReleaseId })
      .from(sessions)
      .where(eq(sessions.id, late.sessionId));
    if (!made?.releaseId) throw new Error("no release");
    const [release] = await db
      .select({ agentId: schema.agentReleases.agentId })
      .from(schema.agentReleases)
      .where(eq(schema.agentReleases.id, made.releaseId));
    if (!release) throw new Error("no release row");
    await stop(s, s.admin);
    // The stopped binding is the release's agent's.
    await client.exec("SET session_replication_role = replica");
    await db
      .update(surfaceBindings)
      .set({ agentId: release.agentId })
      .where(eq(surfaceBindings.id, s.bindingId));
    await client.exec("SET session_replication_role = DEFAULT");
    const accept = (channelId: string) =>
      createPostgresSessionUnitOfWork(db).acceptInputAtomic({
        principal: { ...OWNER, requestId: randomUUID() },
        idempotencyKey: randomUUID(),
        payloadHash: randomUUID(),
        repository: {
          id: "sample-app",
          url: "https://example.invalid/app.git",
          branch: "main",
        },
        agentReleaseId: made.releaseId as string,
        model: "claude-sonnet-5",
        message: "from Slack",
        limits: LIMITS,
        slackMessage: {
          team_id: "T0STOP",
          channel_id: channelId,
          ts: "300.000100",
        },
      } as never);
    expect((await accept(CHANNEL)).outcome).toBe("emergency_stopped");
    expect((await accept("C0ELSE")).outcome).toBe("accepted");
  });

  test("a thread's session made but not yet linked is stopped with the channel", async () => {
    const s = await stage();
    const late = await claimedSession(db, gateway, OWNER);
    const next = await gateway.nextInput(late.principal, late.scope);
    if (!next.input) throw new Error("no input delivered");
    await db
      .update(sessions)
      .set({ workspaceId: s.workspaceId })
      .where(eq(sessions.id, late.sessionId));
    const [made] = await db
      .select({ releaseId: sessions.agentReleaseId })
      .from(sessions)
      .where(eq(sessions.id, late.sessionId));
    await client.exec("SET session_replication_role = replica");
    const { link } = await createPostgresSessionLinkStore(db).reserve({
      workspaceId: s.workspaceId,
      installationId: s.installationId,
      surfaceBindingId: s.bindingId,
      surfaceRef: `${CHANNEL}:400.000100`,
      channelId: CHANNEL,
      threadId: "400.000100",
      openedByTs: "400.000100",
      agentId: s.agentId,
      releaseId: made?.releaseId as string,
      createdBy: s.owner.userId,
    });
    // Reserved before the session was made, as a thread's link is.
    await db
      .update(schema.sessionLinks)
      .set({ createdAt: new Date(Date.now() - 3_600_000) })
      .where(eq(schema.sessionLinks.id, link.id));
    // What the session's create left: its receipt under the link's key.
    const receiptId = randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: s.workspaceId,
      actor: null,
      requestId: null,
      operation: CREATE_SESSION,
      targetRef: { session_id: late.sessionId, turn_id: "1", request_id: null },
      status: "accepted",
      result: { session_id: late.sessionId } as never,
    });
    await db.insert(schema.idempotencyKeys).values({
      principal: s.workspaceId,
      operation: CREATE_SESSION,
      resource: SESSIONS_RESOURCE,
      key: link.id,
      payloadHash: "x",
      receiptId,
    } as never);
    await client.exec("SET session_replication_role = DEFAULT");
    expect(await stop(s, s.admin)).toMatchObject({
      outcome: "stopped",
      stopped: { turns: 2 },
    });
    expect(await turnsOf(late.sessionId)).toMatchObject([
      { sequence: 1, status: "failed", reason: "emergency_stopped" },
    ]);
    // Linked only once the channel is on again: its cut turn is still never
    // told there as a failure.
    expect((await turnOn(s, s.admin, "checked")).outcome).toBe("set");
    await createPostgresSessionLinkStore(db).attachSession(
      link.id,
      late.sessionId,
    );
    const owed = await createPostgresSlackOutboxStore(db).unansweredTurns(50);
    expect(owed.filter((turn) => turn.sessionId === late.sessionId)).toEqual(
      [],
    );
  });
});

describe("a session already paused when the channel is stopped", () => {
  test("its waiting input is cancelled, so a resume after the stop runs nothing", async () => {
    const s = await stage();
    // A message queued behind the running turn, then a person's pause: a
    // pause keeps what is queued for the resume.
    expect((await send(s, { message: "queued behind" })).outcome).toBe(
      "accepted",
    );
    // The pause has settled: its turn drained, its execution gone.
    await db
      .update(turns)
      .set({ status: "completed", endedAt: new Date() })
      .where(
        and(eq(turns.sessionId, s.worker.sessionId), eq(turns.sequence, 1)),
      );
    await executionGone(s.worker);
    await db
      .update(sessions)
      .set({
        admissionState: "paused",
        pauseReason: null,
        workspaceId: s.workspaceId,
      })
      .where(eq(sessions.id, s.worker.sessionId));
    expect(await sessionOf(s.worker.sessionId)).toMatchObject({
      admissionState: "paused",
      pauseReason: null,
    });
    expect((await stop(s, s.admin)).outcome).toBe("stopped");
    expect(await sessionOf(s.worker.sessionId)).toMatchObject({
      admissionState: "paused",
      pauseReason: "emergency_stopped",
    });
    expect((await turnsOf(s.worker.sessionId))[1]).toMatchObject({
      sequence: 2,
      status: "cancelled",
    });
  });
});

describe("a session waiting on a decision when the channel is stopped", () => {
  for (const state of ["recovery_required", "stopped"] as const) {
    test(`${state}: its waiting input is cancelled and no decision puts it back to work`, async () => {
      const s = await stage();
      expect((await send(s, { message: "queued behind" })).outcome).toBe(
        "accepted",
      );
      await db
        .update(turns)
        .set({ status: "completed", endedAt: new Date() })
        .where(
          and(eq(turns.sessionId, s.worker.sessionId), eq(turns.sequence, 1)),
        );
      await executionGone(s.worker);
      await db
        .update(sessions)
        .set({ admissionState: state, workspaceId: s.workspaceId })
        .where(eq(sessions.id, s.worker.sessionId));
      expect((await stop(s, s.admin)).outcome).toBe("stopped");
      expect(await sessionOf(s.worker.sessionId)).toMatchObject({
        admissionState: state,
      });
      expect((await turnsOf(s.worker.sessionId))[1]).toMatchObject({
        sequence: 2,
        status: "cancelled",
      });
      for (const decision of ["start_fresh", "retry_restore"] as const) {
        const decided = await decideRecoveryAtomic(db, {
          principal: { ...OWNER, requestId: randomUUID() },
          sessionId: s.worker.sessionId,
          idempotencyKey: randomUUID(),
          payloadHash: randomUUID(),
          decision: {
            decision,
            reason: "try again",
            expected_revision: (await sessionOf(s.worker.sessionId)).revision,
          },
          now: new Date(),
        });
        expect(decided.outcome).toBe("emergency_stopped");
      }
    });
  }
});

describe("a post that meets an emergency stop as it goes", () => {
  test("one claimed as the stop ran does not begin once it has", async () => {
    const s = await stage();
    const outbox = createPostgresSlackOutboxStore(db);
    const claimed = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    const row = claimed.find((post) => post.channelId === CHANNEL);
    if (!row) throw new Error("nothing claimed for the channel");
    const held = await client.query<{ value: string }>(
      "SELECT CAST(claim_token AS text) AS value FROM slack_outbox WHERE id = $1",
      [row.id],
    );
    expect((await stop(s, s.admin)).outcome).toBe("stopped");
    // Written and claimed after the stop's cancel, before it committed.
    await client.query(
      `UPDATE slack_outbox SET (status, error_code, claim_token, lease_expires_at)
        = ('pending', NULL, CAST($2 AS uuid), now() + interval '30 seconds')
       WHERE id = $1`,
      [row.id, held.rows[0]?.value],
    );
    expect(await outbox.beginSend(row)).toBe(false);
    const [after] = await db
      .select({ status: slackOutbox.status, errorCode: slackOutbox.errorCode })
      .from(slackOutbox)
      .where(eq(slackOutbox.id, row.id));
    expect(after).toEqual({ status: "failed", errorCode: "emergency_stopped" });
  });

  test("a reaction under way when the stop came is not asked for again once its lease lapses", async () => {
    const s = await stage();
    await stop(s, s.admin);
    const [notice] = await db
      .select({ slackAppId: slackOutbox.slackAppId })
      .from(slackOutbox)
      .where(eq(slackOutbox.kind, "emergency_stop_notice"));
    if (!notice) throw new Error("no notice");
    const id = randomUUID();
    await db.insert(slackOutbox).values({
      id,
      workspaceId: s.workspaceId,
      agentId: s.agentId,
      slackAppId: notice.slackAppId,
      installationId: s.installationId,
      kind: "reaction",
      channelId: CHANNEL,
      threadTs: "100.000300",
      body: { name: "eyes", timestamp: "100.000300" } as never,
      dedupeKey: "reaction:under-way",
    });
    // Sending when the stop marked it; the channel is on before its lease
    // lapses.
    await client.query(
      `UPDATE slack_outbox SET status = 'sending', error_code = 'emergency_stopped',
        attempts = 1, claim_token = gen_random_uuid(),
        lease_expires_at = now() - interval '1 second'
       WHERE id = $1`,
      [id],
    );
    expect((await turnOn(s, s.admin, "checked")).outcome).toBe("set");
    await createPostgresSlackOutboxStore(db).expireSending();
    const [after] = await db
      .select({ status: slackOutbox.status })
      .from(slackOutbox)
      .where(eq(slackOutbox.id, id));
    expect(after?.status).not.toBe("pending");
  });
});

describe("the same channel id in another Slack team", () => {
  test("is another channel: the stop leaves its work alone", async () => {
    const s = await stage();
    const other = { appId: "A0STOP", teamId: "T0OTHER" };
    await registerSlackInstallation(db, {
      ...other,
      workspaceId: s.workspaceId,
    });
    await verifySlackInstallation(db, { ...other, botUserId: "B0OTHER" });
    const linked = await createPostgresAgentIdentityStore(db).link({
      principal: s.owner,
      workspaceId: s.workspaceId,
      agentId: s.agentId,
      key: other,
      credentialRef: "slack-bot-other",
      managerRoles: MANAGERS,
    });
    if (linked.outcome !== "linked") throw new Error(linked.outcome);
    // The newest install is the one a save writes.
    const bound = await turnOn(s, s.owner);
    if (bound.outcome !== "set") throw new Error(bound.outcome);
    expect(bound.binding.id).not.toBe(s.bindingId);
    const conversation = await createPostgresConversationStore(
      db,
    ).findOrCreateConversation({
      kind: "channel",
      workspaceId: s.workspaceId,
      agentId: s.agentId,
      teamId: other.teamId,
      channelId: CHANNEL,
    });
    const there = await claimedSession(db, gateway, OWNER);
    if (!(await gateway.nextInput(there.principal, there.scope)).input) {
      throw new Error("no input delivered");
    }
    await db
      .update(sessions)
      .set({
        workspaceId: s.workspaceId,
        parentConversationId: conversation.id,
      })
      .where(eq(sessions.id, there.sessionId));
    expect((await stop(s, s.admin)).outcome).toBe("stopped");
    expect(await turnsOf(s.worker.sessionId)).toMatchObject([
      { sequence: 1, status: "failed", reason: "emergency_stopped" },
    ]);
    expect(await turnsOf(there.sessionId)).toMatchObject([
      { sequence: 1, status: "running" },
    ]);
    expect(await emergencyStopHolds(db, s.worker.sessionId)).toBe(true);
    expect(await emergencyStopHolds(db, there.sessionId)).toBe(false);
  });
});

describe("a stop that cancelled input behind the cut-off turn", () => {
  test("[Continue] still takes the cut-off turn once the channel is on", async () => {
    const s = await stage();
    expect((await send(s, { message: "queued behind" })).outcome).toBe(
      "accepted",
    );
    await db
      .update(sessions)
      .set({ workspaceId: s.workspaceId })
      .where(eq(sessions.id, s.worker.sessionId));
    await stoppedAndBack(s);
    expect(await turnsOf(s.worker.sessionId)).toMatchObject([
      { sequence: 1, status: "failed", reason: "emergency_stopped" },
      { sequence: 2, status: "cancelled" },
    ]);
    expect((await send(s, { continueTurn: 1 })).outcome).toBe("accepted");
  });
});

describe("the stop's own line", () => {
  test("the stop's line waits for a send already under way in the channel", async () => {
    const s = await stage();
    const outbox = createPostgresSlackOutboxStore(db);
    const claimed = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    const sending = claimed.find((row) => row.channelId === CHANNEL);
    if (!sending) throw new Error("nothing claimed for the channel");
    expect(await outbox.beginSend(sending)).not.toBe(false);
    await stop(s, s.admin);
    const kinds = async () =>
      (await outbox.claim({ limit: 10, leaseMs: 30_000 })).map(
        (row) => row.kind,
      );
    expect(await kinds()).not.toContain("emergency_stop_notice");
    await outbox.settle(sending, { status: "sent", slackTs: "100.000200" });
    expect(await kinds()).toContain("emergency_stop_notice");
  });

  test("the stop's line is told to a channel waiting for approval", async () => {
    const s = await stage();
    await db
      .update(surfaceBindings)
      .set({ surfaceKind: "private_channel", status: "pending_approval" })
      .where(eq(surfaceBindings.id, s.bindingId));
    expect((await stop(s, s.admin)).outcome).toBe("stopped");
    const outbox = createPostgresSlackOutboxStore(db);
    const claimed = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    expect(claimed.map((row) => row.kind)).toContain("emergency_stop_notice");
  });
});

describe("two installs of one Slack team in the channel", () => {
  async function secondInstall(s: Stage) {
    const second = { appId: "A0SECOND", teamId: "T0STOP" };
    const appRowId = randomUUID();
    await db.insert(slackApps).values({
      id: appRowId,
      workspaceId: s.workspaceId,
      kind: "agent",
      agentId: s.agentId,
      // The agent's one live app is the first's; the row is only what the
      // second install's posts name.
      state: "failed",
      appId: second.appId,
      clientId: "2.stop",
      redirectUrl: "https://example.invalid/slack/callback",
      eventsState: "verified",
    });
    await registerSlackInstallation(db, {
      ...second,
      workspaceId: s.workspaceId,
    });
    await verifySlackInstallation(db, { ...second, botUserId: "B0SECOND" });
    const linked = await createPostgresAgentIdentityStore(db).link({
      principal: s.owner,
      workspaceId: s.workspaceId,
      agentId: s.agentId,
      key: second,
      credentialRef: "slack-bot-second",
      managerRoles: MANAGERS,
    });
    if (linked.outcome !== "linked") throw new Error(linked.outcome);
    return { appRowId, installationId: linked.identity.installationId };
  }

  const postThrough = (
    s: Stage,
    install: { appRowId: string; installationId: string },
    channelId: string,
    dedupeKey: string,
  ) =>
    db.insert(slackOutbox).values({
      id: randomUUID(),
      workspaceId: s.workspaceId,
      agentId: s.agentId,
      slackAppId: install.appRowId,
      installationId: install.installationId,
      kind: "reply",
      channelId,
      threadTs: "100.000100",
      body: { text: "a reply on its way" } as never,
      dedupeKey,
    });

  const stopsOf = async (ids: readonly string[]) =>
    (
      await db
        .select({
          id: surfaceBindings.id,
          stoppedAt: surfaceBindings.emergencyStoppedAt,
        })
        .from(surfaceBindings)
        .where(inArray(surfaceBindings.id, [...ids]))
    ).map((row) => row.stoppedAt !== null);

  const resultOf = async (receiptId: string) => {
    const [row] = await db
      .select({ result: receipts.result })
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    return row?.result as Record<string, unknown> | undefined;
  };

  test("one stop covers both: the other install posts nothing after its line, and turning it on frees both", async () => {
    const s = await stage();
    const b = await secondInstall(s);
    const bound = await turnOn(s, s.owner);
    if (bound.outcome !== "set") throw new Error(bound.outcome);
    expect(bound.binding.id).not.toBe(s.bindingId);
    const both = [s.bindingId, bound.binding.id].sort();
    await postThrough(s, b, CHANNEL, "reply:b-before");
    await postThrough(s, b, "C0ELSE", "reply:b-else");

    // Stopped through the older install's binding.
    const stopped = await stop(s, s.admin);
    if (stopped.outcome !== "stopped") throw new Error(stopped.outcome);
    expect(await stopsOf(both)).toEqual([true, true]);
    expect(
      ((await resultOf(stopped.receiptId))?.surface_binding_ids as string[])
        .slice()
        .sort(),
    ).toEqual(both);
    expect(await stop(s, s.admin)).toMatchObject({
      outcome: "already_stopped",
    });
    await postThrough(s, b, CHANNEL, "reply:b-after");

    const outbox = createPostgresSlackOutboxStore(db);
    const began: string[] = [];
    for (const row of await outbox.claim({ limit: 50, leaseMs: 30_000 })) {
      if ((await outbox.beginSend(row)) !== false) {
        began.push(`${row.kind}:${row.channelId}`);
      }
    }
    // The other channel's posts go out, the stopped channel's only line.
    expect(began.sort()).toEqual(
      [
        `emergency_stop_notice:${CHANNEL}`,
        "reply:C0ELSE",
        "reply:C0ELSE",
      ].sort(),
    );

    const on = await turnOn(s, s.owner, "checked, it was a false alarm");
    if (on.outcome !== "set") throw new Error(on.outcome);
    expect(on.binding.id).toBe(bound.binding.id);
    expect(await stopsOf(both)).toEqual([false, false]);
    const ended = (await resultOf(on.receiptId))?.emergency_stop_ended as {
      surface_binding_ids: string[];
    };
    expect(ended.surface_binding_ids.slice().sort()).toEqual(both);
    const left = await db
      .select({ status: slackOutbox.status })
      .from(slackOutbox)
      .where(
        and(
          eq(slackOutbox.installationId, b.installationId),
          eq(slackOutbox.channelId, CHANNEL),
        ),
      );
    expect(left.map((row) => row.status)).toEqual(["failed", "failed"]);
  });

  test("a post through an install with no binding of the channel is held as well", async () => {
    const s = await stage();
    const b = await secondInstall(s);
    await postThrough(s, b, CHANNEL, "reply:b-before");
    await postThrough(s, b, "C0ELSE", "reply:b-else");
    expect((await stop(s, s.admin)).outcome).toBe("stopped");
    await postThrough(s, b, CHANNEL, "reply:b-after");
    const outbox = createPostgresSlackOutboxStore(db);
    const began: string[] = [];
    for (const row of await outbox.claim({ limit: 50, leaseMs: 30_000 })) {
      if (
        row.installationId === b.installationId &&
        (await outbox.beginSend(row)) !== false
      ) {
        began.push(`${row.kind}:${row.channelId}`);
      }
    }
    expect(began).toEqual(["reply:C0ELSE"]);
    const rows = await db
      .select({ key: slackOutbox.dedupeKey, status: slackOutbox.status })
      .from(slackOutbox)
      .where(
        and(
          eq(slackOutbox.installationId, b.installationId),
          eq(slackOutbox.channelId, CHANNEL),
        ),
      )
      .orderBy(asc(slackOutbox.dedupeKey));
    expect(rows).toEqual([
      { key: "reply:b-after", status: "pending" },
      { key: "reply:b-before", status: "failed" },
    ]);
  });

  test("a channel the other install's bot is invited to while the stop holds starts stopped", async () => {
    const s = await stage();
    const b = await secondInstall(s);
    expect((await stop(s, s.admin)).outcome).toBe("stopped");
    const joined = await store().ensureInvitedChannel(
      b.installationId,
      CHANNEL,
      "public_channel",
    );
    expect(joined?.emergencyStop?.reason).toBe("a leak suspected");
    expect(joined?.mode).toBe("off");
  });

  test("a thread linked through an install whose binding is gone stays held", async () => {
    const s = await stage();
    const b = await secondInstall(s);
    const bound = await turnOn(s, s.owner);
    if (bound.outcome !== "set") throw new Error(bound.outcome);
    const [made] = await db
      .select({ releaseId: sessions.agentReleaseId })
      .from(sessions)
      .where(eq(sessions.id, s.worker.sessionId));
    if (!made?.releaseId) throw new Error("no release");
    await db
      .update(sessions)
      .set({ parentConversationId: null })
      .where(eq(sessions.id, s.worker.sessionId));
    const links = createPostgresSessionLinkStore(db);
    await client.exec("SET session_replication_role = replica");
    const { link } = await links.reserve({
      workspaceId: s.workspaceId,
      installationId: s.installationId,
      surfaceBindingId: s.bindingId,
      surfaceRef: `${CHANNEL}:300.000100`,
      channelId: CHANNEL,
      threadId: "300.000100",
      openedByTs: "300.000100",
      agentId: s.agentId,
      releaseId: made.releaseId,
      createdBy: s.owner.userId,
    });
    await client.exec("SET session_replication_role = DEFAULT");
    await links.attachSession(link.id, s.worker.sessionId);
    expect((await stop(s, s.admin)).outcome).toBe("stopped");
    expect(await emergencyStopHolds(db, s.worker.sessionId)).toBe(true);
    // The first install's binding goes, as a revoke of its identity takes it.
    await db
      .update(surfaceBindings)
      .set({ revokedAt: new Date(), status: "revoked" })
      .where(eq(surfaceBindings.id, s.bindingId));
    expect(b.installationId).not.toBe(s.installationId);
    expect(await emergencyStopHolds(db, s.worker.sessionId)).toBe(true);
  });

  test("a binding written while the stop holds starts stopped", async () => {
    const s = await stage();
    expect((await stop(s, s.admin)).outcome).toBe("stopped");
    await secondInstall(s);
    const saved = await store().set({
      principal: s.owner,
      workspaceId: s.workspaceId,
      agentId: s.agentId,
      channelId: CHANNEL,
      channelKind: "public_channel",
      mode: "off",
      home: false,
      ceiling: DEFAULT_SURFACE_CEILING,
      managerRoles: MANAGERS,
    });
    if (saved.outcome !== "set") throw new Error(saved.outcome);
    expect(saved.binding.id).not.toBe(s.bindingId);
    expect(saved.binding.emergencyStop?.reason).toBe("a leak suspected");
    expect(saved.binding.mode).toBe("off");
    expect((await turnOn(s, s.owner)).outcome).toBe("reason_required");
    expect(
      (await turnOn(s, s.owner, "checked, it was a false alarm")).outcome,
    ).toBe("set");
    expect(await stopsOf([s.bindingId, saved.binding.id])).toEqual([
      false,
      false,
    ]);
  });
});
