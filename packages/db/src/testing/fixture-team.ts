// Test fixtures only: an agent row needs a managing team, so a test that
// inserts one directly takes the workspace's fixture team from here.
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { memberTeams } from "../schema.ts";

const FIXTURE_TEAM_NAME = "fixture team";

/** The workspace's fixture team, made on first use. */
export async function fixtureTeam(
  db: Database,
  workspaceId: string,
): Promise<string> {
  await db
    .insert(memberTeams)
    .values({ id: randomUUID(), workspaceId, name: FIXTURE_TEAM_NAME })
    .onConflictDoNothing();
  const [team] = await db
    .select({ id: memberTeams.id })
    .from(memberTeams)
    .where(
      and(
        eq(memberTeams.workspaceId, workspaceId),
        eq(memberTeams.name, FIXTURE_TEAM_NAME),
        isNull(memberTeams.archivedAt),
      ),
    );
  if (!team) throw new Error("fixture team missing");
  return team.id;
}

interface Queryable {
  query(
    text: string,
    values: unknown[],
  ): PromiseLike<{ rows: Record<string, unknown>[] }>;
}

/** `fixtureTeam` for a test that talks to Postgres through a pool or client. */
export async function fixtureTeamSql(
  pool: Queryable,
  workspaceId: string,
): Promise<string> {
  await pool.query(
    "INSERT INTO member_teams (id, workspace_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [randomUUID(), workspaceId, FIXTURE_TEAM_NAME],
  );
  const { rows } = await pool.query(
    "SELECT id FROM member_teams WHERE workspace_id = $1 AND name = $2 AND archived_at IS NULL",
    [workspaceId, FIXTURE_TEAM_NAME],
  );
  const id = rows[0]?.id;
  if (typeof id !== "string") throw new Error("fixture team missing");
  return id;
}
