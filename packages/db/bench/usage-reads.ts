/**
 * What the usage summary, series and breakdown cost on real PostgreSQL when an
 * installation has a long history: `days` of sessions at `per-day` a day,
 * each with turns and proxy-metered calls. One person started a twentieth of
 * them, which is what scope=me reads. PGlite timings do not carry over, so
 * this takes a server: an empty database it migrates and seeds once; a later
 * run against the same database reuses the seed.
 *
 *   BENCH_DATABASE_URL=postgresql://… bun packages/db/bench/usage-reads.ts [per-day] [days] [turns-per-session] [calls-per-session]
 */
import { performance } from "node:perf_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/index.ts";
import { createPostgresUsageReader } from "../src/index.ts";
import { migrate } from "../src/migrate.ts";

const url = process.env.BENCH_DATABASE_URL;
if (!url) throw new Error("BENCH_DATABASE_URL names the database to use");
const perDay = Number(process.argv[2] ?? 1000);
const days = Number(process.argv[3] ?? 400);
const turnsPerSession = Number(process.argv[4] ?? 3);
const callsPerSession = Number(process.argv[5] ?? 10);
const RUNS = Number(process.env.BENCH_RUNS ?? 20);
const OWNER = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-000000000002";
const USERS = 20;
const AGENTS = 10;

const pool = new Pool({ connectionString: url, max: 4 });
const captured: { query: string; params: unknown[] }[] = [];
const db = drizzle(pool, {
  schema,
  logger: { logQuery: (query, params) => captured.push({ query, params }) },
});
await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });

const existing = await pool.query<{ n: number }>(
  "SELECT count(*)::int AS n FROM sessions",
);
if (existing.rows[0]?.n === 0) {
  const seeded = performance.now();
  const total = perDay * days;
  const client = await pool.connect();
  try {
    // Triggers and foreign keys off for the bulk load; provider_tokens, which
    // a trigger keeps, is set from the calls afterwards.
    await client.query("SET session_replication_role = replica");
    await client.query(`
      INSERT INTO users (id, email, display_name)
      SELECT CASE WHEN u = 1 THEN '${ME}'::uuid ELSE gen_random_uuid() END,
             'bench-' || u || '@example.invalid', 'bench ' || u
      FROM generate_series(1, ${USERS}) u`);
    const team = crypto.randomUUID();
    await client.query(
      "INSERT INTO member_teams (id, workspace_id, name) VALUES ($1, $2, 'bench')",
      [team, OWNER],
    );
    await client.query(`
      INSERT INTO agents (id, workspace_id, slug, name, managing_team_id)
      SELECT gen_random_uuid(), '${OWNER}', 'agent-' || a, 'Agent ' || a, '${team}'
      FROM generate_series(1, ${AGENTS}) a`);
    await client.query(`
      INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
        runtime_profile_id, profile_digest, runtime_config_snapshot, effective_tools)
      SELECT 'rel-' || id, id, gen_random_uuid(), 'x', 'claude-coding-v1', 'x', '{}', '[]'
      FROM agents`);
    // Every 20th session is ME's; a fifth have no agent; a tenth are other
    // owners'. created_at spreads evenly over `days` back from now.
    await client.query(`
      WITH u AS (SELECT array_agg(id ORDER BY id = '${ME}' DESC, id) AS ids FROM users),
           r AS (SELECT array_agg(id ORDER BY id) AS ids FROM agent_releases)
      INSERT INTO sessions (id, owner_id, repository_mode, created_at,
        created_by_user_id, agent_release_id, cost_usd, model)
      SELECT gen_random_uuid(),
             CASE WHEN g % 10 = 5 THEN 'other-' || (g % 50) ELSE '${OWNER}' END,
             'none',
             now() - (g::float8 / ${total}) * interval '${days} days',
             CASE WHEN g % 20 = 0 THEN '${ME}'::uuid ELSE u.ids[1 + (g % ${USERS - 1}) + 1] END,
             CASE WHEN g % 5 = 0 THEN NULL ELSE r.ids[1 + g % ${AGENTS}] END,
             0, 'claude-sonnet-5-5'
      FROM generate_series(1, ${total}) g, u, r`);
    // The newest turn of the newest sessions is still running; one in fifty
    // ended without reporting a cost.
    await client.query(`
      INSERT INTO turns (session_id, sequence, message, status, started_at,
        ended_at, result_json, attempt_id)
      SELECT s.id, t,
             'go',
             CASE WHEN s.created_at > now() - interval '1 hour' AND t = ${turnsPerSession} THEN 'running'
                  WHEN hashtext(s.id::text || t) % 50 = 0 THEN 'failed'
                  ELSE 'completed' END,
             s.created_at + (t - 1) * interval '3 minutes',
             CASE WHEN s.created_at > now() - interval '1 hour' AND t = ${turnsPerSession} THEN NULL
                  ELSE s.created_at + (t - 1) * interval '3 minutes' + (30 + abs(hashtext(s.id::text) % 150)) * interval '1 second' END,
             CASE WHEN hashtext(s.id::text || t) % 50 = 0 THEN '{"error":"x"}'::jsonb
                  ELSE '{"cost_usd":0.12}'::jsonb END,
             'attempt-' || s.id
      FROM sessions s, generate_series(1, ${turnsPerSession}) t`);
    await client.query(`
      INSERT INTO provider_usage (exchange_id, session_id, attempt_id, model,
        input_tokens, output_tokens, cache_creation_input_tokens,
        cache_creation_1h_input_tokens, cache_read_input_tokens, estimated,
        cost_usd, priced_by, recorded_at)
      SELECT s.id || '-' || c, s.id, 'attempt-' || s.id,
             (ARRAY['claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5'])[1 + abs(hashtext(s.id::text || c)) % 3],
             2000 + c * 10, 800, 3000, 0, 40000, false, 0.031, 'table',
             s.created_at + c * interval '20 seconds'
      FROM sessions s, generate_series(1, ${callsPerSession}) c`);
    await client.query(`
      UPDATE sessions s SET provider_tokens = p.tokens, cost_usd = p.cost
      FROM (SELECT session_id,
                   sum(input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens) AS tokens,
                   sum(cost_usd) AS cost
            FROM provider_usage GROUP BY session_id) p
      WHERE p.session_id = s.id`);
    // What the insert trigger would have kept; every session here is
    // metered, so none has a cost from before metering.
    await client.query(`
      INSERT INTO session_model_usage (session_id, model, session_created_at,
        agent_id, input_tokens, output_tokens, cache_read_input_tokens,
        cache_creation_input_tokens, cost_usd)
      SELECT pu.session_id, pu.model, s.created_at, ar.agent_id,
             sum(pu.input_tokens), sum(pu.output_tokens),
             sum(pu.cache_read_input_tokens),
             sum(pu.cache_creation_input_tokens), sum(pu.cost_usd)
      FROM provider_usage pu JOIN sessions s ON s.id = pu.session_id
      LEFT JOIN agent_releases ar ON ar.id = s.agent_release_id
      GROUP BY 1, 2, 3, 4`);
    await client.query("RESET session_replication_role");
    await client.query("VACUUM ANALYZE");
  } finally {
    client.release();
  }
  console.log(`seeded in ${((performance.now() - seeded) / 1000).toFixed(1)}s`);
}
const counts = await pool.query(
  `SELECT (SELECT count(*)::int FROM sessions) AS sessions,
          (SELECT count(*)::int FROM turns) AS turns,
          (SELECT count(*)::int FROM provider_usage) AS provider_usage,
          (SELECT count(*)::int FROM session_model_usage) AS session_model_usage,
          (SELECT count(*)::int FROM sessions WHERE created_at > now() - interval '90 days') AS sessions_90d,
          (SELECT count(*)::int FROM sessions WHERE created_by_user_id = '${ME}' AND created_at > now() - interval '90 days') AS my_sessions_90d`,
);
console.log(JSON.stringify(counts.rows[0]));
const indexes = await pool.query<{ indexdef: string }>(
  "SELECT indexdef FROM pg_indexes WHERE tablename = 'sessions' AND indexdef LIKE '%created_at%'",
);
console.log(
  `sessions indexes on created_at: ${JSON.stringify(indexes.rows.map((r) => r.indexdef))}`,
);

