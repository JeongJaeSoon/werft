import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Principal } from "@werft-ai/contracts";
import { callerFor, createAuthorizationPolicy } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { authzDecisions, memberships, users, workspaces } from "../schema.ts";
import {
  createPostgresAuditRetention,
  createPostgresDecisionLog,
  expireAuthzDecisions,
} from "./authz-decisions.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("authz_decisions on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "authz_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function workspace(settings: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db
      .insert(workspaces)
      .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "Acme", settings });
    return id;
  }

  function member(workspaceId: string): Principal {
    return {
      kind: "user",
      id: randomUUID(),
      workspace_id: workspaceId,
      role: "member",
      scopes: ["sessions:read"],
    };
  }

  async function rowsFor(requestId: string) {
    return db
      .select()
      .from(authzDecisions)
      .where(eq(authzDecisions.requestId, requestId));
  }

  async function backdate(id: string, days: number) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE authz_decisions DISABLE TRIGGER authz_decisions_append_only",
      );
      await client.query(
        "UPDATE authz_decisions SET at = clock_timestamp() - make_interval(days => $1) WHERE id = $2",
        [days, id],
      );
      await client.query(
        "ALTER TABLE authz_decisions ENABLE TRIGGER authz_decisions_append_only",
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  }

  test("a refusal leaves one row naming who asked, for what, and the request", async () => {
    const workspaceId = await workspace();
    const principal = member(workspaceId);
    const policy = createAuthorizationPolicy({
      decisions: createPostgresDecisionLog(db),
    });
    const caller = callerFor(principal, { kind: "web" }, randomUUID());
    const decision = await policy.authorize({
      subject: caller.subject,
      action: "session.recover",
      resource: { kind: "session", id: null, owner_scope: caller.ownerId },
      request_id: caller.requestId,
    });
    expect(decision).toMatchObject({ outcome: "deny", reason_code: "role" });

    const rows = await rowsFor(caller.requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: decision.decision_id,
      ownerId: workspaceId,
      workspaceId,
      principalKind: "user",
      principalId: principal.id,
      actorUserId: principal.id,
      surface: { kind: "web" },
      action: "session.recover",
      resourceKind: "session",
      resourceId: null,
      outcome: "deny",
      reasonCode: "role",
      policyVersion: decision.policy_version,
    });
  });

  test("an allow that need not be kept leaves no row", async () => {
    const workspaceId = await workspace();
    const policy = createAuthorizationPolicy({
      decisions: createPostgresDecisionLog(db),
    });
    const caller = callerFor(
      member(workspaceId),
      { kind: "api" },
      randomUUID(),
    );
    const decision = await policy.authorize({
      subject: caller.subject,
      action: "session.read",
      resource: { kind: "session", id: null, owner_scope: caller.ownerId },
      request_id: caller.requestId,
    });
    expect(decision.outcome).toBe("allow");
    expect(await rowsFor(caller.requestId)).toEqual([]);
  });

  test("a row cannot be rewritten", async () => {
    const workspaceId = await workspace();
    const caller = callerFor(
      member(workspaceId),
      { kind: "web" },
      randomUUID(),
    );
    await createAuthorizationPolicy({
      decisions: createPostgresDecisionLog(db),
    }).authorize({
      subject: caller.subject,
      action: "session.recover",
      resource: { kind: "session", id: null, owner_scope: caller.ownerId },
      request_id: caller.requestId,
    });
    const refused = await db
      .update(authzDecisions)
      .set({ outcome: "allow" })
      .where(eq(authzDecisions.requestId, caller.requestId))
      .then(
        () => null,
        (error: Error) => error,
      );
    expect(String((refused?.cause as Error | undefined)?.message)).toContain(
      "append-only",
    );
    const [row] = await rowsFor(caller.requestId);
    expect(row?.outcome).toBe("deny");
  });

  test("rows past their workspace's retention are deleted, younger ones stay", async () => {
    const kept30 = await workspace({ audit_retention_days: 30 });
    const kept90 = await workspace();
    const log = createPostgresDecisionLog(db);
    const policy = createAuthorizationPolicy({ decisions: log });
    async function refusalIn(workspaceId: string, ageDays: number) {
      const caller = callerFor(
        member(workspaceId),
        { kind: "web" },
        randomUUID(),
      );
      const decision = await policy.authorize({
        subject: caller.subject,
        action: "session.recover",
        resource: { kind: "session", id: null, owner_scope: caller.ownerId },
        request_id: caller.requestId,
      });
      await backdate(decision.decision_id, ageDays);
      return decision.decision_id;
    }
    const old30 = await refusalIn(kept30, 31);
    const young30 = await refusalIn(kept30, 29);
    const old90 = await refusalIn(kept90, 91);
    const young90 = await refusalIn(kept90, 89);

    expect(await expireAuthzDecisions(db, { limit: 100, dryRun: true })).toBe(
      2,
    );
    expect(await expireAuthzDecisions(db, { limit: 100, dryRun: false })).toBe(
      2,
    );
    const left = new Set(
      (await db.select({ id: authzDecisions.id }).from(authzDecisions)).map(
        (row) => row.id,
      ),
    );
    expect(left.has(old30)).toBe(false);
    expect(left.has(old90)).toBe(false);
    expect(left.has(young30)).toBe(true);
    expect(left.has(young90)).toBe(true);
  });

  test("a setting under the floor written around the API still keeps 30 days", async () => {
    const workspaceId = await workspace({ audit_retention_days: 1 });
    const caller = callerFor(
      member(workspaceId),
      { kind: "web" },
      randomUUID(),
    );
    const decision = await createAuthorizationPolicy({
      decisions: createPostgresDecisionLog(db),
    }).authorize({
      subject: caller.subject,
      action: "session.recover",
      resource: { kind: "session", id: null, owner_scope: caller.ownerId },
      request_id: caller.requestId,
    });
    await backdate(decision.decision_id, 10);
    await expireAuthzDecisions(db, { limit: 100, dryRun: false });
    expect(await rowsFor(caller.requestId)).toHaveLength(1);
  });

  test("the pass deletes at most its limit, oldest first", async () => {
    await db.execute(sql`DELETE FROM authz_decisions`);
    const workspaceId = await workspace();
    const policy = createAuthorizationPolicy({
      decisions: createPostgresDecisionLog(db),
    });
    const ids: string[] = [];
    for (const age of [200, 150, 100]) {
      const caller = callerFor(
        member(workspaceId),
        { kind: "web" },
        randomUUID(),
      );
      const decision = await policy.authorize({
        subject: caller.subject,
        action: "session.recover",
        resource: { kind: "session", id: null, owner_scope: caller.ownerId },
        request_id: caller.requestId,
      });
      await backdate(decision.decision_id, age);
      ids.push(decision.decision_id);
    }
    expect(await expireAuthzDecisions(db, { limit: 2, dryRun: false })).toBe(2);
    const left = await db
      .select({ id: authzDecisions.id })
      .from(authzDecisions);
    expect(left.map((row) => row.id)).toEqual(ids.slice(2));
  });

  async function joined(
    workspaceId: string,
    role: string,
    disabled = false,
  ): Promise<string> {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: role,
    });
    await db.insert(memberships).values({
      workspaceId,
      userId,
      role,
      disabledAt: disabled ? new Date() : null,
    });
    return userId;
  }

  test("only an active owner writes the retention into the workspace settings", async () => {
    const workspaceId = await workspace({ kill_switch: true });
    const store = createPostgresAuditRetention(db);
    const set = (ownerUserId: string, days: number, id = workspaceId) =>
      store.setAuditRetentionDays({ workspaceId: id, ownerUserId, days });
    const owner = await joined(workspaceId, "owner");
    expect(await set(await joined(workspaceId, "member"), 60)).toBe(false);
    expect(await set(await joined(workspaceId, "owner", true), 60)).toBe(false);
    for (const days of [29, 3651, 30.5]) {
      await expect(set(owner, days)).rejects.toThrow();
    }
    expect(await set(owner, 45)).toBe(true);
    const [row] = await db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(row?.settings).toEqual({
      kill_switch: true,
      audit_retention_days: 45,
    });
    expect(await set(owner, 45, await workspace())).toBe(false);
  });
});
