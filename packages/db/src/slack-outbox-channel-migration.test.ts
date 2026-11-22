import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

const TAG = "0306_slack_outbox_channel";

let client: PGlite;
let before: string;

afterEach(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

async function beforeIt(rows: { kind: string; channelId: string }[]) {
  client = new PGlite();
  before = migrationsThrough(TAG, { exclusive: true });
  await migrate(drizzle(client), { migrationsFolder: before });
  // The rows an outbox row names are not what is under test.
  await client.exec("SET session_replication_role = replica");
  for (const [index, row] of rows.entries()) {
    await client.query(
      `INSERT INTO slack_outbox (id, workspace_id, agent_id, slack_app_id,
         installation_id, kind, channel_id, thread_ts, body, dedupe_key, status)
       VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
         gen_random_uuid(), gen_random_uuid(), $1, $2, '', '{"text":"x"}', $3, 'sent')`,
      [row.kind, row.channelId, `row:${index}`],
    );
  }
  await client.exec("SET session_replication_role = origin");
}

const validated = async () =>
  (
    await client.query<{ convalidated: boolean }>(
      "SELECT convalidated FROM pg_constraint WHERE conname = 'slack_outbox_channel_check'",
    )
  ).rows.map((row) => row.convalidated);

/**
 * 0306 refuses an outbox row whose channel is a Slack user id, but a model
 * notice's direct message, and checks the rows already there.
 */
describe("0306 slack_outbox_channel_check", () => {
  test("validates over the rows releases wrote: conversations and model notices", async () => {
    await beforeIt([
      { kind: "reply", channelId: "C0PUBLIC" },
      { kind: "reply", channelId: "G0PRIVATE" },
      { kind: "failure_notice", channelId: "D0DIRECT" },
      { kind: "model_notice", channelId: "U0PERSON" },
    ]);
    expect(await validated()).toEqual([]);

    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });

    expect(await validated()).toEqual([true]);
  });

  test("stops at a row that names a person, leaving new ones refused", async () => {
    await beforeIt([{ kind: "reply", channelId: "W0GRIDPERSON" }]);

    const failed = await migrate(drizzle(client), {
      migrationsFolder: MIGRATIONS_FOLDER,
    }).then(
      () => null,
      (error: Error) => `${error.message} ${String(error.cause)}`,
    );

    expect(failed).toContain("slack_outbox_channel_check");
    expect(await validated()).toEqual([false]);
  });
});
