import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "../migrate.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { MAX_SESSION_COST_USD } from "../schema.ts";
import { createPostgresUsageReader } from "../usage-reader.ts";
import { createPostgresWorkerUnitOfWork } from "../worker-unit-of-work.ts";
import { readPlatformMetrics } from "./metrics-reader.ts";

const BUDGET = { costUsd: 25, tokens: null };
const BUCKETS = [1, 60, 3600];
const HOUR = 3_600_000;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

const read = () =>
  readPlatformMetrics(db as unknown as Database, {
    budget: BUDGET,
    buckets: BUCKETS,
  });

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: `${import.meta.dir}/../../migrations`,
  });
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE sessions, attempts, executions, turns, pending_requests, tool_calls, provider_usage, session_model_usage, session_pre_metering_cost, queue_messages, unassigned_sessions, worker_launches CASCADE`,
  );
});

type SessionSeed = {
  status?: string;
  admission?: string;
  createdAt?: string;
  costUsd?: number;
};

async function session(seed: SessionSeed = {}): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch, status, admission_state, created_at, cost_usd)
     VALUES ($1, 'owner-a', 'https://example.invalid/r.git', 'main', $2, $3, coalesce($4::timestamptz, now()), $5)`,
    [
      id,
      seed.status ?? "idle",
      seed.admission ?? "active",
      seed.createdAt ?? null,
      seed.costUsd ?? 0,
    ],
  );
  return id;
}

/** A live attempt on the session's current epoch, as askerIsLive wants it. */
async function attempt(sessionId: string, state = "running"): Promise<string> {
  const executionId = `exec-${crypto.randomUUID()}`;
  await client.query(
    `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state)
     VALUES ($1, $2, 'local_docker', 0, 'running', 'running')`,
    [executionId, sessionId],
  );
  const id = `att-${crypto.randomUUID()}`;
  await client.query(
    `INSERT INTO attempts (id, session_id, execution_id, lease_epoch, execution_generation, auth_revision, state, lease_expires_at)
     VALUES ($1, $2, $3, 0, 0, 0, $4, now() + interval '1 hour')`,
    [id, sessionId, executionId, state],
  );
  return id;
}

let sequence = 0;
async function turn(
  sessionId: string,
  status: string,
  times: { started?: number; ended?: number } = {},
  attemptId: string | null = null,
): Promise<number> {
  const now = Date.now();
  const iso = (offsetMs: number | undefined) =>
    offsetMs === undefined ? null : new Date(now + offsetMs).toISOString();
  const result = await client.query<{ id: number }>(
    `INSERT INTO turns (session_id, sequence, message, status, started_at, ended_at, attempt_id)
     VALUES ($1, $2, 'hi', $3, $4, $5, $6) RETURNING id`,
    [
      sessionId,
      ++sequence,
      status,
      iso(times.started),
      iso(times.ended),
      attemptId,
    ],
  );
  return Number(result.rows[0]?.id);
}

async function pending(
  at: { sessionId: string; turnId: number; attemptId: string },
  request: {
    kind: "permission" | "question";
    parked?: boolean;
    toolUseId?: string;
    answer?: unknown;
  },
) {
  const answered = request.answer !== undefined;
  await client.query(
    `INSERT INTO pending_requests (request_id, session_id, turn_id, attempt_id, kind, payload, input_hash, expires_at, parked_at, tool_use_id, answer, answered_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, '{}', 'h', now() + interval '1 hour', $6, $7, $8, $9, $9)`,
    [
      crypto.randomUUID(),
      at.sessionId,
      at.turnId,
      at.attemptId,
      request.kind,
      request.parked ? new Date().toISOString() : null,
      request.toolUseId ?? null,
      answered ? JSON.stringify(request.answer) : null,
      answered ? new Date().toISOString() : null,
    ],
  );
}

let eventId = 0;
async function toolCall(
  sessionId: string,
  name: string,
  outcome: "ok" | "failed" | "unknown",
  options: { toolUseId?: string; attemptKey?: string; at?: Date } = {},
) {
  const at = (options.at ?? new Date()).toISOString();
  await client.query(
    `INSERT INTO tool_calls (use_event_id, ord, session_id, attempt_key, tool_use_id, name, at, created_at, outcome)
     VALUES ($1, 0, $2, $3, $4, $5, $6, $6, $7)`,
    [
      ++eventId,
      sessionId,
      options.attemptKey ?? "",
      options.toolUseId ?? crypto.randomUUID(),
      name,
      at,
      outcome,
    ],
  );
}

