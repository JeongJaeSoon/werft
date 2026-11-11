import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionReader,
  events,
  fillNeutralFields,
  projectToolCalls,
  sessions,
  turns,
} from "@werft-ai/db";
import {
  fixtureRelease,
  sessionPinColumns,
} from "@werft-ai/db/testing/spec-pins";
import { createLogger } from "@werft-ai/observability";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eventNeutralizer } from "./neutral-fields.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-neutral";

// Events as a worker stored them before the control plane added the
// neutral fields: the Claude engine's own shape, one block each.
const block = (content: unknown, parent: string | null = null) => ({
  type: "assistant",
  message: { content: [content] },
  parent_tool_use_id: parent,
});
const use = (
  id: string,
  name: string,
  input: unknown = {},
  parent: string | null = null,
) => block({ type: "tool_use", id, name, input }, parent);
const said = (text: string) => block({ type: "text", text });
const result = (id: string, isError?: boolean) => ({
  type: "tool_result",
  tool_use_id: id,
  content: "",
  ...(isError === undefined ? {} : { is_error: isError }),
});

integration("events stored before the neutral fields, once filled", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "neutral_legacy_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  test("read in the session list and the tool calls as the neutral ones are", async () => {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: OWNER,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      agentReleaseId: await fixtureRelease(db),
      ...sessionPinColumns(),
    });
    const [turn] = await db
      .insert(turns)
      .values({ sessionId: id, sequence: 1, message: "hi", status: "running" })
      .returning({ id: turns.id });
    const stored: Array<[string, unknown]> = [
      ["status", { phase: "running" }],
      ["assistant", said("Reading the retry code first.")],
      ["assistant", use("t-read", "Read", { file_path: "retry.ts" })],
      ["assistant", use("t-bash", "Bash", { description: "run tests" })],
      ["tool_result", result("t-read")],
      ["tool_result", result("t-bash", true)],
      ["tool_use", use("t-task", "Task", { subagent_type: "reviewer" })],
      ["tool_use", use("t-grep", "Grep", { pattern: "max" }, "t-task")],
      ["tool_result", result("t-grep", false)],
    ];
    for (const [type, payload] of stored) {
      await db.insert(events).values({
        sessionId: id,
        turnId: turn?.id ?? null,
        type,
        payload,
        createdAt: new Date(Date.now() - 600_000),
      });
    }
    await db.execute(sql`
      UPDATE neutral_field_progress
      SET filled_through = 0, history_through = (SELECT max(id) FROM events)
      WHERE id = 1`);

    const neutralize = eventNeutralizer(createLogger({ level: "error" }));
    const fill = await fillNeutralFields(db, {
      neutralize,
      batchSize: 100,
      budgetMs: 10_000,
    });
    expect(fill).toMatchObject({ filled: 8, caughtUp: true });

    // As the session list reads the same events written with the neutral
    // fields (session-activity.integration.test.ts).
    const detail = await createPostgresSessionReader(db).getSession(OWNER, id);
    expect(detail?.activity).toMatchObject({
      tool_count: 4,
      error_count: 1,
      subagent_count: 1,
      last: { kind: "tool", name: "Grep", target: "max" },
      current_tool: { id: "t-task", name: "Task", state: "running" },
    });

    // As before, the projection counts the calls of tool_use events.
    await projectToolCalls(db, { batchSize: 100, budgetMs: 10_000 });
    const calls = await db.execute(
      sql`SELECT tool_use_id, name, outcome FROM tool_calls ORDER BY tool_use_id`,
    );
    expect(calls.rows).toEqual([
      { tool_use_id: "t-grep", name: "Grep", outcome: "ok" },
      { tool_use_id: "t-task", name: "Task", outcome: "unknown" },
    ]);
  });
});
