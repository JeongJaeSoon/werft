import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { createPostgresSessionLinkStore } from "./session-links.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

const TAG = "0313_session_link_history";

let client: PGlite;
let before: string;
const installationId = randomUUID();
const oldLinkId = randomUUID();
const oldSessionId = randomUUID();

// What the host before 0313 writes: no closed_* columns, its ON CONFLICT
// naming the old (installation_id, surface_ref) key.
const oldHostReserve = (surfaceRef: string, sessionId: string | null = null) =>
  client.query<{ id: string }>(
    `INSERT INTO session_links (id, workspace_id, owner_id, session_id,
       installation_id, surface_binding_id, surface_ref, channel_id, thread_id,
       opened_by_ts, agent_id, release_id)
     VALUES ($1, $2, 'owner', $3, $4, $5, $6, 'C1', '1.1', '1.1', $7, 'r1')
     ON CONFLICT (installation_id, surface_ref) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      randomUUID(),
      sessionId,
      installationId,
      randomUUID(),
      surfaceRef,
      randomUUID(),
    ],
  );

const oldHostOutbox = () =>
  client.query(
    `INSERT INTO slack_outbox (id, workspace_id, agent_id, slack_app_id,
       installation_id, kind, channel_id, thread_ts, body, dedupe_key)
     VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
       gen_random_uuid(), $1, 'reply', 'C1', '1.1', '{"text":"x"}', $2)`,
    [installationId, randomUUID()],
  );

beforeAll(async () => {
  client = new PGlite();
  before = migrationsThrough(TAG, { exclusive: true });
  await migrate(drizzle(client), { migrationsFolder: before });
  // The rows a link names are not what is under test.
  await client.exec("SET session_replication_role = replica");
  await client.query(
    `INSERT INTO session_links (id, workspace_id, owner_id, session_id,
       installation_id, surface_binding_id, surface_ref, channel_id, thread_id,
       opened_by_ts, agent_id, release_id)
     VALUES ($1, $2, 'owner', $3, $4, $5, 'T1:C1:1.1', 'C1', '1.1', '1.1', $6, 'r1')`,
    [
      oldLinkId,
      randomUUID(),
      oldSessionId,
      installationId,
      randomUUID(),
      randomUUID(),
    ],
  );
  await oldHostOutbox();
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
});

afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

const uniques = async (table: string) =>
  (
    await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = $1 AND indexdef LIKE 'CREATE UNIQUE INDEX%'
         AND indexname <> $1 || '_pkey'
       ORDER BY indexname`,
      [table],
    )
  ).rows;

