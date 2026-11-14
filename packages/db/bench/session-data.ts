/**
 * What the session data reads cost on PostgreSQL once an installation has a
 * long history: the session list, an event page of a 20,000-event
 * session, the session count, GitHub refusals, the platform metrics,
 * installation usage and one checkpoint collection pass over the session
 * ids. Seeds an empty database once: one owner's sessions over 90 days
 * among the whole installation's, their events, turns, tool calls, denied
 * permission requests, provider usage, checkpoints and receipts; a later
 * run reads the same seed, so a run from another checkout after migrating
 * compares like with like.
 *
 *   BENCH_DATABASE_URL=postgresql://… bun packages/db/bench/session-data.ts <values-out.json> [listed-events] [other-sessions] [events-per-other]
 *
 * Writes what the metrics and installation usage reads returned to
 * <values-out.json>, so two runs can be diffed.
 */
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresCheckpointStore,
  createPostgresSessionOutcomes,
  createPostgresSessionReader,
  createPostgresUsageReader,
  readPlatformMetrics,
} from "../src/index.ts";
import { migrate } from "../src/migrate.ts";
import * as schema from "../src/schema.ts";
import { timedMs } from "./lib.ts";

const url = process.env.BENCH_DATABASE_URL;
if (!url) throw new Error("BENCH_DATABASE_URL names the database to use");
const valuesOut = process.argv[2];
if (!valuesOut) throw new Error("usage: session-data.ts <values-out.json> …");
const eventsPerListed = Number(process.argv[3] ?? 20000);
const otherSessions = Number(process.argv[4] ?? 20000);
const eventsPerOther = Number(process.argv[5] ?? 100);
const OWNER = "bench-owner";
const OWNER_SESSIONS = 2000;
const LISTED = 100;
const TURNS = 5;
const RUNS = Number(process.env.BENCH_RUNS ?? 20);
const VIEWER = { userId: null, apiKeyId: null };

const pool = new Pool({ connectionString: url, max: 8 });
const captured: { query: string; params: unknown[] }[] = [];
let capturing = false;
const db = drizzle(pool, {
  schema,
  logger: {
    logQuery: (query, params) => {
      if (capturing) captured.push({ query, params });
    },
  },
});
const migrateStarted = performance.now();
await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
console.log(
  `migrate: ${((performance.now() - migrateStarted) / 1000).toFixed(1)}s`,
);

const { rows: existing } = await pool.query<{ n: number }>(
  "SELECT count(*)::int AS n FROM sessions",
);
if (existing[0]?.n === 0) await seed();

