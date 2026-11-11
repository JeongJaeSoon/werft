/**
 * What the session list page and the session detail cost when one owner has
 * many sessions and the listed ones have long event histories.
 * Only the sessions a page lists get events, since the reads touch no other
 * session's; the rest of the table is other owners' sessions.
 *
 *   bun packages/db/bench/session-reads.ts [owner-sessions] [events-per-listed-session] [other-sessions] [data-dir]
 */
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/index.ts";
import { createPostgresSessionReader } from "../src/index.ts";
import { migrate } from "../src/migrate.ts";
import { timedMs } from "./lib.ts";

const ownerSessions = Number(process.argv[2] ?? 1000);
const eventsPerSession = Number(process.argv[3] ?? 20000);
const otherSessions = Number(process.argv[4] ?? 20000);
const dataDir = process.argv[5];
const PAGE = 100;
const RUNS = 20;
const OWNER = "bench-owner";

const client = new PGlite(dataDir);
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });

const seeded = performance.now();
await client.query(`
  INSERT INTO sessions (id, owner_id, repo_url, branch, created_at)
  SELECT gen_random_uuid(),
         CASE WHEN g <= ${ownerSessions} THEN '${OWNER}' ELSE 'other-' || (g % 500) END,
         'https://example.invalid/app.git', 'main',
         now() - g * interval '1 second'
  FROM generate_series(1, ${ownerSessions + otherSessions}) g`);
await client.query(`
  INSERT INTO events (session_id, type, payload, created_at)
  SELECT s.id, 'message',
         jsonb_build_object('event', 'message', 'data', jsonb_build_object('text', repeat('x', 160), 'n', e)),
         now() - (${eventsPerSession} - e) * interval '1 millisecond'
  FROM (SELECT id FROM sessions WHERE owner_id = '${OWNER}'
        ORDER BY created_at DESC, id DESC LIMIT ${PAGE}) s,
       generate_series(1, ${eventsPerSession}) e`);
await client.query("ANALYZE");
const counts = await client.query<{ sessions: number; events: number }>(
  "SELECT (SELECT count(*)::int FROM sessions) AS sessions, (SELECT count(*)::int FROM events) AS events",
);
console.log(
  `seeded ${JSON.stringify(counts.rows[0])} in ${((performance.now() - seeded) / 1000).toFixed(1)}s`,
);

const reader = createPostgresSessionReader(db);
const page = await reader.listSessions(
  OWNER,
  { limit: PAGE },
  { userId: null, apiKeyId: null },
);
const detailId = page.items[0]?.id;
if (!detailId || page.items.length !== PAGE) throw new Error("seed failed");

const timed = (fn: () => Promise<unknown>) => timedMs(fn, RUNS);

console.table({
  [`listSessions(limit ${PAGE})`]: await timed(() =>
    reader.listSessions(
      OWNER,
      { limit: PAGE },
      { userId: null, apiKeyId: null },
    ),
  ),
  "listSessions(q, limit 100)": await timed(() =>
    reader.listSessions(
      OWNER,
      { limit: PAGE, q: "fix" },
      { userId: null, apiKeyId: null },
    ),
  ),
  countSessions: await timed(() =>
    reader.countSessions(OWNER, {}, { userId: null, apiKeyId: null }),
  ),
  getSession: await timed(() => reader.getSession(OWNER, detailId)),
});

async function explain(label: string, query: string) {
  const plan = await client.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${query}`,
  );
  console.log(`\n-- ${label}`);
  for (const row of plan.rows) console.log(row["QUERY PLAN"].slice(0, 140));
}

const ids = page.items.map((item) => `'${item.id}'`).join(", ");
await explain(
  "list page: sessions of one owner",
  `SELECT id FROM sessions WHERE owner_id = '${OWNER}'
   ORDER BY created_at DESC, id DESC LIMIT ${PAGE + 1}`,
);
await explain(
  "list page: last_event_at as max(created_at) GROUP BY session_id",
  `SELECT session_id, max(created_at) FROM events
   WHERE session_id IN (${ids}) GROUP BY session_id`,
);
await explain(
  "list page: last_event_at as the newest event row per session",
  `SELECT s.id, last.created_at FROM unnest(ARRAY[${ids}]::uuid[]) AS s(id)
   LEFT JOIN LATERAL (SELECT created_at FROM events WHERE session_id = s.id
                      ORDER BY id DESC LIMIT 1) last ON true`,
);
await client.close();
