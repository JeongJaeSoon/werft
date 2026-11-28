import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { TASK_CLOSING_DEFAULT, TASK_LIMITS_DEFAULT } from "@werft-ai/contracts";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { events, sessionOutcomes, sessions, turns } from "../schema.ts";
import { newPartitionedSession } from "../testing/sessions.ts";
import { createPostgresTaskCloses } from "./task-close.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

type PullState = "open" | "merged" | "closed";

async function pullRequest(
  sessionId: string,
  number: string,
  state: PullState,
) {
  const [session] = await db
    .select({ ownerId: sessions.ownerId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  await db.insert(sessionOutcomes).values({
    id: randomUUID(),
    ownerId: session?.ownerId ?? "",
    sessionId,
    type: "github_pull_request",
    url: `https://github.com/acme/app/pull/${number}`,
    externalId: number,
    state,
    stateChangedAt: new Date(),
  });
}

async function taskWithPullRequest(
  name: string,
  state: PullState = "merged",
): Promise<string> {
  const { sessionId } = await newPartitionedSession(db, name);
  await db
    .update(sessions)
    .set({ taskClosing: TASK_CLOSING_DEFAULT })
    .where(eq(sessions.id, sessionId));
  await pullRequest(sessionId, name, state);
  return sessionId;
}

const taskOf = async (sessionId: string) =>
  (
    await db
      .select({
        admission: sessions.admissionState,
        reason: sessions.taskClosedReason,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
  )[0];

test("a task the close keeps refusing does not hold the ones after it out of every pass", async () => {
  const [stuck, next] = [
    await taskWithPullRequest("1"),
    await taskWithPullRequest("2"),
  ].sort();
  if (stuck === undefined || next === undefined) throw new Error("no tasks");
  // A legacy pod binding: closeAtomic answers unsupported every time.
  await db
    .update(sessions)
    .set({ podId: "legacy-pod" })
    .where(eq(sessions.id, stuck));
  const sweep = createPostgresTaskCloses(db);

  expect(await sweep.closeOnPullRequests(1)).toBe(0);
  expect(await sweep.closeOnPullRequests(1)).toBe(1);
  expect(await taskOf(next)).toEqual({
    admission: "closed",
    reason: "completed",
  });
  // Past the last one the pass finds none and starts over: the one refused
  // before is tried again and, no longer refused, closes.
  await db.update(sessions).set({ podId: null }).where(eq(sessions.id, stuck));
  expect(await sweep.closeOnPullRequests(1)).toBe(0);
  expect(await sweep.closeOnPullRequests(1)).toBe(1);
  expect(await taskOf(stuck)).toEqual({
    admission: "closed",
    reason: "completed",
  });
});

/** The database, with `then` run right after the pass reads its candidates. */
function afterCandidates(then: () => Promise<void>): Database {
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "execute") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: Parameters<Database["execute"]>) => {
        const rows = await target.execute(...args);
        await then();
        return rows;
      };
    },
  });
}

test.each([
  ["open", { admission: "active", reason: null }],
  ["merged", { admission: "closed", reason: "completed" }],
] as const)(
  "a pull request saved %s after the pass chose a task to cancel is what its close judges",
  async (state, after) => {
    const sessionId = await taskWithPullRequest("1", "closed");
    const sweep = createPostgresTaskCloses(
      afterCandidates(() => pullRequest(sessionId, "2", state)),
    );
    expect(await sweep.closeOnPullRequests(10)).toBe(state === "open" ? 0 : 1);
    expect(await taskOf(sessionId)).toEqual(after);
  },
);

