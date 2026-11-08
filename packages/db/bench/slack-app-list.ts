/**
 * What GET /v1/workspaces/{id}/slack/apps costs: one workspace's made Slack
 * apps, each with its three sealed secrets, among other workspaces' apps.
 * Counts the statements one list issues and times it.
 *
 *   bun packages/db/bench/slack-app-list.ts [apps] [other-apps] [data-dir]
 */
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { SecretKey } from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/index.ts";
import { migrate } from "../src/migrate.ts";
import type { Database } from "../src/queries.ts";
import { createPostgresSlackAppStore } from "../src/slack-apps.ts";

const appCount = Number(process.argv[2] ?? 50);
const otherApps = Number(process.argv[3] ?? 5000);
const dataDir = process.argv[4];
const RUNS = 30;
const WORKSPACE = "00000000-0000-4000-8000-000000000001";

let statements = 0;
const client = new PGlite(dataDir);
const db = drizzle(client, {
  schema,
  logger: { logQuery: () => void statements++ },
});
await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });

const seeded = performance.now();
const workspaces = 1 + Math.ceil(otherApps / 50);
await client.exec(`
  INSERT INTO workspaces (id, slug, name)
  SELECT ('00000000-0000-4000-8000-' || lpad(w::text, 12, '0'))::uuid, 'ws-' || w, 'ws ' || w
  FROM generate_series(1, ${workspaces}) w;
  INSERT INTO users (id, email, display_name)
  SELECT ('00000000-0000-4000-9000-' || lpad(w::text, 12, '0'))::uuid, 'owner' || w || '@example.invalid', 'Owner ' || w
  FROM generate_series(1, ${workspaces}) w;
  INSERT INTO member_teams (id, workspace_id, name)
  SELECT gen_random_uuid(), ('00000000-0000-4000-8000-' || lpad(w::text, 12, '0'))::uuid, 'team ' || w
  FROM generate_series(1, ${workspaces}) w;
  INSERT INTO agents (id, workspace_id, slug, name, created_by, managing_team_id)
  SELECT gen_random_uuid(), ws, 'agent-' || g, 'Agent ' || g,
         ('00000000-0000-4000-9000-' || right(ws::text, 12))::uuid,
         (SELECT t.id FROM member_teams t WHERE t.workspace_id = s.ws LIMIT 1)
  FROM (SELECT g, CASE WHEN g <= ${appCount} THEN '${WORKSPACE}'::uuid
                  ELSE ('00000000-0000-4000-8000-' || lpad((2 + g % ${workspaces - 1})::text, 12, '0'))::uuid END AS ws
        FROM generate_series(1, ${appCount + otherApps}) g) s;
  INSERT INTO slack_apps (id, workspace_id, kind, agent_id, state, app_id, client_id, redirect_url)
  SELECT gen_random_uuid(), workspace_id, 'agent', id, 'created',
         'A' || left(id::text, 8), '1.' || left(id::text, 8), 'https://example.invalid/slack/callback'
  FROM agents;
  INSERT INTO secret_values (id, workspace_id, owner_ref, purpose, secret_version, key_version, nonce, ciphertext, last4, updated_by)
  SELECT gen_random_uuid(), a.workspace_id, 'slack_app:' || a.id, p, 1, 1, '\\x00'::bytea, '\\x00'::bytea, 'abcd',
         ('00000000-0000-4000-9000-' || right(a.workspace_id::text, 12))::uuid
  FROM slack_apps a, unnest(ARRAY['slack_signing_secret', 'slack_client_secret', 'slack_bot_token']) p;
  ANALYZE;
`);
console.log(
  `seeded ${appCount} listed apps and ${otherApps} others in ${Math.round(performance.now() - seeded)} ms`,
);

const store = createPostgresSlackAppStore(
  db as unknown as Database,
  SecretKey.fromHex("00".repeat(32), "BENCH_KEY"),
);
const durations: number[] = [];
let perList = 0;
for (let run = 0; run < RUNS; run += 1) {
  statements = 0;
  const started = performance.now();
  const listed = await store.listMade(WORKSPACE);
  durations.push(performance.now() - started);
  perList = statements;
  if (listed.length !== appCount) {
    throw new Error(`listed ${listed.length} apps, expected ${appCount}`);
  }
}
durations.sort((a, b) => a - b);
const at = (p: number) =>
  durations[Math.min(durations.length - 1, Math.floor(p * durations.length))] ??
  0;
console.log(
  `listMade: ${perList} statements, median ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms over ${RUNS} runs`,
);
await client.close();
