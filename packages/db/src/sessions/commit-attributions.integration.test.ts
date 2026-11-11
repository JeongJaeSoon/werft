import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CommitAttributionLedger } from "@werft-ai/platform";
import type { AttributionExpectation } from "@werft-ai/runtime-core";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { sessionCommitAttributions, sessions } from "../schema.ts";
import { createPostgresCommitAttributionLedger } from "./commit-attributions.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const BOT = {
  name: "werft-dev[bot]",
  email: "41898282+werft-dev[bot]@users.noreply.github.com",
};
const LINKED: AttributionExpectation = {
  author: BOT,
  coAuthor: {
    name: "octocat",
    email: "583231+octocat@users.noreply.github.com",
  },
  agentSession: "https://console.example.com/sessions/s1",
};
const UNLINKED: AttributionExpectation = { ...LINKED, coAuthor: null };

integration("postgres commit attribution ledger", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let ledger: CommitAttributionLedger;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "commit_attr_it" });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
    ledger = createPostgresCommitAttributionLedger(db);
  });
  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function session() {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: "owner-attr",
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      repositoryId: "sample-app",
    });
    return id;
  }

  test("a session with no claim recorded has no bundle", async () => {
    expect(await ledger.list(await session())).toEqual([]);
  });

  test("keeps each distinct bundle once, oldest first, and the same bundle twice is one row", async () => {
    const id = await session();
    await ledger.record(id, UNLINKED);
    await ledger.record(id, UNLINKED);
    await ledger.record(id, LINKED);
    await ledger.record(id, UNLINKED);
    expect(await ledger.list(id)).toEqual([UNLINKED, LINKED]);
  });

  test("bundles are per session", async () => {
    const [first, second] = [await session(), await session()];
    await ledger.record(first, LINKED);
    expect(await ledger.list(second)).toEqual([]);
  });

  test("an uppercase session id reaches the same rows", async () => {
    const id = await session();
    await ledger.record(id.toUpperCase(), LINKED);
    expect(await ledger.list(id)).toEqual([LINKED]);
  });

  test("the rows go with the session", async () => {
    const id = await session();
    await ledger.record(id, LINKED);
    await db.delete(sessions).where(eq(sessions.id, id));
    expect(
      await db
        .select()
        .from(sessionCommitAttributions)
        .where(eq(sessionCommitAttributions.sessionId, id)),
    ).toEqual([]);
  });

  test("a co-author name without its email is refused by the table", async () => {
    const id = await session();
    // The insert builder is a thenable, not a Promise: run it inside one.
    await expect(
      (async () => {
        await db.insert(sessionCommitAttributions).values({
          sessionId: id,
          digest: "x",
          authorName: "a",
          authorEmail: "a@b",
          coAuthorName: "only a name",
        });
      })(),
    ).rejects.toThrow();
  });
});
