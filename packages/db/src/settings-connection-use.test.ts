import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema.ts";
import { createPostgresSettingsDocumentStore } from "./settings-document.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
  sessionPinValues,
} from "./testing/spec-pins.ts";

/**
 * What runs on a connection, read in SQL when a person opens the disable
 * confirmation: active agents whose active release names it, live sessions
 * whose spec names it, and the workspace judge setting.
 */

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let workspaceId: string;
let userId: string;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
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

const on = (id: string) => ({
  connection: {
    id,
    kind: "anthropic" as const,
    endpoint: "https://api.anthropic.invalid",
    billing: "per_token" as const,
  },
});

async function release(
  agentId: string,
  versionNo: number,
  connectionId: string,
): Promise<string> {
  const versionId = randomUUID();
  const releaseId = `sha256:${randomUUID()}`;
  await client.query(
    `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
     VALUES ($1, $2, $3, '{}', $4)`,
    [versionId, agentId, versionNo, String(versionNo).repeat(64)],
  );
  await client.query(
    `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
       repository_id, runtime_config_snapshot, effective_tools, policy_pins,
       ${RELEASE_SPEC_SQL_COLUMNS})
     VALUES ($1, $2, $3, $4, 'sample-app', '{}', '{}', '{}',
       ${releaseSpecSqlValues(on(connectionId))})`,
    [releaseId, agentId, versionId, "a".repeat(64)],
  );
  return releaseId;
}

/**
 * An agent whose active release runs on `connectionId`; `past` adds an
 * earlier release on another connection that is no longer the active one.
 */
async function agent(connectionId: string, status = "active", past?: string) {
  const agentId = randomUUID();
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
  const releaseId = await release(agentId, 1, connectionId);
  await client.query(
    "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
    [agentId, releaseId],
  );
  if (past) await release(agentId, 2, past);
}

/** A session whose spec runs on `connectionId`, or one with no spec. */
async function session(connectionId: string | null, status: string) {
  const pin =
    connectionId === null
      ? null
      : sessionPinValues(undefined, on(connectionId));
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
       workspace_id, created_by_user_id, status, model, spec_source,
       spec_source_digest, runtime_spec, spec_digest)
     VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', 'sample-app',
       $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      workspaceId,
      workspaceId,
      userId,
      status,
      pin?.model ?? null,
      pin?.spec_source ?? null,
      pin?.spec_source_digest ?? null,
      pin?.runtime_spec ?? null,
      pin?.spec_digest ?? null,
    ],
  );
}

describe("connectionUse", () => {
  test("only active agents on an active release of that connection are counted", async () => {
    await agent("use-a");
    await agent("use-a");
    await agent("use-a", "paused");
    await agent("use-a", "archived");
    await agent("use-b");
    expect(
      (await store().connectionUse({ connectionId: "use-a" })).agents,
    ).toBe(2);
    expect(
      (await store().connectionUse({ connectionId: "use-none" })).agents,
    ).toBe(0);
  });

  test("a release the agent no longer runs does not count", async () => {
    // Active on a connection that is not the one asked about, with an older
    // release on it: the agent is not left without a model.
    await agent("use-b", "active", "use-a");
    expect(
      (await store().connectionUse({ connectionId: "use-a" })).agents,
    ).toBe(0);
    expect(
      (await store().connectionUse({ connectionId: "use-b" })).agents,
    ).toBe(1);
  });

  test("sessions not yet failed or stopped count by the connection their spec names", async () => {
    for (const status of [
      "running",
      "queued",
      "idle",
      "needs_input",
      "stopped",
      "failed",
    ]) {
      await session("sess-a", status);
    }
    await session("sess-b", "running");
    // A session without a spec runs on no connection.
    await session(null, "idle");
    expect(
      (await store().connectionUse({ connectionId: "sess-a" })).sessions,
    ).toBe(4);
  });

  test("a workspace judge setting naming the connection is reported, another id is not", async () => {
    expect(
      await store().connectionUse({ connectionId: "judge-connection" }),
    ).toEqual({ agents: 0, sessions: 0, judgeNamed: false });
    await client.query(
      "UPDATE workspaces SET settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{achievement_judge}', $2::jsonb) WHERE id = $1",
      [workspaceId, JSON.stringify({ connection_id: "judge-connection" })],
    );
    expect(
      (await store().connectionUse({ connectionId: "judge-connection" }))
        .judgeNamed,
    ).toBe(true);
    expect(
      (await store().connectionUse({ connectionId: "other-connection" }))
        .judgeNamed,
    ).toBe(false);
  });
});
