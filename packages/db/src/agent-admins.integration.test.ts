import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  agentCardRequestSchema,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  type ActingOwner,
  type Caller,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  type SessionCatalog,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createDatabaseAgentAuthority } from "./agent-authority.ts";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresWorkspaceKeyStore } from "./api-keys.ts";
import { createPostgresCredentialBindingStore } from "./credential-bindings.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import { createPostgresInviteStore } from "./invites.ts";
import * as schema from "./schema.ts";
import {
  agentAdmins,
  agentReleases,
  agentVersions,
  apiKeys,
  memberships,
  receipts,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
  TEST_RUNTIMES,
  testSessionCatalog,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const AGENT_KEY_ISSUERS: readonly WorkspaceRole[] = ["owner", "admin"];

const CATALOG: SessionCatalog = testSessionCatalog();
const CARD = agentCardRequestSchema.parse({
  role: "재무 분석가",
  instructions: "v1",
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
});

async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    return String((error as { cause?: Error }).cause?.message ?? error);
  }
  return "accepted";
}

integration("agent admins, the admin role and agent keys on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_admins_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const policy = () =>
    createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
      agents: createDatabaseAgentAuthority(db),
    });

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  /** A live team holding `members` as plain members. */
  async function team(workspaceId: string, ...members: Caller[]) {
    const teamId = randomUUID();
    await db.insert(schema.memberTeams).values({
      id: teamId,
      workspaceId,
      name: `team-${teamId.slice(0, 8)}`,
    });
    for (const member of members) {
      await db.insert(schema.memberTeamMembers).values({
        id: randomUUID(),
        workspaceId,
        teamId,
        userId: member.actor?.userId ?? "",
      });
    }
    return teamId;
  }

  function acting(caller: Caller): ActingOwner {
    const userId = caller.actor?.userId;
    if (!userId) throw new Error("no person");
    return { principal: caller, workspaceId: caller.ownerId, userId };
  }

  async function allows(
    caller: Caller,
    action: "agent.manage" | "api_key.manage",
    agentId: string,
  ) {
    const decision = await policy().authorize({
      subject: caller.subject,
      action,
      resource: { kind: "agent", id: agentId, owner_scope: caller.ownerId },
      request_id: caller.requestId,
    });
    return decision.outcome === "allow";
  }

  function agentsService() {
    return createAgentService({
      authorization: policy(),
      store: createPostgresAgentStore(db),
      catalog: CATALOG,
      credentials: createPostgresCredentialBindingStore(db),
      runtimes: TEST_RUNTIMES,
    });
  }

  test("a member who creates an agent administers it and no other (D3)", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const member = await person(workspaceId, "member");
    const other = await person(workspaceId, "member");
    const service = agentsService();

    const mine = await service.createAgent(member, {
      slug: "mine",
      name: "mine",
      managing_team_id: await team(workspaceId, member),
      card: CARD,
    });
    const theirs = await service.createAgent(owner, {
      slug: "theirs",
      name: "theirs",
      managing_team_id: await team(workspaceId),
      card: CARD,
    });
    expect(
      await db
        .select({ userId: agentAdmins.userId })
        .from(agentAdmins)
        .where(eq(agentAdmins.agentId, mine.agent.id)),
    ).toEqual([{ userId: member.actor?.userId ?? "" }]);

    expect(await allows(member, "agent.manage", mine.agent.id)).toBe(true);
    expect(await allows(member, "api_key.manage", mine.agent.id)).toBe(true);
    expect(await allows(member, "agent.manage", theirs.agent.id)).toBe(false);
    expect(await allows(other, "agent.manage", mine.agent.id)).toBe(false);
    // The member edits what they made, through the agent service itself.
    await service.updateAgent(member, mine.agent.id, { name: "renamed" });

    // An admin who leaves the workspace administers nothing.
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, member.actor?.userId ?? ""));
    expect(
      await createDatabaseAgentAuthority(db).isAdmin(
        workspaceId,
        mine.agent.id,
        member.actor?.userId ?? "",
      ),
    ).toBe(false);
  });

  test("an admin names no one owner and leaves owners alone", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const member = await person(workspaceId, "member");
    const store = createPostgresInviteStore(db);
    const change = (by: Caller, target: Caller, role: WorkspaceRole) =>
      store.changeMemberRole({
        userId: target.actor?.userId ?? "",
        role,
        actor: acting(by),
        receiptId: randomUUID(),
      });

    expect(await change(admin, owner, "member")).toEqual({
      outcome: "owner_protected",
    });
    expect(await change(admin, member, "owner")).toEqual({
      outcome: "owner_protected",
    });
    expect(
      await store.createInvite({
        id: randomUUID(),
        actor: acting(admin),
        email: "new-owner@example.invalid",
        role: "owner",
        tokenHash: new Uint8Array(32).fill(7),
        ttlMs: 60_000,
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "owner_protected" });
    expect(await change(admin, member, "admin")).toMatchObject({
      outcome: "changed",
      member: { role: "admin" },
    });
    // An owner may still do all of it.
    expect(await change(owner, member, "owner")).toMatchObject({
      outcome: "changed",
    });
  });

  test("an agent key is a service key of its own workspace's agent", async () => {
    const workspaceId = await workspace();
    const elsewhere = await workspace();
    const owner = await person(workspaceId, "owner");
    const foreignOwner = await person(elsewhere, "owner");
    const agent = await agentsService().createAgent(owner, {
      slug: "bot",
      name: "bot",
      managing_team_id: await team(workspaceId),
      card: CARD,
    });
    const foreign = await agentsService().createAgent(foreignOwner, {
      slug: "bot",
      name: "bot",
      managing_team_id: await team(elsewhere),
      card: CARD,
    });
    const row = (
      agentId: string | null,
      kind: string,
      name: string | null = null,
    ) => ({
      id: randomUUID(),
      keyHash: new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
      ownerId: workspaceId,
      workspaceId,
      scopes: ["sessions:read"],
      kind,
      name,
      createdByUserId: owner.actor?.userId ?? null,
      agentId,
    });
    expect(
      await refusal(db.insert(apiKeys).values(row(agent.agent.id, "personal"))),
    ).toContain("api_keys_agent_check");
    expect(
      await refusal(db.insert(apiKeys).values(row(foreign.agent.id, "agent"))),
    ).toContain("api_keys_agent_fk");
    // No key reaches a whole workspace as itself (94S-929).
    expect(
      await refusal(db.insert(apiKeys).values(row(null, "agent"))),
    ).toContain("api_keys_agent_check");
    expect(
      await refusal(db.insert(apiKeys).values(row(null, "operator"))),
    ).toContain("api_keys_operator_check");
    expect(
      await refusal(db.insert(apiKeys).values(row(null, "service"))),
    ).toContain("api_keys_kind_check");
    for (const name of ["", " ci", "x".repeat(65)]) {
      expect(
        await refusal(
          db.insert(apiKeys).values(row(agent.agent.id, "agent", name)),
        ),
      ).toContain("api_keys_name_check");
    }
    expect(
      await refusal(
        db.insert(apiKeys).values(row(agent.agent.id, "agent", "ci-deploy")),
      ),
    ).toBe("accepted");
  });

  test("keys issued, listed and revoked leave receipts and reach only their agent", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const member = await person(workspaceId, "member");
    const agent = await agentsService().createAgent(member, {
      slug: "bot",
      name: "bot",
      managing_team_id: await team(workspaceId, member),
      card: CARD,
    });
    const other = await agentsService().createAgent(owner, {
      slug: "other",
      name: "other",
      managing_team_id: await team(workspaceId),
      card: CARD,
    });
    const store = createPostgresWorkspaceKeyStore(db);
    const issue = (
      by: Caller,
      kind: "personal" | "agent",
      agentId: string | null,
    ) =>
      store.issue({
        principal: by,
        id: randomUUID(),
        workspaceId,
        keyHash: new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
        kind,
        name: null,
        agentId,
        createdByUserId: by.actor?.userId ?? "",
        scopes: ["sessions:read", "sessions:write"],
        expiresAt: null,
        receiptId: randomUUID(),
        issuerRoles:
          kind === "personal"
            ? ["owner", "admin", "member"]
            : AGENT_KEY_ISSUERS,
      });

    const bound = await issue(member, "agent", agent.agent.id);
    const personal = await issue(member, "personal", null);
    const othersKey = await issue(owner, "agent", other.agent.id);
    if (
      bound.outcome !== "issued" ||
      personal.outcome !== "issued" ||
      othersKey.outcome !== "issued"
    ) {
      throw new Error("issue failed");
    }
    expect(await issue(member, "agent", randomUUID())).toEqual({
      outcome: "agent_not_found",
    });

    const ids = (keys: { id: string }[]) => keys.map((key) => key.id).sort();
    expect(
      ids(
        (
          await store.list(
            workspaceId,
            {
              personalOf: member.actor?.userId ?? "",
              allAgentKeysFor: AGENT_KEY_ISSUERS,
            },
            { limit: 50 },
          )
        ).items,
      ),
    ).toEqual(ids([bound.key, personal.key]));
    expect(
      ids(
        (
          await store.list(
            workspaceId,
            {
              personalOf: owner.actor?.userId ?? "",
              allAgentKeysFor: AGENT_KEY_ISSUERS,
            },
            { limit: 50 },
          )
        ).items,
      ),
    ).toEqual(ids([bound.key, othersKey.key]));

    // The key reaches sessions pinned to its agent's release, no others.
    const [version] = await db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agent.agent.id));
    if (!version) throw new Error("no version");
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId: agent.agent.id,
      versionId: version.id,
      cardSha256: version.contentSha256,
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: [],
    });
    const pinned = randomUUID();
    const bare = randomUUID();
    for (const [id, agentReleaseId] of [
      [pinned, releaseId],
      [bare, null],
    ] as const) {
      await db.insert(sessions).values({
        id,
        ownerId: workspaceId,
        workspaceId,
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
        ...sessionPinColumns(),
        agentReleaseId,
      });
    }
    const keyCaller = callerFor(
      {
        kind: "api_key",
        id: bound.key.id,
        owner_id: workspaceId,
        workspace_id: workspaceId,
        scopes: ["sessions:read", "sessions:write", "sessions:approve"],
      },
      { kind: "api" },
      randomUUID(),
      { creatorId: null },
    );
    const read = async (sessionId: string) =>
      (
        await policy().authorize({
          subject: keyCaller.subject,
          action: "session.read",
          resource: {
            kind: "session",
            id: sessionId,
            owner_scope: workspaceId,
          },
          request_id: keyCaller.requestId,
        })
      ).reason_code;
    expect(await read(pinned)).toBe("ok");
    expect(await read(bare)).toBe("agent_ceiling");
    expect(
      (
        await policy().authorize({
          subject: keyCaller.subject,
          action: "session.submit",
          resource: {
            kind: "session",
            id: null,
            owner_scope: workspaceId,
            agent_id: other.agent.id,
          },
          request_id: keyCaller.requestId,
        })
      ).reason_code,
    ).toBe("agent_ceiling");

    const revoked = await store.revoke({
      principal: member,
      workspaceId,
      keyId: bound.key.id,
      receiptId: randomUUID(),
      revokerRoles: AGENT_KEY_ISSUERS,
    });
    expect(revoked).toMatchObject({ outcome: "revoked" });
    expect(
      await store.revoke({
        principal: member,
        workspaceId,
        keyId: bound.key.id,
        receiptId: randomUUID(),
        revokerRoles: AGENT_KEY_ISSUERS,
      }),
    ).toMatchObject({ outcome: "already_revoked" });
    expect(await read(pinned)).toBe("disabled");

    const written = await db
      .select({
        operation: receipts.operation,
        result: receipts.result,
        requestId: receipts.requestId,
      })
      .from(receipts)
      .where(
        and(
          eq(receipts.ownerId, workspaceId),
          eq(receipts.targetRef, {
            resource: { kind: "api_key", id: bound.key.id },
            workspace_id: workspaceId,
          }),
        ),
      );
    expect(written.map((row) => row.operation).sort()).toEqual([
      "create_api_key",
      "revoke_api_key",
    ]);
    // Joins each receipt to the decision that let it through.
    expect(written.map((row) => row.requestId)).toEqual([
      member.requestId,
      member.requestId,
    ]);
    expect(JSON.stringify(written)).not.toContain("csp_");
  });

  test("a role lowered after the decision stops the key and narrows the list", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const demoted = await person(workspaceId, "owner");
    const userId = demoted.actor?.userId ?? "";
    const agent = await agentsService().createAgent(owner, {
      slug: "bot",
      name: "bot",
      managing_team_id: await team(workspaceId),
      card: CARD,
    });
    const other = await agentsService().createAgent(owner, {
      slug: "other",
      name: "other",
      managing_team_id: await team(workspaceId),
      card: CARD,
    });
    const store = createPostgresWorkspaceKeyStore(db);
    const othersKey = await store.issue({
      principal: owner,
      id: randomUUID(),
      workspaceId,
      keyHash: new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
      kind: "agent",
      name: null,
      agentId: other.agent.id,
      createdByUserId: owner.actor?.userId ?? "",
      scopes: ["sessions:read"],
      expiresAt: null,
      receiptId: randomUUID(),
      issuerRoles: AGENT_KEY_ISSUERS,
    });
    expect(othersKey.outcome).toBe("issued");
    // The policy allowed `demoted` as an owner; the role falls before the write.
    await db
      .update(memberships)
      .set({ role: "member" })
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, userId),
        ),
      );
    const issue = (
      agentId: string,
      scopes: ("sessions:read" | "sessions:recover")[],
    ) =>
      store.issue({
        principal: demoted,
        id: randomUUID(),
        workspaceId,
        keyHash: new Uint8Array(32).map(() => Math.floor(Math.random() * 256)),
        kind: "agent",
        name: null,
        agentId,
        createdByUserId: userId,
        scopes,
        expiresAt: null,
        receiptId: randomUUID(),
        issuerRoles: AGENT_KEY_ISSUERS,
      });
    expect(await issue(other.agent.id, ["sessions:read"])).toEqual({
      outcome: "outranked",
    });
    expect(await issue(agent.agent.id, ["sessions:read"])).toEqual({
      outcome: "outranked",
    });
    // An agent's admin may still issue for it, within a member's scopes.
    await db.insert(agentAdmins).values({
      workspaceId,
      agentId: agent.agent.id,
      userId,
      createdBy: owner.actor?.userId ?? "",
    });
    expect(await issue(agent.agent.id, ["sessions:recover"])).toEqual({
      outcome: "scope_not_grantable",
    });
    const bound = await issue(agent.agent.id, ["sessions:read"]);
    if (bound.outcome !== "issued") throw new Error(bound.outcome);
    expect(
      await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.workspaceId, workspaceId)),
    ).toHaveLength(2);

    const listed = await store.list(
      workspaceId,
      { personalOf: userId, allAgentKeysFor: AGENT_KEY_ISSUERS },
      { limit: 50 },
    );
    expect(listed.items.map((key) => key.id)).toEqual([bound.key.id]);

    if (othersKey.outcome !== "issued") throw new Error("not issued");
    const revoke = (keyId: string) =>
      store.revoke({
        principal: demoted,
        workspaceId,
        keyId,
        receiptId: randomUUID(),
        revokerRoles: AGENT_KEY_ISSUERS,
      });
    expect(await revoke(othersKey.key.id)).toEqual({
      outcome: "outranked",
    });
    expect(await revoke(bound.key.id)).toMatchObject({ outcome: "revoked" });
  });
});