async function seed() {
  const started = performance.now();
  const client = await pool.connect();
  const step = async (label: string, text: string) => {
    const at = performance.now();
    const result = await client.query(text);
    console.log(
      `seed ${label}: ${result.rowCount ?? 0} rows in ${((performance.now() - at) / 1000).toFixed(1)}s`,
    );
  };
  try {
    // Triggers and foreign keys off for the bulk load, as usage-reads.ts.
    await client.query("SET session_replication_role = replica");
    await client.query("SET statement_timeout = 0");
    // Every other session of other owners is closed, a day or more ago.
    await step(
      "sessions",
      `INSERT INTO sessions (id, owner_id, repo_url, branch, status, admission_state, created_at, updated_at, last_turn_at)
       SELECT gen_random_uuid(),
              CASE WHEN g <= ${OWNER_SESSIONS} THEN '${OWNER}' ELSE 'other-' || (g % 500) END,
              'https://example.invalid/app.git', 'main',
              CASE WHEN g > ${OWNER_SESSIONS} AND g % 2 = 0 THEN 'stopped' ELSE 'idle' END::session_status,
              CASE WHEN g > ${OWNER_SESSIONS} AND g % 2 = 0 THEN 'closed' ELSE 'active' END::admission_state,
              c.at, c.at, c.at
       FROM generate_series(1, ${OWNER_SESSIONS + otherSessions}) g,
            LATERAL (SELECT now() - interval '1 day' - (g % 7776000) * interval '1 second'
                     * (7776000.0 / ${OWNER_SESSIONS + otherSessions}) AS at) c`,
    );
    // Every fifth event a call, the next its result (1.5 kB of output), then a status and two assistant lines.
    const eventRows = (sessionsSql: string, perSession: number) => `
      INSERT INTO events (session_id, type, payload, occurred_at, created_at)
      SELECT s.id,
             CASE e % 5 WHEN 1 THEN 'tool_use' WHEN 2 THEN 'tool_result'
                        WHEN 3 THEN 'status' ELSE 'assistant' END,
             CASE e % 5
               WHEN 1 THEN jsonb_build_object('type', 'assistant', 'parent_tool_use_id', null,
                 'message', jsonb_build_object('content', jsonb_build_array(jsonb_build_object(
                   'type', 'tool_use', 'id', 'u' || e,
                   'name', (ARRAY['Bash','Read','Edit','Grep','Write','Glob','Task'])[1 + e % 7],
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
    await step(
      "events (listed)",
      eventRows(
        `SELECT id, created_at FROM sessions WHERE owner_id = '${OWNER}'
         ORDER BY created_at DESC, id DESC LIMIT ${LISTED}`,
        eventsPerListed,
      ),
    );
    await step(
      "events (others)",
      eventRows(
        `SELECT id, created_at FROM sessions WHERE owner_id <> '${OWNER}'`,
        eventsPerOther,
      ),
    );
    // The last turn of one session in 50 is queued, 1 in 100 running, 1
    // in 200 outcome_unknown; one settled turn in 20 failed.
    await step(
      "turns",
      `INSERT INTO turns (session_id, sequence, message, status, started_at, ended_at, created_at)
       SELECT s.id, t, 'bench input ' || t,
              CASE WHEN t = ${TURNS} AND n % 50 = 0 THEN 'queued'
                   WHEN t = ${TURNS} AND n % 100 = 1 THEN 'running'
                   WHEN t = ${TURNS} AND n % 200 = 2 THEN 'outcome_unknown'
                   WHEN (n + t) % 20 = 0 THEN 'failed'
                   ELSE 'completed' END,
              s.created_at + t * interval '1 minute',
              CASE WHEN t = ${TURNS} AND (n % 50 = 0 OR n % 100 = 1) THEN NULL
                   ELSE s.created_at + t * interval '1 minute' + (n % 600) * interval '1 second' END,
              s.created_at + t * interval '1 minute'
       FROM (SELECT id, created_at, row_number() OVER (ORDER BY id) AS n FROM sessions) s,
            generate_series(1, ${TURNS}) t`,
    );
    // A settled call per tool_use event, as projectToolCalls makes them. The
    // id and name come from the event id rather than its payload, which only
    // the runtime adapters read (tests/architecture.test.ts, G3).
    await step(
      "tool_calls",
      `INSERT INTO tool_calls (use_event_id, ord, session_id, attempt_key, tool_use_id, name, used_at, at, created_at, result_event_id, result_at, outcome, ms)
       SELECT e.id, 1, e.session_id, '', 'u' || e.id,
              (ARRAY['Bash','Read','Edit','Grep','Write','Glob','Task'])[1 + e.id % 7],
              e.occurred_at, e.occurred_at, e.created_at,
              CASE WHEN e.id % 97 = 0 THEN NULL ELSE e.id + 1 END,
              CASE WHEN e.id % 97 = 0 THEN NULL ELSE e.occurred_at + interval '50 milliseconds' END,
              CASE WHEN e.id % 97 = 0 THEN 'unknown' WHEN e.id % 35 = 0 THEN 'failed' ELSE 'ok' END,
              CASE WHEN e.id % 97 = 0 THEN NULL ELSE 50 END
       FROM events e WHERE e.type = 'tool_use'`,
    );
    // One call in 200 asked for permission and was denied, one in 100 allowed.
    await step(
      "pending_requests",
      `INSERT INTO pending_requests (request_id, session_id, turn_id, attempt_id, kind, payload, input_hash, expires_at, resolved_at, created_at, answer, answered_at, tool_use_id)
       SELECT 'pr-' || c.use_event_id, c.session_id, 1, 'bench-attempt', 'permission', '{}'::jsonb, 'h',
              c.created_at + interval '1 hour', c.created_at, c.created_at,
              jsonb_build_object('decision', CASE WHEN c.use_event_id % 200 = 0 THEN 'deny' ELSE 'allow' END),
              c.created_at, c.tool_use_id
       FROM tool_calls c WHERE c.use_event_id % 200 = 0 OR c.use_event_id % 100 = 50`,
    );
    await step(
      "provider_usage",
      `INSERT INTO provider_usage (exchange_id, session_id, attempt_id, model, input_tokens, output_tokens,
         cache_creation_input_tokens, cache_creation_1h_input_tokens, cache_read_input_tokens, estimated,
         cost_usd, priced_by, recorded_at)
       SELECT 'x-' || t.id || '-' || k, t.session_id, 'bench-attempt',
              (ARRAY['claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5'])[k],
              1000 + t.id % 997, 200 + t.id % 313, t.id % 50, 0, 5000 + t.id % 4001, false,
              round(((t.id % 1000) * 0.000731 + k * 0.01)::numeric, 6),
              CASE WHEN t.id % 100 = 0 THEN 'fallback' ELSE 'table' END,
              t.created_at + k * interval '10 seconds'
       FROM turns t, generate_series(1, 3) k`,
    );
    // A revision per turn, naming its own output and its two parents';
    // closed sessions had their first three revisions collected and purged,
    // which releases the first output.
    await step(
      "checkpoints",
      `INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256, versions_held, parent_revision,
         committed_at, collected_at, objects_purged_at, outputs_recorded)
       SELECT s.id, r, 'sessions/' || s.id || '/checkpoints/' || lpad(r::text, 10, '0') || '/a/p/manifest.json',
              md5(s.id::text || r), true, nullif(r - 1, 0), s.created_at + r * interval '2 minutes',
              CASE WHEN s.admission_state = 'closed' AND r <= 3 THEN s.created_at + interval '1 hour' END,
              CASE WHEN s.admission_state = 'closed' AND r <= 3 THEN s.created_at + interval '1 hour' + r * interval '1 second' END,
              NOT (r = 1 AND s.n % 100 = 0)
       FROM (SELECT id, created_at, admission_state, row_number() OVER (ORDER BY id) AS n FROM sessions) s,
            generate_series(1, ${TURNS}) r`,
    );
    await step(
      "checkpoint_outputs",
      `INSERT INTO checkpoint_outputs (session_id, revision, object_key, bytes)
       SELECT c.session_id, c.revision,
              'sessions/' || c.session_id || '/checkpoints/' || lpad(k::text, 10, '0') || '/a/p/outputs/' || md5(c.session_id::text || k),
              1000 * k + c.revision % 3
       FROM checkpoints c, generate_series(greatest(1, c.revision - 2), c.revision) k
       WHERE c.outputs_recorded`,
    );
    // Fifty receipts per owner session and ten per other one; one in 25 a
    // refused GitHub gate.
    await step(
      "receipts",
      `INSERT INTO receipts (id, owner_id, operation, target_ref, status, result, created_at, updated_at)
       SELECT gen_random_uuid(), s.owner_id,
              CASE WHEN k % 25 = 0 THEN 'mint_github_token' ELSE 'input' END,
              jsonb_build_object('session_id', s.id),
              CASE WHEN k % 25 = 0 THEN 'failed' ELSE 'accepted' END::receipt_status,
              CASE WHEN k % 25 = 0 THEN jsonb_build_object('reason_code', 'repository_not_allowed', 'purpose', 'push') END,
              s.created_at + k * interval '1 second', s.created_at + k * interval '1 second'
       FROM sessions s,
            generate_series(1, CASE WHEN s.owner_id = '${OWNER}' THEN 50 ELSE 10 END) k`,
    );
    await step("vacuum", "VACUUM ANALYZE");
  } finally {
    client.release();
  }
  console.log(
    `seeded in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
}

