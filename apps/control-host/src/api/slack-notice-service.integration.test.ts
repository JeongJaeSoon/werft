import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type SlackNoticeVersionEntry,
  scopesForRole,
  slackNoticeVersionSchema,
  type WorkspaceRole,
} from "@werft-ai/contracts";
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
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createSlackNoticeService } from "./slack-notice-service.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const textOf = (words: string) => ({
  body: [words],
  policyLink: { label: "Data", href: "https://docs.example.test/data" },
});
const entry = (
  version: number,
  requiresReapproval: boolean,
): SlackNoticeVersionEntry => ({
  version: slackNoticeVersionSchema.parse(version),
  text: { ko: textOf(`ko ${version}`), ja: textOf(`ja ${version}`) },
  requiresReapproval,
});
const V1 = [entry(1, true)];
/** Version 2 asks for a new approval. */
const V2 = [...V1, entry(2, true)];

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

  const service = (versions: readonly SlackNoticeVersionEntry[]) =>
    createSlackNoticeService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
        agents: createDatabaseAgentAuthority(db),
      }),
      db,
      versions,
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

  test("an owner or admin approves the current version; the record and a receipt with the language shown are written", async () => {
    const ws = await setUp();
    const notices = service(V1);
    const before = await notices.read(ws.admin.caller, ws.agentId);
    expect(before).toMatchObject({
      notice: {
        version: 1,
        requires_reapproval: true,
        text: {
          ko: {
            body: ["ko 1"],
            policy_link: { href: "https://docs.example.test/data" },
          },
          ja: { body: ["ja 1"] },
        },
      },
      state: "not_approved",
      can_approve: true,
      approvals: [],
    });

    const approved = await notices.approve(ws.admin.caller, ws.agentId, {
      notice_version: slackNoticeVersionSchema.parse(1),
      locale: "ja",
    });
    expect(approved.state).toBe("approved");
    expect(approved.approvals).toEqual([
      {
        id: expect.any(String),
        slack_team_id: ws.teamId,
        notice_version: 1,
        counts: true,
        approved_by: {
          user_id: ws.admin.userId,
          display_name: "admin person",
          email: ws.admin.email,
        },
        approved_at: expect.any(String),
      },
    ] as never);
    const rows = await db
      .select()
      .from(slackNoticeApprovals)
      .where(eq(slackNoticeApprovals.agentId, ws.agentId));
    expect(
      rows.map((row) => [row.slackTeamId, row.noticeVersion, row.approvedBy]),
    ).toEqual([[ws.teamId, 1, ws.admin.userId]]);
    const written = await receiptsOf(ws.agentId, "approve_slack_notice");
    expect(written.map((row) => row.result)).toEqual([
      {
        agent_id: ws.agentId,
        approval_id: rows[0]?.id,
        slack_team_id: ws.teamId,
        notice_version: 1,
        notice_locale: "ja",
      },
    ]);

    // The owner approving again writes nothing more.
    expect(
      (
        await notices.approve(ws.owner.caller, ws.agentId, {
          notice_version: slackNoticeVersionSchema.parse(1),
          locale: "ko",
        })
      ).state,
    ).toBe("approved");
    expect(await receiptsOf(ws.agentId, "approve_slack_notice")).toHaveLength(
      1,
    );
  });

  test("the agent's admin reads the notice without the approvers' email and is refused approve and revoke", async () => {
    const ws = await setUp();
    const notices = service(V1);
    await notices.approve(ws.owner.caller, ws.agentId, {
      notice_version: slackNoticeVersionSchema.parse(1),
      locale: "ko",
    });
    const read = await notices.read(ws.agentAdmin.caller, ws.agentId);
    expect(read.can_approve).toBe(false);
    expect(read.state).toBe("approved");
    expect(read.approvals.map((a) => a.approved_by)).toEqual([
      { user_id: ws.owner.userId, display_name: "owner person", email: null },
    ] as never);
    for (const work of [
      () =>
        notices.approve(ws.agentAdmin.caller, ws.agentId, {
          notice_version: slackNoticeVersionSchema.parse(1),
          locale: "ko",
        }),
      // A stale version is still a refusal of the person, not of the version.
      () =>
        notices.approve(ws.agentAdmin.caller, ws.agentId, {
          notice_version: slackNoticeVersionSchema.parse(2),
          locale: "ko",
        }),
      () => notices.revoke(ws.agentAdmin.caller, ws.agentId),
    ]) {
      expect(await refusal(work())).toEqual({
        code: "FORBIDDEN",
        reason: "workspace_admin_required",
      });
    }
    expect((await notices.read(ws.owner.caller, ws.agentId)).state).toBe(
      "approved",
    );
  });

  test("another workspace's agent is not found, and an API key is refused", async () => {
    const ws = await setUp();
    const other = await setUp();
    const notices = service(V1);
    for (const work of [
      () => notices.read(other.owner.caller, ws.agentId),
      () =>
        notices.approve(other.owner.caller, ws.agentId, {
          notice_version: slackNoticeVersionSchema.parse(1),
          locale: "ko",
        }),
      () => notices.revoke(other.owner.caller, ws.agentId),
    ]) {
      expect((await refusal(work())).code).toBe("NOT_FOUND");
    }
    const viaKey = await person(ws.workspaceId, "owner", "api");
    expect(await refusal(notices.read(viaKey.caller, ws.agentId))).toEqual({
      code: "FORBIDDEN",
      reason: "web_session_required",
    });
    expect(
      await db
        .select()
        .from(slackNoticeApprovals)
        .where(eq(slackNoticeApprovals.agentId, ws.agentId)),
    ).toEqual([]);
  });

  test("a revoke leaves no approval and writes a receipt", async () => {
    const ws = await setUp();
    const notices = service(V1);
    await notices.approve(ws.admin.caller, ws.agentId, {
      notice_version: slackNoticeVersionSchema.parse(1),
      locale: "ko",
    });
    const revoked = await notices.revoke(ws.owner.caller, ws.agentId);
    expect(revoked).toMatchObject({ state: "not_approved", approvals: [] });
    const written = await receiptsOf(ws.agentId, "revoke_slack_notice");
    expect(written).toHaveLength(1);
    expect(written[0]?.result).toMatchObject({
      agent_id: ws.agentId,
      slack_team_ids: [ws.teamId],
      notice_versions: [1],
    });
    // Nothing live: a second revoke writes nothing.
    await notices.revoke(ws.owner.caller, ws.agentId);
    expect(await receiptsOf(ws.agentId, "revoke_slack_notice")).toHaveLength(1);
  });

  test("a version that asks anew shows the old approval as not counting until it is given", async () => {
    const ws = await setUp();
    await service(V1).approve(ws.admin.caller, ws.agentId, {
      notice_version: slackNoticeVersionSchema.parse(1),
      locale: "ko",
    });
    const notices = service(V2);
    const read = await notices.read(ws.admin.caller, ws.agentId);
    expect(read.state).toBe("reapproval_required");
    expect(read.notice?.version).toBe(2 as never);
    expect(read.approvals.map((a) => [a.notice_version, a.counts])).toEqual([
      [1, false],
    ] as never);
    expect(
      await refusal(
        notices.approve(ws.admin.caller, ws.agentId, {
          notice_version: slackNoticeVersionSchema.parse(1),
          locale: "ko",
        }),
      ),
    ).toEqual({ code: "REVISION_CONFLICT", reason: "notice_version_stale" });
    const again = await notices.approve(ws.admin.caller, ws.agentId, {
      notice_version: slackNoticeVersionSchema.parse(2),
      locale: "ko",
    });
    expect(again.state).toBe("approved");
    expect(again.approvals.map((a) => [a.notice_version, a.counts])).toEqual([
      [2, true],
      [1, false],
    ] as never);
  });

  test("before a version is published the notice is null and approve is refused", async () => {
    const ws = await setUp();
    const notices = service([]);
    expect(await notices.read(ws.owner.caller, ws.agentId)).toEqual({
      notice: null,
      state: "no_notice",
      can_approve: true,
      approvals: [],
    });
    expect(
      await refusal(
        notices.approve(ws.owner.caller, ws.agentId, {
          notice_version: slackNoticeVersionSchema.parse(1),
          locale: "ko",
        }),
      ),
    ).toEqual({ code: "REVISION_CONFLICT", reason: "no_notice" });
    expect(
      await refusal(
        notices.approve(ws.agentAdmin.caller, ws.agentId, {
          notice_version: slackNoticeVersionSchema.parse(1),
          locale: "ko",
        }),
      ),
    ).toEqual({ code: "FORBIDDEN", reason: "workspace_admin_required" });
  });

  test("an agent without a live Slack install cannot be approved", async () => {
    const ws = await setUp();
    await db
      .update(agentIdentities)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(and(eq(agentIdentities.agentId, ws.agentId)));
    const notices = service(V1);
    expect((await notices.read(ws.owner.caller, ws.agentId)).state).toBe(
      "not_installed",
    );
    expect(
      (
        await refusal(
          notices.approve(ws.owner.caller, ws.agentId, {
            notice_version: slackNoticeVersionSchema.parse(1),
            locale: "ko",
          }),
        )
      ).code,
    ).toBe("SLACK_NOT_INSTALLED");
  });
});
