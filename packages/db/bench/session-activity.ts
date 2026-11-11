/**
 * What the session list costs on PostgreSQL once it reads each listed
 * session's activity: one owner's sessions over 90 days among the whole
 * installation's, the listed ones with long tool-heavy histories and every
 * other session with a short one. Seeds a fresh database the URL names.
 *
 *   bun packages/db/bench/session-activity.ts <postgres-url> [owner-sessions] [events-per-listed-session] [other-sessions] [events-per-other-session]
 */
import { performance } from "node:perf_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { createPostgresSessionReader } from "../src/index.ts";
import { migrate } from "../src/migrate.ts";
import * as schema from "../src/schema.ts";
import {
  activityQuery,
  readSessionActivity,
} from "../src/sessions/session-activity.ts";

const url = process.argv[2];
if (!url) throw new Error("usage: session-activity.ts <postgres-url> ...");
const ownerSessions = Number(process.argv[3] ?? 2000);
const eventsPerSession = Number(process.argv[4] ?? 20000);
const otherSessions = Number(process.argv[5] ?? 50000);
const eventsPerOther = Number(process.argv[6] ?? 100);
const PAGES = [50, 100];
const RUNS = 40;
const OWNER = "bench-owner";
const VIEWER = { userId: null, apiKeyId: null };

const pool = new Pool({ connectionString: url, max: 4 });
const db = drizzle(pool, { schema });
await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });

// Every fifth event a call, the next its result (one in 35 failed, 1.5 kB of
// output), then a status and two assistant lines; one call in 250 a Task.
const eventRows = (sessionsSql: string, perSession: number) => `
  INSERT INTO events (session_id, type, payload, occurred_at, created_at)
  SELECT s.id,
         CASE e % 5 WHEN 1 THEN 'tool_use' WHEN 2 THEN 'tool_result'
                    WHEN 3 THEN 'status' ELSE 'assistant' END,
         CASE e % 5
           WHEN 1 THEN jsonb_build_object('type', 'assistant', 'parent_tool_use_id', null,
             'message', jsonb_build_object('content', jsonb_build_array(jsonb_build_object(
               'type', 'tool_use', 'id', 'u' || e,
               'name', CASE WHEN e % 1250 = 1 THEN 'Task' ELSE 'Bash' END,
               'input', jsonb_build_object('command', 'bun test packages/' || e)))))
           WHEN 2 THEN jsonb_build_object('tool_use_id', 'u' || (e - 1),
             'is_error', e % 175 = 2, 'content', repeat('y', 1500))
           WHEN 3 THEN jsonb_build_object('phase', 'running')
           ELSE jsonb_build_object('type', 'assistant', 'parent_tool_use_id', null,
             'message', jsonb_build_object('content', jsonb_build_array(jsonb_build_object(
               'type', 'text', 'text', 'Line ' || e || ' ' || repeat('x', 160)))))
         END,
         s.created_at + e * interval '50 milliseconds',
         s.created_at + e * interval '50 milliseconds'
  FROM (${sessionsSql}) s, generate_series(1, ${perSession}) e`;

const seeded = performance.now();
const { rows: existing } = await pool.query<{ n: number }>(
  "SELECT count(*)::int AS n FROM sessions",
);
// A database this bench seeded before is read as it is.
if (existing[0]?.n === 0) await seed();

async function seed() {
  await pool.query(`
  INSERT INTO sessions (id, owner_id, repo_url, branch, created_at)
  SELECT gen_random_uuid(),
         CASE WHEN g <= ${ownerSessions} THEN '${OWNER}' ELSE 'other-' || (g % 500) END,
         'https://example.invalid/app.git', 'main',
         now() - (g % 7776000) * interval '1 second' * (7776000.0 / ${ownerSessions + otherSessions})
  FROM generate_series(1, ${ownerSessions + otherSessions}) g`);
  await pool.query(
    eventRows(
      `SELECT id, created_at FROM sessions WHERE owner_id = '${OWNER}'
     ORDER BY created_at DESC, id DESC LIMIT ${Math.max(...PAGES)}`,
      eventsPerSession,
    ),
  );
  await pool.query(
    eventRows(
      `SELECT id, created_at FROM sessions WHERE owner_id <> '${OWNER}'`,
      eventsPerOther,
    ),
  );
  await pool.query("VACUUM ANALYZE");
}
const counts = await pool.query<{
  sessions: number;
  events: number;
  span_days: number;
}>(
  `SELECT (SELECT count(*)::int FROM sessions) AS sessions,
          (SELECT count(*)::int FROM events) AS events,
          (SELECT round(extract(epoch FROM max(created_at) - min(created_at)) / 86400)::int FROM sessions) AS span_days`,
);
console.log(
  `seeded ${JSON.stringify(counts.rows[0])} in ${((performance.now() - seeded) / 1000).toFixed(1)}s`,
);

const reader = createPostgresSessionReader(db);

async function timed(fn: () => Promise<unknown>) {
  await fn();
  const samples: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    Number((samples[Math.ceil(q * samples.length) - 1] ?? 0).toFixed(1));
  return { p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
}

const table: Record<string, unknown> = {};
for (const limit of PAGES) {
  const page = await reader.listSessions(OWNER, { limit }, VIEWER);
  if (
    page.items.length !== limit ||
    page.items.some((item) => item.activity?.window.complete !== false)
  ) {
    throw new Error("seed failed");
  }
  table[`listSessions(limit ${limit})`] = await timed(() =>
    reader.listSessions(OWNER, { limit }, VIEWER),
  );
  const ids = page.items.map((item) => item.id);
  table[`  of which activity(${limit})`] = await timed(() =>
    readSessionActivity(db, ids),
  );
}
console.table(table);
const sample = (await reader.listSessions(OWNER, { limit: 1 }, VIEWER))
  .items[0];
console.log(JSON.stringify(sample?.activity));

const ids = (
  await reader.listSessions(OWNER, { limit: Math.max(...PAGES) }, VIEWER)
).items.map((item) => item.id);
const query = new PgDialect().sqlToQuery(activityQuery(ids));
// As readSessionActivity runs it.
const client = await pool.connect();
await client.query("BEGIN");
await client.query("SET LOCAL jit = off");
const plan = await client.query<{ "QUERY PLAN": string }>(
  `EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`,
  query.params,
);
await client.query("COMMIT");
client.release();
console.log(`\n-- activity of a ${ids.length}-session page`);
for (const row of plan.rows) console.log(row["QUERY PLAN"]);
await pool.end();
