/**
 * What the turn list and turn detail pay to find each turn's checkpoint
 * revision when the checkpoints table holds every session's revisions.
 * Prints the plan of the exact checkpoint statement the reader sends. PGlite
 * reports enable_seqscan off after the migrations, even past a RESET, so a
 * sequential scan's cost carries the disable penalty; the scan is still the
 * only path when no index covers the filter.
 *
 *   bun packages/db/bench/turn-checkpoints.ts [sessions] [checkpoints-per-session] [data-dir]
 */
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/index.ts";
import { createPostgresSessionReader } from "../src/index.ts";
import { migrate } from "../src/migrate.ts";
import { timedMs } from "./lib.ts";

const sessionCount = Number(process.argv[2] ?? 2000);
const perSession = Number(process.argv[3] ?? 50);
const dataDir = process.argv[4];
const OWNER = "bench-owner";

const client = new PGlite(dataDir);
const statements: { sql: string; params: unknown[] }[] = [];
const db = drizzle(client, {
  schema,
  logger: {
    logQuery: (sql, params) => {
      statements.push({ sql, params });
    },
  },
});
await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });

const seeded = performance.now();
await client.query(`
  INSERT INTO sessions (id, owner_id, repo_url, branch, created_at)
  SELECT gen_random_uuid(), CASE WHEN g = 1 THEN '${OWNER}' ELSE 'other-' || (g % 50) END,
         'https://example.invalid/app.git', 'main', now() - g * interval '1 second'
  FROM generate_series(1, ${sessionCount}) g`);
await client.query(`
  INSERT INTO turns (session_id, sequence, message, status, created_at)
  SELECT s.id, t, 'turn ' || t, 'completed', now()
  FROM sessions s, generate_series(1, ${perSession}) t`);
await client.query(`
  INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256, turn_id)
  SELECT t.session_id, t.sequence, 'ref/' || t.id, md5(t.id::text), t.id
  FROM turns t`);
await client.query("ANALYZE");
const counts = await client.query<{ sessions: number; checkpoints: number }>(
  "SELECT (SELECT count(*)::int FROM sessions) AS sessions, (SELECT count(*)::int FROM checkpoints) AS checkpoints",
);
console.log(
  `seeded ${JSON.stringify(counts.rows[0])} in ${((performance.now() - seeded) / 1000).toFixed(1)}s`,
);

const [owned] = (
  await client.query<{ id: string }>(
    `SELECT id FROM sessions WHERE owner_id = '${OWNER}'`,
  )
).rows;
if (!owned) throw new Error("seed failed");
const reader = createPostgresSessionReader(db);
const list = () => reader.listTurns(OWNER, owned.id, { limit: 50 });
const detail = () => reader.getTurn(OWNER, owned.id, "1");

async function plan(read: () => Promise<unknown>) {
  statements.length = 0;
  await read();
  const checkpoint = statements.find(({ sql }) =>
    sql.includes('from "checkpoints"'),
  );
  if (!checkpoint) throw new Error("no checkpoint statement");
  const rows = await client.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${checkpoint.sql}`,
    checkpoint.params,
  );
  return [checkpoint.sql, ...rows.rows.map((row) => row["QUERY PLAN"])].join(
    "\n",
  );
}

// The finalize replay's lookup (worker-unit-of-work probeFinalize), unbound
// and bound to the session.
const [first] = (
  await client.query<{ id: number }>(
    "SELECT id FROM turns WHERE session_id = $1 AND sequence = 1",
    [owned.id],
  )
).rows;
for (const [name, sql, params] of [
  [
    "turn_id only",
    "SELECT max(revision) FROM checkpoints WHERE turn_id = $1",
    [first?.id],
  ],
  [
    "session_id and turn_id",
    "SELECT max(revision) FROM checkpoints WHERE session_id = $1 AND turn_id = $2",
    [owned.id, first?.id],
  ],
] as const) {
  const rows = await client.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    [...params],
  );
  console.log(
    `finalize replay lookup, ${name}:\n${rows.rows.map((row) => row["QUERY PLAN"]).join("\n")}\n`,
  );
}
console.log(`listTurns(limit 50) checkpoint statement:\n${await plan(list)}\n`);
console.log(`getTurn checkpoint statement:\n${await plan(detail)}\n`);
console.table({
  "listTurns(limit 50)": await timedMs(list, 20),
  getTurn: await timedMs(detail, 20),
});
await client.close();
