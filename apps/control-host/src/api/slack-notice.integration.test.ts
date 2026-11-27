import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as schema from "@werft-ai/db";
import { fixtureTeamSql } from "@werft-ai/db/testing/fixture-team";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { runSlackNotice, SLACK_NOTICE_EXIT } from "./slack-notice.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/** Stored where the command could reach it; it must never be printed. */
const CREDENTIAL_REF = "slack/notice-cli-bot-token";

integration("slack-notice command on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const admin = randomUUID();

  async function command(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSlackNotice(argv, {
      env: { DATABASE_URL: database.url },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      openDatabase: async () => ({ db, close: async () => {} }),
    });
    return { code, out, err };
  }

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_notice_cli" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
      [admin, `admin-${admin.slice(0, 8)}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
      [workspaceId, admin],
    );
    const team = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, $4, 'agent', 'active')",
      [agentId, workspaceId, team, `agent-${agentId.slice(0, 8)}`],
    );
    const installationId = randomUUID();
    await pool.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0NOTICECLI', 'T0NOTICECLI')",
      [installationId, workspaceId],
    );
    await pool.query(
      `INSERT INTO agent_identities
         (id, workspace_id, agent_id, provider, installation_id, external_principal_id, credential_ref)
       VALUES ($1, $2, $3, 'slack_bot', $4, 'U0NOTICECLI', $5)`,
      [randomUUID(), workspaceId, agentId, installationId, CREDENTIAL_REF],
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  test("show prints the switch, ids and values only; no approval is read", async () => {
    // An approval row left from before the approval was retired: never printed.
    await pool.query(
      `INSERT INTO slack_notice_approvals
         (id, workspace_id, agent_id, slack_team_id, notice_version, approved_by)
       VALUES ($1, $2, $3, 'T0NOTICECLI', 1, $4)`,
      [randomUUID(), workspaceId, agentId, admin],
    );
    const shown = await command(["show", "--agent", agentId]);
    expect(shown.code).toBe(SLACK_NOTICE_EXIT.ok);
    expect(shown.out).toHaveLength(1);
    expect(JSON.parse(shown.out[0] ?? "")).toEqual({
      outcome: "shown",
      agent_id: agentId,
      workspace_id: workspaceId,
      rollout: "off",
    });
    const text = shown.out.join("\n");
    expect(text).not.toContain(CREDENTIAL_REF);
    expect(text).not.toContain("U0NOTICECLI");
    expect(text).not.toContain("@example.invalid");
    expect(shown.err).toEqual([]);
  });

  test("list is gone with the approval", async () => {
    const listed = await command(["list", "--workspace", workspaceId]);
    expect(listed.code).toBe(SLACK_NOTICE_EXIT.usage);
    expect(listed.out).toEqual([]);
  });

  test("set-rollout raises the switch without any approval and records by operator_cli; on exits 4", async () => {
    const rolloutReceipts = async () =>
      (
        await pool.query(
          "SELECT result, actor FROM receipts WHERE operation = 'set_conversation_rollout' AND target_ref->'resource'->>'id' = $1 ORDER BY created_at",
          [agentId],
        )
      ).rows;
    // No live approval: the one row there is revoked.
    await pool.query(
      "UPDATE slack_notice_approvals SET revoked_at = now(), revoked_by = $2 WHERE agent_id = $1",
      [agentId, admin],
    );
    const on = await command([
      "set-rollout",
      "--agent",
      agentId,
      "--rollout",
      "on",
    ]);
    expect(on.code).toBe(SLACK_NOTICE_EXIT.refused);
    expect(JSON.parse(on.out[0] ?? "")).toEqual({
      outcome: "refused",
      agent_id: agentId,
      reason_code: "rollout_on_unavailable",
    });
    const raised = await command([
      "set-rollout",
      "--agent",
      agentId,
      "--rollout",
      "shadow",
    ]);
    expect(raised.code).toBe(SLACK_NOTICE_EXIT.ok);
    expect(JSON.parse(raised.out[0] ?? "")).toEqual({
      outcome: "changed",
      agent_id: agentId,
      before: "off",
      after: "shadow",
      buffered_dropped: 0,
    });
    const again = await command([
      "set-rollout",
      "--agent",
      agentId,
      "--rollout",
      "shadow",
    ]);
    expect(JSON.parse(again.out[0] ?? "")).toMatchObject({
      outcome: "unchanged",
    });
    const shown = await command(["show", "--agent", agentId]);
    expect(JSON.parse(shown.out[0] ?? "")).toMatchObject({
      rollout: "shadow",
    });
    const lowered = await command([
      "set-rollout",
      "--agent",
      agentId,
      "--rollout",
      "off",
    ]);
    expect(JSON.parse(lowered.out[0] ?? "")).toMatchObject({
      outcome: "changed",
      after: "off",
    });
    expect(await rolloutReceipts()).toEqual([
      {
        result: {
          agent_id: agentId,
          before: "off",
          after: "shadow",
          by: "operator_cli",
          reason: null,
          buffered_dropped: 0,
        },
        actor: null,
      },
      {
        result: {
          agent_id: agentId,
          before: "shadow",
          after: "off",
          by: "operator_cli",
          reason: null,
          buffered_dropped: 0,
        },
        actor: null,
      },
    ]);
  });

  test("an unknown agent exits 3", async () => {
    for (const argv of [
      ["show", "--agent", randomUUID()],
      ["set-rollout", "--agent", randomUUID(), "--rollout", "off"],
    ]) {
      const result = await command(argv);
      expect(result.code).toBe(SLACK_NOTICE_EXIT.not_found);
      expect(JSON.parse(result.out[0] ?? "")).toEqual({ outcome: "not_found" });
    }
  });
});
