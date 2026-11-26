import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { checkStorageCounter } from "./storage-counter-check.ts";

let client: PGlite;
let db: Database;

beforeAll(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
});

afterAll(() => client.close());

const counter = async () =>
  Number(
    (
      await client.query<{ bytes: string }>(
        "SELECT bytes FROM storage_usage WHERE scope = 'installation'",
      )
    ).rows[0]?.bytes,
  );

describe("checkStorageCounter", () => {
  test("reads the counter and the turns' bytes, and changes neither", async () => {
    const session = crypto.randomUUID();
    await client.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, status)
       VALUES ($1, 'owner-a', 'https://example.invalid/r.git', 'main', 'idle')`,
      [session],
    );
    await client.query(
      `INSERT INTO turns (session_id, sequence, message, status)
       VALUES ($1, 1, 'héllo', 'queued'), ($1, 2, 'abc', 'queued')`,
      [session],
    );
    // The charge trigger counted both inserts: 6 + 3 bytes.
    expect(await checkStorageCounter(db, { timeoutMs: 60_000 })).toEqual({
      outcome: "checked",
      counterBytes: 9,
      actualBytes: 9,
    });
    await client.query(
      "UPDATE storage_usage SET bytes = bytes + 5 WHERE scope = 'installation'",
    );
    expect(await checkStorageCounter(db, { timeoutMs: 60_000 })).toEqual({
      outcome: "checked",
      counterBytes: 14,
      actualBytes: 9,
    });
    expect(await counter()).toBe(14);
  });

  test("the scan's timeout is the transaction's own", async () => {
    await checkStorageCounter(db, { timeoutMs: 1_234 });
    const { rows } = await client.query<{ statement_timeout: string }>(
      "SHOW statement_timeout",
    );
    expect(rows[0]?.statement_timeout).toBe("0");
  });
});
