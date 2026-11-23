import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { moveSummaryLinks } from "./link-posting.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("moveSummaryLinks on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "link_posting_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema }) as unknown as Database;
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("a summary link another writer holds is waited for and moved, not skipped", async () => {
    const id = randomUUID();
    const writer = await pool.connect();
    try {
      // The rows a link names are not what is under test.
      await writer.query("SET session_replication_role = replica");
      await writer.query(
        `INSERT INTO session_links (id, workspace_id, owner_id, installation_id,
           surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts,
           agent_id, release_id, visibility)
         VALUES ($1, $2, 'owner', $3, $4, 'T1:C1:1.1', 'C1', '1.1', '1.1', $5, 'r1', 'summary')`,
        [id, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      );
      await writer.query("BEGIN");
      await writer.query(
        "SELECT 1 FROM session_links WHERE id = $1 FOR UPDATE",
        [id],
      );
      let settled = false;
      const moving = moveSummaryLinks(db).then((moved) => {
        settled = true;
        return moved;
      });
      await Bun.sleep(300);
      expect(settled).toBe(false);
      await writer.query("COMMIT");
      expect(await moving).toBe(1);
    } finally {
      writer.release();
    }
    const { rows } = await pool.query(
      "SELECT report_mode, mirror_instructions, post_prompts FROM session_links WHERE id = $1",
      [id],
    );
    expect(rows).toEqual([
      { report_mode: "none", mirror_instructions: false, post_prompts: false },
    ]);
    expect(await moveSummaryLinks(db)).toBe(0);
  });
});
