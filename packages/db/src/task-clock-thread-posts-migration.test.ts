import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER, readJournal } from "./migration-journal.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

// By name: db:restack renumbers the migration and not this file.
const TAG =
  readJournal(MIGRATIONS_FOLDER).find((entry) =>
    entry.tag.endsWith("_task_clock_thread_posts"),
  )?.tag ?? "task_clock_thread_posts";

let client: PGlite;
let before: string;

// What an image from before from_bot writes: no from_bot named.
const oldImageRecord = (eventId: string) =>
  client.query(
    `INSERT INTO slack_inbound_events (id, workspace_id, agent_id,
       slack_app_id, team_id, app_id, event_id, event_type, status, payload,
       conversation_key)
     VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
       gen_random_uuid(), 'T1', 'A1', $1, 'message', 'received',
       '{"event":{"bot_id":"B1"}}', 'app:C1:1.1')`,
    [eventId],
  );

const fromBotOf = async (eventId: string) =>
  (
    await client.query<{ from_bot: boolean | null }>(
      "SELECT from_bot FROM slack_inbound_events WHERE event_id = $1",
      [eventId],
    )
  ).rows;

const indexDef = async () =>
  (
    await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE indexname = 'slack_inbound_events_thread_received_idx'`,
    )
  ).rows.map((row) => row.indexdef);

beforeAll(async () => {
  client = new PGlite();
  before = migrationsThrough(TAG, { exclusive: true });
  await migrate(drizzle(client), { migrationsFolder: before });
  // The rows an event names are not what is under test.
  await client.exec("SET session_replication_role = replica");
  await oldImageRecord("EvBefore");
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
});

afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

describe("0400 keeps whether an inbox event is a bot's", () => {
  test("a row from before is left null, which the task clock reads as a person's", async () => {
    expect(await fromBotOf("EvBefore")).toEqual([{ from_bot: null }]);
  });

  test("an image from before records as it did, its row null", async () => {
    await oldImageRecord("EvOldImage");
    expect(await fromBotOf("EvOldImage")).toEqual([{ from_bot: null }]);
  });

  test("indexes a thread's posts that are no bot's, by when they came", async () => {
    expect(await indexDef()).toEqual([
      "CREATE INDEX slack_inbound_events_thread_received_idx ON public.slack_inbound_events USING btree (conversation_key, received_at) WHERE ((conversation_key IS NOT NULL) AND (from_bot IS NOT TRUE))",
    ]);
  });

  test("every statement runs again on a database it already changed", async () => {
    // As migrate runs it on PGlite, which builds no index concurrently.
    const statements = readFileSync(
      join(MIGRATIONS_FOLDER, `${TAG}.sql`),
      "utf8",
    )
      .split("--> statement-breakpoint")
      .map((statement) =>
        statement.replaceAll(/\bINDEX CONCURRENTLY\b/g, "INDEX"),
      );
    for (const statement of statements) {
      await client.exec(statement);
    }
    expect((await indexDef()).length).toBe(1);
    expect(await fromBotOf("EvBefore")).toEqual([{ from_bot: null }]);
  });
});
