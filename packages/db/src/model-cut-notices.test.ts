import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { enqueueModelCutNotices } from "./model-cut-notices.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agentReleases,
  agents,
  attempts,
  events,
  linkedAccounts,
  memberships,
  memberTeamMembers,
  memberTeams,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
  users,
  workspaces,
} from "./schema.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

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
  const inTeam = async (team: string, who: Person, role: "lead" | "member") => {
    await db.insert(memberTeamMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      teamId: team,
      userId: who.userId,
      role,
    });
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
  const outbox = () => db.select().from(slackOutbox);
  return {
    workspaceId,
    agentId,
    sessionId,
    teamId,
    installationId,
    person,
    inTeam,
    startSession,
    outbox,
  };
}

describe("enqueueModelCutNotices", () => {
  test("tells the creator and each administrator once, as direct messages", async () => {
    const w = await world();
    const creator = await w.person("creator", { locale: "en" });
    const direct = await w.person("direct", { locale: "ja" });
    const lead = await w.person("lead");
    const viaTeam = await w.person("viateam");
    const plainMember = await w.person("plain");
    const outsider = await w.person("outsider");
    await w.inTeam(w.teamId, lead, "lead");
    await w.inTeam(w.teamId, plainMember, "member");
    const adminTeam = crypto.randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: adminTeam, workspaceId: w.workspaceId, name: "admins" });
    await w.inTeam(adminTeam, viaTeam, "member");
    await db.insert(agentAdminTeams).values({
      workspaceId: w.workspaceId,
      agentId: w.agentId,
      teamId: adminTeam,
    });
    await db.insert(agentAdmins).values({
      workspaceId: w.workspaceId,
      agentId: w.agentId,
      userId: direct.userId,
    });
    await w.startSession(creator);

    expect(
      await enqueueModelCutNotices(db, {
        sessionId: w.sessionId,
        model: "claude-opus-5-5",
      }),
    ).toBe(4);

    const rows = await w.outbox();
    expect(rows.map((row) => row.channelId).sort()).toEqual(
      [creator, direct, lead, viaTeam].map((p) => p.slackUserId).sort(),
    );
    expect(rows.map((row) => row.channelId)).not.toContain(
      plainMember.slackUserId,
    );
    expect(rows.map((row) => row.channelId)).not.toContain(
      outsider.slackUserId,
    );
    for (const row of rows) {
      expect(row.kind).toBe("model_notice");
      expect(row.threadTs).toBe("");
      expect(row.slackUserId).toBeNull();
      expect(row.sessionId).toBe(w.sessionId);
      expect(row.installationId).toBe(w.installationId);
      expect(row.agentId).toBe(w.agentId);
      expect(row.body.text).toContain("claude-opus-5-5");
      expect(row.dedupeKey).toBe(
        `model-not-allowed:${w.workspaceId}:${w.sessionId}:${row.channelId}`,
      );
    }
    const textOf = (who: Person) =>
      rows.find((row) => row.channelId === who.slackUserId)?.body.text;
    expect(textOf(creator)).toStartWith("The session stopped.");
    expect(textOf(direct)).toStartWith("セッションが止まりました。");
    // No locale on the account reads English.
    expect(textOf(lead)).toStartWith("The session stopped.");
  });

  test("a second cut of the session, or a later administrator, adds nothing for the told", async () => {
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
    const cut = { sessionId: w.sessionId, model: "claude-opus-5-5" };
    expect(await enqueueModelCutNotices(db, cut)).toBe(1);
    expect(await enqueueModelCutNotices(db, cut)).toBe(0);
    const late = await w.person("late");
    await db.insert(agentAdmins).values({
      workspaceId: w.workspaceId,
      agentId: w.agentId,
      userId: late.userId,
    });
    // The new administrator was not told at the first cut, and is now.
    expect(await enqueueModelCutNotices(db, cut)).toBe(1);
    expect(await w.outbox()).toHaveLength(2);
  });

  test("passes over disabled members, revoked or missing links and other Slack teams", async () => {
    const w = await world();
    const creator = await w.person("creator", { disabled: true });
    const revoked = await w.person("revoked", { link: "revoked" });
    const unlinked = await w.person("unlinked", { link: "none" });
    const elsewhere = await w.person("elsewhere", { tenant: "T2" });
    for (const who of [revoked, unlinked, elsewhere]) {
      await db.insert(agentAdmins).values({
        workspaceId: w.workspaceId,
        agentId: w.agentId,
        userId: who.userId,
      });
    }
    await w.startSession(creator);
    expect(
      await enqueueModelCutNotices(db, {
        sessionId: w.sessionId,
        model: "claude-opus-5-5",
      }),
    ).toBe(0);
    expect(await w.outbox()).toEqual([]);
  });

  test("writes nothing without a verified installation of the agent's app", async () => {
    const w = await world({ installation: "pending" });
    const creator = await w.person("creator");
    await w.startSession(creator);
    expect(
      await enqueueModelCutNotices(db, {
        sessionId: w.sessionId,
        model: "claude-opus-5-5",
      }),
    ).toBe(0);
  });

  test("a session without a creator tells the administrators only", async () => {
    const w = await world();
    const admin = await w.person("admin");
    // Linked and enabled, but neither creator nor administrator.
    await w.person("bystander");
    await db.insert(agentAdmins).values({
      workspaceId: w.workspaceId,
      agentId: w.agentId,
      userId: admin.userId,
    });
    await w.startSession(null);
    expect(
      await enqueueModelCutNotices(db, {
        sessionId: w.sessionId,
        model: "claude-opus-5-5",
      }),
    ).toBe(1);
    expect((await w.outbox()).map((row) => row.channelId)).toEqual([
      admin.slackUserId,
    ]);
  });

  test("the cut's error event and its notices are written by the same call, once per person across attempts", async () => {
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
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
    // A later attempt cut for the same reason adds an event, not a second DM.
    expect(await cut("att-2")).toEqual({ recorded: true });
    expect(await w.outbox()).toHaveLength(1);
    expect(
      await db
        .select({ attemptId: events.attemptId })
        .from(events)
        .where(eq(events.type, "error")),
    ).toHaveLength(2);
  });

  test("a call for an attempt the session does not have writes no notice", async () => {
    const w = await world();
    const creator = await w.person("creator");
    await w.startSession(creator);
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

  test("a connection that is gone says so in the event and the DM, still naming the model", async () => {
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
    await createPostgresWorkerUnitOfWork(db).recordModelCutAtomic({
      sessionId: w.sessionId,
      attemptId: "att-1",
      model: "claude-opus-5-5",
      cause: "connection_removed",
    });
    const [event] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.type, "error"));
    expect(event?.payload).toMatchObject({
      code: "MODEL_NOT_ALLOWED",
      model: "claude-opus-5-5",
      cause: "connection_removed",
    });
    const [dm] = await w.outbox();
    expect(dm?.body).toMatchObject({
      text: expect.stringMatching(/claude-opus-5-5.* is gone/),
    });
  });

  test("a session from before workspaces and releases has nobody to tell", async () => {
    const w = await world();
    await w.person("creator");
    await db.insert(sessions).values({
      id: w.sessionId,
      ownerId: "owner-legacy",
      repoUrl: "https://github.com/acme/app.git",
      branch: "main",
      repositoryId: "app",
      checkpointRevision: 1,
    });
    expect(
      await enqueueModelCutNotices(db, {
        sessionId: w.sessionId,
        model: "claude-opus-5-5",
      }),
    ).toBe(0);
  });
});
