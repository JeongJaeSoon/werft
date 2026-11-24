import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { createPostgresGitHubGateStore } from "./github-settings.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("GitHub gate receipts", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "github_gate_receipts_it" });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("a release read's mint receipt is on the workspace, a session's on the session", async () => {
    const store = createPostgresGitHubGateStore(db);
    const workspaceId = randomUUID();
    const sessionId = randomUUID();
    const mint = {
      ownerId: workspaceId,
      actor: null,
      operation: "mint_github_token",
      status: "succeeded",
      error: null,
    } as const;
    const release = await store.recordReceipt({
      ...mint,
      sessionId: null,
      workspaceId,
      result: { purpose: "release_instructions" },
    });
    const clone = await store.recordReceipt({
      ...mint,
      sessionId,
      result: { purpose: "clone" },
    });

    const { rows } = await pool.query<{
      id: string;
      target_ref: unknown;
      purpose: string;
    }>(
      "SELECT id, target_ref, result->>'purpose' AS purpose FROM receipts WHERE owner_id = $1",
      [workspaceId],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(release)).toEqual({
      id: release,
      target_ref: {
        resource: { kind: "workspace", id: workspaceId },
        workspace_id: workspaceId,
      },
      purpose: "release_instructions",
    });
    expect(byId.get(clone)).toEqual({
      id: clone,
      target_ref: { session_id: sessionId, turn_id: null, request_id: null },
      purpose: "clone",
    });
  });
});