// v1-b/C2: the time rules. Each test moves the clock by moving the rows' own
// times back, so the database clock the rules read stays the real one.
describe("a task's time rules", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /**
   * A paused task whose one turn ended `days` ago, with `count` turns
   * that each ran `minutes`. Paused: closeAtomic closes it with no drain.
   */
  async function quietTask(
    name: string,
    days: number,
    options: { count?: number; minutes?: number; task?: boolean } = {},
  ): Promise<string> {
    const { sessionId } = await newPartitionedSession(db, name);
    const at = new Date(Date.now() - days * DAY);
    const minutes = options.minutes ?? 1;
    await db
      .update(sessions)
      .set({
        taskClosing: options.task === false ? null : TASK_CLOSING_DEFAULT,
        taskInterpretation:
          options.task === false
            ? null
            : {
                goal: "Fix the flaky test",
                doneWhen: "It passes ten times",
                limits: { ...TASK_LIMITS_DEFAULT },
              },
        admissionState: "paused",
        status: "idle",
        createdAt: new Date(at.getTime() - DAY),
        lastTurnAt: at,
      })
      .where(eq(sessions.id, sessionId));
    const ran = {
      status: "completed",
      createdAt: new Date(at.getTime() - minutes * 60_000),
      startedAt: new Date(at.getTime() - minutes * 60_000),
      endedAt: at,
    };
    await db.update(turns).set(ran).where(eq(turns.sessionId, sessionId));
    for (let sequence = 2; sequence <= (options.count ?? 1); sequence += 1) {
      await db
        .insert(turns)
        .values({ sessionId, sequence, message: `turn ${sequence}`, ...ran });
    }
    return sessionId;
  }

  test.each([
    ["14 days idle closes it", 14.01, {}, true],
    ["13 days idle leaves it open", 13.9, {}, false],
    [
      "a session that is no task stays open 60 days idle",
      60,
      { task: false },
      false,
    ],
    ["7 days quiet past its 40 turns closes it", 7.01, { count: 40 }, true],
    [
      "7 days quiet past its 2 working hours closes it",
      7.01,
      { minutes: 121 },
      true,
    ],
    [
      "7 days quiet short of its limits leaves it open",
      7.01,
      { count: 39, minutes: 3 },
      false,
    ],
    [
      "6 days quiet past its 40 turns leaves it open",
      6.9,
      { count: 40 },
      false,
    ],
  ] as const)("%s (as abandoned)", async (_, days, options, closed) => {
    const sessionId = await quietTask("1", days, options);
    expect(await createPostgresTaskCloses(db).closeOnTimeRules(50)).toBe(
      closed ? 1 : 0,
    );
    expect(await taskOf(sessionId)).toEqual(
      closed
        ? { admission: "closed", reason: "abandoned" }
        : { admission: "paused", reason: null },
    );
  });

  test("its close is the system's, by its time rules", async () => {
    const sessionId = await quietTask("1", 15);
    await createPostgresTaskCloses(db).closeOnTimeRules(50);
    const stream = await db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, sessionId));
    expect(stream.map(({ payload }) => payload)).toContainEqual(
      expect.objectContaining({
        admission_state: "closed",
        actor: { kind: "system", by: "idle_rule" },
      }),
    );
  });

  test.each(["queued", "running"])(
    "a %s turn holds both rules off however old the rest is",
    async (status) => {
      const sessionId = await quietTask("1", 30, { count: 40 });
      await db
        .update(turns)
        .set({ status, endedAt: null })
        .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 40)));
      expect(await createPostgresTaskCloses(db).closeOnTimeRules(50)).toBe(0);
      expect(await taskOf(sessionId)).toEqual({
        admission: "paused",
        reason: null,
      });
    },
  );

  test("a person's new input starts the clock again", async () => {
    const sessionId = await quietTask("1", 20, { count: 40 });
    await db.insert(turns).values({
      sessionId,
      sequence: 41,
      message: "still there?",
      status: "completed",
      createdAt: new Date(Date.now() - 6 * DAY),
      startedAt: new Date(Date.now() - 6 * DAY),
      endedAt: new Date(Date.now() - 6 * DAY),
    });
    expect(await createPostgresTaskCloses(db).closeOnTimeRules(50)).toBe(0);
    // Another day of quiet past its limits and it closes.
    await db.execute(sql`
      UPDATE turns SET created_at = created_at - interval '1 day 1 hour',
        started_at = started_at - interval '1 day 1 hour',
        ended_at = ended_at - interval '1 day 1 hour'
      WHERE session_id = ${sessionId}::uuid AND sequence = 41`);
    expect(await createPostgresTaskCloses(db).closeOnTimeRules(50)).toBe(1);
    expect(await taskOf(sessionId)).toEqual({
      admission: "closed",
      reason: "abandoned",
    });
  });

  test("an input saved after the pass chose the task is what its close judges", async () => {
    const sessionId = await quietTask("1", 15);
    const sweep = createPostgresTaskCloses(
      afterCandidates(async () => {
        await db.insert(turns).values({
          sessionId,
          sequence: 2,
          message: "wait, one more thing",
          status: "queued",
        });
      }),
    );
    expect(await sweep.closeOnTimeRules(50)).toBe(0);
    expect(await taskOf(sessionId)).toEqual({
      admission: "paused",
      reason: null,
    });
  });

  test("a pass closes at most its limit, and the next pass the rest", async () => {
    const ids = [
      await quietTask("1", 15),
      await quietTask("2", 15),
      await quietTask("3", 15),
    ];
    const sweep = createPostgresTaskCloses(db);
    expect(await sweep.closeOnTimeRules(2)).toBe(2);
    expect(await sweep.closeOnTimeRules(2)).toBe(1);
    expect(await sweep.closeOnTimeRules(2)).toBe(0);
    for (const id of ids) {
      expect(await taskOf(id)).toEqual({
        admission: "closed",
        reason: "abandoned",
      });
    }
  });

  test("a task the close keeps refusing does not hold another out of every pass", async () => {
    const stuck = await quietTask("1", 15);
    const next = await quietTask("2", 15);
    // A legacy pod binding: closeAtomic answers unsupported every time.
    await db
      .update(sessions)
      .set({ podId: "legacy-pod" })
      .where(eq(sessions.id, stuck));
    // Each pass is a process of its own (runPassLoop): a new sweep each time.
    for (let pass = 0; pass < 40; pass += 1) {
      if ((await createPostgresTaskCloses(db).closeOnTimeRules(1)) === 1) break;
    }
    expect(await taskOf(next)).toEqual({
      admission: "closed",
      reason: "abandoned",
    });
    expect(await taskOf(stuck)).toEqual({
      admission: "paused",
      reason: null,
    });
  });

  test.each(["pausing", "stopping", "resuming", "recovery_required"] as const)(
    "a task %s is left until it settles; once paused, the same rules close it",
    async (state) => {
      const sessionId = await quietTask("1", 15);
      await db
        .update(sessions)
        .set({ admissionState: state })
        .where(eq(sessions.id, sessionId));
      expect(await createPostgresTaskCloses(db).closeOnTimeRules(50)).toBe(0);
      expect((await taskOf(sessionId))?.admission).toBe(state);
      await db
        .update(sessions)
        .set({ admissionState: "paused" })
        .where(eq(sessions.id, sessionId));
      expect(await createPostgresTaskCloses(db).closeOnTimeRules(50)).toBe(1);
      expect(await taskOf(sessionId)).toEqual({
        admission: "closed",
        reason: "abandoned",
      });
    },
  );
});

test("a close of a session no longer there is not_found, not closed work", async () => {
  expect(
    await createPostgresTaskCloses(db).close({
      principal: { ownerId: randomUUID() },
      sessionId: randomUUID(),
      reason: "completed",
    }),
  ).toBe("not_found");
});
