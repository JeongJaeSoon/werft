import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { fillSessionParents } from "./conversations/session-parents.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { makeFixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/**
 * Hosts that start at once each run the pass over the same sessions: every
 * session is filled once, each channel and person keeps one conversation,
 * and no run fails.
 */
integration("fillSessionParents on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  const workspaceId = randomUUID();
  const installationId = randomUUID();
  const person = randomUUID();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_parents" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema }) as unknown as Database;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  test("four passes at once fill each session once and make one conversation per place", async () => {
    const releaseId = await makeFixtureRelease(db, {
      workspaceId,
      model: TEST_MODEL,
    });
    const { rows: releases } = await pool.query<{ agent_id: string }>(
      "SELECT agent_id FROM agent_releases WHERE id = $1",
      [releaseId],
    );
    const agentId = releases[0]?.agent_id as string;
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
      [person, `${person}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [workspaceId, person],
    );
    await pool.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0001', 'T0001')",
      [installationId, workspaceId],
    );
    const binding = async (kind: string, channel: string | null) => {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface, installation_id,
           external_surface_id, surface_kind, mode, ceiling_actions, ceiling_disclosure, status)
         VALUES ($1, $2, $3, 'slack', $4, $5, $6, 'on', '{}', 'full', 'ready')`,
        [id, workspaceId, agentId, installationId, channel, kind],
      );
      return id;
    };
    const dm = await binding("dm", null);
    const channels = await binding("public_channel", "C0001");
    const sessionIds: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const sessionId = randomUUID();
      sessionIds.push(sessionId);
      await pool.query(
        `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id)
         VALUES ($1, $2::text, 'https://example.invalid/repo.git', $3, $2::uuid)`,
        [sessionId, workspaceId, `session/${sessionId}`],
      );
      const inDm = i % 2 === 0;
      const channelId = inDm ? "D0001" : `C000${i % 3}`;
      const thread = `${1000 + i}.000100`;
      await pool.query(
        `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id,
           surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id,
           release_id, created_by)
         VALUES ($1, $2::uuid, $2::text, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11)`,
        [
          randomUUID(),
          workspaceId,
          sessionId,
          installationId,
          inDm ? dm : channels,
          `${channelId}:${thread}`,
          channelId,
          thread,
          agentId,
          releaseId,
          inDm ? person : null,
        ],
      );
    }

    const runs = await Promise.all(
      Array.from({ length: 4 }, () => fillSessionParents(db, { batchSize: 7 })),
    );
    expect(runs.flatMap((run) => run.failed)).toEqual([]);
    expect(runs.reduce((sum, run) => sum + run.filled, 0)).toBe(40);
    const { rows: empty } = await pool.query(
      "SELECT id FROM sessions WHERE parent_conversation_id IS NULL",
    );
    expect(empty).toEqual([]);
    // One DM conversation and the three channels'.
    const { rows: places } = await pool.query<{
      kind: string;
      place: string;
      sessions: number;
    }>(
      `SELECT c.kind, coalesce(c.channel_id, c.person_user_id::text) AS place,
         count(s.id)::int AS sessions
       FROM conversations c JOIN sessions s ON s.parent_conversation_id = c.id
       GROUP BY c.id ORDER BY place`,
    );
    expect(places).toEqual(
      [
        { kind: "channel", place: "C0000", sessions: 7 },
        { kind: "channel", place: "C0001", sessions: 7 },
        { kind: "channel", place: "C0002", sessions: 6 },
        { kind: "dm", place: person, sessions: 20 },
      ].sort((a, b) => (a.place < b.place ? -1 : 1)),
    );
  }, 60_000);
});
