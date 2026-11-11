/**
 * Event storage forms compared on PostgreSQL: the events table's
 * shape (a row per event, payload jsonb compressed with pglz), the same with
 * payload compressed by lz4, and one jsonb array per session. Seeds
 * <sessions> sessions of <events> events each, interleaved as concurrent
 * sessions write them, 15% of them tool results of 2 to 11 kB, and prints per
 * form the heap, TOAST and index size, a 100-event page read from the middle
 * of a session, and a one-event append. Drops and recreates its own tables,
 * so give it a database of its own.
 *
 *   BENCH_DATABASE_URL=postgresql://… bun packages/db/bench/event-storage.ts [sessions] [events]
 *
 * A separate document store and the backup sizes are measured outside this
 * script (docs/operator/data-retention.md, "이벤트 저장 형태").
 */
import { performance } from "node:perf_hooks";
import { Pool } from "pg";

const url = process.env.BENCH_DATABASE_URL;
if (!url) throw new Error("BENCH_DATABASE_URL names the database to use");
const SESSIONS = Number(process.argv[2] ?? 20);
const EVENTS = Number(process.argv[3] ?? 20_000);
const RUNS = Number(process.env.BENCH_RUNS ?? 30);
const pool = new Pool({ connectionString: url, max: 2 });

async function step(label: string, text: string) {
  const at = performance.now();
  await pool.query(text);
  console.log(`${label}: ${((performance.now() - at) / 1000).toFixed(1)}s`);
}

await pool.query("SET statement_timeout = 0");
await pool.query("DROP TABLE IF EXISTS ev_row, ev_row_lz4, ev_doc");
const columns = `id bigserial PRIMARY KEY, session_id uuid NOT NULL, type text NOT NULL,
  payload jsonb NOT NULL, attempt_id text, source_sequence integer,
  created_at timestamptz NOT NULL DEFAULT now()`;
await pool.query(`CREATE TABLE ev_row (${columns})`);
await pool.query(`CREATE TABLE ev_row_lz4 (${columns})`);
await pool.query(
  "ALTER TABLE ev_row_lz4 ALTER COLUMN payload SET COMPRESSION lz4",
);
// Assistant text, tool calls and tool results in the proportions a coding
// session writes them; a result is lines of code-like text, which compress
// as such output does.
await step(
  "seed ev_row",
  `INSERT INTO ev_row (session_id, type, payload, attempt_id, source_sequence, created_at)
   SELECT s.id,
     CASE WHEN e.n % 20 < 3 THEN 'tool_result' WHEN e.n % 20 < 6 THEN 'tool_use' ELSE 'assistant' END,
     CASE
       WHEN e.n % 20 < 3 THEN jsonb_build_object('type', 'user', 'message', jsonb_build_object(
         'role', 'user', 'content', jsonb_build_array(jsonb_build_object(
           'type', 'tool_result', 'tool_use_id', 'toolu_' || md5(s.id::text || e.n),
           'content', (SELECT string_agg(format('%s    const v%s = compute(%s, "%s"); // step %s', g, g, (e.n * g) % 997,
                                                substr(md5((e.n * g)::text), 1, 10), g), E'\\n')
                       FROM generate_series(1, 40 + (e.n * 7) % 200) g)))))
       WHEN e.n % 20 < 6 THEN jsonb_build_object('type', 'assistant', 'message', jsonb_build_object(
         'role', 'assistant', 'content', jsonb_build_array(jsonb_build_object(
           'type', 'tool_use', 'id', 'toolu_' || md5(s.id::text || e.n), 'name', 'Bash',
           'input', jsonb_build_object('command', 'bun test packages/db/src/' || substr(md5(e.n::text), 1, 8) || '.test.ts')))))
       ELSE jsonb_build_object('type', 'assistant', 'message', jsonb_build_object(
         'role', 'assistant', 'content', jsonb_build_array(jsonb_build_object(
           'type', 'text', 'text', 'Reading the failing test first: ' || repeat(substr(md5(e.n::text), 1, 12) || ' then ', 20)))))
     END,
     'att-' || (e.n / 5000), e.n, now() - (${EVENTS} - e.n) * interval '1 second'
   FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, ${SESSIONS})) s
   CROSS JOIN generate_series(1, ${EVENTS}) AS e(n)
   ORDER BY e.n, s.id`,
);
// Through text, so each value is compressed again: an INSERT … SELECT keeps
// a value compressed the way its source column holds it.
await step(
  "copy ev_row_lz4",
  `INSERT INTO ev_row_lz4 SELECT id, session_id, type, payload::text::jsonb, attempt_id, source_sequence, created_at
   FROM ev_row ORDER BY id`,
);
await pool.query(
  "SELECT setval(pg_get_serial_sequence('ev_row_lz4', 'id'), (SELECT max(id) FROM ev_row_lz4))",
);
for (const table of ["ev_row", "ev_row_lz4"]) {
  await pool.query(
    `CREATE INDEX ${table}_session_id_idx ON ${table} (session_id, id)`,
  );
  await pool.query(
    `CREATE UNIQUE INDEX ${table}_attempt_sequence_uniq ON ${table} (session_id, attempt_id, source_sequence) WHERE attempt_id IS NOT NULL`,
  );
}
await step(
  "build ev_doc",
  `CREATE TABLE ev_doc AS
   SELECT session_id, jsonb_agg(jsonb_build_object('id', id, 'type', type, 'payload', payload,
            'attempt_id', attempt_id, 'source_sequence', source_sequence, 'created_at', created_at) ORDER BY id) AS events
   FROM ev_row GROUP BY session_id`,
);
await pool.query("ALTER TABLE ev_doc ADD PRIMARY KEY (session_id)");
for (const table of ["ev_row", "ev_row_lz4", "ev_doc"]) {
  await pool.query(`VACUUM ANALYZE ${table}`);
}

