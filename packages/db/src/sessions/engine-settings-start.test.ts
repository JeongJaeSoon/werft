import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "../schema.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "../testing/spec-pins.ts";
import { captureEngineSettingsStart } from "./engine-settings-start.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let workspaceId: string;
let agentId: string;
const releaseId = `sha256:${"d".repeat(64)}`;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  workspaceId = randomUUID();
  agentId = randomUUID();
  const versionId = randomUUID();
  await client.query(
    "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
    [workspaceId],
  );
  await client.query(
    "INSERT INTO agents (id, workspace_id, slug, name, status, managing_team_id) VALUES ($1, $2, 'bot', 'bot', 'active', $3)",
    [agentId, workspaceId, await fixtureTeamSql(client, workspaceId)],
  );
  await client.query(
    `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
     VALUES ($1, $2, 1, '{}', $3)`,
    [versionId, agentId, "a".repeat(64)],
  );
  await client.query(
    `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
       runtime_config_snapshot, effective_tools, policy_pins,
       ${RELEASE_SPEC_SQL_COLUMNS})
     VALUES ($1, $2, $3, $4, '{}', '{}', '{}', ${releaseSpecSqlValues()})`,
    [releaseId, agentId, versionId, "a".repeat(64)],
  );
});

afterEach(async () => {
  await client.close();
});

describe("captureEngineSettingsStart", () => {
  test("an agent without a settings row starts restrict-only (null)", async () => {
    expect(await captureEngineSettingsStart(db, releaseId)).toBeNull();
  });

  test("a release that does not exist captures nothing", async () => {
    expect(await captureEngineSettingsStart(db, "sha256:none")).toBeNull();
  });

  test("keeps the saved content and the revision it came from", async () => {
    await client.query(
      `INSERT INTO agent_engine_settings (agent_id, workspace_id, permissions, auto_mode, revision)
       VALUES ($1, $2, '{"deny":["Bash(rm:*)"]}'::jsonb, '{}'::jsonb, 3)`,
      [agentId, workspaceId],
    );
    expect(await captureEngineSettingsStart(db, releaseId)).toEqual({
      permissions: { deny: ["Bash(rm:*)"] },
      auto_mode: {},
      revision: 3,
    });
  });
});
