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
import { createPostgresSessionShareStore } from "./access-control/session-shares.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
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
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import {
  lockSessionReach,
  type Requester,
} from "./sessions/requester-locks.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// agent-rbac (b)(c): only those inside an agent start it or see its
// workspace-wide sessions, judged where the data is. A workspace may still
// hold the retired agent_outsider_* settings; nothing reads them.
integration("agent access on PostgreSQL", () => {
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
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: [],
    });
    await db
      .update(agents)
      .set({ activeReleaseId: releaseId, activationRevision: 0 })
      .where(eq(agents.id, agentId));
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
      ...sessionPinColumns(),
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

  // The retired settings, as a workspace from before may still hold them.
  function setVisibility(workspaceId: string, value: string) {
    return db
      .update(workspaces)
      .set({
        settings: sql`${workspaces.settings} || jsonb_build_object('agent_outsider_session_visibility', ${value}::text)`,
      })
      .where(eq(workspaces.id, workspaceId));
  }

  function setAccess(workspaceId: string, value: string) {
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
        slackBotUserId: null,
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

  /** The session's agent as `who` reads it in the list, the detail and the filter. */
  async function agentShown(
    workspaceId: string,
    sessionId: string,
    agentId: string,
    who: SessionViewer,
  ) {
    const reader = createPostgresSessionReader(db);
    const listed = (
      await reader.listSessions(workspaceId, { limit: 100 }, who)
    ).items.find((item) => item.id === sessionId);
    const detail = await reader.getSession(workspaceId, sessionId, who);
    const filtered = (
      await reader.listSessions(
        workspaceId,
        { limit: 100, agent_id: agentId },
        who,
      )
    ).items.map((item) => item.id);
    return {
      listed: listed?.agent?.id ?? null,
      detail: detail?.agent?.id ?? null,
      hidden: [listed?.agent_hidden, detail?.agent_hidden],
      filtered,
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

  test("the holding team of 0243 keeps its agents' workspace sessions as visible as before, until they move to a real team", async () => {
    const c = await cast();
    const holding = randomUUID();
    await db.insert(memberTeams).values({
      id: holding,
      workspaceId: c.ws,
      name: "Unassigned agents",
      holdsUnassigned: true,
    });
    await db
      .update(agents)
      .set({ managingTeamId: holding })
      .where(eq(agents.id, c.agentId));
    expect(await whoSees(c)).toEqual(everyone);
    expect(await shares().get(c.ws, c.id)).toMatchObject({
      scope: "workspace",
      audienceLimited: false,
    });
    expect(await reaches(c.ws, c.id, viewer(c.outsider), "member")).toBe("ok");
    // The agent's name goes with the session to everyone who sees it, in the
    // list, the detail and the list's agent filter alike.
    expect(await agentShown(c.ws, c.id, c.agentId, viewer(c.outsider))).toEqual(
      {
        listed: c.agentId,
        detail: c.agentId,
        hidden: [false, false],
        filtered: [c.id],
      },
    );

    await db
      .update(agents)
      .set({ managingTeamId: c.managing })
      .where(eq(agents.id, c.agentId));
    expect(await whoSees(c)).toEqual(insideOnly);
    expect(await shares().get(c.ws, c.id)).toMatchObject({
      audienceLimited: true,
    });
    expect(await reaches(c.ws, c.id, viewer(c.outsider), "member")).toBe(
      "not_found",
    );
    // Shared to them by name, the session reaches them again, but a managed
    // agent's name does not (#1801).
    expect(
      (
        await shares().set({
          principal: c.holder,
          ownerId: c.ws,
          workspaceId: c.ws,
          sessionId: c.id,
          scope: "people",
          userIds: [idOf(c.outsider)],
          teamIds: [],
          updatedBy: idOf(c.holder),
          receiptId: randomUUID(),
        })
      ).outcome,
    ).toBe("changed");
    expect(await agentShown(c.ws, c.id, c.agentId, viewer(c.outsider))).toEqual(
      {
        listed: null,
        detail: null,
        hidden: [true, true],
        filtered: [],
      },
    );
  });

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

  test("a stored retired visibility setting gives no session back to those outside the agent", async () => {
    const c = await cast();
    await db
      .update(agents)
      .set({ managingTeamId: c.managing })
      .where(eq(agents.id, c.agentId));
    for (const value of ["workspace", "managing_team", "everyone"]) {
      await setVisibility(c.ws, value);
      expect(await whoSees(c), value).toEqual(insideOnly);
      expect(await shares().get(c.ws, c.id)).toMatchObject({
        audienceLimited: true,
      });
      expect(await reaches(c.ws, c.id, viewer(c.outsider), "member")).toBe(
        "not_found",
      );
      expect(await reaches(c.ws, c.id, viewer(c.owner), "owner")).toBe("ok");
      expect(await reaches(c.ws, c.id, viewer(c.admin), "member")).toBe("ok");
    }
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

  describe("who the session's create lets start the agent", () => {
    const inputs = () => createPostgresSessionUnitOfWork(db);
    const create = (caller: Caller, releaseId: string) =>
      inputs().acceptInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: caller,
        idempotencyKey: randomUUID(),
        payloadHash: randomUUID(),
        model: TEST_MODEL,
        repository: "none",
        agentReleaseId: releaseId,
        message: "hello",
      });

    test("those outside the agent are refused whatever the retired setting says; those inside start", async () => {
      const c = await cast();
      await db
        .update(agents)
        .set({ managingTeamId: c.managing })
        .where(eq(agents.id, c.agentId));
      const before = await db.$count(
        sessions,
        eq(sessions.agentReleaseId, c.releaseId),
      );
      for (const access of ["use", "view", "none"]) {
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
      // Four starts under each of the three values, none by the outsider.
      expect(
        await db.$count(sessions, eq(sessions.agentReleaseId, c.releaseId)),
      ).toBe(before + 12);
      // An agent whose managing team has no one in it: only the workspace's
      // owners and admins are inside.
      const bare = await agent(c.ws);
      await setAccess(c.ws, "use");
      expect((await create(c.member, bare.releaseId)).outcome).toBe(
        "agent_use_refused",
      );
      expect((await create(c.owner, bare.releaseId)).outcome).toBe("accepted");
    });
  });
});