describe("0313 session link history", () => {
  test("adds the closed columns, the two open-only uniques beside the old two, and the outbox link column", async () => {
    const columns = (
      await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE (table_name = 'session_links' AND column_name IN ('closed_at', 'closed_reason'))
            OR (table_name = 'slack_outbox' AND column_name = 'session_link_id')
         ORDER BY table_name, column_name`,
      )
    ).rows;
    expect(columns).toEqual([
      { table_name: "session_links", column_name: "closed_at" },
      { table_name: "session_links", column_name: "closed_reason" },
      { table_name: "slack_outbox", column_name: "session_link_id" },
    ]);
    const indexes = await uniques("session_links");
    expect(indexes.map((index) => index.indexname)).toEqual([
      "session_links_open_session_uniq",
      "session_links_open_surface_ref_uniq",
      "session_links_session_uniq",
      "session_links_surface_ref_key",
    ]);
    expect(
      indexes.find((i) => i.indexname === "session_links_open_surface_ref_uniq")
        ?.indexdef,
    ).toContain("(installation_id, surface_ref) WHERE (closed_at IS NULL)");
    expect(
      indexes.find((i) => i.indexname === "session_links_open_session_uniq")
        ?.indexdef,
    ).toContain(
      "(session_id) WHERE ((session_id IS NOT NULL) AND (closed_at IS NULL))",
    );
    const validated = (
      await client.query<{ conname: string; convalidated: boolean }>(
        `SELECT conname, convalidated FROM pg_constraint
         WHERE conname IN ('session_links_closed_check',
           'session_links_closed_reason_check', 'slack_outbox_session_link_fk')
         ORDER BY conname`,
      )
    ).rows;
    expect(validated).toEqual([
      { conname: "session_links_closed_check", convalidated: true },
      { conname: "session_links_closed_reason_check", convalidated: true },
      { conname: "slack_outbox_session_link_fk", convalidated: true },
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
    const built = await uniques("session_links");
    for (const statement of statements) {
      await client.exec(statement);
    }
    expect(await uniques("session_links")).toEqual(built);
  });

  test("leaves the rows already there open and the outbox rows without a link", async () => {
    const link = await client.query(
      "SELECT closed_at, closed_reason FROM session_links WHERE id = $1",
      [oldLinkId],
    );
    expect(link.rows).toEqual([{ closed_at: null, closed_reason: null }]);
    const outbox = await client.query(
      "SELECT session_link_id FROM slack_outbox",
    );
    expect(outbox.rows).toEqual([{ session_link_id: null }]);
  });

  test("the old host's insert and ON CONFLICT still reserve once per thread", async () => {
    const first = await oldHostReserve("T1:C1:2.2");
    const again = await oldHostReserve("T1:C1:2.2");
    expect(first.rows).toHaveLength(1);
    expect(again.rows).toEqual([]);
    await oldHostOutbox();
  });

  test("this release's store reserves, replays and attaches as before", async () => {
    const store = createPostgresSessionLinkStore(
      drizzle(client, { schema }) as unknown as Database,
    );
    const input = {
      workspaceId: randomUUID(),
      installationId,
      surfaceBindingId: randomUUID(),
      surfaceRef: "T1:C1:3.3",
      channelId: "C1",
      threadId: "3.3",
      openedByTs: "3.3",
      agentId: randomUUID(),
      releaseId: "r1",
      createdBy: null,
    };
    const reserved = await store.reserve(input);
    const replayed = await store.reserve(input);
    expect([reserved.reserved, replayed.reserved]).toEqual([true, false]);
    expect(replayed.link.id).toBe(reserved.link.id);
    const sessionId = randomUUID();
    const attached = await store.attachSession(reserved.link.id, sessionId);
    expect(attached.sessionId).toBe(sessionId);
    // A second link cannot take a session another link holds.
    const other = await store.reserve({ ...input, surfaceRef: "T1:C1:4.4" });
    await expect(
      client.query("UPDATE session_links SET session_id = $1 WHERE id = $2", [
        sessionId,
        other.link.id,
      ]),
    ).rejects.toThrow(/session_links_(open_)?session_uniq/);
  });

  test("a closed link stays held by the old unique until a later migration drops it", async () => {
    await client.query(
      "UPDATE session_links SET closed_at = now(), closed_reason = 'completed' WHERE id = $1",
      [oldLinkId],
    );
    const reopened = await oldHostReserve("T1:C1:1.1");
    expect(reopened.rows).toEqual([]);
    await expect(oldHostReserve("T1:C1:9.9", oldSessionId)).rejects.toThrow(
      /session_links_session_uniq/,
    );
  });

  test("a close needs both its time and a known reason", async () => {
    const link = (await oldHostReserve("T1:C1:5.5")).rows[0]?.id;
    await expect(
      client.query("UPDATE session_links SET closed_at = now() WHERE id = $1", [
        link,
      ]),
    ).rejects.toThrow(/session_links_closed_check/);
    await expect(
      client.query(
        "UPDATE session_links SET closed_at = now(), closed_reason = 'revoked' WHERE id = $1",
        [link],
      ),
    ).rejects.toThrow(/session_links_closed_reason_check/);
    for (const reason of schema.SESSION_LINK_CLOSED_REASONS) {
      await client.query(
        "UPDATE session_links SET closed_at = now(), closed_reason = $2 WHERE id = $1",
        [link, reason],
      );
    }
  });

  // Other outbox keys fail first on a bare row, so the definition is read.
  test("the outbox row's link column refers to session_links", async () => {
    const { rows } = await client.query<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'slack_outbox_session_link_fk'",
    );
    expect(rows).toEqual([
      { def: "FOREIGN KEY (session_link_id) REFERENCES session_links(id)" },
    ]);
  });
});