const { rows: counts } = await pool.query(
  `SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM events) AS events,
          (SELECT count(*) FROM turns) AS turns, (SELECT count(*) FROM tool_calls) AS tool_calls,
          (SELECT count(*) FROM pending_requests) AS pending_requests,
          (SELECT count(*) FROM provider_usage) AS provider_usage,
          (SELECT count(*) FROM checkpoints) AS checkpoints,
          (SELECT count(*) FROM checkpoint_outputs) AS checkpoint_outputs,
          (SELECT count(*) FROM receipts) AS receipts,
          pg_size_pretty(pg_database_size(current_database())) AS database`,
);
console.log(`seed ${JSON.stringify(counts[0])}`);

const timed = (fn: () => Promise<unknown>) => timedMs(fn, RUNS);

// Each statement the call sends, EXPLAINed as it ran: the full plan, then
// one summary line per statement.
async function explained(label: string, fn: () => Promise<unknown>) {
  captured.length = 0;
  capturing = true;
  try {
    await fn();
  } finally {
    capturing = false;
  }
  const statements = captured.filter(
    ({ query }) =>
      !/^(begin|commit|rollback|set |savepoint|release)/i.test(query.trim()),
  );
  const summaries: string[] = [];
  for (const [index, { query, params }] of statements.entries()) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL jit = off");
      const { rows } = await client.query<{ "QUERY PLAN": string }>(
        `EXPLAIN (ANALYZE, BUFFERS) ${query}`,
        params,
      );
      await client.query("ROLLBACK");
      const lines = rows.map((row) => row["QUERY PLAN"]);
      console.log(`\n-- plan ${label} #${index + 1}`);
      for (const line of lines) console.log(line.slice(0, 240));
      const scans = [
        ...new Set(
          lines.flatMap((line) => {
            const match =
              /(Seq Scan|Index Only Scan|Index Scan|Bitmap Heap Scan)(?: Backward)?(?: using (\S+))? on (\S+)/.exec(
                line,
              );
            return match
              ? [`${match[1]} ${match[3]}${match[2] ? ` (${match[2]})` : ""}`]
              : [];
          }),
        ),
      ];
      const execution = lines
        .find((line) => line.startsWith("Execution Time"))
        ?.replace("Execution Time: ", "");
      const buffers = /Buffers: (.*)/.exec(lines[1] ?? "")?.[1] ?? "";
      summaries.push(
        `#${index + 1} ${execution} | ${scans.join(", ")} | ${buffers}`,
      );
    } finally {
      client.release();
    }
  }
  return summaries;
}

