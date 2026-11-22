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
import { editedSources, workspaces } from "../schema.ts";
import {
  createPostgresSlackSourceMarkStore,
  lockSlackSourceMark,
} from "./slack-source-marks.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("Slack source marks on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_marks_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function message() {
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    return {
      workspaceId,
      teamId: "T0MARKS",
      channelId: "C0MARKS",
      ts: "1792800000.000100",
    };
  }
  const at = new Date("2026-11-23T01:00:00.000Z");

  test("a delete waits for an edit of the same message still in flight, then drops its mark", async () => {
    const where = await message();
    const marks = createPostgresSlackSourceMarkStore(db);
    const editing = await pool.connect();
    try {
      await editing.query("BEGIN");
      await drizzle(editing).execute(lockSlackSourceMark(where));
      await editing.query(
        "INSERT INTO edited_sources (workspace_id, team_id, channel_id, ts, edited_at) VALUES ($1, $2, $3, $4, $5)",
        [where.workspaceId, where.teamId, where.channelId, where.ts, at],
      );
      let settled = false;
      const deleting = marks.markDeleted({ ...where, at }).then((result) => {
        settled = true;
        return result;
      });
      await Bun.sleep(300);
      expect(settled).toBe(false);
      await editing.query("COMMIT");
      expect(await deleting).toBe("recorded");
    } finally {
      editing.release();
    }
    expect(
      await db
        .select()
        .from(editedSources)
        .where(eq(editedSources.workspaceId, where.workspaceId)),
    ).toEqual([]);
  });

  test("an edit waits for a delete of the same message still in flight, and leaves no mark", async () => {
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    const where = {
      workspaceId,
      teamId: "T0MARKS",
      channelId: "C0MARKS",
      ts: "1792800000.000100",
    };
    const at = new Date("2026-11-23T01:00:00.000Z");
    const marks = createPostgresSlackSourceMarkStore(db);

    // A delete holds the message's lock and has not committed its mark.
    const deleting = await pool.connect();
    try {
      await deleting.query("BEGIN");
      const lock = drizzle(deleting).execute(lockSlackSourceMark(where));
      await lock;
      await deleting.query(
        "INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at) VALUES ($1, $2, $3, $4, $5)",
        [where.workspaceId, where.teamId, where.channelId, where.ts, at],
      );
      let settled = false;
      const editing = marks.markEdited({ ...where, at }).then((result) => {
        settled = true;
        return result;
      });
      await Bun.sleep(300);
      expect(settled).toBe(false);
      await deleting.query("COMMIT");
      expect(await editing).toBe("deleted");
    } finally {
      deleting.release();
    }
    expect(
      await db
        .select()
        .from(editedSources)
        .where(eq(editedSources.workspaceId, workspaceId)),
    ).toEqual([]);
    const held = await db.execute(
      sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`,
    );
    expect(held.rows).toEqual([{ n: 0 }]);
  });
});
