/**
 * The tool call projection on real PostgreSQL. An empty database is first
 * seeded with a whole installation: `per-day` sessions a day for `days`
 * days, `events` events each (30% tool_use, 30% their results), started by
 * 20 users in turn and one in a thousand by a 21st; later runs reuse it.
 * Then:
 *
 *   backfill  every existing event from cursor 0, one reconciler-sized batch
 *             per transaction, timing each batch
 *   reads     toolCallTotals for GET /v1/usage/tools, installation and me
 *   live      worker-shaped inserts while passes run every `pass-every` ms:
 *             how long a call takes to show, and what a running pass costs
 *             an insert
 *   burst     a day of one heavy installation's events at once, then passes
 *             until caught up
 *
 *   bun packages/db/bench/tool-calls.ts <postgres-url> [batch-size] [pass-every-ms] [per-day] [days] [events]
 */
import { performance } from "node:perf_hooks";
import type { UsageSummaryFilter } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/index.ts";
import { projectToolCalls, toolCallTotals } from "../src/index.ts";
import { migrate } from "../src/migrate.ts";
import { stats, timed } from "./lib.ts";

const url = process.argv[2];
if (!url) throw new Error("usage: tool-calls.ts <postgres-url> ...");
const batchSize = Number(process.argv[3] ?? 5_000);
// The reconciler's budget; projections and reads run under the job pool's
// statement timeout, as they do in production.
const BUDGET_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 10_000;
const passEveryMs = Number(process.argv[4] ?? 10_000);
const OWNER = "bench-owner";
const ME = "00000000-0000-4000-8000-000000000001";

const perDay = Number(process.argv[5] ?? 100);
const days = Number(process.argv[6] ?? 90);
const eventsPerSession = Number(process.argv[7] ?? 2000);
const USERS = 20;
// Live and burst events carry it in their attempt ids, so a later run's
// sequences do not collide with an earlier run's.
const RUN = `run${Date.now().toString(36)}`;

// Seeding and bookkeeping run unbounded on `pool`; `db` is the job pool.
const pool = new Pool({ connectionString: url, max: 8 });
await migrate(drizzle(pool, { schema }), {
  migrationsFolder: `${import.meta.dir}/../migrations`,
});
const jobs = new Pool({
  connectionString: url,
  max: 8,
  statement_timeout: STATEMENT_TIMEOUT_MS,
});
const db = drizzle(jobs, { schema });

