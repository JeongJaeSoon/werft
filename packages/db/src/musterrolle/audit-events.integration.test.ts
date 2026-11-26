import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AuditEvent } from "@werft-ai/contracts";
import { InvalidCursorError } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { authzDecisions, receipts, workspaces } from "../schema.ts";
import { createPostgresAuditLogReader } from "./audit-events.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const LOW = "00000000-0000-4000-8000-000000000001";
const HIGH = "ffffffff-ffff-4fff-bfff-ffffffffffff";

// An instant `daysAgo` back with six fraction digits, as Postgres keeps it.
function instant(daysAgo: number, micros: string): string {
  const iso = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return `${iso.slice(0, 19)}.${micros}Z`;
}

integration("audit log reader on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "audit_it" });
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

  async function decision(
    ownerId: string,
    at: string,
    fields: Partial<typeof authzDecisions.$inferInsert> = {},
  ) {
    const id = fields.id ?? randomUUID();
    await db.insert(authzDecisions).values({
      id,
      // Text, so the microseconds survive; a Date would drop them.
      at: sql`${at}::timestamptz`,
      ownerId,
      principalKind: "user",
      principalId: randomUUID(),
      actorUserId: null,
      surface: { kind: "web" },
      action: "member.manage",
      resourceKind: "workspace",
      resourceId: ownerId,
      outcome: "deny",
      reasonCode: "owner_protected",
      policyVersion: "m17",
      requestId: `req-${id}`,
      ...fields,
    });
    return id;
  }

  async function receipt(
    ownerId: string,
    at: string,
    fields: Partial<typeof receipts.$inferInsert> = {},
  ) {
    const id = fields.id ?? randomUUID();
    await db.insert(receipts).values({
      id,
      ownerId,
      operation: "update_member",
      targetRef: {
        user_id: randomUUID(),
        workspace_id: ownerId,
      },
      status: "succeeded",
      actor: null,
      requestId: `req-${id}`,
      createdAt: sql`${at}::timestamptz`,
      ...fields,
    });
    return id;
  }

  const reader = () => createPostgresAuditLogReader(db);

  async function readAll(ownerId: string, limit: number) {
    const seen: AuditEvent[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const page = await reader().page(ownerId, {}, cursor, limit);
      seen.push(...page.items);
      if (page.next_cursor === null) return seen;
      cursor = page.next_cursor;
    }
    throw new Error("paging did not end");
  }

  test("merges both tables newest first across same-instant page edges", async () => {
    const ownerId = await workspace();
    // Two instants, each holding a decision and a receipt, with the id
    // order between the tables flipped from one instant to the other.
    const first = instant(2, "123456");
    const second = instant(1, "654321");
    const d1 = await decision(ownerId, first, { id: LOW });
    const r1 = await receipt(ownerId, first, { id: HIGH });
    const d2 = await decision(ownerId, second, { id: HIGH });
    const r2 = await receipt(ownerId, second, { id: LOW });
    const d3 = await decision(ownerId, second);
    const expected = [
      [second, "receipt", r2],
      ...[
        [second, "decision", d2],
        [second, "decision", d3],
      ].sort((a, b) => ((a[2] ?? "") > (b[2] ?? "") ? -1 : 1)),
      [first, "receipt", r1],
      [first, "decision", d1],
    ];

    for (const limit of [1, 2, 50]) {
      const rows = await readAll(ownerId, limit);
      expect(rows.map((row) => [row.at, row.kind, row.id])).toEqual(expected);
    }
  });

  test("shapes each kind and keeps the microseconds", async () => {
    const ownerId = await workspace();
    const at = instant(1, "000007");
    const userId = randomUUID();
    const agentId = randomUUID();
    await decision(ownerId, at, {
      actorUserId: userId,
      principalId: userId,
      agentId,
      outcome: "allow",
      reasonCode: "ok",
      action: "audit_log.read",
      requestId: "req-decision",
    });
    const sessionId = randomUUID();
    await receipt(ownerId, at, {
      operation: "create_session",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      actor: {
        principal: { kind: "api_key", id: "key-1" },
        actor_user_id: userId,
        agent_id: null,
      },
      status: "accepted",
      requestId: "req-receipt",
    });

    const page = await reader().page(ownerId, {}, undefined, 10);
    expect(page.items).toEqual([
      {
        kind: "receipt",
        id: expect.any(String),
        at,
        request_id: "req-receipt",
        actor: {
          principal_kind: "api_key",
          principal_id: "key-1",
          user_id: userId,
          agent_id: null,
        },
        action: "create_session",
        target: { kind: "session", id: sessionId },
        outcome: "accepted",
        reason_code: null,
        surface: null,
      },
      {
        kind: "decision",
        id: expect.any(String),
        at,
        request_id: "req-decision",
        actor: {
          principal_kind: "user",
          principal_id: userId,
          user_id: userId,
          agent_id: agentId,
        },
        action: "audit_log.read",
        target: { kind: "workspace", id: ownerId },
        outcome: "allow",
        reason_code: "ok",
        surface: "web",
      },
    ]);
  });

  test("lists only the retention window, for both tables", async () => {
    const ownerId = await workspace({ audit_retention_days: 30 });
    const inside = await decision(ownerId, instant(29, "000000"));
    const insideReceipt = await receipt(ownerId, instant(29, "000001"));
    await decision(ownerId, instant(31, "000000"));
    await receipt(ownerId, instant(31, "000000"));

    const page = await reader().page(
      ownerId,
      { from: instant(400, "000000") },
      undefined,
      50,
    );
    expect(page.items.map((row) => row.id).sort()).toEqual(
      [inside, insideReceipt].sort(),
    );
    const start = Date.parse(page.retention_start);
    expect(Math.abs(start - (Date.now() - 30 * 86_400_000))).toBeLessThan(
      60_000,
    );
  });

  test("never shows another workspace's rows", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const own = await decision(mine, instant(1, "000000"));
    await decision(theirs, instant(1, "000000"));
    await receipt(theirs, instant(1, "000000"));

    const page = await reader().page(mine, {}, undefined, 50);
    expect(page.items.map((row) => row.id)).toEqual([own]);
  });

  test("filters by kind, person, action, outcome and time", async () => {
    const ownerId = await workspace();
    const userId = randomUUID();
    const mineDenied = await decision(ownerId, instant(3, "000000"), {
      actorUserId: userId,
    });
    await decision(ownerId, instant(2, "000000"), {
      outcome: "allow",
      reasonCode: "ok",
    });
    const mineReceipt = await receipt(ownerId, instant(1, "000000"), {
      actor: {
        principal: { kind: "user", id: userId },
        actor_user_id: userId,
        agent_id: null,
      },
    });
    const ids = async (
      filter: Parameters<ReturnType<typeof reader>["page"]>[1],
    ) =>
      (await reader().page(ownerId, filter, undefined, 50)).items.map(
        (row) => row.id,
      );

    expect(await ids({ actor_user_id: userId.toUpperCase() })).toEqual([
      mineReceipt,
      mineDenied,
    ]);
    expect(await ids({ kind: "receipt" })).toEqual([mineReceipt]);
    expect(await ids({ outcome: "deny" })).toEqual([mineDenied]);
    expect(await ids({ outcome: "succeeded" })).toEqual([mineReceipt]);
    expect(await ids({ action: "update_member" })).toEqual([mineReceipt]);
    expect(
      await ids({ from: instant(3.5, "000000"), to: instant(1.5, "000000") }),
    ).toHaveLength(2);
  });

  test("refuses a cursor it did not mint", async () => {
    const ownerId = await workspace();
    for (const forged of [
      "nope",
      Buffer.from(
        JSON.stringify({
          at: "2026-13-40T00:00:00.000000Z",
          kind: "decision",
          id: LOW,
        }),
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({
          at: "2026-11-20T00:00:00.000000Z",
          kind: "other",
          id: LOW,
        }),
      ).toString("base64url"),
    ]) {
      const refused = await reader()
        .page(ownerId, {}, forged, 10)
        .catch((error) => error);
      expect(refused, forged).toBeInstanceOf(InvalidCursorError);
    }
  });

  test("counts what a page lists, per table, inside the window and up to where it is told to stop", async () => {
    const ownerId = await workspace({ audit_retention_days: 30 });
    const other = await workspace();
    const userId = randomUUID();
    await decision(ownerId, instant(1, "000001"), { actorUserId: userId });
    await decision(ownerId, instant(2, "000002"));
    // Outside the 30-day window: listed nowhere, so counted nowhere.
    await decision(ownerId, instant(40, "000003"));
    await receipt(ownerId, instant(1, "000004"), {
      actor: { actor_user_id: userId },
    });
    // Another workspace's rows are never this owner's.
    await decision(other, instant(1, "000005"));
    await receipt(other, instant(1, "000006"));

    const count = (filter: Parameters<ReturnType<typeof reader>["count"]>[1]) =>
      reader().count(ownerId, filter, 1001);
    expect(await count({})).toEqual({ decision: 2, receipt: 1 });
    expect(await count({ kind: "decision" })).toEqual({
      decision: 2,
      receipt: 0,
    });
    expect(await count({ actor_user_id: userId.toUpperCase() })).toEqual({
      decision: 1,
      receipt: 1,
    });
    expect(await count({ from: instant(1.5, "000000") })).toEqual({
      decision: 1,
      receipt: 1,
    });
    // Each count is what reading every page gives.
    expect((await readAll(ownerId, 2)).length).toBe(3);
  });

  test("stops counting at the limit it is given", async () => {
    const ownerId = await workspace();
    const at = instant(1, "000000");
    await db.insert(authzDecisions).values(
      Array.from({ length: 1001 }, () => ({
        id: randomUUID(),
        at: sql`${at}::timestamptz`,
        ownerId,
        principalKind: "user",
        principalId: randomUUID(),
        actorUserId: null,
        surface: { kind: "web" },
        action: "member.manage",
        resourceKind: "workspace",
        resourceId: ownerId,
        outcome: "deny",
        reasonCode: "owner_protected",
        policyVersion: "m17",
        requestId: `req-${randomUUID()}`,
      })),
    );
    expect(await reader().count(ownerId, {}, 1000)).toEqual({
      decision: 1000,
      receipt: 0,
    });
    expect(await reader().count(ownerId, {}, 1001)).toEqual({
      decision: 1001,
      receipt: 0,
    });
    expect(await reader().count(ownerId, {}, 5000)).toEqual({
      decision: 1001,
      receipt: 0,
    });
  });
});
