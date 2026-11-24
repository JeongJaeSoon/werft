import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { slackNoticeVersionSchema } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import { approveSlackNotice, revokeSlackNotice } from "@werft-ai/db";
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

const V1 = [
  {
    version: slackNoticeVersionSchema.parse(1),
    text: {
      ko: {
        body: ["notice"],
        policyLink: { label: "policy", href: "https://docs.example.test/data" },
      },
      ja: {
        body: ["notice"],
        policyLink: { label: "policy", href: "https://docs.example.test/data" },
      },
    },
    requiresReapproval: true,
  },
];
/** Stored where the command could reach it; it must never be printed. */
const CREDENTIAL_REF = "slack/notice-cli-bot-token";

integration("slack-notice command on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const admin = randomUUID();

  async function command(argv: string[], versions?: typeof V1) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSlackNotice(argv, {
      env: { DATABASE_URL: database.url },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      openDatabase: async () => ({ db, close: async () => {} }),
      ...(versions === undefined ? {} : { versions }),
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

  test("show and list print the approval rows, ids, versions and times only", async () => {
    const empty = await command(["show", "--agent", agentId]);
    expect(empty.code).toBe(SLACK_NOTICE_EXIT.ok);
    expect(JSON.parse(empty.out[0] ?? "")).toEqual({
      outcome: "shown",
      agent_id: agentId,
      workspace_id: workspaceId,
      rollout: "off",
      approved: false,
      reason: "no_notice",
      approvals: [],
    });

    const approved = await approveSlackNotice(
      db,
      { workspaceId, agentId, by: admin, locale: "ko" },
      V1,
    );
    if (approved.outcome !== "approved") throw new Error(approved.outcome);
    const [first] = approved.added;
    await revokeSlackNotice(db, { workspaceId, agentId, by: admin });
    await approveSlackNotice(
      db,
      { workspaceId, agentId, by: admin, locale: "ko" },
      V1,
    );

    const shown = await command(["show", "--agent", agentId]);
    expect(shown.code).toBe(SLACK_NOTICE_EXIT.ok);
    expect(shown.out).toHaveLength(1);
    const line = JSON.parse(shown.out[0] ?? "");
    // The published list is still empty, so the command reports no notice.
    expect(line).toMatchObject({ approved: false, reason: "no_notice" });
    expect(line.approvals).toHaveLength(2);
    expect(line.approvals[0]).toEqual({
      id: first?.approvalId,
      agent_id: agentId,
      slack_team_id: "T0NOTICECLI",
      notice_version: 1,
      approved_by: admin,
      approved_at: expect.any(String),
      revoked_by: admin,
      revoked_at: expect.any(String),
    });
    expect(line.approvals[1]).toMatchObject({
      revoked_by: null,
      revoked_at: null,
    });

    const listed = await command(["list", "--workspace", workspaceId]);
    expect(listed.code).toBe(SLACK_NOTICE_EXIT.ok);
    const list = JSON.parse(listed.out[0] ?? "");
    expect(list).toMatchObject({
      outcome: "listed",
      workspace_id: workspaceId,
    });
    expect(list.approvals).toEqual(line.approvals);

    for (const output of [shown, listed]) {
      const text = output.out.join("\n");
      expect(text).not.toContain(CREDENTIAL_REF);
      expect(text).not.toContain("U0NOTICECLI");
      expect(text).not.toContain("@example.invalid");
      expect(output.err).toEqual([]);
    }
  });

  test("set-rollout raises the switch of an approved agent and records by operator_cli; on and an unapproved raise exit 4", async () => {
    const rolloutReceipts = async () =>
      (
        await pool.query(
          "SELECT result, actor FROM receipts WHERE operation = 'set_conversation_rollout' AND target_ref->'resource'->>'id' = $1 ORDER BY created_at",
          [agentId],
        )
      ).rows;
    await revokeSlackNotice(db, { workspaceId, agentId, by: admin });
    const refused = await command(
      ["set-rollout", "--agent", agentId, "--rollout", "shadow"],
      V1,
    );
    expect(refused.code).toBe(SLACK_NOTICE_EXIT.refused);
    expect(JSON.parse(refused.out[0] ?? "")).toEqual({
      outcome: "refused",
      agent_id: agentId,
      reason_code: "not_approved",
    });
    await approveSlackNotice(
      db,
      { workspaceId, agentId, by: admin, locale: "ko" },
      V1,
    );
    const on = await command(
      ["set-rollout", "--agent", agentId, "--rollout", "on"],
      V1,
    );
    expect(on.code).toBe(SLACK_NOTICE_EXIT.refused);
    expect(JSON.parse(on.out[0] ?? "")).toMatchObject({
      reason_code: "rollout_on_unavailable",
    });
    const raised = await command(
      ["set-rollout", "--agent", agentId, "--rollout", "shadow"],
      V1,
    );
    expect(raised.code).toBe(SLACK_NOTICE_EXIT.ok);
    expect(JSON.parse(raised.out[0] ?? "")).toEqual({
      outcome: "changed",
      agent_id: agentId,
      before: "off",
      after: "shadow",
      buffered_dropped: 0,
    });
    const again = await command(
      ["set-rollout", "--agent", agentId, "--rollout", "shadow"],
      V1,
    );
    expect(JSON.parse(again.out[0] ?? "")).toMatchObject({
      outcome: "unchanged",
    });
    const shown = await command(["show", "--agent", agentId], V1);
    expect(JSON.parse(shown.out[0] ?? "")).toMatchObject({
      rollout: "shadow",
      approved: true,
    });
    const lowered = await command(
      ["set-rollout", "--agent", agentId, "--rollout", "off"],
      V1,
    );
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

  test("an unknown agent or workspace exits 3", async () => {
    for (const argv of [
      ["show", "--agent", randomUUID()],
      ["list", "--workspace", randomUUID()],
      ["set-rollout", "--agent", randomUUID(), "--rollout", "off"],
    ]) {
      const result = await command(argv);
      expect(result.code).toBe(SLACK_NOTICE_EXIT.not_found);
      expect(JSON.parse(result.out[0] ?? "")).toEqual({ outcome: "not_found" });
    }
  });
});