const empty = await pool.query<{ n: number }>(
  "SELECT count(*)::int AS n FROM sessions",
);
if (empty.rows[0]?.n === 0) {
  const seeded = performance.now();
  await pool.query(`
    INSERT INTO users (id, email, display_name)
    SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
           'bench-' || g || '@example.invalid', 'bench ' || g
    FROM generate_series(1, ${USERS + 1}) g`);
  // User USERS + 1 starts one session in a thousand: a scope with few calls.
  await pool.query(`
    INSERT INTO sessions (id, owner_id, repo_url, branch, created_by_user_id, created_at)
    SELECT gen_random_uuid(), '${OWNER}', 'https://example.invalid/app.git', 'main',
           ('00000000-0000-4000-8000-' || lpad((CASE WHEN g % 1000 = 0 THEN ${USERS + 1} ELSE 1 + g % ${USERS} END)::text, 12, '0'))::uuid,
           now() - g * (interval '1 day' * ${days} / ${perDay * days})
    FROM generate_series(1, ${perDay * days}) g`);
  // Per ten events: three tool_use, their three results (2% failing), four
  // other messages. Ten tool names, Bash the most used.
  await pool.query(`
    INSERT INTO events (session_id, type, payload, attempt_id, source_sequence, occurred_at, created_at)
    SELECT s.id,
           CASE WHEN e % 10 < 3 THEN 'tool_use' WHEN e % 10 < 6 THEN 'tool_result' ELSE 'assistant' END,
           CASE
             WHEN e % 10 < 3 THEN jsonb_build_object(
               'type', 'assistant', 'parent_tool_use_id', null,
               'message', jsonb_build_object('role', 'assistant', 'content', jsonb_build_array(
                 jsonb_build_object('type', 'tool_use', 'id', 'tu_' || (e / 10) || '_' || (e % 10),
                   'name', (ARRAY['Bash','Bash','Bash','Read','Read','Edit','Grep','WebFetch','Task','mcp__linear__get_issue'])[1 + (e * 7 + s.n) % 10],
                   'input', jsonb_build_object('command', repeat('x', 80))))))
             WHEN e % 10 < 6 THEN jsonb_build_object(
               'type', 'tool_result', 'tool_use_id', 'tu_' || (e / 10) || '_' || (e % 10 - 3),
               'is_error', (e + s.n) % 50 = 0, 'content', repeat('y', 200))
             ELSE jsonb_build_object('type', 'assistant', 'message',
               jsonb_build_object('role', 'assistant', 'content', jsonb_build_array(
                 jsonb_build_object('type', 'text', 'text', repeat('z', 160)))))
           END,
           'att_' || s.n, e,
           s.created_at + e * interval '900 milliseconds' + (CASE WHEN e % 10 BETWEEN 3 AND 5 THEN (e % 7) * interval '400 milliseconds' ELSE interval '0' END),
           s.created_at + e * interval '900 milliseconds'
    FROM (SELECT id, created_at, row_number() OVER (ORDER BY created_at) AS n FROM sessions) s,
         generate_series(1, ${eventsPerSession}) e`);
  await pool.query("ANALYZE");
  console.log(`seeded in ${((performance.now() - seeded) / 1000).toFixed(1)}s`);
}
const counts = await pool.query(`
  SELECT (SELECT count(*)::int FROM sessions) AS sessions,
         (SELECT count(*)::bigint FROM events) AS events,
         pg_size_pretty(pg_total_relation_size('events')) AS events_size,
         (SELECT string_agg(indexname, ', ') FROM pg_indexes WHERE tablename = 'events') AS events_indexes`);
console.log(JSON.stringify(counts.rows[0]));

const seconds = (ms: number) => Number((ms / 1000).toFixed(1));

// --- backfill; BENCH_SKIP_BACKFILL=1 keeps what an earlier run projected.
if (process.env.BENCH_SKIP_BACKFILL !== "1") {
  await pool.query(
    "TRUNCATE tool_call_days, tool_calls; UPDATE tool_call_progress SET applied_through = 0",
  );
  const backfillStarted = performance.now();
  const batchMs: number[] = [];
  let eventsRead = 0;
  let timedOut = 0;
  for (;;) {
    const started = performance.now();
    // budget 1ms: one batch landed per call, after any cut by the timeout.
    const pass = await projectToolCalls(db, { batchSize, budgetMs: 1 });
    batchMs.push(performance.now() - started);
    eventsRead += pass.eventsRead;
    timedOut += pass.timedOut;
    if (pass.caughtUp) break;
  }
  const backfillMs = performance.now() - backfillStarted;
  const sizes = await pool.query(`
  SELECT (SELECT count(*) FROM tool_calls) AS tool_calls,
         (SELECT count(*) FROM tool_call_days) AS tool_call_days,
         pg_size_pretty(pg_total_relation_size('tool_calls')) AS tool_calls_size,
         pg_size_pretty(pg_total_relation_size('tool_call_days')) AS tool_call_days_size`);
  console.log(
    JSON.stringify({
      backfill: {
        batch_size: batchSize,
        events_read: eventsRead,
        seconds: seconds(backfillMs),
        events_per_second: Math.round(eventsRead / (backfillMs / 1000)),
        batch_ms: stats(batchMs),
        timed_out_batches: timedOut,
        ...sizes.rows[0],
      },
    }),
  );
}

