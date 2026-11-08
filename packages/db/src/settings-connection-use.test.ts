import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import * as schema from "./schema.ts";
import { createPostgresSettingsDocumentStore } from "./settings-document.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";

/**
 * What runs on the profiles of a connection, read in SQL when a person opens
 * the disable confirmation: active agents, live sessions (their own profile or
 * the one their open attempt claimed) and the workspace judge setting.
 */

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let workspaceId: string;
let userId: string;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
  workspaceId = randomUUID();
  userId = randomUUID();
  await client.query(
    "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
    [workspaceId],
  );
  await client.query(
    "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'owner')",
    [userId, `${userId}@example.invalid`],
  );
});

afterEach(async () => {
  await client.close();
});

const store = () => createPostgresSettingsDocumentStore(db);

/**
 * An agent whose active release runs `profile`; `past` adds an earlier release
 * on another profile that is no longer the active one.
 */
async function agent(profile: string, status = "active", past?: string) {
  const agentId = randomUUID();
  const versionId = randomUUID();
  const releaseId = `sha256:${randomUUID()}`;
  await client.query(
    "INSERT INTO agents (id, workspace_id, slug, name, status, managing_team_id) VALUES ($1, $2, $3, 'a', $4, $5)",
    [
      agentId,
      workspaceId,
      `a-${agentId.slice(0, 8)}`,
      status,
      await fixtureTeamSql(client, workspaceId),
    ],
  );
  await client.query(
    `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
     VALUES ($1, $2, 1, '{}', $3)`,
    [versionId, agentId, "a".repeat(64)],
  );
  await client.query(
    `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
       runtime_profile_id, repository_id, profile_digest,
       runtime_config_snapshot, effective_tools, policy_pins)
     VALUES ($1, $2, $3, $4, $5, 'sample-app', $6, '{}', '{}', '{}')`,
    [
      releaseId,
      agentId,
      versionId,
      "a".repeat(64),
      profile,
      `sha256:${"c".repeat(64)}`,
    ],
  );
  await client.query(
    "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
    [agentId, releaseId],
  );
  if (past) {
    const pastVersionId = randomUUID();
    await client.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 2, '{}', $3)`,
      [pastVersionId, agentId, "b".repeat(64)],
    );
    await client.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         runtime_profile_id, repository_id, profile_digest,
         runtime_config_snapshot, effective_tools, policy_pins)
       VALUES ($1, $2, $3, $4, $5, 'sample-app', $6, '{}', '{}', '{}')`,
      [
        `sha256:${randomUUID()}`,
        agentId,
        pastVersionId,
        "b".repeat(64),
        past,
        `sha256:${"c".repeat(64)}`,
      ],
    );
  }
}

/** A session on `profile`, optionally holding an attempt that claimed another. */
async function session(
  profile: string,
  status: string,
  attempt?: { profile: string; ended?: boolean },
) {
  const sessionId = randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
       workspace_id, created_by_user_id, profile_id, status)
     VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', 'sample-app',
       $3, $4, $5, $6)`,
    [sessionId, workspaceId, workspaceId, userId, profile, status],
  );
  if (attempt) {
    await client.query(
      `INSERT INTO attempts (id, session_id, execution_id, lease_epoch,
         execution_generation, auth_revision, state, lease_expires_at,
         profile_id, ended_at)
       VALUES ($1, $2, 'exec', 1, 1, 1, 'running', now(), $3, $4)`,
      [
        randomUUID(),
        sessionId,
        attempt.profile,
        attempt.ended ? new Date() : null,
      ],
    );
  }
}

describe("connectionUse", () => {
  test("only active agents on an active release of those profiles are counted", async () => {
    await agent("use-a_v1");
    await agent("use-a_v1");
    await agent("use-a_v1", "paused");
    await agent("use-a_v1", "archived");
    await agent("use-b_v1");
    expect(
      (
        await store().connectionUse({
          profileIds: ["use-a_v1"],
          connectionId: "console",
        })
      ).agents,
    ).toBe(2);
    expect(
      (
        await store().connectionUse({
          profileIds: ["use-none"],
          connectionId: "console",
        })
      ).agents,
    ).toBe(0);
  });

  test("a release the agent no longer runs does not count", async () => {
    // Active on a profile the connection does not touch, with an older release
    // on one it does: the agent is not left without a model.
    await agent("use-b_v1", "active", "use-a_v1");
    expect(
      (
        await store().connectionUse({
          profileIds: ["use-a_v1"],
          connectionId: "console",
        })
      ).agents,
    ).toBe(0);
    expect(
      (
        await store().connectionUse({
          profileIds: ["use-b_v1"],
          connectionId: "console",
        })
      ).agents,
    ).toBe(1);
  });

  test("sessions not yet failed or stopped count, by their profile or their open attempt's", async () => {
    await session("sess-a_v1", "running");
    await session("sess-a_v1", "queued");
    await session("sess-a_v1", "idle");
    await session("sess-a_v1", "needs_input");
    await session("sess-a_v1", "stopped");
    await session("sess-a_v1", "failed");
    await session("sess-b_v1", "running");
    // Moved onto another profile, the open attempt still runs the old one.
    await session("sess-b_v1", "running", { profile: "sess-a_v1" });
    // An attempt that ended holds nothing.
    await session("sess-b_v1", "running", {
      profile: "sess-a_v1",
      ended: true,
    });
    // The session and its attempt both name the profile: still one session.
    await session("sess-a_v1", "running", { profile: "sess-a_v1" });
    const use = await store().connectionUse({
      profileIds: ["sess-a_v1"],
      connectionId: "console",
    });
    expect(use.sessions).toBe(6);
  });

  test("a workspace judge setting naming the connection is reported, another id is not", async () => {
    expect(
      await store().connectionUse({
        profileIds: [],
        connectionId: "judge-connection",
      }),
    ).toEqual({ agents: 0, sessions: 0, judgeNamed: false });
    await client.query(
      "UPDATE workspaces SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{achievement_judge}', $2::jsonb) WHERE id = $1",
      [workspaceId, JSON.stringify({ connection_id: "judge-connection" })],
    );
    expect(
      (
        await store().connectionUse({
          profileIds: [],
          connectionId: "judge-connection",
        })
      ).judgeNamed,
    ).toBe(true);
    expect(
      (
        await store().connectionUse({
          profileIds: [],
          connectionId: "other-connection",
        })
      ).judgeNamed,
    ).toBe(false);
  });
});