const { rows: compression } = await pool.query<{
  table: string;
  method: string | null;
  values: number;
}>(
  `SELECT 'ev_row' AS table, pg_column_compression(payload) AS method, count(*)::int AS values FROM ev_row GROUP BY 2
   UNION ALL
   SELECT 'ev_row_lz4', pg_column_compression(payload), count(*)::int FROM ev_row_lz4 GROUP BY 2`,
);
console.log("\n== payload values by compression (null: stored uncompressed)");
console.table(compression);

async function sizes(title: string) {
  const { rows } = await pool.query(
    `SELECT c.relname AS form,
            pg_size_pretty(pg_relation_size(c.oid)) AS heap,
            pg_size_pretty(coalesce(pg_relation_size(c.reltoastrelid), 0)) AS toast,
            pg_size_pretty(pg_indexes_size(c.oid)) AS indexes,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
            pg_total_relation_size(c.oid) AS total_bytes
     FROM pg_class c WHERE c.relname IN ('ev_row', 'ev_row_lz4', 'ev_doc') ORDER BY 1`,
  );
  console.log(`\n== ${title}`);
  console.table(rows);
}
await sizes("disk size");

const { rows: picks } = await pool.query<{ session_id: string; after: string }>(
  `SELECT session_id, (SELECT id FROM ev_row r WHERE r.session_id = d.session_id ORDER BY id OFFSET ${EVENTS / 2} LIMIT 1) AS after
   FROM ev_doc d`,
);
const pick = (run: number) => picks[run % picks.length] as (typeof picks)[0];

async function timed(fn: (run: number) => Promise<unknown>) {
  await fn(0);
  const samples: number[] = [];
  for (let run = 1; run <= RUNS; run += 1) {
    const at = performance.now();
    await fn(run);
    samples.push(performance.now() - at);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) =>
    Number(
      (
        samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ??
        0
      ).toFixed(2),
    );
  return { p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
}

const page = (table: string) => (run: number) =>
  pool.query(
    `SELECT id, type, payload FROM ${table} WHERE session_id = $1 AND id > $2 ORDER BY id LIMIT 100`,
    [pick(run).session_id, pick(run).after],
  );
const event = JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "toolu_append",
        content: "    const v = compute(1, 'x'); // step\n".repeat(100),
      },
    ],
  },
});
let sequence = EVENTS;
const append = (table: string) => (run: number) => {
  sequence += 1;
  return pool.query(
    `INSERT INTO ${table} (session_id, type, payload, attempt_id, source_sequence) VALUES ($1, 'tool_result', $2, 'att-append', $3)`,
    [pick(run).session_id, event, sequence],
  );
};

const results = {
  "page ev_row": await timed(page("ev_row")),
  "page ev_row_lz4": await timed(page("ev_row_lz4")),
  // The best case for the document: the page's place in the array is known.
  "page ev_doc": await timed((run) =>
    pool.query(
      `SELECT jsonb_path_query_array(events, '$[${EVENTS / 2} to ${EVENTS / 2 + 99}]') FROM ev_doc WHERE session_id = $1`,
      [pick(run).session_id],
    ),
  ),
  "append ev_row": await timed(append("ev_row")),
  "append ev_row_lz4": await timed(append("ev_row_lz4")),
  "append ev_doc": await timed((run) =>
    pool.query(
      `UPDATE ev_doc SET events = events || jsonb_build_array(jsonb_build_object('type', 'tool_result', 'payload', $2::jsonb)) WHERE session_id = $1`,
      [pick(run).session_id, event],
    ),
  ),
};
console.log("\n== reads and writes");
console.table(results);
await sizes(`disk size after ${RUNS + 1} appends per form, before vacuum`);
await pool.end();
