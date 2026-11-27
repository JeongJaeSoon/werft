import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentAdmins,
  agentIdentities,
  agents,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  memberships,
  receipts,
  slackInstallations,
  slackNoticeApprovals,
  users,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  SessionServiceError,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createSlackNoticeService } from "./slack-notice-service.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

async function refusal(work: Promise<unknown>) {
  const error = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof SessionServiceError))
    throw error ?? new Error("no refusal");
  return {
    code: error.code,
    reason: (error.details as { reason_code?: string } | undefined)
      ?.reason_code,
  };
}

integration("Slack notice service on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_notice_svc" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const service = () =>
    createSlackNoticeService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
        agents: createDatabaseAgentAuthority(db),
      }),
      db,
    });

  async function person(
    workspaceId: string,
    role: WorkspaceRole,
    surface: "web" | "api" = "web",
  ): Promise<{ userId: string; email: string; caller: Caller }> {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    await db
      .insert(users)
      .values({ id: userId, email, displayName: `${role} person` });
    await db.insert(memberships).values({ workspaceId, userId, role });
    const caller = callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: surface },
      randomUUID(),
    );
    return { userId, email, caller };
  }

  /** A workspace with an owner, an admin, and an agent installed in one Slack team. */
  async function setUp() {
    const workspaceId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      name: "Acme",
    });
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const agentAdmin = await person(workspaceId, "member");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "Notes",
    });
    await db
      .insert(agentAdmins)
      .values({ workspaceId, agentId, userId: agentAdmin.userId });
    const installationId = randomUUID();
    const teamId = `T${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    await db.insert(slackInstallations).values({
      id: installationId,
      workspaceId,
      appId: `A${teamId.slice(1)}`,
      teamId,
    });
    await db.insert(agentIdentities).values({
      id: randomUUID(),
      workspaceId,
      agentId,
      provider: "slack_bot",
      installationId,
      externalPrincipalId: `U${teamId.slice(1)}`,
      credentialRef: `slack/${agentId}`,
    });
    return { workspaceId, agentId, teamId, owner, admin, agentAdmin };
  }

  const receiptsOf = (agentId: string, operation: string) =>
    db
      .select({ result: receipts.result, actor: receipts.actor })
      .from(receipts)
      .where(eq(receipts.operation, operation))
      .orderBy(asc(receipts.createdAt))
      .then((rows) =>
        rows.filter(
          (row) => (row.result as { agent_id?: string }).agent_id === agentId,
        ),
      );

  /** An approval row as the retired approval left it; nothing reads it now. */
  const storedApproval = (
    ws: Awaited<ReturnType<typeof setUp>>,
    revoked: boolean,
  ) =>
    db.insert(slackNoticeApprovals).values({
      id: randomUUID(),
      workspaceId: ws.workspaceId,
      agentId: ws.agentId,
      slackTeamId: ws.teamId,
      noticeVersion: 1,
      approvedBy: ws.admin.userId,
      ...(revoked ? { revokedAt: new Date(), revokedBy: ws.admin.userId } : {}),
    });

  const approvalRows = (agentId: string) =>
    db
      .select()
      .from(slackNoticeApprovals)
      .where(eq(slackNoticeApprovals.agentId, agentId));

  test("read answers the switch, with the retired notice fields empty whatever rows are stored", async () => {
    const ws = await setUp();
    const notices = service();
    const empty = {
      notice: null,
      state: "no_notice" as const,
      rollout: "off" as const,
      approvals: [],
    };
    expect(await notices.read(ws.admin.caller, ws.agentId)).toEqual({
      ...empty,
      can_approve: true,
    });
    await storedApproval(ws, false);
    expect(await notices.read(ws.owner.caller, ws.agentId)).toEqual({
      ...empty,
      can_approve: true,
    });
    expect(await notices.read(ws.agentAdmin.caller, ws.agentId)).toEqual({
      ...empty,
      can_approve: false,
    });
  });

  test("approve and revoke are retired: 410, nothing written, stored rows untouched", async () => {
    const ws = await setUp();
    await storedApproval(ws, false);
    const before = await approvalRows(ws.agentId);
    const notices = service();
    // Whoever calls: the route asks the service before reading any caller.
    expect(
      await refusal(Promise.resolve().then(() => notices.retired())),
    ).toEqual({ code: "ENDPOINT_RETIRED", reason: "slack_notice_retired" });
    expect(await approvalRows(ws.agentId)).toEqual(before);
    expect(await receiptsOf(ws.agentId, "approve_slack_notice")).toEqual([]);
    expect(await receiptsOf(ws.agentId, "revoke_slack_notice")).toEqual([]);
  });

  test("an owner or admin raises the switch to shadow with no approval and no Slack install; on is refused", async () => {
    const ws = await setUp();
    await db
      .update(agentIdentities)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(agentIdentities.agentId, ws.agentId));
    const notices = service();
    expect(
      await refusal(
        notices.setRollout(ws.admin.caller, ws.agentId, { rollout: "on" }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "rollout_on_unavailable" });
    expect(await receiptsOf(ws.agentId, "set_conversation_rollout")).toEqual(
      [],
    );

    const raised = await notices.setRollout(ws.admin.caller, ws.agentId, {
      rollout: "shadow",
    });
    expect(raised).toMatchObject({ rollout: "shadow", state: "no_notice" });
    expect((await notices.read(ws.agentAdmin.caller, ws.agentId)).rollout).toBe(
      "shadow",
    );
    expect(
      await refusal(
        notices.setRollout(ws.owner.caller, ws.agentId, { rollout: "on" }),
      ),
    ).toEqual({ code: "BAD_REQUEST", reason: "rollout_on_unavailable" });
    await notices.setRollout(ws.owner.caller, ws.agentId, {
      rollout: "shadow",
    });
    expect(await receiptsOf(ws.agentId, "set_conversation_rollout")).toEqual([
      {
        result: {
          agent_id: ws.agentId,
          before: "off",
          after: "shadow",
          by: "web",
          reason: null,
          buffered_dropped: 0,
        },
        actor: {
          principal: { kind: "user", id: ws.admin.userId },
          actor_user_id: ws.admin.userId,
          agent_id: null,
        },
      },
    ]);
    const lowered = await notices.setRollout(ws.owner.caller, ws.agentId, {
      rollout: "off",
    });
    expect(lowered.rollout).toBe("off");
  });

  test("a revoked approval from before does not refuse a raise", async () => {
    const ws = await setUp();
    await storedApproval(ws, true);
    const notices = service();
    expect(
      (
        await notices.setRollout(ws.owner.caller, ws.agentId, {
          rollout: "shadow",
        })
      ).rollout,
    ).toBe("shadow");
    expect((await notices.read(ws.owner.caller, ws.agentId)).rollout).toBe(
      "shadow",
    );
  });

  test("the agent's admin may not change the switch, another workspace's agent is not found, and an API key is refused", async () => {
    const ws = await setUp();
    const other = await setUp();
    const notices = service();
    for (const rollout of ["shadow", "off"] as const) {
      expect(
        await refusal(
          notices.setRollout(ws.agentAdmin.caller, ws.agentId, { rollout }),
        ),
      ).toEqual({ code: "FORBIDDEN", reason: "workspace_admin_required" });
    }
    for (const work of [
      () => notices.read(other.owner.caller, ws.agentId),
      () =>
        notices.setRollout(other.owner.caller, ws.agentId, {
          rollout: "shadow",
        }),
    ]) {
      expect((await refusal(work())).code).toBe("NOT_FOUND");
    }
    const viaKey = await person(ws.workspaceId, "owner", "api");
    for (const work of [
      () => notices.read(viaKey.caller, ws.agentId),
      () =>
        notices.setRollout(viaKey.caller, ws.agentId, { rollout: "shadow" }),
    ]) {
      expect(await refusal(work())).toEqual({
        code: "FORBIDDEN",
        reason: "web_session_required",
      });
    }
    expect((await notices.read(ws.owner.caller, ws.agentId)).rollout).toBe(
      "off",
    );
    expect(await receiptsOf(ws.agentId, "set_conversation_rollout")).toEqual(
      [],
    );
  });
});
