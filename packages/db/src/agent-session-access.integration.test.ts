import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import { type Caller, callerFor, type SessionViewer } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { lockSessionReach, type Requester } from "./requester-locks.ts";
import * as schema from "./schema.ts";
import {
  agentAdmins,
  agentReleases,
  agents,
  agentVersions,
  apiKeys,
  memberships,
  memberTeamMembers,
  memberTeams,
  receipts,
  sessionShares,
  sessionShareTargets,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { createPostgresSessionShareStore } from "./session-shares.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { createPostgresAgentAccessSetting } from "./workspace-settings.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// agent-rbac (b)(c): axis A (agent_outsider_access) and axis B
// (agent_outsider_session_visibility), judged where the data is.
integration("agent access settings on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_session_access_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const shares = () => createPostgresSessionShareStore(db);
  const settings = () => createPostgresAgentAccessSetting(db);

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function person(workspaceId: string, role: WorkspaceRole = "member") {
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

  const idOf = (caller: Caller) => caller.actor?.userId ?? "";
  const viewer = (caller: Caller): SessionViewer => ({
    userId: idOf(caller),
    apiKeyId: null,
    keyAgentId: null,
  });

  async function team(
    workspaceId: string,
    members: { caller: Caller; role?: "lead" | "member" }[],
  ) {
    const teamId = randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: `team-${teamId}` });
    for (const { caller, role } of members) {
      await db.insert(memberTeamMembers).values({
        id: randomUUID(),
        workspaceId,
        teamId,
        userId: idOf(caller),
        role: role ?? "member",
      });
    }
    return teamId;
  }

  // An agent with one release, managed by the team given or else by the
  // workspace's fixture team, which no one is in.
  async function agent(workspaceId: string, managingTeamId?: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
      managingTeamId: managingTeamId ?? (await fixtureTeam(db, workspaceId)),
    });
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card: {
        role: "r",
        instructions: "i",
        model: "m",
        capabilities: { tools: [], mcp: null, forbidden: [] },
      },
      contentSha256: "0".repeat(64),
    });
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "0".repeat(64),
      runtimeProfileId: "coding",
      profileDigest: "digest",
      runtimeConfigSnapshot: {},
      effectiveTools: [],
    });
    return { agentId, releaseId };
  }

  async function session(
    workspaceId: string,
    creator: Caller,
    releaseId: string | null,
  ) {
    const id = randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/repo.git",
      branch: "main",
      agentReleaseId: releaseId,
      createdByUserId: idOf(creator),
    });
    return id;
  }

  async function key(
    workspaceId: string,
    owner: { agentId: string } | { creator: Caller },
  ) {
    const id = randomUUID();
    await db.insert(apiKeys).values({
      id,
      keyHash: Buffer.from(randomUUID()),
      ownerId: workspaceId,
      workspaceId,
      ...("agentId" in owner
        ? { kind: "agent", agentId: owner.agentId }
        : { kind: "personal", createdByUserId: idOf(owner.creator) }),
      scopes: ["sessions:read"],
    });
    return id;
  }

  function setVisibility(
    workspaceId: string,
    value: "managing_team" | "workspace",
  ) {
    return db
      .update(workspaces)
      .set({
        settings: sql`${workspaces.settings} || jsonb_build_object('agent_outsider_session_visibility', ${value}::text)`,
      })
      .where(eq(workspaces.id, workspaceId));
  }

  function setAccess(workspaceId: string, value: "use" | "view" | "none") {
    return db
      .update(workspaces)
      .set({
        settings: sql`${workspaces.settings} || jsonb_build_object('agent_outsider_access', ${value}::text)`,
      })
      .where(eq(workspaces.id, workspaceId));
  }

  const sees = (workspaceId: string, sessionId: string, who: SessionViewer) =>
    shares().visibleTo(workspaceId, sessionId, who);

  // The write-side re-check, as an input or an answer takes it.
  async function reaches(
    workspaceId: string,
    sessionId: string,
    who: SessionViewer,
    role: WorkspaceRole | null,
  ) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .for("update");
      if (row?.workspaceId !== workspaceId) throw new Error("no session");
      const requester: Requester = {
        userId: who.userId,
        apiKeyId: who.apiKeyId,
        role,
        keyAgentId: who.keyAgentId ?? null,
      };
      return lockSessionReach(tx, requester, {
        id: row.id,
        workspaceId: row.workspaceId,
        createdByUserId: row.createdByUserId,
        createdByApiKeyId: row.createdByApiKeyId,
        agentReleaseId: row.agentReleaseId,
      });
    });
  }

  // Every subject of the design's table, plus a member holding the session.
  async function cast() {
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const lead = await person(ws);
    const member = await person(ws);
    const admin = await person(ws);
    const outsider = await person(ws);
    const holder = await person(ws);
    const managing = await team(ws, [
      { caller: lead, role: "lead" },
      { caller: member },
    ]);
    const { agentId, releaseId } = await agent(ws);
    await db
      .insert(agentAdmins)
      .values({ workspaceId: ws, agentId, userId: idOf(admin) });
    const id = await session(ws, holder, releaseId);
    return {
      ws,
      owner,
      lead,
      member,
      admin,
      outsider,
      holder,
      managing,
      agentId,
      releaseId,
      id,
    };
  }

  async function whoSees(
    c: Awaited<ReturnType<typeof cast>>,
    sessionId = c.id,
  ) {
    const got: Record<string, boolean> = {};
    for (const name of [
      "owner",
      "lead",
      "member",
      "admin",
      "outsider",
      "holder",
    ] as const) {
      got[name] = await sees(c.ws, sessionId, viewer(c[name]));
    }
    return got;
  }

  const everyone = {
    owner: true,
    lead: true,
    member: true,
    admin: true,
    outsider: true,
    holder: true,
  };
  const insideOnly = { ...everyone, outsider: false };

  test("naming a managing team takes the agent's workspace sessions, old ones too, from those outside it", async () => {
    const c = await cast();
    // The holder is outside the agent too, yet keeps their own session.
    await db
      .update(agents)
      .set({ managingTeamId: c.managing })
      .where(eq(agents.id, c.agentId));
    expect(await whoSees(c)).toEqual(insideOnly);
    expect(await shares().get(c.ws, c.id)).toMatchObject({
      scope: "workspace",
      audienceLimited: true,
    });
    expect(await reaches(c.ws, c.id, viewer(c.outsider), "member")).toBe(
      "not_found",
    );
    for (const name of ["lead", "member", "admin", "holder"] as const) {
      expect(await reaches(c.ws, c.id, viewer(c[name]), "member"), name).toBe(
        "ok",
      );
    }
    expect(await reaches(c.ws, c.id, viewer(c.owner), "owner")).toBe("ok");
    // A session with no agent is not limited.
    const plain = await session(c.ws, c.holder, null);
    expect(await sees(c.ws, plain, viewer(c.outsider))).toBe(true);
  });

  test("a people or team share still reaches those it names outside the agent", async () => {
    const c = await cast();
    await db
      .update(agents)
      .set({ managingTeamId: c.managing })
      .where(eq(agents.id, c.agentId));
    const shareWith = async (
      scope: "people" | "team",
      target: { userId?: string; teamId?: string },
    ) => {
      const result = await shares().set({
        principal: c.holder,
        ownerId: c.ws,
        workspaceId: c.ws,
        sessionId: c.id,
        scope,
        userIds: target.userId ? [target.userId] : [],
        teamIds: target.teamId ? [target.teamId] : [],
        updatedBy: idOf(c.holder),
        receiptId: randomUUID(),
      });
      expect(result.outcome).toBe("changed");
    };
    await shareWith("people", { userId: idOf(c.outsider) });
    expect(await sees(c.ws, c.id, viewer(c.outsider))).toBe(true);
    expect(await reaches(c.ws, c.id, viewer(c.outsider), "member")).toBe("ok");
    const theirs = await team(c.ws, [{ caller: c.outsider }]);
    await shareWith("team", { teamId: theirs });
    expect(await sees(c.ws, c.id, viewer(c.outsider))).toBe(true);
    expect(await reaches(c.ws, c.id, viewer(c.outsider), "member")).toBe("ok");
    // Not named, and the share is no longer workspace-wide: the managing
    // team's member is out too, as before axis B.
    expect(await sees(c.ws, c.id, viewer(c.member))).toBe(false);
    expect(await shares().get(c.ws, c.id)).toMatchObject({
      scope: "team",
      audienceLimited: true,
    });
  });

  test("moving the managing team moves who sees the sessions at once", async () => {
    const c = await cast();
    const newcomer = await person(c.ws);
    const next = await team(c.ws, [{ caller: newcomer }]);
    await db
      .update(agents)
      .set({ managingTeamId: c.managing })
      .where(eq(agents.id, c.agentId));
    expect(await sees(c.ws, c.id, viewer(c.member))).toBe(true);
    expect(await sees(c.ws, c.id, viewer(newcomer))).toBe(false);
    await db
      .update(agents)
      .set({ managingTeamId: next })
      .where(eq(agents.id, c.agentId));
    expect(await sees(c.ws, c.id, viewer(c.member))).toBe(false);
    expect(await sees(c.ws, c.id, viewer(c.lead))).toBe(false);
    expect(await sees(c.ws, c.id, viewer(newcomer))).toBe(true);
    expect(await reaches(c.ws, c.id, viewer(c.member), "member")).toBe(
      "not_found",
    );
    expect(await reaches(c.ws, c.id, viewer(newcomer), "member")).toBe("ok");
  });

  test("axis B workspace gives the sessions back to everyone, and managing_team takes them again", async () => {
    const c = await cast();
    await db
      .update(agents)
      .set({ managingTeamId: c.managing })
      .where(eq(agents.id, c.agentId));
    await setVisibility(c.ws, "workspace");
    expect(await whoSees(c)).toEqual(everyone);
    expect(await shares().get(c.ws, c.id)).toMatchObject({
      audienceLimited: false,
    });
    expect(await reaches(c.ws, c.id, viewer(c.outsider), "member")).toBe("ok");
    await setVisibility(c.ws, "managing_team");
    expect(await whoSees(c)).toEqual(insideOnly);
    // A value no write stores keeps them inside (fail-closed).
    await db
      .update(workspaces)
      .set({
        settings: sql`${workspaces.settings} || '{"agent_outsider_session_visibility": "everyone"}'::jsonb`,
      })
      .where(eq(workspaces.id, c.ws));
    expect(await whoSees(c)).toEqual(insideOnly);
    expect(await reaches(c.ws, c.id, viewer(c.outsider), "member")).toBe(
      "not_found",
    );
  });

  test("a member leaving the managing team loses the sessions at the next read", async () => {
    const c = await cast();
    await db
      .update(agents)
      .set({ managingTeamId: c.managing })
      .where(eq(agents.id, c.agentId));
    expect(await sees(c.ws, c.id, viewer(c.member))).toBe(true);
    await db
      .update(memberTeamMembers)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(memberTeamMembers.teamId, c.managing),
          eq(memberTeamMembers.userId, idOf(c.member)),
        ),
      );
    expect(await sees(c.ws, c.id, viewer(c.member))).toBe(false);
    expect(await reaches(c.ws, c.id, viewer(c.member), "member")).toBe(
      "not_found",
    );
  });

  test("an agent key is inside its own agent only; a personal key reads as its creator", async () => {
    const c = await cast();
    await db
      .update(agents)
      .set({ managingTeamId: c.managing })
      .where(eq(agents.id, c.agentId));
    const other = await agent(c.ws, c.managing);
    const own = await key(c.ws, { agentId: c.agentId });
    const foreign = await key(c.ws, { agentId: other.agentId });
    const asKey = (apiKeyId: string, keyAgentId: string): SessionViewer => ({
      userId: null,
      apiKeyId,
      keyAgentId,
    });
    expect(await sees(c.ws, c.id, asKey(own, c.agentId))).toBe(true);
    expect(await sees(c.ws, c.id, asKey(foreign, other.agentId))).toBe(false);
    expect(
      await sees(c.ws, c.id, { userId: null, apiKeyId: own, keyAgentId: null }),
    ).toBe(false);
    expect(await reaches(c.ws, c.id, asKey(own, c.agentId), null)).toBe("ok");
    expect(await reaches(c.ws, c.id, asKey(foreign, other.agentId), null)).toBe(
      "not_found",
    );
    const creatorKey = async (caller: Caller): Promise<SessionViewer> => ({
      userId: idOf(caller),
      apiKeyId: await key(c.ws, { creator: caller }),
      keyAgentId: null,
    });
    expect(await sees(c.ws, c.id, await creatorKey(c.member))).toBe(true);
    expect(await sees(c.ws, c.id, await creatorKey(c.outsider))).toBe(false);
  });

  describe("axis A in the session's create", () => {
    const inputs = () => createPostgresSessionUnitOfWork(db);
    const create = (caller: Caller, releaseId: string) =>
      inputs().acceptInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: caller,
        idempotencyKey: randomUUID(),
        payloadHash: randomUUID(),
        profileId: "coding",
        repository: "none",
        agentReleaseId: releaseId,
        message: "hello",
      });

    test("view and none refuse those outside the agent; use and those inside start", async () => {
      const c = await cast();
      await db
        .update(agents)
        .set({ managingTeamId: c.managing })
        .where(eq(agents.id, c.agentId));
      for (const access of ["view", "none"] as const) {
        await setAccess(c.ws, access);
        expect((await create(c.outsider, c.releaseId)).outcome, access).toBe(
          "agent_use_refused",
        );
        for (const name of ["owner", "lead", "member", "admin"] as const) {
          expect(
            (await create(c[name], c.releaseId)).outcome,
            `${access} ${name}`,
          ).toBe("accepted");
        }
      }
      await setAccess(c.ws, "use");
      expect((await create(c.outsider, c.releaseId)).outcome).toBe("accepted");
      // An agent whose managing team has no one in it: only W and L are inside.
      const bare = await agent(c.ws);
      await setAccess(c.ws, "view");
      expect((await create(c.member, bare.releaseId)).outcome).toBe(
        "agent_use_refused",
      );
      expect((await create(c.owner, bare.releaseId)).outcome).toBe("accepted");
    });

    test("a create waits for a settings change in flight and is judged on what it committed", async () => {
      const c = await cast();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE",
          [c.ws],
        );
        await client.query(
          `UPDATE workspaces SET settings = settings || '{"agent_outsider_access": "view"}'::jsonb WHERE id = $1`,
          [c.ws],
        );
        let settled = false;
        const creating = create(c.outsider, c.releaseId).finally(() => {
          settled = true;
        });
        await Bun.sleep(300);
        expect(settled).toBe(false);
        await client.query("COMMIT");
        expect((await creating).outcome).toBe("agent_use_refused");
      } finally {
        client.release();
      }
      const made = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.agentReleaseId, c.releaseId));
      // Only the session cast() wrote.
      expect(made).toHaveLength(1);
    });

    test("a settings change waits for a create in flight", async () => {
      const c = await cast();
      const owner = c.owner;
      let settled = false;
      let changing: Promise<unknown> = Promise.resolve();
      await db.transaction(async (tx) => {
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, c.ws))
          .for("key share");
        changing = settings()
          .setAgentAccess({
            principal: owner,
            workspaceId: c.ws,
            actorUserId: idOf(owner),
            settings: { agent_outsider_access: "none" },
            receiptId: randomUUID(),
          })
          .finally(() => {
            settled = true;
          });
        await Bun.sleep(300);
        expect(settled).toBe(false);
      });
      expect(await changing).toMatchObject({ outcome: "set" });
    });
  });

  describe("the settings store", () => {
    test("a change writes the keys asked for and a receipt of what changed; asking again changes nothing", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      expect(await settings().access(ws)).toBe("use");
      const receiptId = randomUUID();
      expect(
        await settings().setAgentAccess({
          principal: owner,
          workspaceId: ws,
          actorUserId: idOf(owner),
          settings: { agent_outsider_access: "view" },
          receiptId,
        }),
      ).toEqual({
        outcome: "set",
        settings: {
          agent_outsider_access: "view",
          agent_outsider_session_visibility: "managing_team",
        },
      });
      expect(await settings().access(ws)).toBe("view");
      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, receiptId));
      expect(receipt).toMatchObject({
        operation: "set_agent_access_settings",
        targetRef: { resource: { kind: "workspace", id: ws } },
        result: {
          from: { agent_outsider_access: "use" },
          to: { agent_outsider_access: "view" },
        },
      });
      const again = randomUUID();
      expect(
        await settings().setAgentAccess({
          principal: owner,
          workspaceId: ws,
          actorUserId: idOf(owner),
          settings: {
            agent_outsider_access: "view",
            agent_outsider_session_visibility: "managing_team",
          },
          receiptId: again,
        }),
      ).toMatchObject({ outcome: "unchanged" });
      expect(
        await db.select().from(receipts).where(eq(receipts.id, again)),
      ).toEqual([]);
      const [row] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, ws));
      // Only the key that changed is stored; the other stays its default.
      expect(row?.settings).toEqual({ agent_outsider_access: "view" });
    });

    test("a member, or an admin disabled since, writes nothing", async () => {
      const ws = await workspace();
      const member = await person(ws);
      const admin = await person(ws, "admin");
      await db
        .update(memberships)
        .set({ disabledAt: new Date() })
        .where(eq(memberships.userId, idOf(admin)));
      for (const actor of [member, admin]) {
        expect(
          await settings().setAgentAccess({
            principal: actor,
            workspaceId: ws,
            actorUserId: idOf(actor),
            settings: { agent_outsider_access: "none" },
            receiptId: randomUUID(),
          }),
        ).toEqual({ outcome: "inactive" });
      }
      expect(await settings().access(ws)).toBe("use");
    });

    test("a stored value no write makes hides agents (fail-closed)", async () => {
      const ws = await workspace();
      await db
        .update(workspaces)
        .set({ settings: { agent_outsider_access: "everyone" } })
        .where(eq(workspaces.id, ws));
      expect(await settings().access(ws)).toBe("none");
      await db
        .update(workspaces)
        .set({ settings: { agent_outsider_access: null } })
        .where(eq(workspaces.id, ws));
      expect(await settings().access(ws)).toBe("none");
      await db
        .update(workspaces)
        .set({ settings: {} })
        .where(eq(workspaces.id, ws));
      expect(await settings().access(ws)).toBe("use");
    });
  });

  test("session shares and targets are untouched by axis B", async () => {
    const c = await cast();
    await db
      .update(agents)
      .set({ managingTeamId: c.managing })
      .where(eq(agents.id, c.agentId));
    await setVisibility(c.ws, "workspace");
    await setVisibility(c.ws, "managing_team");
    expect(
      await db
        .select()
        .from(sessionShares)
        .where(eq(sessionShares.sessionId, c.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(sessionShareTargets)
        .where(eq(sessionShareTargets.sessionId, c.id)),
    ).toEqual([]);
  });
});
