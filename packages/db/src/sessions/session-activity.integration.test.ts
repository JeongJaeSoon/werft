import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SESSION_ACTIVITY_WINDOW_EVENTS } from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionReader } from "../postgres-unit-of-work.ts";
import * as schema from "../schema.ts";
import { events, sessions, turns } from "../schema.ts";
import { readSessionActivity } from "./session-activity.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-activity";
const VIEWER = { userId: null, apiKeyId: null };
const T0 = Date.parse("2026-10-25T01:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000);

// Events as the runtime's codec gives them: one call or text each, read
// through the engine-neutral fields only.
const use = (id: string, name: string, input: unknown = {}) => ({
  tool_call: { id, name, input },
});
const text = (value: string) => ({ text: value });
const assistant = (
  said: Record<string, unknown>,
  parent: string | null = null,
) => ({
  type: "assistant",
  ...said,
  parent_tool_use_id: parent,
});
const result = (id: string, isError = false) => ({
  tool_result: { tool_call_id: id, is_error: isError, text: "" },
});

integration("session activity on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let statements = 0;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_activity_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, {
      schema,
      logger: {
        logQuery() {
          statements += 1;
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  async function session() {
    const [row] = await db
      .insert(sessions)
      .values({
        id: crypto.randomUUID(),
        ownerId: OWNER,
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
      })
      .returning({ id: sessions.id });
    if (!row) throw new Error("no session");
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId: row.id,
        sequence: 1,
        message: "hello",
        status: "running",
      })
      .returning({ id: turns.id });
    if (!turn) throw new Error("no turn");
    let second = 0;
    const record = async (
      type: string,
      payload: unknown,
      options: { turn?: number | null; seconds?: number } = {},
    ) => {
      second = options.seconds ?? second + 1;
      await db.insert(events).values({
        sessionId: row.id,
        type,
        payload,
        turnId: options.turn === undefined ? turn.id : options.turn,
        occurredAt: at(second),
      });
    };
    return { id: row.id, turnId: turn.id, record };
  }

  async function activity(id: string) {
    return (await readSessionActivity(db, [id])).get(id);
  }

  test("the session list and detail answer no activity", async () => {
    const s = await session();
    await s.record("assistant", assistant(use("t-1", "Read")));
    const reader = createPostgresSessionReader(db);
    const item = (
      await reader.listSessions(OWNER, { limit: 100 }, VIEWER)
    ).items.find((listed) => listed.id === s.id);
    const detail = await reader.getSession(OWNER, s.id);
    if (item === undefined || detail === null) throw new Error("not read");
    expect(Object.hasOwn(item, "activity")).toBe(false);
    expect(Object.hasOwn(detail, "activity")).toBe(false);
    expect((await activity(s.id))?.tool_count).toBe(1);
  });

  test("a session without events has an empty, complete window", async () => {
    const { id } = await session();
    expect(await activity(id)).toEqual({
      last: null,
      tool_count: 0,
      error_count: 0,
      subagent_count: 0,
      current_tool: null,
      window: { events: 0, complete: true, since: null },
    });
  });

  test("calls pair with their results; a subagent's calls count, and Task spawns one", async () => {
    const s = await session();
    await s.record("status", { phase: "running" });
    await s.record(
      "assistant",
      assistant(text("\n  Reading the retry code first.  \nthen more")),
    );
    await s.record(
      "assistant",
      assistant(use("t-read", "Read", { file_path: "retry.ts" })),
    );
    await s.record(
      "assistant",
      assistant(
        use("t-bash", "Bash", { command: 42, description: "run tests" }),
      ),
    );
    await s.record("tool_result", result("t-read", false));
    await s.record("tool_result", result("t-bash", true));
    await s.record(
      "tool_use",
      assistant(use("t-task", "Task", { subagent_type: "code-reviewer" })),
    );
    await s.record(
      "tool_use",
      assistant(use("t-grep", "Grep", { pattern: "maxAttempts" }), "t-task"),
    );
    // The same call again, as a replayed frame: counted once.
    await s.record(
      "assistant",
      assistant(use("t-grep", "Grep", { pattern: "maxAttempts" }), "t-task"),
    );
    await s.record("tool_result", result("t-grep"));
    // A result for a call the window never saw is not an error of it.
    await s.record("tool_result", result("elsewhere", true));

    const read = await activity(s.id);
    expect(read).toMatchObject({
      tool_count: 4,
      error_count: 1,
      subagent_count: 1,
      last: { kind: "tool", name: "Grep", target: "maxAttempts" },
      current_tool: {
        id: "t-task",
        name: "Task",
        target: "",
        state: "running",
        since: at(7).toISOString(),
      },
      window: { events: 11, complete: true, since: expect.any(String) },
    });

    await s.record("assistant", assistant(text("   ")));
    await s.record(
      "assistant",
      assistant(use("t-edit", "Edit", { file_path: "retry.ts" })),
    );
    await s.record(
      "assistant",
      assistant(text("Done reviewing.\r\nDetails follow.")),
    );
    expect((await activity(s.id))?.last).toEqual({
      kind: "text",
      text: "Done reviewing.",
    });
  });

  test("a subagent run counts once its events name it, and for a call any frame of which is a Task", async () => {
    const s = await session();
    // The Task call fell out of the window; its subagent's calls remain.
    await s.record(
      "tool_use",
      assistant(use("t-in", "Read", { path: "a.ts" }), "t-gone"),
    );
    await s.record(
      "tool_use",
      assistant(use("t-in2", "Read", { path: "b.ts" }), "t-gone"),
    );
    await s.record("assistant", assistant(use("t-twice", "Bash")));
    await s.record("assistant", assistant(use("t-twice", "Task")));
    expect(await activity(s.id)).toMatchObject({
      tool_count: 3,
      subagent_count: 2,
    });
  });

  test("an open call waits on its question until the session moves past needs_input", async () => {
    const s = await session();
    await s.record("status", { phase: "running" });
    await s.record(
      "assistant",
      assistant(
        use("t-push", "Bash", { command: "git push origin fix/webhook" }),
      ),
    );
    await s.record("question", {
      request_id: "r1",
      tool_use_id: "t-push",
      kind: "permission",
      tool: "Bash",
      input: {},
    });
    await s.record("status", { phase: "needs_input" });
    expect((await activity(s.id))?.current_tool).toEqual({
      id: "t-push",
      name: "Bash",
      target: "git push origin fix/webhook",
      state: "waiting",
      since: at(3).toISOString(),
      request: { kind: "permission", prompt: null },
    });

    await s.record("status", { phase: "running" });
    expect((await activity(s.id))?.current_tool).toMatchObject({
      id: "t-push",
      state: "running",
      since: at(2).toISOString(),
      request: null,
    });

    await s.record("tool_result", result("t-push"));
    expect((await activity(s.id))?.current_tool).toBeNull();
  });

  test("a question's request carries its first question's text, cut by code points", async () => {
    const s = await session();
    await s.record("assistant", assistant(use("t-ask", "AskUserQuestion")));
    const asked = (questions: unknown) =>
      s.record("question", {
        request_id: "r-ask",
        tool_use_id: "t-ask",
        kind: "question",
        input: { questions },
      });
    // As the control plane stores them (pendingQuestionSchema).
    const pending = (prompt: string) => ({
      question_id: "q0",
      prompt,
      options: [{ option_id: "q0o0", label: "A" }],
      multi_select: false,
      allow_free_text: true,
    });
    await asked([pending("  "), pending(" 'workspace'를 어떻게 옮길까요?\n")]);
    expect((await activity(s.id))?.current_tool?.request).toEqual({
      kind: "question",
      prompt: "'workspace'를 어떻게 옮길까요?",
    });
    // The newer question for the call is the one shown.
    await asked([pending("😀".repeat(250))]);
    const prompt = (await activity(s.id))?.current_tool?.request?.prompt;
    expect([...(prompt ?? "")]).toEqual(Array(200).fill("😀"));
    await asked([{ header: "no text" }]);
    expect((await activity(s.id))?.current_tool?.request).toEqual({
      kind: "question",
      prompt: null,
    });
  });

  test("a call its turn's result or a stopped session leaves open is interrupted, not current or failed", async () => {
    const byTurn = await session();
    await byTurn.record(
      "assistant",
      assistant(use("t-long", "Bash", { command: "sleep 600" })),
    );
    await byTurn.record("result", {
      type: "result",
      subtype: "error_during_execution",
      session_id: "engine",
    });
    expect(await activity(byTurn.id)).toMatchObject({
      tool_count: 1,
      error_count: 0,
      current_tool: null,
    });

    const byStatus = await session();
    await byStatus.record("status", { phase: "running" });
    await byStatus.record(
      "assistant",
      assistant(use("t-old", "Read", { path: "a.ts" })),
    );
    await byStatus.record("status", { phase: "interrupting" });
    expect((await activity(byStatus.id))?.current_tool?.id).toBe("t-old");
    await byStatus.record("status", { phase: "idle" });
    expect((await activity(byStatus.id))?.current_tool).toBeNull();
    // A call made after the stop is open again.
    await byStatus.record(
      "assistant",
      assistant(use("t-new", "Read", { path: "b.ts" })),
    );
    expect((await activity(byStatus.id))?.current_tool?.id).toBe("t-new");
  });

  test("counts read only the newest events and say so", async () => {
    const s = await session();
    await db.insert(events).values(
      Array.from({ length: SESSION_ACTIVITY_WINDOW_EVENTS + 1 }, (_, i) => ({
        sessionId: s.id,
        type: "tool_use",
        payload: assistant(use(`t-${i}`, "Read", { path: `${i}.ts` })),
        turnId: s.turnId,
        occurredAt: at(i),
        createdAt: at(i),
      })),
    );
    expect(await activity(s.id)).toMatchObject({
      tool_count: SESSION_ACTIVITY_WINDOW_EVENTS,
      window: {
        events: SESSION_ACTIVITY_WINDOW_EVENTS,
        complete: false,
        since: at(1).toISOString(),
      },
    });
  });

  test("activity for many sessions reads in a fixed number of statements, whatever their number", async () => {
    const statementsFor = async (count: number) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const s = await session();
        await s.record("assistant", assistant(use(`t-${i}`, "Read")));
        ids.push(s.id);
      }
      statements = 0;
      const read = await readSessionActivity(db, ids);
      expect(read.size).toBe(count);
      expect([...read.values()].every((one) => one.tool_count === 1)).toBe(
        true,
      );
      return statements;
    };
    const small = await statementsFor(2);
    expect(await statementsFor(25)).toBe(small);
  });
});
