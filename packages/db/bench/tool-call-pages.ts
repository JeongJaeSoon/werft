/**
 * GET /v1/usage/tools/{name}/calls on real PostgreSQL, over a database
 * bench/tool-calls.ts has seeded and projected: the most-called tool's first
 * and third pages by recent and slowest, and per_day, for the installation,
 * a busy user, a user with few sessions and one with none, under the API's
 * statement timeout.
 *
 *   bun packages/db/bench/tool-call-pages.ts <postgres-url>
 */
import type { UsageSummaryFilter } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../src/index.ts";
import { toolCallDays, toolCallPage } from "../src/sessions/tool-call-pages.ts";
import { type stats, timed } from "./lib.ts";

const url = process.argv[2];
if (!url) throw new Error("usage: tool-call-pages.ts <postgres-url>");
const OWNER = "bench-owner";
const ME = "00000000-0000-4000-8000-000000000001";
// bench/tool-calls.ts gives this user one session in a thousand.
const RARE = "00000000-0000-4000-8000-000000000021";
const NOBODY = "00000000-0000-4000-8000-0000000000ff";

const pool = new Pool({
  connectionString: url,
  max: 4,
  statement_timeout: 10_000,
});
const db = drizzle(pool, { schema });

const DAY = 86_400_000;
const until = new Date();
const since = new Date(until.getTime() - 90 * DAY);
const viewer = { userId: ME, apiKeyId: null };

async function pages(
  filter: UsageSummaryFilter,
  sort: "recent" | "slowest",
  count: number,
) {
  let cursor: string | undefined;
  for (let i = 0; i < count; i += 1) {
    const page = await toolCallPage(db, filter, {
      period: { since },
      until,
      name: "Bash",
      sort,
      limit: 20,
      ...(cursor === undefined ? {} : { cursor }),
      ownerId: OWNER,
      viewer,
    });
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) break;
  }
}

const installation: UsageSummaryFilter = { kind: "installation" };
const me: UsageSummaryFilter = { kind: "user", ownerId: OWNER, userId: ME };
const rare: UsageSummaryFilter = { kind: "user", ownerId: OWNER, userId: RARE };
const nobody: UsageSummaryFilter = {
  kind: "user",
  ownerId: OWNER,
  userId: NOBODY,
};
// A database seeded before bench/tool-calls.ts had the rare user would
// time "few calls" over none.
const seeded = await pool.query<{ sessions: number; calls: number }>(
  `SELECT count(DISTINCT s.id)::int AS sessions, count(c.session_id)::int AS calls
   FROM sessions s LEFT JOIN tool_calls c ON c.session_id = s.id AND c.name = 'Bash'
   WHERE s.created_by_user_id = $1`,
  [RARE],
);
console.log(JSON.stringify({ few_calls: seeded.rows[0] }));
if (!seeded.rows[0]?.calls) {
  throw new Error(
    "no Bash calls for the rare user: reseed with bench/tool-calls.ts",
  );
}
const rows: Record<string, ReturnType<typeof stats>> = {};
for (const [label, filter] of [
  ["installation", installation],
  ["me", me],
  ["few calls", rare],
  ["no calls", nobody],
] as const) {
  for (const sort of ["recent", "slowest"] as const) {
    rows[`${label} ${sort} page 1`] = await timed(() => pages(filter, sort, 1));
    rows[`${label} ${sort} pages 1-3`] = await timed(() =>
      pages(filter, sort, 3),
    );
  }
  rows[`${label} per_day 90d`] = await timed(() =>
    toolCallDays(db, filter, { name: "Bash", since, until }),
  );
}
console.table(rows);
await pool.end();
