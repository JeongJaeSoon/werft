/**
 * What reading sessions by status costs when one workspace holds many ended
 * sessions and few in flight: the status-filtered list pages, the counts and
 * the agent cards' in-flight tally. Prints the plan of each statement the
 * code emits.
 *
 *   BENCH_PG_URL=postgresql://postgres@127.0.0.1:<port>/<db> \
 *     bun packages/db/bench/session-status-reads.ts [owner-sessions] [other-workspaces] [sessions-per-other] [idle-percent]
 *
 * Without BENCH_PG_URL it runs on PGlite. The database must be empty.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleLite } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { createPostgresAgentStore } from "../src/agents.ts";
import * as schema from "../src/index.ts";
import { createPostgresSessionReader } from "../src/index.ts";
import { migrate } from "../src/migrate.ts";
import type { Database } from "../src/queries.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "../src/testing/spec-pins.ts";
import { timedMs } from "./lib.ts";

const ownerSessions = Number(process.argv[2] ?? 50000);
const otherWorkspaces = Number(process.argv[3] ?? 4);
const perOther = Number(process.argv[4] ?? 25000);
const idlePercent = Number(process.argv[5] ?? 20);
const AGENTS = 20;
const RUNNING = 20;
const WAITING = 5;
const RUNS = 20;

let emitted: { query: string; params: unknown[] }[] = [];
const logger = {
  logQuery: (query: string, params: unknown[]) => {
    emitted.push({ query, params });
  },
};

const url = process.env.BENCH_PG_URL;
const pool = url ? new Pool({ connectionString: url, max: 1 }) : null;
const lite = pool ? null : new PGlite();
const db = (pool
  ? drizzlePg(pool, { schema, logger })
  : drizzleLite(lite as PGlite, { schema, logger })) as unknown as Database;
const run = async <T>(text: string, params: unknown[] = []): Promise<T[]> =>
  (pool
    ? await pool.query(text, params)
    : await (lite as PGlite).query(text, params)
  ).rows as T[];

await migrate(db as never, {
  migrationsFolder: `${import.meta.dir}/../migrations`,
});

const ws = (n: string) =>
  `('00000000-0000-4000-8000-' || lpad((${n})::text, 12, '0'))::uuid`;
const user = (n: string) =>
  `('00000000-0000-4000-9000-' || lpad((${n})::text, 12, '0'))::uuid`;
const all = 1 + otherWorkspaces;
for (const statement of [
  `INSERT INTO workspaces (id, slug, name)
   SELECT ${ws("w")}, 'ws-' || w, 'ws ' || w FROM generate_series(1, ${all}) w`,
  `INSERT INTO users (id, email, display_name)
   SELECT ${user("w")}, 'owner' || w || '@example.invalid', 'Owner ' || w
   FROM generate_series(1, ${all}) w`,
  `INSERT INTO memberships (workspace_id, user_id, role)
   SELECT ${ws("w")}, ${user("w")}, 'owner' FROM generate_series(1, ${all}) w`,
  `INSERT INTO member_teams (id, workspace_id, name)
   SELECT gen_random_uuid(), ${ws("w")}, 'team ' || w FROM generate_series(1, ${all}) w`,
  `INSERT INTO agents (id, workspace_id, slug, name, created_by, managing_team_id)
   SELECT gen_random_uuid(), ${ws("w")}, 'agent-' || a, 'Agent ' || a, ${user("w")},
          (SELECT t.id FROM member_teams t WHERE t.workspace_id = ${ws("w")})
   FROM generate_series(1, ${all}) w, generate_series(1, ${AGENTS}) a`,
  `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
   SELECT gen_random_uuid(), a.id, 1,
          jsonb_build_object('role', 'r', 'instructions', 'i', 'language', 'ko',
            'model', 'claude-sonnet-5', 'rules', '[]'::jsonb,
            'capabilities', jsonb_build_object('tools', jsonb_build_array('Read'),
              'mcp', 'null'::jsonb, 'forbidden', '[]'::jsonb, 'credential_refs', '[]'::jsonb)),
          md5(a.id::text) || md5(a.id::text)
   FROM agents a`,
  `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
     runtime_config_snapshot, effective_tools, ${RELEASE_SPEC_SQL_COLUMNS})
   SELECT 'rel-' || a.id, a.id, v.id, v.content_sha256, '{}',
          '{"tools": ["Read"], "mcp": []}', ${releaseSpecSqlValues()}
   FROM agents a JOIN agent_versions v ON v.agent_id = a.id`,
  // Newest first by g. The in-flight and waiting rows are spread over the
  // whole history; the rest are idle or ended.
  `INSERT INTO sessions (id, owner_id, workspace_id, agent_release_id, created_by_user_id,
                         repo_url, branch, model, runtime_spec, spec_source,
                         spec_source_digest, spec_digest, status, created_at)
   SELECT gen_random_uuid(), ${ws("s.w")}::text, ${ws("s.w")}, r.id, ${user("s.w")},
          'https://example.invalid/app.git', 'main', r.runtime_spec ->> 'model',
          r.runtime_spec, r.spec_source, r.spec_source_digest, r.spec_digest,
          (CASE
             WHEN s.g % (s.n / ${RUNNING + WAITING}) = 0
              AND s.g / (s.n / ${RUNNING + WAITING}) <= ${RUNNING + WAITING} THEN 'running'
             WHEN s.g % 100 < ${idlePercent} THEN 'idle'
             WHEN s.g % 10 = 0 THEN 'failed'
             ELSE 'stopped'
           END)::session_status,
          now() - s.g * interval '1 minute'
   FROM (SELECT w, g, CASE WHEN w = 1 THEN ${ownerSessions} ELSE ${perOther} END AS n
         FROM generate_series(1, ${all}) w,
              generate_series(1, greatest(${ownerSessions}, ${perOther})) g) s
   JOIN (SELECT r.id, r.runtime_spec, r.spec_source, r.spec_source_digest, r.spec_digest, a.workspace_id, (row_number() OVER (PARTITION BY a.workspace_id ORDER BY a.id) - 1) AS k
         FROM agent_releases r JOIN agents a ON a.id = r.agent_id) r
     ON r.workspace_id = ${ws("s.w")} AND r.k = s.g % ${AGENTS}
   WHERE s.g <= s.n`,
  // WAITING of each workspace's running sessions ask a parked request.
  `INSERT INTO turns (session_id, sequence, message, status)
   SELECT id, 1, 'm', 'running'
   FROM (SELECT id, row_number() OVER (PARTITION BY owner_id ORDER BY created_at DESC) AS k
         FROM sessions WHERE status = 'running') s WHERE k <= ${WAITING}`,
  `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state)
   SELECT 'exec-' || t.id, t.session_id, 'local_docker', 0, 'running', 'running'
   FROM turns t`,
  `INSERT INTO attempts (id, session_id, execution_id, lease_epoch,
     execution_generation, auth_revision, state, lease_expires_at)
   SELECT 'att-' || t.id, t.session_id, 'exec-' || t.id, 0, 0, 0, 'running',
          now() + interval '1 day'
   FROM turns t`,
  `INSERT INTO pending_requests (request_id, session_id, turn_id, attempt_id, kind,
                                 payload, input_hash, expires_at, parked_at)
   SELECT 'req-' || t.id, t.session_id, t.id, 'att-' || t.id, 'question', '{}', 'h',
          now() + interval '1 day', now()
   FROM turns t`,
  "ANALYZE",
]) {
  await run(statement);
}
console.log(
  await run(
    `SELECT owner_id = ${ws("1")}::text AS listed, status, count(*)::int
     FROM sessions GROUP BY 1, 2 ORDER BY 1 DESC, 2`,
  ),
);

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const VIEWER = {
  userId: "00000000-0000-4000-9000-000000000001",
  apiKeyId: null,
};
const reader = createPostgresSessionReader(db);
const agents = createPostgresAgentStore(db);
const agentIds = (
  await run<{ id: string }>(
    "SELECT id FROM agents WHERE workspace_id = $1 LIMIT 4",
    [WORKSPACE],
  )
).map((row) => row.id);

const reads: [string, () => Promise<unknown>, RegExp][] = [
  ...(["running", "idle", "needs_input"] as const).map(
    (status): [string, () => Promise<unknown>, RegExp] => [
      `list status=${status}`,
      () => reader.listSessions(WORKSPACE, { limit: 50, status }, VIEWER),
      /from "sessions".*order by "sessions"\."created_at" desc/s,
    ],
  ),
  [
    "list (no status)",
    () => reader.listSessions(WORKSPACE, { limit: 50 }, VIEWER),
    /from "sessions".*order by "sessions"\."created_at" desc/s,
  ],
  ["counts", () => reader.countSessions(WORKSPACE, {}, VIEWER), /"listed"/],
  [
    "agent summaries (4 cards)",
    () => agents.summaries(WORKSPACE, agentIds, VIEWER),
    /count\(\*\) filter/,
  ],
];

console.log((await reader.countSessions(WORKSPACE, {}, VIEWER)).counts);
const table: Record<string, unknown> = {};
for (const [label, read, statement] of reads) {
  table[label] = await timedMs(read, RUNS);
  emitted = [];
  await read();
  const found = emitted.find((entry) => statement.test(entry.query));
  if (!found) throw new Error(`no statement matched for ${label}`);
  // The code turns JIT off for the list and the counts.
  await run("SET jit = off");
  console.log(`\n-- ${label}`);
  for (const row of await run<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${found.query}`,
    found.params,
  )) {
    console.log(row["QUERY PLAN"].slice(0, 150));
  }
  await run("RESET jit");
}
console.table(table);
await pool?.end();
await lite?.close();
