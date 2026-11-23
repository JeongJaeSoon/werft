import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { reportModeChoiceSchema } from "@werft-ai/contracts";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { moveSummaryLinks, reportsTurns } from "./link-posting.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import type { Database } from "./queries.ts";
import { rowsOf } from "./statement-rows.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

const TAG = "0323_link_posting";

let client: PGlite;
let db: Database;
let before: string;
const bindingId = randomUUID();

// What a host from before 0323 writes: `visibility` at most, no new column.
const oldHostLink = (visibility?: "full" | "summary") =>
  client.query<{ id: string }>(
    `INSERT INTO session_links (id, workspace_id, owner_id, installation_id,
       surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts,
       agent_id, release_id${visibility ? ", visibility" : ""})
     VALUES ($1, $2, 'owner', $3, $4, $5, 'C1', $6, $6, $7, 'r1'${visibility ? ", $8" : ""})
     RETURNING id`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      bindingId,
      `T1:C1:${randomUUID()}`,
      randomUUID(),
      randomUUID(),
      ...(visibility ? [visibility] : []),
    ],
  );

let fullId: string;
let summaryId: string;

beforeAll(async () => {
  client = new PGlite();
  before = migrationsThrough(TAG, { exclusive: true });
  await migrate(drizzle(client), { migrationsFolder: before });
  // The rows a link names are not what is under test.
  await client.exec("SET session_replication_role = replica");
  await client.query(
    `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface, mode,
       ceiling_actions, ceiling_disclosure)
     VALUES ($1, $2, $3, 'web', 'on', '{}', 'full')`,
    [bindingId, randomUUID(), randomUUID()],
  );
  fullId = (await oldHostLink("full")).rows[0]?.id ?? "";
  summaryId = (await oldHostLink("summary")).rows[0]?.id ?? "";
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  db = drizzle(client) as unknown as Database;
});

afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

// The columns as the outbox reads them, by `visibility`.
const byVisibility = async () =>
  rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      SELECT l.visibility, ${reportsTurns(sql.raw("l"))} AS reports_turns,
        coalesce(l.report_mode, b.report_mode) AS report_mode,
        l.mirror_instructions, l.post_prompts, count(*)::int AS links
      FROM session_links l JOIN surface_bindings b ON b.id = l.surface_binding_id
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 1
    `),
  );

describe("0323 link posting", () => {
  test("adds the three link columns and the binding's report mode, its checks validated", async () => {
    const columns = (
      await client.query<{
        table_name: string;
        column_name: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT table_name, column_name, is_nullable, column_default
         FROM information_schema.columns
         WHERE (table_name = 'session_links' AND column_name IN ('report_mode', 'mirror_instructions', 'post_prompts'))
            OR (table_name = 'surface_bindings' AND column_name = 'report_mode')
         ORDER BY table_name, column_name`,
      )
    ).rows;
    expect(columns).toEqual([
      {
        table_name: "session_links",
        column_name: "mirror_instructions",
        is_nullable: "NO",
        column_default: "true",
      },
      {
        table_name: "session_links",
        column_name: "post_prompts",
        is_nullable: "NO",
        column_default: "true",
      },
      {
        table_name: "session_links",
        column_name: "report_mode",
        is_nullable: "YES",
        column_default: null,
      },
      {
        table_name: "surface_bindings",
        column_name: "report_mode",
        is_nullable: "NO",
        column_default: "'per_step'::text",
      },
    ]);
    const validated = (
      await client.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
         WHERE conname IN ('session_links_report_mode_check', 'surface_bindings_report_mode_check')
         ORDER BY conname`,
      )
    ).rows;
    expect(validated).toEqual([
      { conname: "session_links_report_mode_check", convalidated: true },
      { conname: "surface_bindings_report_mode_check", convalidated: true },
    ]);
  });

  test("every statement runs again on a database it already changed", async () => {
    const statements = readFileSync(
      join(MIGRATIONS_FOLDER, `${TAG}.sql`),
      "utf8",
    ).split("--> statement-breakpoint");
    for (const statement of statements) {
      await client.exec(statement);
    }
  });

  test("the start pass moves summary links to none, off, off; full links read per_step, on, on", async () => {
    // Before the pass a summary link still reads as full did: the pass is
    // what moves it, and it runs before the outbox at each start.
    expect(await moveSummaryLinks(db)).toBe(1);
    expect(await moveSummaryLinks(db)).toBe(0);
    expect(await byVisibility()).toEqual([
      {
        visibility: "full",
        reports_turns: true,
        report_mode: "per_step",
        mirror_instructions: true,
        post_prompts: true,
        links: 1,
      },
      {
        visibility: "summary",
        reports_turns: false,
        report_mode: "none",
        mirror_instructions: false,
        post_prompts: false,
        links: 1,
      },
    ]);
    const moved = (
      await client.query(
        "SELECT report_mode FROM session_links WHERE id = ANY($1) ORDER BY visibility",
        [[fullId, summaryId]],
      )
    ).rows;
    expect(moved).toEqual([{ report_mode: null }, { report_mode: "none" }]);
  });

  test("a link an old host writes after the migration reads as full did", async () => {
    const { rows } = await oldHostLink();
    const [link] = (
      await client.query(
        "SELECT report_mode, mirror_instructions, post_prompts FROM session_links WHERE id = $1",
        [rows[0]?.id],
      )
    ).rows;
    expect(link).toEqual({
      report_mode: null,
      mirror_instructions: true,
      post_prompts: true,
    });
    await client.query("DELETE FROM session_links WHERE id = $1", [
      rows[0]?.id,
    ]);
  });

  test("a link without a report mode takes its binding's; one with a mode keeps its own", async () => {
    const effective = async () =>
      rowsOf<{ mode: string; reports: boolean }>(
        await db.execute(sql`
            SELECT coalesce(l.report_mode, b.report_mode) AS mode, ${reportsTurns(sql.raw("l"))} AS reports
            FROM session_links l JOIN surface_bindings b ON b.id = l.surface_binding_id
            WHERE l.id = ${fullId}
          `),
      )[0];
    await client.query(
      "UPDATE surface_bindings SET report_mode = 'progress' WHERE id = $1",
      [bindingId],
    );
    expect(await effective()).toEqual({ mode: "progress", reports: true });
    await client.query(
      "UPDATE session_links SET report_mode = 'none' WHERE id = $1",
      [fullId],
    );
    expect(await effective()).toEqual({ mode: "none", reports: false });
    await client.query(
      "UPDATE session_links SET report_mode = NULL WHERE id = $1",
      [fullId],
    );
    await client.query(
      "UPDATE surface_bindings SET report_mode = 'per_step' WHERE id = $1",
      [bindingId],
    );
  });

  test("none stays readable on links but no binding or writer may pick it", async () => {
    await expect(
      client.query(
        "UPDATE surface_bindings SET report_mode = 'none' WHERE id = $1",
        [bindingId],
      ),
    ).rejects.toThrow(/surface_bindings_report_mode_check/);
    await expect(
      client.query(
        "UPDATE session_links SET report_mode = 'turns' WHERE id = $1",
        [fullId],
      ),
    ).rejects.toThrow(/session_links_report_mode_check/);
    expect(reportModeChoiceSchema.safeParse("none").success).toBe(false);
    expect(reportModeChoiceSchema.options).toEqual([
      "notify_only",
      "progress",
      "per_step",
    ]);
  });
});
