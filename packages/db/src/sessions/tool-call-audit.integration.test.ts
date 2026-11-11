import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { toolCallAudits, workspaces } from "../schema.ts";
import { expireToolCallAudits } from "./tool-call-audit.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("tool_call_audits on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "tool_audit_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 90_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 90_000);

  async function workspace(settings: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db
      .insert(workspaces)
      .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "Acme", settings });
    return id;
  }

  async function auditIn(workspaceId: string | null, ageDays: number) {
    const [row] = await db
      .insert(toolCallAudits)
      .values({
        workspaceId,
        ownerId: "owner",
        sessionId: randomUUID(),
        turnId: 1,
        attemptId: "att_1",
        callKey: `t:${randomUUID()}`,
        phase: "decided",
        toolName: "Bash",
        decision: "allow",
        basis: "trusted_tool",
        source: "worker_report",
        recordVersion: 1,
      })
      .returning({ id: toolCallAudits.id });
    const id = row?.id ?? "";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "ALTER TABLE tool_call_audits DISABLE TRIGGER tool_call_audits_append_only",
      );
      await client.query(
        "UPDATE tool_call_audits SET at = clock_timestamp() - make_interval(days => $1) WHERE id = $2",
        [ageDays, id],
      );
      await client.query(
        "ALTER TABLE tool_call_audits ENABLE TRIGGER tool_call_audits_append_only",
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    return id;
  }

  const idsLeft = async () =>
    new Set(
      (await db.select({ id: toolCallAudits.id }).from(toolCallAudits)).map(
        (row) => row.id,
      ),
    );

  test("a row cannot be rewritten", async () => {
    const id = await auditIn(null, 0);
    const refused = await db
      .update(toolCallAudits)
      .set({ decision: "deny", basis: "not_permitted" })
      .where(eq(toolCallAudits.id, id))
      .then(
        () => null,
        (error: Error) => error,
      );
    expect(String((refused?.cause as Error | undefined)?.message)).toContain(
      "append-only",
    );
    const [row] = await db
      .select()
      .from(toolCallAudits)
      .where(eq(toolCallAudits.id, id));
    expect(row).toMatchObject({ decision: "allow", basis: "trusted_tool" });
  });

  test("a row that says asked must be a require_approval, and only that", async () => {
    const insert = (phase: string, decision: string) =>
      pool.query(
        `INSERT INTO tool_call_audits (owner_id, session_id, turn_id, attempt_id, call_key, phase, tool_name, decision, basis, source, record_version)
         VALUES ('o', $1, 1, 'a', $2, $3, 'Bash', $4, 'x', 'platform', 1)`,
        [randomUUID(), `t:${randomUUID()}`, phase, decision],
      );
    await expect(insert("asked", "allow")).rejects.toThrow();
    await expect(insert("decided", "require_approval")).rejects.toThrow();
    await expect(insert("asked", "require_approval")).resolves.toBeDefined();
  });

  test("a hash comes with its byte count, and neither without the other", async () => {
    const insert = (hash: string | null, bytes: number | null) =>
      pool.query(
        `INSERT INTO tool_call_audits (owner_id, session_id, turn_id, attempt_id, call_key, phase, tool_name, input_sha256, input_bytes, decision, basis, source, record_version)
         VALUES ('o', $1, 1, 'a', $2, 'decided', 'Bash', $3, $4, 'allow', 'trusted_tool', 'worker_report', 1)`,
        [randomUUID(), `t:${randomUUID()}`, hash, bytes],
      );
    await expect(insert("a".repeat(64), null)).rejects.toThrow();
    await expect(insert(null, 5)).rejects.toThrow();
    await expect(insert("a".repeat(64), 5)).resolves.toBeDefined();
  });

  test("a second row for the same call and phase is refused by the key", async () => {
    const session = randomUUID();
    const insert = () =>
      pool.query(
        `INSERT INTO tool_call_audits (owner_id, session_id, turn_id, attempt_id, call_key, phase, tool_name, decision, basis, source, record_version)
         VALUES ('o', $1, 1, 'a', 't:x', 'decided', 'Bash', 'allow', 'trusted_tool', 'worker_report', 1)`,
        [session],
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  test("rows past their workspace's retention are deleted, younger ones stay", async () => {
    const kept30 = await workspace({ audit_retention_days: 30 });
    const kept90 = await workspace();
    const old30 = await auditIn(kept30, 31);
    const young30 = await auditIn(kept30, 29);
    const old90 = await auditIn(kept90, 91);
    const young90 = await auditIn(kept90, 89);
    const unbound = await auditIn(null, 91);

    expect(await expireToolCallAudits(db, { limit: 100, dryRun: true })).toBe(
      3,
    );
    expect((await idsLeft()).has(old30)).toBe(true);
    expect(await expireToolCallAudits(db, { limit: 100, dryRun: false })).toBe(
      3,
    );
    const left = await idsLeft();
    for (const gone of [old30, old90, unbound]) {
      expect(left.has(gone)).toBe(false);
    }
    for (const kept of [young30, young90]) expect(left.has(kept)).toBe(true);
  });

  test("a setting under the floor written around the API still keeps 30 days", async () => {
    const workspaceId = await workspace({ audit_retention_days: 1 });
    const id = await auditIn(workspaceId, 10);
    await expireToolCallAudits(db, { limit: 100, dryRun: false });
    expect((await idsLeft()).has(id)).toBe(true);
  });

  test("the pass deletes at most its limit, oldest first", async () => {
    await db.execute(sql`DELETE FROM tool_call_audits`);
    const workspaceId = await workspace();
    const ids = [
      await auditIn(workspaceId, 200),
      await auditIn(workspaceId, 150),
      await auditIn(workspaceId, 100),
    ];
    expect(await expireToolCallAudits(db, { limit: 2, dryRun: false })).toBe(2);
    expect([...(await idsLeft())]).toEqual(ids.slice(2));
  });
});
