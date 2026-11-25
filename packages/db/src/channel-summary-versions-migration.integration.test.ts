import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresChannelSummaryStore,
  pruneChannelSummaryHistory,
} from "./conversations/channel-summaries.ts";
import { migrate } from "./migrate.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("0359 on a database that already has a channel summary", () => {
  let database: TempDatabase;
  let pool: Pool;
  let before: string;
  let through: string;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const place = { workspaceId, teamId: "T0MIG", channelId: "C0MIG" };
  const oldLine = randomUUID();

  beforeAll(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "summary_versions_migration",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    before = migrationsThrough("0359_channel_summary_writes", {
      exclusive: true,
    });
    through = migrationsThrough("0359_channel_summary_writes");
    await migrate(drizzle(pool), { migrationsFolder: before });
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    const team = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, 'summed', 'summed', 'active')",
      [agentId, workspaceId, team],
    );
    await pool.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, 'T0MIG', 'C0MIG')",
      [randomUUID(), workspaceId],
    );
    // Before: a summary at version 2, last changed 30 days ago, with a line
    // only version 1 held and one current.
    await pool.query(
      "INSERT INTO channel_summaries (workspace_id, team_id, channel_id, version, updated_at) VALUES ($1, 'T0MIG', 'C0MIG', 2, now() - interval '30 days')",
      [workspaceId],
    );
    for (const [id, text, to] of [
      [oldLine, "old line", 2],
      [randomUUID(), "current line", null],
    ] as const) {
      await pool.query(
        "INSERT INTO channel_summary_lines (id, workspace_id, team_id, channel_id, origin_id, text, written_by_agent_id, from_version, to_version) VALUES ($1, $2, 'T0MIG', 'C0MIG', $1, $3, $4, $5, $6)",
        [id, workspaceId, text, agentId, to === null ? 2 : 1, to],
      );
    }
    await pool.query(
      "INSERT INTO channel_summary_line_sources (line_id, input_id, workspace_id, team_id, channel_id, ts, speaker_kind, speaker_id) VALUES ($1, $2, $3, 'T0MIG', 'C0MIG', '1.000100', 'slack_user', 'U0OLD')",
      [oldLine, randomUUID(), workspaceId],
    );
    await migrate(drizzle(pool), { migrationsFolder: through });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
    for (const folder of [before, through]) {
      if (folder) rmSync(folder, { recursive: true, force: true });
    }
  });

  test("keeps the earlier versions readable, and the reconciler removes them past the 7 days", async () => {
    const db = drizzle(pool, { schema }) as unknown as Database;
    const summaries = createPostgresChannelSummaryStore(db);
    const texts = async (version?: number) =>
      (await summaries.read(place, version))?.lines.map((line) => line.text);
    // After the migration: every version reads as before.
    expect(await texts(1)).toEqual(["old line"]);
    expect(await texts()).toEqual(["current line"]);
    // Version 2 has been current for 30 days: version 1 and its line go.
    expect(
      await pruneChannelSummaryHistory(db, { limit: 10, dryRun: false }),
    ).toEqual({ channels: 1, versions: 2, lines: 1 });
    expect(await texts(1)).toBeUndefined();
    expect(await texts()).toEqual(["current line"]);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM channel_summary_line_sources WHERE line_id = $1",
      [oldLine],
    );
    expect(rows[0]).toEqual({ n: 0 });
  });
});
