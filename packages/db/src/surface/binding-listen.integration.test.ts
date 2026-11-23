import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migrate } from "../migrate.ts";
import { MIGRATIONS_FOLDER } from "../migration-journal.ts";
import * as schema from "../schema.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import { migrationsThrough } from "../testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("surface_bindings.listen and agents.conversation_rollout", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let before: string;

  beforeEach(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "binding_listen_it",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
    before = migrationsThrough("0317_binding_listen", { exclusive: true });
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
    await rm(before, { recursive: true, force: true });
  }, 60_000);

  test("a channel bound before listens as its agent's mention_only said, and every agent's switch is off", async () => {
    await migrate(db, { migrationsFolder: before });
    const workspaceId = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    const teamId = await fixtureTeam(db, workspaceId);
    const agents = { waits: randomUUID(), talks: randomUUID() };
    for (const [slug, id] of Object.entries(agents)) {
      await pool.query(
        `INSERT INTO agents (id, workspace_id, slug, name, managing_team_id,
           slack_mention_only)
         VALUES ($1, $2, $3, $3, $4, $5)`,
        [id, workspaceId, slug, teamId, slug === "waits"],
      );
    }
    const binding = (agentId: string, channel: string | null, mode: string) =>
      pool.query(
        `INSERT INTO surface_bindings (id, workspace_id, agent_id,
           external_surface_id, surface_kind, mode, ceiling_actions,
           ceiling_disclosure, status)
         VALUES ($1, $2, $3, $4, $5, $6, ARRAY[]::text[], 'full', 'partial')`,
        [
          randomUUID(),
          workspaceId,
          agentId,
          channel,
          channel === null ? "dm" : "public_channel",
          mode,
        ],
      );
    await binding(agents.waits, "C0WAITS", "on");
    await binding(agents.waits, "C0WAITSOFF", "off");
    await binding(agents.waits, null, "on");
    await binding(agents.talks, "C0TALKS", "on");
    await binding(agents.talks, null, "on");

    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const byMentionOnly = await pool.query(
      `SELECT a.slack_mention_only, b.listen, count(*)::int AS bindings
         FROM surface_bindings b JOIN agents a ON a.id = b.agent_id
        GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    expect(byMentionOnly.rows).toEqual([
      { slack_mention_only: false, listen: "free", bindings: 2 },
      { slack_mention_only: true, listen: "mention", bindings: 3 },
    ]);
    // The mode and the agent's own setting are left as they were.
    const modes = await pool.query(
      "SELECT external_surface_id, mode FROM surface_bindings WHERE external_surface_id IS NOT NULL ORDER BY 1",
    );
    expect(modes.rows).toEqual([
      { external_surface_id: "C0TALKS", mode: "on" },
      { external_surface_id: "C0WAITS", mode: "on" },
      { external_surface_id: "C0WAITSOFF", mode: "off" },
    ]);
    const switches = await pool.query(
      `SELECT slug, slack_mention_only, conversation_rollout FROM agents
        ORDER BY slug`,
    );
    expect(switches.rows).toEqual([
      { slug: "talks", slack_mention_only: false, conversation_rollout: "off" },
      { slug: "waits", slack_mention_only: true, conversation_rollout: "off" },
    ]);

    // Bound after the migration, a channel listens to every message even
    // when its agent waits for a mention.
    const later = randomUUID();
    await pool.query(
      `INSERT INTO surface_bindings (id, workspace_id, agent_id,
         external_surface_id, surface_kind, mode, ceiling_actions,
         ceiling_disclosure, status)
       VALUES ($1, $2, $3, 'C0LATER', 'public_channel', 'on', ARRAY[]::text[],
         'full', 'partial')`,
      [later, workspaceId, agents.waits],
    );
    const fresh = await pool.query(
      "SELECT listen FROM surface_bindings WHERE id = $1",
      [later],
    );
    expect(fresh.rows).toEqual([{ listen: "free" }]);
  });

  test("a value outside the lists is refused", async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const refused = async (statement: string) => {
      try {
        await pool.query(statement);
      } catch (error) {
        return String((error as Error).message);
      }
      return "accepted";
    };
    // A CHECK fails at the row, before any foreign key is looked at.
    expect(
      await refused(
        "INSERT INTO surface_bindings (id, workspace_id, agent_id, mode, listen, ceiling_actions, ceiling_disclosure, status) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'on', 'ambient', ARRAY[]::text[], 'full', 'partial')",
      ),
    ).toContain("surface_bindings_listen_check");
    expect(
      await refused(
        "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id, conversation_rollout) VALUES (gen_random_uuid(), gen_random_uuid(), 'x', 'x', gen_random_uuid(), 'maybe')",
      ),
    ).toContain("agents_conversation_rollout_check");
  });
});
