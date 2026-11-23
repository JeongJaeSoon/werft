import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER, readJournal } from "./migration-journal.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { createPostgresSessionLinkStore } from "./session-links.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

// By name: db:restack renumbers the migration and not this file.
const TAG =
  readJournal(MIGRATIONS_FOLDER).find((entry) =>
    entry.tag.endsWith("_session_link_old_uniques"),
  )?.tag ?? "session_link_old_uniques";

let client: PGlite;
let before: string;
const installationId = randomUUID();
const oldLinkId = randomUUID();
const oldSessionId = randomUUID();

const insertLink = (
  surfaceRef: string,
  options: { sessionId?: string | null; closed?: boolean } = {},
) =>
  client.query<{ id: string }>(
    `INSERT INTO session_links (id, workspace_id, owner_id, session_id,
       installation_id, surface_binding_id, surface_ref, channel_id, thread_id,
       opened_by_ts, agent_id, release_id, closed_at, closed_reason)
     VALUES ($1, $2, 'owner', $3, $4, $5, $6, 'C1', '1.1', '1.1', $7, 'r1',
       $8, $9)
     RETURNING id`,
    [
      randomUUID(),
      randomUUID(),
      options.sessionId ?? null,
      installationId,
      randomUUID(),
      surfaceRef,
      randomUUID(),
      options.closed === true ? new Date() : null,
      options.closed === true ? "completed" : null,
    ],
  );

// What a host from before the open-only uniques (94S-2021) writes.
const preOpenOnlyHostReserve = (surfaceRef: string) =>
  client.query(
    `INSERT INTO session_links (id, workspace_id, owner_id, installation_id,
       surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts,
       agent_id, release_id)
     VALUES (gen_random_uuid(), gen_random_uuid(), 'owner', $1,
       gen_random_uuid(), $2, 'C1', '1.1', '1.1', gen_random_uuid(), 'r1')
     ON CONFLICT (installation_id, surface_ref) DO NOTHING`,
    [installationId, surfaceRef],
  );

const uniques = async () =>
  (
    await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'session_links' AND indexdef LIKE 'CREATE UNIQUE INDEX%'
         AND indexname <> 'session_links_pkey'
       ORDER BY indexname`,
    )
  ).rows.map((row) => row.indexname);

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
     VALUES ($1, gen_random_uuid(), 'owner', $2, $3, gen_random_uuid(),
       'T1:C1:1.1', 'C1', '1.1', '1.1', gen_random_uuid(), 'r1')`,
    [oldLinkId, oldSessionId, installationId],
  );
  // Before: the old uniques refuse a closed link beside an open one.
  await expect(insertLink("T1:C1:1.1", { closed: true })).rejects.toThrow(
    /session_links_surface_ref_key/,
  );
  await expect(
    insertLink("T1:C1:0.9", { sessionId: oldSessionId, closed: true }),
  ).rejects.toThrow(/session_links_session_uniq/);
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
});

afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

describe("0336 drops the old session link uniques", () => {
  test("leaves only the two open-only uniques", async () => {
    expect(await uniques()).toEqual([
      "session_links_open_session_uniq",
      "session_links_open_surface_ref_uniq",
    ]);
    const constraints = await client.query(
      "SELECT conname FROM pg_constraint WHERE conname = 'session_links_surface_ref_key'",
    );
    expect(constraints.rows).toEqual([]);
  });

  test("keeps the open link already there as it was", async () => {
    const { rows } = await client.query(
      "SELECT session_id, closed_at FROM session_links WHERE id = $1",
      [oldLinkId],
    );
    expect(rows).toEqual([{ session_id: oldSessionId, closed_at: null }]);
  });

  test("a closed link sits beside the open one in the same thread and session", async () => {
    await insertLink("T1:C1:1.1", { sessionId: oldSessionId, closed: true });
    await insertLink("T1:C1:1.1", { sessionId: oldSessionId, closed: true });
    const { rows } = await client.query<{ open: boolean }>(
      "SELECT closed_at IS NULL AS open FROM session_links WHERE surface_ref = 'T1:C1:1.1' ORDER BY open",
    );
    expect(rows.map((row) => row.open)).toEqual([false, false, true]);
  });

  test("a second open link of a thread or a session is still refused", async () => {
    await expect(insertLink("T1:C1:1.1")).rejects.toThrow(
      /session_links_open_surface_ref_uniq/,
    );
    await expect(
      insertLink("T1:C1:2.2", { sessionId: oldSessionId }),
    ).rejects.toThrow(/session_links_open_session_uniq/);
  });

  test("this release's store reserves a thread whose link closed", async () => {
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
    const closed = (await insertLink(input.surfaceRef, { closed: true }))
      .rows[0]?.id;
    const reserved = await store.reserve(input);
    const replayed = await store.reserve(input);
    expect([reserved.reserved, replayed.reserved]).toEqual([true, false]);
    expect(reserved.link.id).not.toBe(closed);
    expect(replayed.link.id).toBe(reserved.link.id);
  });

  // Why no image from before the open-only uniques may run after this.
  test("a host from before the open-only uniques can no longer reserve", async () => {
    await expect(preOpenOnlyHostReserve("T1:C1:4.4")).rejects.toThrow(
      /no unique or exclusion constraint matching the ON CONFLICT/,
    );
  });

  test("every statement runs again on a database it already changed", async () => {
    // As migrate runs it on PGlite, which drops no index concurrently.
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
    expect(await uniques()).toEqual([
      "session_links_open_session_uniq",
      "session_links_open_surface_ref_uniq",
    ]);
  });
});
