import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { deleteExpiredWebSessions } from "./identity.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  // Rows of a user, an invite and a reset are beside the point here.
  await client.query(`SET session_replication_role = replica`);
});

afterEach(async () => {
  await client.close();
});

async function webSession(expiredDaysAgo: number): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO web_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1::uuid, $2, decode(md5($1::text), 'hex'), now() - make_interval(days => $3))`,
    [id, crypto.randomUUID(), expiredDaysAgo],
  );
  return id;
}

const left = async () =>
  (
    await client.query<{ id: string }>(
      `SELECT id FROM web_sessions ORDER BY expires_at`,
    )
  ).rows.map(({ id }) => id);

test("deletes web sessions 30 days past expiry, keeps the rest and every reset", async () => {
  const old = await webSession(31);
  const recent = await webSession(29);
  const live = await webSession(-1);
  await client.query(
    `INSERT INTO password_resets (id, workspace_id, user_id, token_hash, issued_by, expires_at)
     VALUES ($1::uuid, $1::uuid, $1::uuid, decode(md5($1::text), 'hex'), $1::uuid, now() - interval '400 days')`,
    [crypto.randomUUID()],
  );

  expect(await deleteExpiredWebSessions(db, { limit: 10, dryRun: true })).toBe(
    1,
  );
  expect(await left()).toEqual([old, recent, live]);

  expect(await deleteExpiredWebSessions(db, { limit: 10, dryRun: false })).toBe(
    1,
  );
  expect(await left()).toEqual([recent, live]);
  expect(
    (await client.query(`SELECT 1 FROM password_resets`)).rows,
  ).toHaveLength(1);
});

test("deletes at most the limit per pass", async () => {
  for (let i = 0; i < 3; i += 1) await webSession(40 + i);
  expect(await deleteExpiredWebSessions(db, { limit: 2, dryRun: false })).toBe(
    2,
  );
  expect(await left()).toHaveLength(1);
});
