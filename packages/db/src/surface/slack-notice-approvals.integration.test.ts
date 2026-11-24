import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type SlackNoticeVersionEntry,
  slackNoticeVersionSchema,
} from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import {
  approveSlackNotice,
  judgeSlackNotice,
  listSlackNoticeApprovals,
  revokeSlackNotice,
} from "./slack-notice-approvals.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const entry = (
  version: number,
  requiresReapproval: boolean,
): SlackNoticeVersionEntry => ({
  version: slackNoticeVersionSchema.parse(version),
  requiresReapproval,
});
const V1 = [entry(1, true)];
/** Version 2 only rewords version 1. */
const V2 = [...V1, entry(2, false)];
/** Version 3 asks for a new approval. */
const V3 = [...V2, entry(3, true)];

integration("Slack notice approvals on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let appCounter = 0;

  type Workspace = {
    id: string;
    owner: string;
    admin: string;
    member: string;
    disabledAdmin: string;
    team: string;
  };
  const workspaces: Workspace[] = [];

  async function user(workspaceId: string, role: string, disabled = false) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
      [id, `u-${id.slice(0, 8)}@example.invalid`],
    );
    await pool.query(
      `INSERT INTO memberships (workspace_id, user_id, role, disabled_at)
       VALUES ($1, $2, $3, ${disabled ? "now()" : "NULL"})`,
      [workspaceId, id, role],
    );
    return id;
  }

  async function workspace(): Promise<Workspace> {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [id, `ws-${id.slice(0, 8)}`],
    );
    return {
      id,
      owner: await user(id, "owner"),
      admin: await user(id, "admin"),
      member: await user(id, "member"),
      disabledAdmin: await user(id, "admin", true),
      team: await fixtureTeamSql(pool, id),
    };
  }

  async function agent(ws: Workspace) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, $4, 'agent', 'active')",
      [id, ws.id, ws.team, `agent-${id.slice(0, 8)}`],
    );
    return id;
  }

  /** Installs the agent's app in a Slack team and links its live identity. */
  async function install(ws: Workspace, agentId: string, slackTeamId: string) {
    appCounter += 1;
    const installationId = randomUUID();
    await pool.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, $3, $4)",
      [installationId, ws.id, `A0NOTICE${appCounter}`, slackTeamId],
    );
    await pool.query(
      `INSERT INTO agent_identities
         (id, workspace_id, agent_id, provider, installation_id, external_principal_id, credential_ref)
       VALUES ($1, $2, $3, 'slack_bot', $4, $5, $6)`,
      [
        randomUUID(),
        ws.id,
        agentId,
        installationId,
        `U0BOT${appCounter}`,
        `slack/bot-${appCounter}`,
      ],
    );
  }

  async function uninstall(agentId: string) {
    await pool.query(
      "UPDATE agent_identities SET status = 'revoked', revoked_at = now() WHERE agent_id = $1 AND status = 'active'",
      [agentId],
    );
  }

  /** The rows an approval added; throws unless it approved. */
  function addedOf(result: Awaited<ReturnType<typeof approveSlackNotice>>) {
    if (result.outcome !== "approved") throw new Error(result.outcome);
    const [first, ...rest] = result.added;
    if (first === undefined) throw new Error("approved with no row");
    return [first, ...rest] as const;
  }

  async function receiptsOf(agentId: string, operation: string) {
    const { rows } = await pool.query(
      `SELECT owner_id, target_ref, status, result, actor, xmin::text AS xmin
       FROM receipts WHERE operation = $1 AND target_ref->'resource'->>'id' = $2
       ORDER BY created_at`,
      [operation, agentId],
    );
    return rows;
  }

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_notice" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    workspaces.push(await workspace(), await workspace());
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  test("an approval writes one row and its receipt in the same transaction", async () => {
    const [ws] = workspaces as [Workspace];
    const agentId = await agent(ws);
    await install(ws, agentId, "T0NOTICEA");

    const approved = await approveSlackNotice(
      db,
      { workspaceId: ws.id, agentId, by: ws.admin, requestId: "req-notice-1" },
      V1,
    );
    const [added] = addedOf(approved);
    expect(approved).toEqual({
      outcome: "approved",
      version: 1,
      added: [
        { approvalId: added.approvalId, version: 1, slackTeamId: "T0NOTICEA" },
      ],
    } as never);

    const { rows } = await pool.query(
      `SELECT id, workspace_id, agent_id, slack_team_id, notice_version, approved_by,
              approved_at, revoked_at, xmin::text AS xmin
       FROM slack_notice_approvals WHERE agent_id = $1`,
      [agentId],
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      id: added.approvalId,
      workspace_id: ws.id,
      agent_id: agentId,
      slack_team_id: "T0NOTICEA",
      notice_version: 1,
      approved_by: ws.admin,
      revoked_at: null,
    });
    const age = Date.now() - new Date(row.approved_at).getTime();
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(60_000);

    const receipts = await receiptsOf(agentId, "approve_slack_notice");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      owner_id: ws.id,
      status: "succeeded",
      target_ref: {
        resource: { kind: "agent", id: agentId },
        workspace_id: ws.id,
      },
      result: {
        agent_id: agentId,
        approval_id: added.approvalId,
        slack_team_id: "T0NOTICEA",
        notice_version: 1,
      },
      actor: {
        principal: { kind: "user", id: ws.admin },
        actor_user_id: ws.admin,
        agent_id: null,
      },
    });
    // One transaction id wrote both rows.
    expect(receipts[0].xmin).toBe(row.xmin);

    expect(
      await judgeSlackNotice(db, { workspaceId: ws.id, agentId }, V1),
    ).toEqual({
      approved: true,
      approvals: [
        { approvalId: added.approvalId, version: 1, slackTeamId: "T0NOTICEA" },
      ],
    } as never);

    // The same approval again writes nothing.
    expect(
      await approveSlackNotice(
        db,
        { workspaceId: ws.id, agentId, by: ws.owner },
        V1,
      ),
    ).toEqual({ outcome: "unchanged", version: 1, added: [] } as never);
    expect(await receiptsOf(agentId, "approve_slack_notice")).toHaveLength(1);
    expect(await listSlackNoticeApprovals(db, { agentId })).toHaveLength(1);
  });

  test("an agent without an approval is not approved, whatever other agents have", async () => {
    const [ws] = workspaces as [Workspace];
    const approvedAgent = await agent(ws);
    const other = await agent(ws);
    await install(ws, approvedAgent, "T0NOTICEB");
    await install(ws, other, "T0NOTICEB");
    await approveSlackNotice(
      db,
      { workspaceId: ws.id, agentId: approvedAgent, by: ws.owner },
      V1,
    );
    expect(
      await judgeSlackNotice(db, { workspaceId: ws.id, agentId: other }, V1),
    ).toEqual({ approved: false, reason: "not_approved" });
    expect(
      (
        await judgeSlackNotice(
          db,
          { workspaceId: ws.id, agentId: approvedAgent },
          V1,
        )
      ).approved,
    ).toBe(true);
  });

  test("a rewording keeps the approval; a re-approval version drops it until approved again", async () => {
    const [ws] = workspaces as [Workspace];
    const agentId = await agent(ws);
    await install(ws, agentId, "T0NOTICEC");
    const place = { workspaceId: ws.id, agentId };
    await approveSlackNotice(db, { ...place, by: ws.admin }, V1);

    expect(await judgeSlackNotice(db, place, V2)).toMatchObject({
      approved: true,
      approvals: [{ version: 1 }],
    });
    expect(await judgeSlackNotice(db, place, V3)).toEqual({
      approved: false,
      reason: "not_approved",
    });

    const again = await approveSlackNotice(db, { ...place, by: ws.admin }, V3);
    expect(again).toMatchObject({ outcome: "approved", version: 3 });
    expect(await judgeSlackNotice(db, place, V3)).toMatchObject({
      approved: true,
      approvals: [{ version: 3 }],
    });
    expect(await receiptsOf(agentId, "approve_slack_notice")).toHaveLength(2);
  });

  test("a revoke leaves the agent unapproved and writes its receipt", async () => {
    const [ws] = workspaces as [Workspace];
    const agentId = await agent(ws);
    await install(ws, agentId, "T0NOTICED");
    const place = { workspaceId: ws.id, agentId };
    const [approved] = addedOf(
      await approveSlackNotice(db, { ...place, by: ws.admin }, V1),
    );

    const revoked = await revokeSlackNotice(db, { ...place, by: ws.owner });
    expect(revoked).toEqual({
      outcome: "revoked",
      approvalIds: [approved.approvalId],
    });
    expect(await judgeSlackNotice(db, place, V1)).toEqual({
      approved: false,
      reason: "not_approved",
    });
    const receipts = await receiptsOf(agentId, "revoke_slack_notice");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      owner_id: ws.id,
      status: "succeeded",
      result: {
        agent_id: agentId,
        approval_ids: [approved.approvalId],
        slack_team_ids: ["T0NOTICED"],
        notice_versions: [1],
      },
      actor: { actor_user_id: ws.owner },
    });
    const [record] = await listSlackNoticeApprovals(db, { agentId });
    expect(record).toMatchObject({ revokedBy: ws.owner });
    expect(record?.revokedAt).toBeInstanceOf(Date);

    // Nothing live: unchanged, no second receipt.
    expect(await revokeSlackNotice(db, { ...place, by: ws.owner })).toEqual({
      outcome: "unchanged",
      approvalIds: [],
    });
    expect(await receiptsOf(agentId, "revoke_slack_notice")).toHaveLength(1);

    // Approving after a revoke makes a new row.
    const [back] = addedOf(
      await approveSlackNotice(db, { ...place, by: ws.admin }, V1),
    );
    expect(back.approvalId).not.toBe(approved.approvalId);
    expect((await judgeSlackNotice(db, place, V1)).approved).toBe(true);
  });

  test("only a live owner or admin of the agent's workspace approves or revokes", async () => {
    const [ws, otherWs] = workspaces as [Workspace, Workspace];
    const agentId = await agent(ws);
    await install(ws, agentId, "T0NOTICEE");
    const place = { workspaceId: ws.id, agentId };
    for (const by of [ws.member, ws.disabledAdmin, otherWs.admin]) {
      expect(await approveSlackNotice(db, { ...place, by }, V1)).toEqual({
        outcome: "not_admin",
      });
      expect(await revokeSlackNotice(db, { ...place, by })).toEqual({
        outcome: "not_admin",
      });
    }
    // Another workspace's admin naming this agent under their own workspace.
    expect(
      await approveSlackNotice(
        db,
        { workspaceId: otherWs.id, agentId, by: otherWs.admin },
        V1,
      ),
    ).toEqual({ outcome: "not_found" });
    expect(await listSlackNoticeApprovals(db, { agentId })).toEqual([]);
    expect(await receiptsOf(agentId, "approve_slack_notice")).toEqual([]);
  });

  test("approvals of one workspace do not reach another's", async () => {
    const [ws, otherWs] = workspaces as [Workspace, Workspace];
    const mine = await agent(ws);
    const theirs = await agent(otherWs);
    // The same Slack team under both workspaces' apps.
    await install(ws, mine, "T0NOTICEF");
    await install(otherWs, theirs, "T0NOTICEF");
    await approveSlackNotice(
      db,
      { workspaceId: ws.id, agentId: mine, by: ws.admin },
      V1,
    );
    expect(
      await judgeSlackNotice(
        db,
        { workspaceId: otherWs.id, agentId: theirs },
        V1,
      ),
    ).toEqual({ approved: false, reason: "not_approved" });
    // The approved agent asked for under the other workspace is not found.
    expect(
      await judgeSlackNotice(
        db,
        { workspaceId: otherWs.id, agentId: mine },
        V1,
      ),
    ).toEqual({ approved: false, reason: "not_installed" });
    expect(
      (await listSlackNoticeApprovals(db, { workspaceId: otherWs.id })).some(
        (row) => row.agentId === mine,
      ),
    ).toBe(false);
  });

  test("an approval holds across a reinstall in the same Slack team, not in another", async () => {
    const [ws] = workspaces as [Workspace];
    const agentId = await agent(ws);
    const place = { workspaceId: ws.id, agentId };
    await install(ws, agentId, "T0NOTICEG");
    await approveSlackNotice(db, { ...place, by: ws.admin }, V1);

    await uninstall(agentId);
    expect(await judgeSlackNotice(db, place, V1)).toEqual({
      approved: false,
      reason: "not_installed",
    });
    expect(
      await approveSlackNotice(db, { ...place, by: ws.admin }, V1),
    ).toEqual({ outcome: "not_installed" });

    await install(ws, agentId, "T0NOTICEG");
    expect(await judgeSlackNotice(db, place, V1)).toMatchObject({
      approved: true,
      approvals: [{ slackTeamId: "T0NOTICEG" }],
    });

    await uninstall(agentId);
    await install(ws, agentId, "T0NOTICEH");
    expect(await judgeSlackNotice(db, place, V1)).toEqual({
      approved: false,
      reason: "not_approved",
    });
    // The old team's row stays, unrevoked.
    expect(await listSlackNoticeApprovals(db, { agentId })).toMatchObject([
      { slackTeamId: "T0NOTICEG", revokedAt: null },
    ]);
  });

  test("an app live in two Slack teams is approved only when both are; one approval covers each team", async () => {
    const [ws] = workspaces as [Workspace];
    const agentId = await agent(ws);
    const place = { workspaceId: ws.id, agentId };
    await install(ws, agentId, "T0NOTICEK");
    await approveSlackNotice(db, { ...place, by: ws.admin }, V1);
    expect((await judgeSlackNotice(db, place, V1)).approved).toBe(true);

    // The same app installed in a second team: that organization has not
    // been approved for.
    await install(ws, agentId, "T0NOTICEL");
    for (let i = 0; i < 3; i++) {
      expect(await judgeSlackNotice(db, place, V1)).toEqual({
        approved: false,
        reason: "not_approved",
      });
    }

    const added = addedOf(
      await approveSlackNotice(db, { ...place, by: ws.admin }, V1),
    );
    expect(added.map((row) => row.slackTeamId)).toEqual(["T0NOTICEL"]);
    const judged = await judgeSlackNotice(db, place, V1);
    expect(judged).toMatchObject({
      approved: true,
      approvals: [{ slackTeamId: "T0NOTICEK" }, { slackTeamId: "T0NOTICEL" }],
    });
    expect(await receiptsOf(agentId, "approve_slack_notice")).toHaveLength(2);

    // A version that asks again: one approval writes a row and a receipt for
    // each team, in one transaction.
    const both = addedOf(
      await approveSlackNotice(db, { ...place, by: ws.owner }, V3),
    );
    expect(both.map((row) => row.slackTeamId)).toEqual([
      "T0NOTICEK",
      "T0NOTICEL",
    ]);
    const { rows } = await pool.query(
      "SELECT DISTINCT xmin::text AS xmin FROM receipts WHERE operation = 'approve_slack_notice' AND result->>'notice_version' = '3' AND target_ref->'resource'->>'id' = $1",
      [agentId],
    );
    expect(rows).toHaveLength(1);
    expect((await judgeSlackNotice(db, place, V3)).approved).toBe(true);
  });

  test("with no notice version nobody is approved and an approval is refused", async () => {
    const [ws] = workspaces as [Workspace];
    const agentId = await agent(ws);
    await install(ws, agentId, "T0NOTICEI");
    const place = { workspaceId: ws.id, agentId };
    expect(await judgeSlackNotice(db, place, [])).toEqual({
      approved: false,
      reason: "no_notice",
    });
    expect(
      await approveSlackNotice(db, { ...place, by: ws.admin }, []),
    ).toEqual({ outcome: "no_notice" });
    // The published list is empty until the first notice is written.
    expect(await judgeSlackNotice(db, place)).toEqual({
      approved: false,
      reason: "no_notice",
    });
    expect(await listSlackNoticeApprovals(db, { agentId })).toEqual([]);
  });

  test("a deleted agent is not approved and cannot be approved", async () => {
    const [ws] = workspaces as [Workspace];
    const agentId = await agent(ws);
    await install(ws, agentId, "T0NOTICEJ");
    const place = { workspaceId: ws.id, agentId };
    await approveSlackNotice(db, { ...place, by: ws.admin }, V1);
    await pool.query(
      "UPDATE agents SET status = 'archived', deleted_at = now(), deleted_by = $2 WHERE id = $1",
      [agentId, ws.owner],
    );
    expect(await judgeSlackNotice(db, place, V1)).toEqual({
      approved: false,
      reason: "not_installed",
    });
    expect(
      await approveSlackNotice(db, { ...place, by: ws.admin }, V1),
    ).toEqual({ outcome: "not_found" });
  });
});
