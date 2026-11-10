/**
 * What the agent cards cost: one list page with its summaries, against each
 * card reading its agent, admins and bindings on its own. The other
 * workspaces' agents stand in for a shared database.
 *
 *   bun packages/db/bench/agent-list.ts [agents] [other-agents] [data-dir]
 */
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresAgentAdminStore } from "../src/agent-admins.ts";
import { createPostgresAgentStore } from "../src/agents.ts";
import { createPostgresCredentialBindingStore } from "../src/credential-bindings.ts";
import * as schema from "../src/index.ts";
import { migrate } from "../src/migrate.ts";
import type { Database } from "../src/queries.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "../src/testing/spec-pins.ts";

const agentCount = Number(process.argv[2] ?? 50);
const otherAgents = Number(process.argv[3] ?? 5000);
const dataDir = process.argv[4];
const PAGE = 100;
const RUNS = 30;
const WORKSPACE = "00000000-0000-4000-8000-000000000001";

const client = new PGlite(dataDir);
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });

const seeded = performance.now();
// One owner per workspace; workspace 1 is the one listed.
const workspaces = 1 + Math.ceil(otherAgents / 50);
await client.exec(`
  INSERT INTO workspaces (id, slug, name)
  SELECT ('00000000-0000-4000-8000-' || lpad(w::text, 12, '0'))::uuid, 'ws-' || w, 'ws ' || w
  FROM generate_series(1, ${workspaces}) w;
  INSERT INTO users (id, email, display_name)
  SELECT ('00000000-0000-4000-9000-' || lpad(w::text, 12, '0'))::uuid, 'owner' || w || '@example.invalid', 'Owner ' || w
  FROM generate_series(1, ${workspaces}) w;
  INSERT INTO memberships (workspace_id, user_id, role)
  SELECT ('00000000-0000-4000-8000-' || lpad(w::text, 12, '0'))::uuid,
         ('00000000-0000-4000-9000-' || lpad(w::text, 12, '0'))::uuid, 'owner'
  FROM generate_series(1, ${workspaces}) w;
  INSERT INTO member_teams (id, workspace_id, name)
  SELECT gen_random_uuid(), ('00000000-0000-4000-8000-' || lpad(w::text, 12, '0'))::uuid, 'team ' || w
  FROM generate_series(1, ${workspaces}) w;
  INSERT INTO agents (id, workspace_id, slug, name, created_by, created_at, managing_team_id)
  SELECT gen_random_uuid(), ws, 'agent-' || g, 'Agent ' || g,
         ('00000000-0000-4000-9000-' || right(ws::text, 12))::uuid,
         now() - g * interval '1 second',
         (SELECT t.id FROM member_teams t WHERE t.workspace_id = s.ws LIMIT 1)
  FROM (SELECT g, CASE WHEN g <= ${agentCount} THEN '${WORKSPACE}'::uuid
                  ELSE ('00000000-0000-4000-8000-' || lpad((2 + g % ${workspaces - 1})::text, 12, '0'))::uuid END AS ws
        FROM generate_series(1, ${agentCount + otherAgents}) g) s;
  -- Three versions each, with long instructions, as cards grow.
  INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256, created_at)
  SELECT gen_random_uuid(), a.id, v,
         jsonb_build_object(
           'role', 'Role of ' || a.name, 'instructions', repeat('Instructions. ', 300),
           'language', 'ko', 'model', 'claude-sonnet-5', 'rules', '[]'::jsonb,
           'capabilities', jsonb_build_object('tools', jsonb_build_array('Read'),
             'mcp', jsonb_build_array(jsonb_build_object('server', 'linear')),
             'forbidden', '[]'::jsonb, 'credential_refs', jsonb_build_array('github', 'slack'))),
         md5(a.id::text || v) || md5(v || a.id::text), now()
  FROM agents a, generate_series(1, 3) v;
  -- Every other agent released at v2 and active.
  INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
                              runtime_config_snapshot, effective_tools,
                              ${RELEASE_SPEC_SQL_COLUMNS})
  SELECT 'rel-' || a.id, a.id, v.id, v.content_sha256, '{}',
         '{"tools": ["Read"], "mcp": []}', ${releaseSpecSqlValues()}
  FROM agents a JOIN agent_versions v ON v.agent_id = a.id AND v.version_no = 2
  WHERE right(a.slug, 1) IN ('0', '2', '4', '6', '8');
  UPDATE agents SET active_release_id = 'rel-' || id, activation_revision = 0
  WHERE right(slug, 1) IN ('0', '2', '4', '6', '8');
  INSERT INTO agent_admins (workspace_id, agent_id, user_id)
  SELECT workspace_id, id, created_by FROM agents;
  INSERT INTO agent_admin_teams (workspace_id, agent_id, team_id)
  SELECT a.workspace_id, a.id, t.id FROM agents a JOIN member_teams t ON t.workspace_id = a.workspace_id;
  INSERT INTO credential_bindings (id, workspace_id, credential_ref, target, target_id, bound_by, revoked_at)
  SELECT gen_random_uuid(), workspace_id, ref, 'agent', id, created_by,
         CASE WHEN ref = 'old' THEN now() END
  FROM agents, unnest(ARRAY['github', 'old']) ref;
  ANALYZE;`);
