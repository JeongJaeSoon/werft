import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SessionScope } from "@werft-ai/contracts";
import {
  createWorkerGateway,
  type IdentityReader,
  type Principal,
  type WorkerGateway,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { issuePasswordReset } from "./identity.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import { createPostgresMemberStore } from "./members.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler-store.ts";
import * as schema from "./schema.ts";
import {
  agents,
  apiKeys,
  memberships,
  passwordResets,
  receipts,
  sessions,
  turns,
  unassignedSessions,
  users,
  webSessions,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { launchSession } from "./testing/launches.ts";
import {
  fixtureRelease,
  releaseSpecColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const ALL_SCOPES: SessionScope[] = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
  "sessions:control",
  "sessions:recover",
];

type Reread = Parameters<IdentityReader["reread"]>[0];

integration("members, identity and takeover on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let gateway: WorkerGateway;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "members_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    gateway = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: testSessionCatalog({
        provider: {
          kind: "litellm",
          endpoint: "https://litellm.invalid",
          auth: {
            kind: "api_key",
            value: "catalog-provider-key",
            ref: { value_env: "PROVIDER_KEY" },
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
      }),
      checkpoints: {
        async verify() {
          return { status: "verified" };
        },
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 5_000,
        sleep: async () => {},
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function member(workspaceId: string, role: "owner" | "member") {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return userId;
  }

  async function webSession(userId: string) {
    const id = randomUUID();
    await db.insert(webSessions).values({
      id,
      userId,
      tokenHash: new TextEncoder().encode(id),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return id;
  }

  // An agent key starts sessions only on its agent's release.
  const releaseOfKey = new Map<string, string>();
  async function key(
    workspaceId: string,
    options: {
      personalFor?: string;
      expiresAt?: Date;
      scopes?: SessionScope[];
    } = {},
  ) {
    const id = randomUUID();
    // Without a person, the key is an agent's: no key reaches a workspace.
    const agentId = options.personalFor === undefined ? randomUUID() : null;
    if (agentId !== null) {
      await db.insert(agents).values({
        id: agentId,
        workspaceId,
        managingTeamId: await fixtureTeam(db, workspaceId),
        slug: agentId,
        name: "bot",
      });
      const versionId = randomUUID();
      await db.insert(schema.agentVersions).values({
        id: versionId,
        agentId,
        versionNo: 1,
        card: {},
        contentSha256: "a".repeat(64),
      });
      const releaseId = `rel-${randomUUID()}`;
      await db.insert(schema.agentReleases).values({
        id: releaseId,
        agentId,
        versionId,
        cardSha256: "a".repeat(64),
        connectionId: TEST_CONNECTION_ID,
        ...releaseSpecColumns(),
        runtimeConfigSnapshot: {},
        effectiveTools: [],
      });
      releaseOfKey.set(id, releaseId);
    }
    await db.insert(apiKeys).values({
      id,
      keyHash: new TextEncoder().encode(id),
      ownerId: workspaceId,
      workspaceId,
      scopes: options.scopes ?? ALL_SCOPES,
      ...(agentId === null
        ? { kind: "personal", createdByUserId: options.personalFor }
        : { kind: "agent", agentId }),
      ...(options.expiresAt === undefined
        ? {}
        : { expiresAt: options.expiresAt }),
    });
    return id;
  }

  const reader = () => createDatabaseIdentityReader(db);
  const userSubject = (userId: string, workspaceId: string): Reread =>
    ({
      principal: {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role: "owner",
        scopes: ALL_SCOPES,
      },
    }) as Reread;
  const keySubject = (keyId: string, workspaceId: string): Reread =>
    ({
      principal: {
        kind: "api_key",
        id: keyId,
        owner_id: workspaceId,
        workspace_id: workspaceId,
        scopes: ALL_SCOPES,
      },
    }) as Reread;

  function asUser(workspaceId: string, userId: string): Principal {
    return {
      ownerId: workspaceId,
      actor: {
        principal: { kind: "user", id: userId },
        userId,
        workspaceId,
        apiKeyId: null,
      },
    };
  }

  function asKey(workspaceId: string, keyId: string, userId: string | null) {
    return {
      ownerId: workspaceId,
      actor: {
        principal: { kind: "api_key" as const, id: keyId },
        userId,
        workspaceId,
        apiKeyId: keyId,
      },
    };
  }

  async function createSession(principal: Principal, agentReleaseId?: string) {
    const result = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal,
      idempotencyKey: randomUUID(),
      payloadHash: randomUUID(),
      agentReleaseId: await fixtureRelease(db, principal.ownerId),
      model: TEST_MODEL,
      repository: {
        id: "sample-app",
        url: "https://example.invalid/app.git",
        branch: "main",
      },
      message: "first input",
      ...(agentReleaseId ? { agentReleaseId } : {}),
    });
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    return result.response;
  }

  function append(principal: Principal, sessionId: string) {
    return createPostgresSessionUnitOfWork(db).appendInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal,
      sessionId,
      idempotencyKey: randomUUID(),
      payloadHash: randomUUID(),
      message: "next input",
    });
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error("session vanished");
    return row;
  }

  async function receiptRow(id: string) {
    const [row] = await db.select().from(receipts).where(eq(receipts.id, id));
    if (!row) throw new Error("receipt vanished");
    return row;
  }

  // Authorization reads the membership before the write transaction opens;
  // an offboarding that commits in between must not let the write through.
  async function offboardingInFlight(ws: string, userId: string) {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "UPDATE memberships SET disabled_at = now() WHERE workspace_id = $1 AND user_id = $2",
      [ws, userId],
    );
    return async () => {
      await client.query(
        "UPDATE sessions SET takeover_required_at = now() WHERE workspace_id = $1 AND created_by_user_id = $2",
        [ws, userId],
      );
      await client.query("COMMIT");
      client.release();
    };
  }

  async function lockWaiter() {
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await pool.query<{ waiting: string }>(
        "SELECT count(*)::text AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (Number(rows[0]?.waiting) >= 1) return;
      await Bun.sleep(10);
    }
    throw new Error("the write never waited on the membership");
  }

  function setAccess(
    workspaceId: string,
    actingUserId: string,
    userId: string,
    change: {
      scope?: "membership" | "account";
      disabled?: boolean;
      reason?: string | null;
    } = {},
  ) {
    return createPostgresMemberStore(db).setAccess({
      actor: {
        principal: { ...asUser(workspaceId, actingUserId), requestId: "req-1" },
        workspaceId,
        userId: actingUserId,
      },
      userId,
      scope: change.scope ?? "membership",
      disabled: change.disabled ?? true,
      reason: change.reason ?? null,
      receiptId: randomUUID(),
    });
  }

  // Offboarding as a fresh owner of the workspace.
  async function offboardBy(workspaceId: string, userId: string) {
    return setAccess(workspaceId, await member(workspaceId, "owner"), userId);
  }

  async function membershipDisabledAt(ws: string, userId: string) {
    const [row] = await db
      .select({ disabledAt: memberships.disabledAt })
      .from(memberships)
      .where(
        and(eq(memberships.workspaceId, ws), eq(memberships.userId, userId)),
      );
    return row?.disabledAt;
  }

  async function cookieRevoked(id: string) {
    const [row] = await db
      .select({ revokedAt: webSessions.revokedAt })
      .from(webSessions)
      .where(eq(webSessions.id, id));
    return row?.revokedAt !== null;
  }

  describe("who acts is recorded", () => {
    test("a cookie caller is the session's requester, the turn's actor and the receipt's", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const created = await createSession(asUser(ws, owner));
      const row = await sessionRow(created.session_id);
      expect(row.workspaceId).toBe(ws);
      expect(row.createdByUserId).toBe(owner);
      expect(row.createdByApiKeyId).toBeNull();
      const [turn] = await db
        .select({ actorId: turns.actorId })
        .from(turns)
        .where(eq(turns.sessionId, created.session_id));
      expect(turn?.actorId).toBe(owner);
      expect((await receiptRow(created.receipt_id)).actor).toEqual({
        principal: { kind: "user", id: owner },
        actor_user_id: owner,
        agent_id: null,
      });
    });

    test("an agent key records only the key; a personal key also its person", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const service = await key(ws);
      const personal = await key(ws, { personalFor: owner });

      const byService = await createSession(
        asKey(ws, service, null),
        releaseOfKey.get(service),
      );
      const serviceRow = await sessionRow(byService.session_id);
      expect(serviceRow.createdByApiKeyId).toBe(service);
      expect(serviceRow.createdByUserId).toBeNull();
      expect((await receiptRow(byService.receipt_id)).actor).toEqual({
        principal: { kind: "api_key", id: service },
        actor_user_id: null,
        agent_id: null,
      });

      const byPersonal = await createSession(asKey(ws, personal, owner));
      const personalRow = await sessionRow(byPersonal.session_id);
      expect(personalRow.createdByApiKeyId).toBe(personal);
      expect(personalRow.createdByUserId).toBe(owner);
    });

    test("a caller with no actor, as before, writes none", async () => {
      const ownerId = randomUUID();
      const created = await createSession({ ownerId });
      const row = await sessionRow(created.session_id);
      expect(row.workspaceId).toBeNull();
      expect(row.createdByUserId).toBeNull();
      expect(row.createdByApiKeyId).toBeNull();
      expect((await receiptRow(created.receipt_id)).actor).toBeNull();
    });
  });

  describe("the identity reader reads every decision afresh", () => {
    test("a user is narrowed to the role they hold now and refused once disabled", async () => {
      const ws = await workspace();
      const user = await member(ws, "member");
      const read = await reader().reread(userSubject(user, ws));
      if (read.status !== "ok") throw new Error(read.status);
      expect(read.principal).toMatchObject({ kind: "user", role: "member" });
      expect(read.principal.scopes).not.toContain("sessions:recover");

      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, user));
      expect(await reader().reread(userSubject(user, ws))).toEqual({
        status: "disabled",
      });
    });

    test("a personal key stops with its creator while a service key keeps working", async () => {
      const ws = await workspace();
      const creator = await member(ws, "member");
      const personal = await key(ws, { personalFor: creator });
      const service = await key(ws);

      const before = await reader().reread(keySubject(personal, ws));
      expect(before).toMatchObject({
        status: "ok",
        keyCreator: { userId: creator, role: "member" },
      });

      await db
        .update(memberships)
        .set({ disabledAt: new Date() })
        .where(
          and(eq(memberships.workspaceId, ws), eq(memberships.userId, creator)),
        );
      expect(await reader().reread(keySubject(personal, ws))).toEqual({
        status: "disabled",
      });
      const kept = await reader().reread(keySubject(service, ws));
      expect(kept.status).toBe("ok");
      expect(kept).not.toHaveProperty("keyCreator");
    });

    test("an expired key, a revoked key and a key that is no row are refused", async () => {
      const ws = await workspace();
      const expired = await key(ws, { expiresAt: new Date(Date.now() - 1) });
      const revoked = await key(ws);
      await db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(eq(apiKeys.id, revoked));
      for (const id of [expired, revoked, "owner-a"]) {
        expect(await reader().reread(keySubject(id, ws))).toEqual({
          status: "disabled",
        });
      }
    });
  });

  describe("offboarding", () => {
    test("a session asked for while offboarding commits is refused, never left running", async () => {
      const ws = await workspace();
      const leaver = await member(ws, "member");
      const commit = await offboardingInFlight(ws, leaver);
      const creating = createPostgresSessionUnitOfWork(db).acceptInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: asUser(ws, leaver),
        idempotencyKey: randomUUID(),
        payloadHash: randomUUID(),
        agentReleaseId: await fixtureRelease(db, asUser(ws, leaver).ownerId),
        model: TEST_MODEL,
        repository: {
          id: "sample-app",
          url: "https://example.invalid/app.git",
          branch: "main",
        },
        message: "first input",
      });
      await lockWaiter();
      await commit();
      expect(await creating).toEqual({ outcome: "actor_inactive" });
      const left = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.createdByUserId, leaver));
      expect(left).toEqual([]);
    });

    test("a message sent while offboarding commits is refused", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const leaver = await member(ws, "member");
      // The owner's session: offboarding does not mark it, so only the
      // membership can stop the leaver's message.
      const created = await createSession(asUser(ws, owner));
      const commit = await offboardingInFlight(ws, leaver);
      const appending = append(asUser(ws, leaver), created.session_id);
      await lockWaiter();
      await commit();
      expect(await appending).toEqual({ outcome: "actor_inactive" });
    });

    test("a message sent while the account is suspended is refused", async () => {
      const ws = await workspace();
      const leaver = await member(ws, "member");
      const created = await createSession(asUser(ws, leaver));
      const client = await pool.connect();
      await client.query("BEGIN");
      // An account suspension's order: the user row, then its memberships.
      await client.query("UPDATE users SET disabled_at = now() WHERE id = $1", [
        leaver,
      ]);
      await client.query(
        "SELECT 1 FROM memberships WHERE user_id = $1 FOR UPDATE",
        [leaver],
      );
      const appending = append(asUser(ws, leaver), created.session_id);
      await lockWaiter();
      await client.query("COMMIT");
      client.release();
      expect(await appending).toEqual({ outcome: "actor_inactive" });
    });

    test("one transaction disables the member, ends their web sessions and personal keys, and marks what they asked for", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const leaver = await member(ws, "member");
      const cookie = await webSession(leaver);
      const ownerCookie = await webSession(owner);
      const personal = await key(ws, { personalFor: leaver });
      const service = await key(ws);
      const asked = await createSession(asUser(ws, leaver));
      const ownersOwn = await createSession(asUser(ws, owner));

      const result = await offboardBy(ws, leaver);
      expect(result).toMatchObject({
        outcome: "changed",
        member: { userId: leaver, disabledAt: expect.any(Date) },
        effects: {
          disabled: true,
          revokedWebSessions: 1,
          revokedPersonalKeys: 1,
          revokedLinkedAccounts: 0,
          sessionsAwaitingTakeover: 1,
        },
      });

      const [membership] = await db
        .select({ disabledAt: memberships.disabledAt })
        .from(memberships)
        .where(
          and(eq(memberships.workspaceId, ws), eq(memberships.userId, leaver)),
        );
      expect(membership?.disabledAt).not.toBeNull();
      const cookies = await db
        .select({ id: webSessions.id, revokedAt: webSessions.revokedAt })
        .from(webSessions)
        .where(eq(webSessions.userId, leaver));
      expect(cookies).toEqual([{ id: cookie, revokedAt: expect.any(Date) }]);
      const [ownerCookieRow] = await db
        .select({ revokedAt: webSessions.revokedAt })
        .from(webSessions)
        .where(eq(webSessions.id, ownerCookie));
      expect(ownerCookieRow?.revokedAt).toBeNull();

      const keyRows = await db
        .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
        .from(apiKeys)
        .where(eq(apiKeys.workspaceId, ws));
      const revokedAt = new Map(keyRows.map((row) => [row.id, row.revokedAt]));
      expect(revokedAt.get(personal)).not.toBeNull();
      expect(revokedAt.get(service)).toBeNull();
      expect((await reader().reread(keySubject(service, ws))).status).toBe(
        "ok",
      );

      expect(
        (await sessionRow(asked.session_id)).takeoverRequiredAt,
      ).not.toBeNull();
      expect(
        (await sessionRow(ownersOwn.session_id)).takeoverRequiredAt,
      ).toBeNull();

      expect(await offboardBy(ws, leaver)).toMatchObject({
        outcome: "unchanged",
      });
    });

    test("two owners offboarding each other leave one owner standing", async () => {
      const ws = await workspace();
      const first = await member(ws, "owner");
      const second = await member(ws, "owner");
      // The first owner's offboarding of the second is under way.
      const commit = await offboardingInFlight(ws, second);
      const reverse = setAccess(ws, second, first);
      await lockWaiter();
      await commit();
      expect(await reverse).toEqual({ outcome: "actor_inactive" });
      const [kept] = await db
        .select({ disabledAt: memberships.disabledAt })
        .from(memberships)
        .where(
          and(eq(memberships.workspaceId, ws), eq(memberships.userId, first)),
        );
      expect(kept?.disabledAt).toBeNull();
    });

    test("a cookie that would resolve to another workspace is ended too", async () => {
      // A cookie resolves to the oldest live membership, so one kept alive
      // would go on working under the other workspace.
      const left = await workspace();
      const other = await workspace();
      const leaver = await member(left, "member");
      await db
        .insert(memberships)
        .values({ workspaceId: other, userId: leaver, role: "member" });
      const cookie = await webSession(leaver);
      await offboardBy(left, leaver);
      const [row] = await db
        .select({ revokedAt: webSessions.revokedAt })
        .from(webSessions)
        .where(eq(webSessions.id, cookie));
      expect(row?.revokedAt).not.toBeNull();
    });

    test("restoring the membership does not bring a personal key back", async () => {
      const ws = await workspace();
      const leaver = await member(ws, "member");
      const personal = await key(ws, { personalFor: leaver });
      await offboardBy(ws, leaver);
      await db
        .update(memberships)
        .set({ disabledAt: null })
        .where(
          and(eq(memberships.workspaceId, ws), eq(memberships.userId, leaver)),
        );
      expect(await reader().reread(userSubject(leaver, ws))).toMatchObject({
        status: "ok",
      });
      expect(await reader().reread(keySubject(personal, ws))).toEqual({
        status: "disabled",
      });
    });
  });

  describe("disabling and enabling", () => {
    test("no password reset link is issued for a disabled member or a suspended account", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const off = await member(ws, "member");
      const suspended = await member(ws, "member");
      await db
        .update(memberships)
        .set({ disabledAt: new Date() })
        .where(eq(memberships.userId, off));
      await db
        .update(users)
        .set({ disabledAt: new Date() })
        .where(eq(users.id, suspended));
      for (const userId of [off, suspended]) {
        expect(
          await issuePasswordReset(db, {
            id: randomUUID(),
            workspaceId: ws,
            userId,
            issuedBy: owner,
            issuerPasswordHash: "argon2id$placeholder",
            tokenHash: new Uint8Array(32),
            ttlMs: 60_000,
            receiptId: randomUUID(),
          }),
        ).toEqual({ outcome: "not_found" });
      }
      expect(await db.select().from(passwordResets)).toEqual([]);
    });

    test("each change leaves a receipt naming its actor, target, request and reason; a no-op leaves none", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const target = await member(ws, "member");
      const off = await setAccess(ws, owner, target, { reason: "left" });
      if (off.outcome !== "changed") throw new Error(off.outcome);
      const receipt = await receiptRow(off.receiptId);
      expect(receipt).toMatchObject({
        ownerId: ws,
        operation: "disable_member",
        requestId: "req-1",
        status: "succeeded",
        targetRef: { user_id: target, workspace_id: ws },
        actor: {
          principal: { kind: "user", id: owner },
          actor_user_id: owner,
          agent_id: null,
        },
        result: {
          reason: "left",
          revoked_web_sessions: 0,
          revoked_personal_keys: 0,
          revoked_linked_accounts: 0,
          sessions_awaiting_takeover: 0,
        },
      });
      const before = await db.$count(receipts);
      expect(await setAccess(ws, owner, target)).toMatchObject({
        outcome: "unchanged",
      });
      expect(await db.$count(receipts)).toBe(before);

      const on = await setAccess(ws, owner, target, { disabled: false });
      if (on.outcome !== "changed") throw new Error(on.outcome);
      expect(await receiptRow(on.receiptId)).toMatchObject({
        operation: "enable_member",
        result: { reason: null, sessions_released: 0 },
      });
      for (const [disabled, operation] of [
        [true, "disable_user"],
        [false, "enable_user"],
      ] as const) {
        const done = await setAccess(ws, owner, target, {
          scope: "account",
          disabled,
        });
        if (done.outcome !== "changed") throw new Error(done.outcome);
        expect((await receiptRow(done.receiptId)).operation).toBe(operation);
      }
    });

    test("enabling brings back neither the cookie nor the personal key, but hands back sessions nobody took over", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const target = await member(ws, "member");
      const cookie = await webSession(target);
      const personal = await key(ws, { personalFor: target });
      const asked = await createSession(asUser(ws, target));
      await setAccess(ws, owner, target);

      const on = await setAccess(ws, owner, target, { disabled: false });
      expect(on).toMatchObject({
        outcome: "changed",
        member: { userId: target, disabledAt: null },
        effects: { disabled: false, sessionsReleased: 1 },
      });
      expect(await membershipDisabledAt(ws, target)).toBeNull();
      expect(await cookieRevoked(cookie)).toBe(true);
      expect(await reader().reread(keySubject(personal, ws))).toEqual({
        status: "disabled",
      });
      expect(await reader().reread(userSubject(target, ws))).toMatchObject({
        status: "ok",
      });
      expect(
        (await sessionRow(asked.session_id)).takeoverRequiredAt,
      ).toBeNull();
    });

    test("a suspended account's membership stays off, and its sessions parked", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const target = await member(ws, "member");
      const asked = await createSession(asUser(ws, target));
      await setAccess(ws, owner, target);
      await setAccess(ws, owner, target, { scope: "account" });
      expect(await setAccess(ws, owner, target, { disabled: false })).toEqual({
        outcome: "account_disabled",
      });
      expect(await membershipDisabledAt(ws, target)).not.toBeNull();
      expect(
        await setAccess(ws, owner, target, {
          scope: "account",
          disabled: false,
        }),
      ).toMatchObject({ effects: { sessionsReleased: 0 } });
      expect(
        (await sessionRow(asked.session_id)).takeoverRequiredAt,
      ).not.toBeNull();
      expect(
        await setAccess(ws, owner, target, { disabled: false }),
      ).toMatchObject({ effects: { sessionsReleased: 1 } });
    });

    test("enabling one membership hands back only that workspace's sessions", async () => {
      const ws = await workspace();
      const other = await workspace();
      const owner = await member(ws, "owner");
      const otherOwner = await member(other, "owner");
      const target = await member(ws, "member");
      await db
        .insert(memberships)
        .values({ workspaceId: other, userId: target, role: "member" });
      const here = await createSession(asUser(ws, target));
      const there = await createSession(asUser(other, target));
      await setAccess(ws, owner, target);
      await setAccess(other, otherOwner, target);
      // Live again there without a release, as an accepted invite leaves it.
      await db
        .update(memberships)
        .set({ disabledAt: null })
        .where(
          and(
            eq(memberships.workspaceId, other),
            eq(memberships.userId, target),
          ),
        );
      expect(
        await setAccess(ws, owner, target, { disabled: false }),
      ).toMatchObject({ effects: { sessionsReleased: 1 } });
      expect((await sessionRow(here.session_id)).takeoverRequiredAt).toBeNull();
      expect(
        (await sessionRow(there.session_id)).takeoverRequiredAt,
      ).not.toBeNull();
    });

    test("nobody turns themselves off, in either scope", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      for (const scope of ["membership", "account"] as const) {
        expect(await setAccess(ws, owner, owner, { scope })).toEqual({
          outcome: "self_protected",
        });
      }
      expect(await membershipDisabledAt(ws, owner)).toBeNull();
    });

    test("a member, a disabled owner and a stranger's workspace are refused", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const plain = await member(ws, "member");
      const target = await member(ws, "member");
      expect(await setAccess(ws, plain, target)).toEqual({
        outcome: "actor_inactive",
      });
      const other = await workspace();
      const stranger = await member(other, "member");
      for (const scope of ["membership", "account"] as const) {
        expect(await setAccess(ws, owner, stranger, { scope })).toEqual({
          outcome: "not_found",
        });
      }
      const gone = await member(ws, "owner");
      await setAccess(ws, owner, gone, { scope: "account" });
      expect(await setAccess(ws, gone, target)).toEqual({
        outcome: "actor_inactive",
      });
    });

    test("an admin manages members but never an owner", async () => {
      // The admin role arrives with M4's migration; this database stands in.
      await pool.query(
        "ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check",
      );
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const admin = await member(ws, "member");
      await db
        .update(memberships)
        .set({ role: "admin" })
        .where(
          and(eq(memberships.workspaceId, ws), eq(memberships.userId, admin)),
        );
      const target = await member(ws, "member");
      for (const scope of ["membership", "account"] as const) {
        expect(await setAccess(ws, admin, target, { scope })).toMatchObject({
          outcome: "changed",
        });
        expect(await setAccess(ws, admin, owner, { scope })).toEqual({
          outcome: "outranked",
        });
      }
      expect(await setAccess(ws, owner, admin)).toMatchObject({
        outcome: "changed",
      });
      expect(await setAccess(ws, admin, target)).toEqual({
        outcome: "actor_inactive",
      });
    });

    test("an account in a workspace the actor does not own is refused; one in two they own is cut off in both", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const target = await member(ws, "member");
      const other = await workspace();
      await db
        .insert(memberships)
        .values({ workspaceId: other, userId: target, role: "member" });
      const cookie = await webSession(target);
      expect(await setAccess(ws, owner, target, { scope: "account" })).toEqual({
        outcome: "elsewhere",
      });
      expect(await cookieRevoked(cookie)).toBe(false);

      // An owner there too, the account is theirs to stop.
      await db
        .insert(memberships)
        .values({ workspaceId: other, userId: owner, role: "owner" });
      const here = await key(ws, { personalFor: target });
      const there = await key(other, { personalFor: target });
      const asked = await createSession(asUser(other, target));
      expect(
        await setAccess(ws, owner, target, { scope: "account" }),
      ).toMatchObject({
        outcome: "changed",
        member: { disabledAt: expect.any(Date) },
        effects: {
          revokedWebSessions: 1,
          revokedPersonalKeys: 2,
          revokedLinkedAccounts: 0,
          sessionsAwaitingTakeover: 1,
        },
      });
      const [account] = await db
        .select({ disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, target));
      expect(account?.disabledAt).not.toBeNull();
      expect(await membershipDisabledAt(ws, target)).toBeNull();
      for (const [keyId, keyWs] of [
        [here, ws],
        [there, other],
      ] as const) {
        expect(await reader().reread(keySubject(keyId, keyWs))).toEqual({
          status: "disabled",
        });
      }
      expect(
        (await sessionRow(asked.session_id)).takeoverRequiredAt,
      ).not.toBeNull();
      // A disabled membership elsewhere does not count against the actor.
      const third = await workspace();
      await db.insert(memberships).values({
        workspaceId: third,
        userId: target,
        role: "member",
        disabledAt: new Date(),
      });
      expect(
        await setAccess(ws, owner, target, {
          scope: "account",
          disabled: false,
        }),
      ).toMatchObject({ outcome: "changed" });
    });

    test("an account turned off while its owner disables someone stops that write", async () => {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const other = await member(ws, "owner");
      const target = await member(ws, "member");
      const client = await pool.connect();
      await client.query("BEGIN");
      // An account disable's own order: the user, then their memberships.
      await client.query("UPDATE users SET disabled_at = now() WHERE id = $1", [
        owner,
      ]);
      await client.query(
        "SELECT 1 FROM memberships WHERE user_id = $1 FOR UPDATE",
        [owner],
      );
      const writing = setAccess(ws, owner, target);
      await lockWaiter();
      await client.query("COMMIT");
      client.release();
      expect(await writing).toEqual({ outcome: "actor_inactive" });
      expect(await membershipDisabledAt(ws, target)).toBeNull();
      expect(other).toBeDefined();
    });
  });

  describe("a session awaiting takeover", () => {
    async function awaiting() {
      const ws = await workspace();
      const owner = await member(ws, "owner");
      const leaver = await member(ws, "member");
      const created = await createSession(asUser(ws, leaver));
      await offboardBy(ws, leaver);
      return { ws, owner, leaver, sessionId: created.session_id };
    }

    test("takes no new message and is never dispatched", async () => {
      const { ws, owner, sessionId } = await awaiting();
      expect(await append(asUser(ws, owner), sessionId)).toEqual({
        outcome: "awaiting_takeover",
      });

      const partition = (await sessionRow(sessionId)).partition;
      await db
        .insert(unassignedSessions)
        .values({ sessionId, partition, signaledAt: new Date() })
        .onConflictDoNothing();
      const store = createPostgresSchedulerStore(db, {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        connectForLock: () => pool.connect(),
      });
      const demand = await store.inspectDemand({ limit: 1_000 });
      expect(demand.eligibleSessionIds).not.toContain(sessionId);
      expect(
        await store.reserveLaunch({
          backend: "local_docker",
          image: "worker:test",
          now: new Date(),
          resources: {
            cpus: 1,
            memoryBytes: 512 * 1024 * 1024,
            pidsLimit: 256,
          },
          sessionId,
          slotLimit: 1_000,
        }),
      ).toBeNull();
    });

    test("a running session finishes the turn it holds and is handed nothing more", async () => {
      const ws = await workspace();
      const leaver = await member(ws, "member");
      const created = await createSession(asUser(ws, leaver));
      const sessionId = created.session_id;
      const { executionId, generation, nonce } = await launchSession(db, {
        sessionId,
      });
      const bootstrap: WorkerPrincipal = { kind: "bootstrap" };
      const claimed = await gateway.bootstrapClaim(bootstrap, {
        execution_id: executionId,
        execution_generation: generation,
        credential: { kind: "launch_nonce", nonce },
      });
      const principal: WorkerPrincipal = {
        kind: "session",
        attemptId: claimed.attempt_id,
        sessionId,
        leaseEpoch: claimed.lease_epoch,
        executionGeneration: claimed.execution_generation,
        authRevision: claimed.auth_revision,
      };
      const scope = {
        session_id: sessionId,
        turn_id: null,
        attempt_id: claimed.attempt_id,
        lease_epoch: claimed.lease_epoch,
        execution_generation: claimed.execution_generation,
        auth_revision: claimed.auth_revision,
      };
      const first = await gateway.nextInput(principal, scope);
      expect(first.input?.turn_id).toBe("1");
      expect((await append(asUser(ws, leaver), sessionId)).outcome).toBe(
        "accepted",
      );

      await offboardBy(ws, leaver);
      expect((await gateway.nextInput(principal, scope)).input?.turn_id).toBe(
        "1",
      );
      await gateway.finalize(principal, {
        ...scope,
        turn_id: "1",
        finalize_key: "fin",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: null,
      });
      expect((await gateway.nextInput(principal, scope)).input).toBeNull();
      const queued = await db
        .select({ sequence: turns.sequence, status: turns.status })
        .from(turns)
        .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 2)));
      expect(queued).toEqual([{ sequence: 2, status: "queued" }]);
    });

    test("is listed for its workspace and taken over by the owner, who becomes its requester", async () => {
      const { ws, owner, leaver, sessionId } = await awaiting();
      const store = createPostgresMemberStore(db);
      const listed = await store.listAwaitingTakeover(ws, 200);
      expect(listed.map((row) => [row.sessionId, row.departedUserId])).toEqual([
        [sessionId, leaver],
      ]);
      expect(await store.listAwaitingTakeover(await workspace(), 200)).toEqual(
        [],
      );

      const taken = await store.takeOver({
        principal: asUser(ws, owner),
        workspaceId: ws,
        sessionId,
        newRequesterId: owner,
      });
      if (taken.outcome !== "taken_over") throw new Error(taken.outcome);
      const row = await sessionRow(sessionId);
      expect(row.createdByUserId).toBe(owner);
      expect(row.takeoverRequiredAt).toBeNull();
      const receipt = await receiptRow(taken.receiptId);
      expect(receipt).toMatchObject({
        operation: "takeover",
        status: "succeeded",
        ownerId: ws,
        actor: {
          principal: { kind: "user", id: owner },
          actor_user_id: owner,
          agent_id: null,
        },
      });

      expect((await append(asUser(ws, owner), sessionId)).outcome).toBe(
        "accepted",
      );
      expect(
        await store.takeOver({
          principal: asUser(ws, owner),
          workspaceId: ws,
          sessionId,
          newRequesterId: owner,
        }),
      ).toEqual({ outcome: "not_awaiting" });
    });

    test("an owner offboarded while taking over does not become the requester", async () => {
      const { ws, owner, leaver, sessionId } = await awaiting();
      const commit = await offboardingInFlight(ws, owner);
      const taking = createPostgresMemberStore(db).takeOver({
        principal: asUser(ws, owner),
        workspaceId: ws,
        sessionId,
        newRequesterId: owner,
      });
      await lockWaiter();
      await commit();
      expect(await taking).toEqual({ outcome: "actor_inactive" });
      const row = await sessionRow(sessionId);
      expect(row.createdByUserId).toBe(leaver);
      expect(row.takeoverRequiredAt).not.toBeNull();
    });

    test("another workspace cannot see or take it", async () => {
      const { sessionId } = await awaiting();
      const other = await workspace();
      const intruder = await member(other, "owner");
      expect(
        await createPostgresMemberStore(db).takeOver({
          principal: asUser(other, intruder),
          workspaceId: other,
          sessionId,
          newRequesterId: intruder,
        }),
      ).toEqual({ outcome: "not_found" });
    });
  });
});