async function record(
  sessionId: string,
  attemptId: string,
  model: string,
  costUsd: number,
  pricedBy: "table" | "fallback" | "unmetered" = "table",
) {
  const result = await createPostgresWorkerUnitOfWork(
    db as unknown as Database,
  ).recordProviderUsageAtomic({
    exchangeId: crypto.randomUUID(),
    sessionId,
    attemptId,
    usage: {
      model,
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: 3,
      cacheCreation1hInputTokens: 0,
      cacheReadInputTokens: 7,
      speed: "standard",
      inferenceGeo: "global",
      webSearchRequests: 0,
      webFetchRequests: 0,
      codeExecutionRequests: 0,
      estimated: false,
    },
    priceFor: () => ({ costUsd, pricedBy }),
  });
  expect(result.outcome).toBe("recorded");
}

const providerCost = (snapshot: Awaited<ReturnType<typeof read>>) =>
  snapshot.providerUsage.reduce((sum, row) => sum + Number(row.costUsd), 0);

describe("sessions", () => {
  test("an actionable request decides awaiting, on a running turn and on a parked one", async () => {
    const running = await session({ status: "running" });
    const runningAttempt = await attempt(running);
    const runningTurn = await turn(running, "running", {}, runningAttempt);
    await pending(
      { sessionId: running, turnId: runningTurn, attemptId: runningAttempt },
      { kind: "permission" },
    );
    // Parked: the attempt is gone, only parked_at keeps it answerable.
    const parked = await session({ status: "idle" });
    const parkedAttempt = await attempt(parked, "exited");
    const parkedTurn = await turn(parked, "completed", {}, parkedAttempt);
    await pending(
      { sessionId: parked, turnId: parkedTurn, attemptId: parkedAttempt },
      { kind: "question", parked: true },
    );
    // Answered: no longer actionable.
    const answered = await session({ status: "running" });
    const answeredAttempt = await attempt(answered);
    const answeredTurn = await turn(answered, "running", {}, answeredAttempt);
    await pending(
      { sessionId: answered, turnId: answeredTurn, attemptId: answeredAttempt },
      { kind: "permission", answer: { kind: "permission", decision: "allow" } },
    );

    const rows = (await read()).sessions;
    const of = (status: string) =>
      rows.filter((row) => row.status === status && row.count > 0);
    expect(of("running")).toContainEqual({
      status: "running",
      admission: "active",
      awaitingApproval: true,
      awaitingAnswer: false,
      count: 1,
    });
    expect(of("running")).toContainEqual({
      status: "running",
      admission: "active",
      awaitingApproval: false,
      awaitingAnswer: false,
      count: 1,
    });
    expect(of("idle")).toEqual([
      {
        status: "idle",
        admission: "active",
        awaitingApproval: false,
        awaitingAnswer: true,
        count: 1,
      },
    ]);
  });

  test("the counts add up to every session", async () => {
    await session({ status: "queued" });
    await session({ status: "idle", admission: "paused" });
    await session({ status: "stopped", admission: "closed" });
    await session({ status: "failed" });
    const rows = (await read()).sessions;
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(4);
  });
});

describe("turns", () => {
  test("settled turns are counted, timed into buckets, and outcome_unknown is apart", async () => {
    const id = await session();
    await turn(id, "completed", { started: -30_000, ended: 0 });
    await turn(id, "completed", { started: -500, ended: 0 });
    await turn(id, "failed", { started: -7_200_000, ended: 0 });
    // Cancelled before it started: counted, not timed.
    await turn(id, "cancelled", { ended: 0 });
    await turn(id, "outcome_unknown", { started: -10, ended: 0 });
    await turn(id, "running", { started: -10 });

    const snapshot = await read();
    const byStatus = Object.fromEntries(
      snapshot.settledTurns.map((row) => [row.status, row]),
    );
    expect(byStatus.completed).toMatchObject({
      count: 2,
      timed: 2,
      le: [1, 2, 2],
    });
    expect(byStatus.completed?.seconds).toBeCloseTo(30.5, 1);
    expect(byStatus.failed).toMatchObject({
      count: 1,
      timed: 1,
      le: [0, 0, 0],
    });
    expect(byStatus.cancelled).toMatchObject({
      count: 1,
      timed: 0,
      le: [0, 0, 0],
    });
    expect(byStatus.outcome_unknown).toBeUndefined();
    expect(snapshot.outcomeUnknownTurns).toBe(1);
  });
});

