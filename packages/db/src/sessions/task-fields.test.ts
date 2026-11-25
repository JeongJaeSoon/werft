import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  type ConversationInputId,
  conversationInputIdSchema,
  TASK_CLOSING_DEFAULT,
  type TaskInterpretation,
} from "@werft-ai/contracts";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "../migrate.ts";
import { MIGRATIONS_FOLDER } from "../migration-journal.ts";
import type { Database } from "../queries.ts";
import { migrationsThrough } from "../testing/migrations-through.ts";
import {
  openTaskFields,
  readTaskFields,
  recordTaskClosedReason,
  recordTaskInterpretation,
} from "./task-fields.ts";

const TAG = "0358_session_task_fields";

let client: PGlite;
let db: Database;
let before: string;
let oldRow: string;

// What a host from before the task fields writes: none of them.
const insertSession = async (admission = "active") => {
  const id = randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch, admission_state)
     VALUES ($1, 'owner', 'https://example.invalid/app.git', 'main', $2)`,
    [id, admission],
  );
  return id;
};

const inputId = (): ConversationInputId =>
  conversationInputIdSchema.parse(randomUUID());

const interpretation: TaskInterpretation = {
  goal: "Handle duplicate webhooks",
  doneWhen: "The reproduction test passes",
  limits: { turns: 40, hours: 2 },
};

beforeAll(async () => {
  client = new PGlite();
  before = migrationsThrough(TAG, { exclusive: true });
  await migrate(drizzle(client), { migrationsFolder: before });
  await client.exec("SET session_replication_role = replica");
  oldRow = await insertSession();
  await insertSession("closed");
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  db = drizzle(client) as unknown as Database;
});

afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

describe("session task fields", () => {
  test("every session from before the migration has them all empty", async () => {
    const { rows } = await client.query<Record<string, number>>(
      `SELECT count(*)::int AS sessions,
         count(task_request)::int AS request,
         count(task_interpretation)::int AS interpretation,
         count(task_closing)::int AS closing,
         count(task_closed_reason)::int AS closed_reason
       FROM sessions`,
    );
    expect(rows[0]).toEqual({
      sessions: 2,
      request: 0,
      interpretation: 0,
      closing: 0,
      closed_reason: 0,
    });
  });

  test("a row an old host wrote reads with no task fields", async () => {
    expect(await readTaskFields(db, oldRow)).toEqual({
      request: null,
      interpretation: null,
      closing: null,
      closedReason: null,
    });
    expect(await readTaskFields(db, randomUUID())).toBeNull();
  });

  test("a row an old host inserts after the migration reads the same", async () => {
    // During a rollout the host from before still writes new sessions.
    expect(await readTaskFields(db, await insertSession())).toEqual({
      request: null,
      interpretation: null,
      closing: null,
      closedReason: null,
    });
  });

  test("the server's part and the model's are written once each", async () => {
    const id = await insertSession();
    // Kept as the requester wrote it: no trim, no normalizing.
    const request = {
      inputId: inputId(),
      text: "  Please fix the retries\n\n- 재시도 두 번 ✅  \t",
    };
    expect(
      await openTaskFields(db, id, { request, closing: TASK_CLOSING_DEFAULT }),
    ).toBe(true);
    expect(
      await openTaskFields(db, id, {
        request: { inputId: inputId(), text: "something else" },
        closing: TASK_CLOSING_DEFAULT,
      }),
    ).toBe(false);
    expect(await recordTaskInterpretation(db, id, interpretation)).toBe(true);
    expect(
      await recordTaskInterpretation(db, id, { ...interpretation, goal: "x" }),
    ).toBe(false);
    expect(await readTaskFields(db, id)).toEqual({
      request,
      interpretation,
      closing: TASK_CLOSING_DEFAULT,
      closedReason: null,
    });
  });

  test("a model result carrying the requester's text is refused", async () => {
    const id = await insertSession();
    const fromModel = {
      ...interpretation,
      request: { inputId: inputId(), text: "rewritten" },
    };
    await expect(
      recordTaskInterpretation(db, id, fromModel as TaskInterpretation),
    ).rejects.toThrow();
    expect((await readTaskFields(db, id))?.interpretation).toBeNull();
  });

  test("a closed reason goes only on a closing or closed session", async () => {
    const active = await insertSession();
    expect(await recordTaskClosedReason(db, active, "completed")).toBe(false);
    const closing = await insertSession("closing");
    expect(await recordTaskClosedReason(db, closing, "cancelled")).toBe(true);
    expect(await recordTaskClosedReason(db, closing, "failed")).toBe(false);
    expect((await readTaskFields(db, closing))?.closedReason).toBe("cancelled");
  });

  test("the CHECK takes the four reasons only, and none on an open session", async () => {
    const closed = await insertSession("closed");
    for (const reason of ["completed", "cancelled", "failed", "abandoned"]) {
      await client.query(
        "UPDATE sessions SET task_closed_reason = $2 WHERE id = $1",
        [closed, reason],
      );
    }
    await expect(
      client.query(
        "UPDATE sessions SET task_closed_reason = 'needs_human' WHERE id = $1",
        [closed],
      ),
    ).rejects.toThrow(/sessions_task_closed_reason_check/);
    const active = await insertSession();
    await expect(
      client.query(
        "UPDATE sessions SET task_closed_reason = 'completed' WHERE id = $1",
        [active],
      ),
    ).rejects.toThrow(/sessions_task_closed_reason_check/);
  });
});

// Type tests: tsc fails the build if the model's writer ever takes the
// requester's text.
type ModelInput = Parameters<typeof recordTaskInterpretation>[2];
const noRequestField: "request" extends keyof ModelInput ? never : true = true;
const noTextField: "text" extends keyof ModelInput ? never : true = true;
void noRequestField;
void noTextField;
export function modelWriterTakesNoRequest(): Promise<boolean> {
  return recordTaskInterpretation(db, oldRow, {
    ...interpretation,
    // @ts-expect-error The model's writer has no place for the requester's text.
    request: { inputId: inputId(), text: "rewritten" },
  });
}