const counts = await client.query<Record<string, number>>(
  `SELECT (SELECT count(*)::int FROM agents) AS agents,
          (SELECT count(*)::int FROM agent_versions) AS versions,
          (SELECT count(*)::int FROM credential_bindings) AS bindings`,
);
console.log(
  `seeded ${JSON.stringify(counts.rows[0])} in ${((performance.now() - seeded) / 1000).toFixed(1)}s`,
);

const agents = createPostgresAgentStore(db as unknown as Database);
const admins = createPostgresAgentAdminStore(db as unknown as Database);
const bindings = createPostgresCredentialBindingStore(
  db as unknown as Database,
);
// Workspace 1's owner, who reads every agent's row and summary.
const OWNER = "00000000-0000-4000-9000-000000000001";
const READER = { userId: OWNER, outsideAccess: "use" } as const;
const page = await agents.list(WORKSPACE, { limit: PAGE }, READER);
const ids = page.items.map((agent) => agent.id);
const VIEWER = { userId: OWNER, apiKeyId: null };
const summaries = await agents.summaries(WORKSPACE, ids, VIEWER);
const listed = Math.min(agentCount, PAGE);
if (ids.length !== listed || summaries.size !== listed)
  throw new Error("seed failed");

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

console.table({
  [`list(limit ${PAGE})`]: await timed(() =>
    agents.list(WORKSPACE, { limit: PAGE }, READER),
  ),
  [`list + summaries(${listed})`]: await timed(async () => {
    const first = await agents.list(WORKSPACE, { limit: PAGE }, READER);
    await agents.summaries(
      WORKSPACE,
      first.items.map((agent) => agent.id),
      VIEWER,
    );
  }),
  // The three reads one card makes without a summary, for one agent.
  "get + admins + bindings (1 agent)": await timed(async () => {
    const id = ids[0] ?? "";
    await agents.get(WORKSPACE, id);
    await admins.list(WORKSPACE, id);
    await bindings.list(WORKSPACE, id);
  }),
  [`get + admins + bindings (${listed} agents)`]: await timed(async () => {
    for (const id of ids) {
      await agents.get(WORKSPACE, id);
      await admins.list(WORKSPACE, id);
      await bindings.list(WORKSPACE, id);
    }
  }),
});

const inList = ids.map((id) => `'${id}'`).join(", ");
const plans: [string, string][] = [
  [
    "active release per agent",
    `SELECT a.id, r.connection_id, r.version_id FROM agents a
     LEFT JOIN agent_releases r ON r.id = a.active_release_id AND r.agent_id = a.id
     WHERE a.workspace_id = '${WORKSPACE}' AND a.id IN (${inList})`,
  ],
  [
    "newest version of each unreleased agent",
    `SELECT DISTINCT ON (agent_id) agent_id, version_no, card->>'role',
            left(card->>'instructions', 300), card->'capabilities'
     FROM agent_versions WHERE agent_id IN (${inList})
     ORDER BY agent_id, version_no DESC`,
  ],
  [
    "admins",
    `SELECT aa.agent_id, u.display_name FROM agent_admins aa
     JOIN users u ON u.id = aa.user_id
     WHERE aa.workspace_id = '${WORKSPACE}' AND aa.agent_id IN (${inList})
     ORDER BY aa.created_at, aa.user_id`,
  ],
  [
    "admin teams",
    `SELECT at.agent_id, t.name FROM agent_admin_teams at
     JOIN member_teams t ON t.id = at.team_id
     WHERE at.workspace_id = '${WORKSPACE}' AND at.agent_id IN (${inList})
     ORDER BY at.created_at, at.team_id`,
  ],
  [
    "live bindings",
    `SELECT target_id, credential_ref FROM credential_bindings
     WHERE workspace_id = '${WORKSPACE}' AND target = 'agent'
       AND target_id IN (${inList}) AND revoked_at IS NULL
     ORDER BY credential_ref`,
  ],
];
for (const [label, query] of plans) {
  const plan = await client.query<{ "QUERY PLAN": string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${query}`,
  );
  console.log(`\n-- ${label}`);
  for (const row of plan.rows) console.log(row["QUERY PLAN"].slice(0, 140));
}