// --- reads
const DAY = 86_400_000;
const today = Math.floor(Date.now() / DAY) * DAY;
const installation: UsageSummaryFilter = { kind: "installation" };
const me: UsageSummaryFilter = { kind: "user", ownerId: OWNER, userId: ME };
// Open periods, as the console asks: today comes whole from its day row.
const read =
  (filter: UsageSummaryFilter, since: number, until?: number) => () =>
    toolCallTotals(db, filter, {
      since: new Date(since),
      ...(until === undefined ? {} : { until: new Date(until) }),
      limit: 200,
    });
console.table({
  "installation 7d": await timed(read(installation, today - 6 * DAY)),
  "installation 30d": await timed(read(installation, today - 29 * DAY)),
  "installation 90d": await timed(read(installation, today - 89 * DAY)),
  // since off a day: its first day comes from tool_calls.
  "installation 90d unaligned": await timed(
    read(installation, Date.now() - 90 * DAY),
  ),
  // Ended an hour ago: today up to then comes from tool_calls too.
  "installation 90d closed": await timed(
    read(installation, today - 89 * DAY, Date.now() - 3_600_000),
  ),
  "me 90d": await timed(read(me, today - 89 * DAY)),
});

// The statement toolCallTotals runs, under EXPLAIN.
async function explain(
  label: string,
  filter: UsageSummaryFilter,
  since: number,
) {
  const logged: { sql: string; params: unknown[] }[] = [];
  const logging = drizzle(pool, {
    schema,
    logger: { logQuery: (sql, params) => logged.push({ sql, params }) },
  });
  await toolCallTotals(logging, filter, { since: new Date(since), limit: 200 });
  const [query] = logged;
  if (!query) throw new Error("no statement logged");
  const plan = await pool.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`,
    query.params,
  );
  console.log(`\n-- ${label}`);
  for (const row of plan.rows) console.log(row["QUERY PLAN"]);
}
await explain(
  "installation 90d unaligned",
  installation,
  Date.now() - 90 * DAY,
);

// --- live: inserts shaped like a worker append (session row locked, 20
// events, 6 of them tool_use and 6 their results) into the newest sessions.
const live = await pool.query<{ id: string }>(
  "SELECT id FROM sessions ORDER BY created_at DESC LIMIT 50",
);
let liveSequence = 1_000_000;
async function append(
  sessionId: string,
): Promise<{ ids: number[]; ms: number }> {
  const client = await pool.connect();
  const started = performance.now();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
      sessionId,
    ]);
    const rows: string[] = [];
    const params: unknown[] = [sessionId];
    for (let i = 0; i < 20; i += 1) {
      liveSequence += 1;
      const k = Math.floor(i / 10) * 3 + (i % 10);
      const tool = i % 10 < 3;
      const result = i % 10 >= 3 && i % 10 < 6;
      const id = `live_${liveSequence - (result ? 3 : 0)}`;
      params.push(
        tool ? "tool_use" : result ? "tool_result" : "assistant",
        JSON.stringify(
          tool
            ? {
                type: "assistant",
                message: {
                  content: [
                    { type: "tool_use", id, name: "Bash", input: { k } },
                  ],
                },
              }
            : result
              ? {
                  type: "tool_result",
                  tool_use_id: id,
                  content: "y".repeat(200),
                }
              : {
                  type: "assistant",
                  message: { content: [{ type: "text", text: "z" }] },
                },
        ),
        liveSequence,
      );
      const n = params.length;
      rows.push(
        `($1, $${n - 2}, $${n - 1}::jsonb, '${RUN}_live', $${n}, now())`,
      );
    }
    const inserted = await client.query<{ id: string; type: string }>(
      `INSERT INTO events (session_id, type, payload, attempt_id, source_sequence, occurred_at)
       VALUES ${rows.join(", ")} RETURNING id, type`,
      params,
    );
    await client.query("COMMIT");
    return {
      ids: inserted.rows
        .filter((r) => r.type === "tool_use")
        .map((r) => Number(r.id)),
      ms: performance.now() - started,
    };
  } finally {
    client.release();
  }
}

async function writeFor(
  durationMs: number,
  everyMs: number,
  onCommit: (ids: number[], at: number) => void,
) {
  const insertMs: number[] = [];
  const until = performance.now() + durationMs;
  let i = 0;
  while (performance.now() < until) {
    const session = live.rows[i % live.rows.length]?.id;
    if (!session) throw new Error("no live session");
    i += 1;
    const { ids, ms } = await append(session);
    insertMs.push(ms);
    onCommit(ids, performance.now());
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return insertMs;
}

// Inserts alone, then the same inserts with passes running.
const quiet = await writeFor(30_000, 50, () => {});
const pending = new Map<number, number>();
const lagMs: number[] = [];
let writing = true;
const passMs: number[] = [];
const passes = (async () => {
  while (writing || pending.size > 0) {
    const started = performance.now();
    await projectToolCalls(db, { batchSize, budgetMs: BUDGET_MS });
    passMs.push(performance.now() - started);
    const ids = [...pending.keys()];
    if (ids.length > 0) {
      const seen = await pool.query<{ id: string }>(
        "SELECT DISTINCT use_event_id AS id FROM tool_calls WHERE use_event_id = ANY($1::bigint[])",
        [ids],
      );
      const now = performance.now();
      for (const { id } of seen.rows) {
        const committed = pending.get(Number(id));
        if (committed !== undefined) lagMs.push(now - committed);
        pending.delete(Number(id));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, passEveryMs));
  }
})();
const busy = await writeFor(120_000, 50, (ids, at) => {
  for (const id of ids) pending.set(id, at);
});
writing = false;
await passes;
console.log(
  JSON.stringify({
    live: {
      pass_every_ms: passEveryMs,
      insert_ms_without_passes: stats(quiet),
      insert_ms_with_passes: stats(busy),
      pass_ms: stats(passMs),
      lag_s: stats(lagMs.map((ms) => ms / 1000)),
    },
  }),
);

// --- burst: one day of a heavy installation (100 sessions × 20,000 events
// = 2M) landing at once, then reconciler passes until caught up.
const burstRows = 2_000_000;
await pool.query(`
  INSERT INTO events (session_id, type, payload, attempt_id, source_sequence, occurred_at)
  SELECT s.id,
    CASE WHEN e % 10 < 3 THEN 'tool_use' WHEN e % 10 < 6 THEN 'tool_result' ELSE 'assistant' END,
    CASE
      WHEN e % 10 < 3 THEN jsonb_build_object('type', 'assistant', 'message', jsonb_build_object('content',
        jsonb_build_array(jsonb_build_object('type', 'tool_use', 'id', 'burst_' || e, 'name', 'Read', 'input', '{}'::jsonb))))
      WHEN e % 10 < 6 THEN jsonb_build_object('type', 'tool_result', 'tool_use_id', 'burst_' || (e - 3), 'content', repeat('y', 200))
      ELSE jsonb_build_object('type', 'assistant', 'message', jsonb_build_object('content', '[]'::jsonb))
    END,
    '${RUN}_burst', 2000000 + e, now()
  FROM (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 100) s,
       generate_series(1, ${burstRows / 100}) e`);
const burstStarted = performance.now();
let burstPasses = 0;
let burstTimedOut = 0;
for (;;) {
  burstPasses += 1;
  const pass = await projectToolCalls(db, { batchSize, budgetMs: BUDGET_MS });
  burstTimedOut += pass.timedOut;
  if (pass.caughtUp) break;
}
console.log(
  JSON.stringify({
    burst: {
      events: burstRows,
      // Back to back; the reconciler also rests between passes.
      passes: burstPasses,
      seconds: seconds(performance.now() - burstStarted),
      timed_out_batches: burstTimedOut,
    },
  }),
);
await jobs.end();
await pool.end();
