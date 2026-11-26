/**
 * What finding a workspace's private channels costs on every list, count and
 * usage read (privateChannels(owner, null)), and what listSessions and
 * countSessions cost with the channels the viewer is a member of, when the
 * workspace has thousands of sessions and dozens of private channels and the
 * table holds other workspaces' sessions too.
 *
 *   bun packages/db/bench/private-channels.ts [workspace-sessions] [private-channels] [other-sessions] [data-dir]
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/index.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionShareStore,
} from "../src/index.ts";
import { migrate } from "../src/migrate.ts";
import type { Database } from "../src/queries.ts";
import { fixtureTeam } from "../src/testing/fixture-team.ts";
import { timedMs } from "./lib.ts";

const workspaceSessions = Number(process.argv[2] ?? 5000);
const privateCount = Number(process.argv[3] ?? 40);
const otherSessions = Number(process.argv[4] ?? 50000);
const dataDir = process.argv[5];
const PUBLIC_CHANNELS = 20;
const RUNS = 20;

const client = new PGlite(dataDir);
let captured: { sql: string; params: unknown[] } | null = null;
const db = drizzle(client, {
  schema,
  logger: {
    logQuery(sql, params) {
      captured = { sql, params };
    },
  },
}) as unknown as Database;
await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });

const ws = randomUUID();
const user = randomUUID();
const seeded = performance.now();
await client.query(
  `INSERT INTO workspaces (id, slug, name) VALUES ($1, 'bench', 'bench')`,
  [ws],
);
await client.query(
  `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'argon2id$placeholder', 'p')`,
  [user, `${user}@example.invalid`],
);
await client.query(
  `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')`,
  [ws, user],
);
const team = await fixtureTeam(db, ws);
const agentId = randomUUID();
await client.query(
  `INSERT INTO agents (id, workspace_id, managing_team_id, slug, name) VALUES ($1, $2, $3, 'bench', 'bench')`,
  [agentId, ws, team],
);
const installationId = randomUUID();
await client.query(
  `INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0B', 'T0B')`,
  [installationId, ws],
);
const channels = privateCount + PUBLIC_CHANNELS;
// Channel g: private for g <= privateCount, else public.
await client.query(
  `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface, installation_id, external_surface_id, surface_kind, mode, ceiling_actions, ceiling_disclosure)
   SELECT gen_random_uuid(), $1, $2, 'slack', $3, 'C' || g,
          CASE WHEN g <= ${privateCount} THEN 'private_channel' ELSE 'public_channel' END,
          'on', '{}', 'summary'
   FROM generate_series(1, ${channels}) g`,
  [ws, agentId, installationId],
);
await client.query(
  `INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id)
   SELECT gen_random_uuid(), $1, 'T0B', 'C' || g FROM generate_series(1, ${channels}) g`,
  [ws],
);
await client.query(
  `INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id)
   SELECT gen_random_uuid(), $1, $2, 'channel', 'T0B', 'C' || g FROM generate_series(1, ${channels}) g`,
  [ws, agentId],
);
// A third of the workspace's sessions from a private channel, a third from
// a public one, a third standalone.
await client.query(
  `INSERT INTO sessions (id, owner_id, workspace_id, repo_url, branch, created_by_user_id, parent_conversation_id, created_at)
   SELECT gen_random_uuid(), $1::text, $1::uuid, 'https://example.invalid/app.git', 'main', $2,
          CASE g % 3
            WHEN 0 THEN (SELECT id FROM conversations WHERE channel_id = 'C' || (1 + g % ${privateCount}))
            WHEN 1 THEN (SELECT id FROM conversations WHERE channel_id = 'C' || (${privateCount} + 1 + g % ${PUBLIC_CHANNELS}))
          END,
          now() - g * interval '1 second'
   FROM generate_series(1, ${workspaceSessions}) g`,
  [ws, user],
);
await client.query(
  `INSERT INTO session_shares (session_id, owner_id, workspace_id, scope)
   SELECT s.id, s.owner_id, s.workspace_id, 'private_channel' FROM sessions s
   JOIN conversations c ON c.id = s.parent_conversation_id
   WHERE s.owner_id = $1 AND c.channel_id IN (SELECT external_surface_id FROM surface_bindings WHERE surface_kind = 'private_channel')`,
  [ws],
);
await client.query(
  `INSERT INTO sessions (id, owner_id, repo_url, branch, created_at)
   SELECT gen_random_uuid(), 'other-' || (g % 500), 'https://example.invalid/app.git', 'main',
          now() - g * interval '1 second'
   FROM generate_series(1, ${otherSessions}) g`,
);
await client.query("ANALYZE");
// PGlite starts with seq scans off; a server plans with them on.
await client.query("SET enable_seqscan = on");
const counts = await client.query<{ sessions: number; conversations: number }>(
  "SELECT (SELECT count(*)::int FROM sessions) AS sessions, (SELECT count(*)::int FROM conversations) AS conversations",
);
console.log(
  `seeded ${JSON.stringify(counts.rows[0])} in ${((performance.now() - seeded) / 1000).toFixed(1)}s`,
);

const shares = createPostgresSessionShareStore(db);
const reader = createPostgresSessionReader(db);
const found = await shares.privateChannels(ws, null);
if (found.length !== privateCount) {
  throw new Error(`seed failed: ${found.length} private channels`);
}
const viewer = {
  userId: user,
  apiKeyId: null,
  privateChannels: found.map((place) => place.conversationId),
};

async function explain(label: string, run: () => Promise<unknown>) {
  captured = null;
  await run();
  const query = captured as { sql: string; params: unknown[] } | null;
  if (query === null) throw new Error(`${label}: no query captured`);
  const plan = await client.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`,
    query.params,
  );
  console.log(`\n-- ${label}`);
  for (const row of plan.rows) console.log(row["QUERY PLAN"]);
}

const timed = (fn: () => Promise<unknown>) => timedMs(fn, RUNS);
console.table({
  "privateChannels(owner, null)": await timed(() =>
    shares.privateChannels(ws, null),
  ),
  "listSessions(limit 50, all channels)": await timed(() =>
    reader.listSessions(ws, { limit: 50 }, viewer),
  ),
  "listSessions(limit 50, no channel)": await timed(() =>
    reader.listSessions(ws, { limit: 50 }, { userId: user, apiKeyId: null }),
  ),
  "countSessions(all channels)": await timed(() =>
    reader.countSessions(ws, {}, viewer),
  ),
});
await explain("privateChannels(owner, null)", () =>
  shares.privateChannels(ws, null),
);
await client.close();