const reader = createPostgresSessionReader(db);
const usage = createPostgresUsageReader(db);
const outcomes = createPostgresSessionOutcomes(db);
const store = createPostgresCheckpointStore(db);
const metricsOptions = {
  budget: { costUsd: 25, tokens: null },
  buckets: [1, 60, 3600],
};

const listed = (await reader.listSessions(OWNER, { limit: LISTED }, VIEWER))
  .items;
const detail = listed[0]?.id;
if (!detail || listed.length !== LISTED) throw new Error("seed failed");
const middle = await pool.query<{ id: string }>(
  `SELECT id FROM events WHERE session_id = $1 ORDER BY id OFFSET ${Math.floor(eventsPerListed / 2)} LIMIT 1`,
  [detail],
);
const { encodeEventCursor } = await import("../src/sessions/cursors.ts");
const middleCursor = encodeEventCursor(Number(middle.rows[0]?.id ?? 0));
const page = (after: string | undefined) =>
  reader.readEvents(OWNER, detail, {
    ...(after === undefined ? {} : { after }),
    limit: 100,
    maxBytes: 1024 * 1024,
  });

async function gcPass() {
  let after: string | null = null;
  let ids = 0;
  for (;;) {
    const batch = await store.listSessionIds({ after, limit: 100 });
    ids += batch.length;
    if (batch.length < 100) return ids;
    after = batch.at(-1) ?? null;
  }
}

await pool.query("SELECT pg_stat_reset()");
const paths: Record<
  string,
  { fn: () => Promise<unknown>; runs?: number; explain?: boolean }