const reader = createPostgresUsageReader(db);
const installation = { kind: "installation" } as const;
const me = { kind: "user", ownerId: OWNER, userId: ME } as const;
const since = (n: number) => {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - n + 1);
  return day;
};

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

const reads = {
  "summary installation 90d": () =>
    reader.usageSummary(installation, { since: since(90) }),
  "summary me 90d": () => reader.usageSummary(me, { since: since(90) }),
  "series installation 7d": () =>
    reader.usageSeries(installation, { since: since(7) }),
  "series installation 30d": () =>
    reader.usageSeries(installation, { since: since(30) }),
  "series installation 90d": () =>
    reader.usageSeries(installation, { since: since(90) }),
  "series me 90d": () => reader.usageSeries(me, { since: since(90) }),
  "breakdown model installation 30d": () =>
    reader.usageBreakdown(installation, { since: since(30) }, "model"),
  "breakdown model installation 90d": () =>
    reader.usageBreakdown(installation, { since: since(90) }, "model"),
  "breakdown agent installation 30d": () =>
    reader.usageBreakdown(installation, { since: since(30) }, "agent"),
  "breakdown agent installation 90d": () =>
    reader.usageBreakdown(installation, { since: since(90) }, "agent"),
  "breakdown model me 90d": () =>
    reader.usageBreakdown(me, { since: since(90) }, "model"),
} satisfies Record<string, () => Promise<unknown>>;

const table: Record<string, Awaited<ReturnType<typeof timed>>> = {};
for (const [label, read] of Object.entries(reads)) {
  table[label] = await timed(read);
}
console.table(table);

for (const label of [
  "series installation 90d",
  "series me 90d",
  "breakdown model installation 90d",
  "breakdown agent installation 90d",
] as const) {
  captured.length = 0;
  await reads[label]();
  const read = captured.find(({ query }) =>
    query.trimStart().startsWith("WITH"),
  );
  if (!read) throw new Error(`${label} ran no query`);
  // As the reader runs it: JIT off for the transaction.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL jit = off");
    const plan = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${read.query}`,
      read.params,
    );
    await client.query("COMMIT");
    console.log(`\n-- ${label}`);
    for (const row of plan.rows) console.log(row["QUERY PLAN"].slice(0, 160));
  } finally {
    client.release();
  }
}
await pool.end();