describe("tool calls", () => {
  test("a call whose permission request was denied counts as denied, from whichever attempt answered", async () => {
    const id = await session({ status: "running" });
    const asked = await attempt(id, "exited");
    const askedTurn = await turn(id, "completed", {}, asked);
    await pending(
      { sessionId: id, turnId: askedTurn, attemptId: asked },
      {
        kind: "permission",
        toolUseId: "toolu_denied",
        answer: { kind: "permission", decision: "deny" },
      },
    );
    await pending(
      { sessionId: id, turnId: askedTurn, attemptId: asked },
      {
        kind: "permission",
        toolUseId: "toolu_allowed",
        answer: { kind: "permission", decision: "allow" },
      },
    );
    // The denied call's result arrived under the next attempt.
    await toolCall(id, "Bash", "failed", {
      toolUseId: "toolu_denied",
      attemptKey: "att-next",
    });
    await toolCall(id, "Bash", "ok", { toolUseId: "toolu_allowed" });
    await toolCall(id, "Bash", "failed");
    await toolCall(id, "Read", "unknown");
    // The same tool_use id in another session is another call.
    const other = await session();
    await toolCall(other, "Bash", "ok", { toolUseId: "toolu_denied" });

    const rows = (await read()).toolCalls.map(({ firstAt: _, ...row }) => row);
    expect(rows).toHaveLength(4);
    expect(rows).toEqual(
      expect.arrayContaining([
        { name: "Bash", outcome: "denied", count: 1 },
        { name: "Bash", outcome: "ok", count: 2 },
        { name: "Bash", outcome: "failed", count: 1 },
        { name: "Read", outcome: "unknown", count: 1 },
      ]),
    );
  });

  test("firstAt is the name's first call across its outcomes", async () => {
    const id = await session();
    await toolCall(id, "Bash", "failed", {
      at: new Date("2026-01-01T00:00:00Z"),
    });
    await toolCall(id, "Bash", "ok", { at: new Date("2026-06-01T00:00:00Z") });
    const rows = (await read()).toolCalls;
    expect(rows.map((row) => row.firstAt.toISOString())).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });
});

describe("provider cost", () => {
  test("equals the usage summary for sessions created and billed inside the period", async () => {
    const since = new Date(Date.now() - HOUR);
    const until = new Date(Date.now() + HOUR);
    for (const model of ["claude-sonnet-5", "claude-haiku-5"]) {
      const id = await session();
      const att = await attempt(id);
      await record(id, att, model, 0.123457);
      await record(id, att, model, 1.5, "fallback");
    }
    const unmetered = await session();
    await record(
      unmetered,
      await attempt(unmetered),
      "in-house",
      0,
      "unmetered",
    );

    const snapshot = await read();
    const summary = await createPostgresUsageReader(
      db as unknown as Database,
    ).usageSummary({ kind: "installation" }, { since, until });
    expect(providerCost(snapshot)).toBeCloseTo(Number(summary.costUsd), 6);
    expect(snapshot.providerUsage).toContainEqual(
      expect.objectContaining({
        model: "claude-sonnet-5",
        pricedBy: "fallback",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 7,
        cacheCreationInputTokens: 3,
        costUsd: "1.500000",
      }),
    );
    expect(snapshot.providerUsage).toContainEqual(
      expect.objectContaining({
        model: "in-house",
        pricedBy: "unmetered",
        costUsd: "0.000000",
      }),
    );
  });

  test("differs from the summary exactly by what the summary cuts or adds", async () => {
    const since = new Date(Date.now() - HOUR);
    const until = new Date(Date.now() + HOUR);
    // Created before the period, billed inside it: the counter has it, the
    // summary does not.
    const older = await session({
      createdAt: new Date(Date.now() - 3 * HOUR).toISOString(),
    });
    await record(older, await attempt(older), "claude-sonnet-5", 2);
    // Engine totals from before metering: the summary has them, the counter
    // does not.
    const legacy = await session({ costUsd: 4 });
    await client.query(
      `INSERT INTO session_pre_metering_cost (session_id, session_created_at, cost_usd) SELECT id, created_at, 4 FROM sessions WHERE id = $1`,
      [legacy],
    );
    // A session at its cost ceiling: the session total is clamped, the call
    // is not.
    const capped = await session({ costUsd: MAX_SESSION_COST_USD - 1 });
    await record(capped, await attempt(capped), "claude-sonnet-5", 5);

    const counter = providerCost(await read());
    const summary = Number(
      (
        await createPostgresUsageReader(db as unknown as Database).usageSummary(
          { kind: "installation" },
          { since, until },
        )
      ).costUsd,
    );
    expect(counter).toBeCloseTo(2 + 5, 6);
    // pre-metering 4, the capped session's clamped total, the older session
    // left out.
    expect(summary).toBeCloseTo(4 + MAX_SESSION_COST_USD, 2);
  });
});