> = {
  "listSessions(limit 50)": {
    fn: () => reader.listSessions(OWNER, { limit: 50 }, VIEWER),
  },
  "listSessions(limit 100)": {
    fn: () => reader.listSessions(OWNER, { limit: 100 }, VIEWER),
  },
  "readEvents first page": { fn: () => page(undefined) },
  "readEvents middle page": { fn: () => page(middleCursor) },
  countSessions: { fn: () => reader.countSessions(OWNER, {}, VIEWER) },
  "refusals(session)": { fn: () => outcomes.refusals(OWNER, detail, 50) },
  "/metrics readPlatformMetrics": {
    fn: () => readPlatformMetrics(db, metricsOptions),
  },
  installationUsage: { fn: () => usage.installationUsage() },
  "GC listSessionIds pass": { fn: gcPass, runs: 3, explain: false },
};
const table: Record<string, unknown> = {};
const plans: Record<string, string[]> = {};
for (const [label, { fn, explain }] of Object.entries(paths)) {
  table[label] = await timed(fn);
  if (explain !== false) plans[label] = await explained(label, fn);
}

console.log("\n== timings");
console.table(table);
console.log("\n== plan summaries (execution | scans | top-node buffers)");
for (const [label, lines] of Object.entries(plans)) {
  console.log(label);
  for (const line of lines) console.log(`  ${line}`);
}

// A collection pass over every session, then the settling a completed pass
// records where this checkout has it, then the next pass.
const firstPass = await gcPass();
let settled = 0;
if ("settleCollection" in store) {
  let after: string | null = null;
  for (;;) {
    const batch = await store.listSessionIds({ after, limit: 100 });
    for (const id of batch) {
      if (await store.settleCollection(id)) settled += 1;
    }
    if (batch.length < 100) break;
    after = batch.at(-1) ?? null;
  }
}
const secondPass = await gcPass();
console.log(
  `\n== GC session ids read: pass 1 ${firstPass}, settled ${settled}, pass 2 ${secondPass}`,
);

const { rows: indexRows } = await pool.query(
  `SELECT relname AS table, indexrelname AS index,
          pg_size_pretty(pg_relation_size(indexrelid)) AS size, idx_scan
   FROM pg_stat_user_indexes
   WHERE relname IN ('events', 'turns', 'tool_calls', 'receipts', 'pending_requests', 'checkpoints', 'sessions')
   ORDER BY relname, pg_relation_size(indexrelid) DESC`,
);
const { rows: tableRows } = await pool.query(
  `SELECT relname AS table, pg_size_pretty(pg_table_size(relid)) AS heap_and_toast,
          pg_size_pretty(pg_indexes_size(relid)) AS indexes
   FROM pg_stat_user_tables
   WHERE relname IN ('events', 'turns', 'tool_calls', 'receipts', 'pending_requests', 'checkpoints', 'checkpoint_outputs', 'provider_usage', 'sessions')
   ORDER BY pg_total_relation_size(relid) DESC`,
);
console.log("\n== index sizes and scans during the reads above");
console.table(indexRows);
console.table(tableRows);

const metrics = await readPlatformMetrics(db, metricsOptions);
const installation = await usage.installationUsage();
const byKey = <T>(rows: T[], key: (row: T) => string) =>
  [...rows].sort((a, b) => key(a).localeCompare(key(b)));
writeFileSync(
  valuesOut,
  `${JSON.stringify(
    {
      metrics: {
        ...metrics,
        toolCalls: byKey(
          metrics.toolCalls,
          (row) => `${row.name}/${row.outcome}`,
        ),
        providerUsage: byKey(
          metrics.providerUsage,
          (row) => `${row.model}/${row.pricedBy}`,
        ),
        sessions: byKey(metrics.sessions, (row) => JSON.stringify(row)),
        settledTurns: byKey(metrics.settledTurns, (row) => row.status),
      },
      installation: { ...installation, readAt: undefined },
    },
    null,
    2,
  )}\n`,
);
await pool.end();