describe("queues", () => {
  test("the launch queue is what the scheduler may launch, waiting since its signal", async () => {
    const waiting = await session({ status: "queued" });
    const paused = await session({ status: "queued", admission: "paused" });
    const spent = await session({ status: "queued", costUsd: 30 });
    for (const [id, ago] of [
      [waiting, 90_000],
      [paused, 600_000],
      [spent, 600_000],
    ] as const) {
      await client.query(
        `INSERT INTO unassigned_sessions (session_id, signaled_at) VALUES ($1, now() - ($2 || ' milliseconds')::interval)`,
        [id, ago],
      );
    }
    const { launchQueue } = await read();
    expect(launchQueue.sessions).toBe(1);
    expect(launchQueue.oldestWaitSeconds).toBeGreaterThanOrEqual(90);
    expect(launchQueue.oldestWaitSeconds).toBeLessThan(600);
  });

  test("the input queue's oldest age skips claimed and not yet visible rows", async () => {
    const id = await session();
    await client.query(
      `INSERT INTO queue_messages (session_id, kind, payload, created_at, visible_at) VALUES
        ($1, 'message', '{}', now() - interval '40 seconds', now() - interval '40 seconds'),
        ($1, 'message', '{}', now() - interval '900 seconds', now() + interval '1 hour')`,
      [id],
    );
    await client.query(
      `INSERT INTO queue_messages (session_id, kind, payload, created_at, claimed_by) VALUES ($1, 'message', '{}', now() - interval '800 seconds', 'att-x')`,
      [id],
    );
    const { inputQueueOldestAgeSeconds } = await read();
    expect(inputQueueOldestAgeSeconds).toBeGreaterThanOrEqual(40);
    expect(inputQueueOldestAgeSeconds).toBeLessThan(800);
  });

  test("empty queues read as zero", async () => {
    const snapshot = await read();
    expect(snapshot.launchQueue).toEqual({ sessions: 0, oldestWaitSeconds: 0 });
    expect(snapshot.inputQueueOldestAgeSeconds).toBe(0);
  });
});

describe("worker images", () => {
  const at = (minute: number) =>
    new Date(Date.UTC(2026, 9, 1, 0, minute)).toISOString();
  async function launch(
    sessionId: string,
    image: string | null,
    launched: { minute: number; generation: number },
  ) {
    await client.query(
      `INSERT INTO worker_launches (execution_id, generation, session_id, backend, image, resources, created_at)
       VALUES ($1, $2, $3, 'local_docker', $4, $5, $6)`,
      [
        `exec-${crypto.randomUUID()}`,
        launched.generation,
        sessionId,
        image,
        image === null ? null : "{}",
        at(launched.minute),
      ],
    );
  }

  test("each live session counts once, under its newest launch's image", async () => {
    // Time decides before generation, which does not follow it across executions.
    const moved = await session();
    await launch(moved, "worker@sha256:aa", { minute: 1, generation: 5 });
    await launch(moved, "worker@sha256:bb", { minute: 9, generation: 1 });
    // Same instant: the higher generation is the newer.
    const tied = await session({ status: "queued" });
    await launch(tied, "worker@sha256:aa", { minute: 4, generation: 3 });
    await launch(tied, "worker@sha256:bb", { minute: 4, generation: 2 });
    // A newer reservation not yet given a spec leaves the image it ran on.
    const running = await session({ status: "running" });
    await launch(running, "worker@sha256:aa", { minute: 2, generation: 0 });
    await launch(running, null, { minute: 8, generation: 1 });
    // Only a reservation, and a session never launched.
    await launch(await session(), null, { minute: 5, generation: 0 });
    await session({ status: "queued" });
    // Ended sessions hold no image.
    await launch(
      await session({ status: "stopped", admission: "closed" }),
      "worker@sha256:aa",
      { minute: 3, generation: 0 },
    );
    await launch(await session({ admission: "stopping" }), "worker@sha256:aa", {
      minute: 3,
      generation: 0,
    });

    const rows = (await read()).sessionWorkerImages;
    const key = (row: (typeof rows)[number]) => `${row.image} ${row.status}`;
    expect(rows.sort((a, b) => key(a).localeCompare(key(b)))).toEqual([
      {
        image: "worker@sha256:aa",
        status: "queued",
        admission: "active",
        count: 1,
      },
      {
        image: "worker@sha256:aa",
        status: "running",
        admission: "active",
        count: 1,
      },
      {
        image: "worker@sha256:bb",
        status: "idle",
        admission: "active",
        count: 1,
      },
    ]);
  });
});
