import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AgentUsageScope,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { type Caller, callerFor, type TeamActor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentStore } from "./agents.ts";
import { agentUsable } from "./musterrolle/administers.ts";
import { createPostgresAgentAdminStore } from "./musterrolle/agent-admins.ts";
import { createPostgresTeamStore } from "./musterrolle/member-teams.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentUsageTargets,
  agentVersions,
  memberships,
  sessionShares,
  sessionShareTargets,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import {
  releaseSpecColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
} from "./testing/spec-pins.ts";
import { createPostgresAgentUsageStore, usageOf } from "./usage/agent-usage.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];
const LIMITS = { queuedInputLimitPerSession: 10_000, storageLimitBytes: 1e15 };

// 94S-902: the SQL predicate behind GET /v1/usable-agents and the hiding of a
// private agent must answer what the start decision (`usageOf`) answers, for
// every kind of requester, on the same rows.
integration("agent_usable on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_usable_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const teams = () => createPostgresTeamStore(db);
  const admins = () => createPostgresAgentAdminStore(db);
  const usage = () => createPostgresAgentUsageStore(db);
  const uow = () => createPostgresSessionUnitOfWork(db);

  const idOf = (caller: Caller) => caller.actor?.userId ?? "";
  const acting = (caller: Caller): TeamActor => ({
    principal: caller,
    workspaceId: caller.ownerId,
    userId: idOf(caller),
  });

  async function workspace() {
    const id = randomUUID();
    const slug = `ws-${id.slice(0, 8)}`;
    await db.insert(workspaces).values({ id, slug, name: slug });
    return id;
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

  async function agent(workspaceId: string) {
    const agentId = randomUUID();
    const managingTeamId = await fixtureTeam(db, workspaceId);
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId,
      slug: `a-${agentId.slice(0, 8)}`,
      name: `agent ${agentId.slice(0, 4)}`,
    });
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card: {},
      contentSha256: "a".repeat(64),
    });
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "a".repeat(64),
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: [],
    });
    await db
      .update(agents)
      .set({
        status: "active",
        activeReleaseId: releaseId,
        activationRevision: 1,
      })
      .where(eq(agents.id, agentId));
    return { agentId, releaseId, managingTeamId };
  }

  async function team(by: Caller, people: Caller[]) {
    const created = await teams().create({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId: randomUUID(),
      name: `team-${randomUUID()}`,
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    for (const who of people) await addMember(by, created.team.id, who);
    return created.team.id;
  }

  const addMember = (by: Caller, teamId: string, who: Caller) =>
    teams().addMember({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId,
      userId: idOf(who),
    });

  const removeMember = (by: Caller, teamId: string, who: Caller) =>
    teams().removeMember({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId,
      userId: idOf(who),
    });

  async function setUsage(
    by: Caller,
    agentId: string,
    scope: AgentUsageScope,
    teamIds: string[],
  ) {
    const current = await usage().get(by.ownerId, agentId);
    const result = await usage().put({
      actor: acting(by),
      receiptId: randomUUID(),
      agentId,
      scope,
      teamIds,
      ifMatch: current?.revision ?? 1,
      managerRoles: MANAGERS,
    });
    expect(result).toMatchObject({ outcome: "set" });
  }

  const admin = (
    by: Caller,
    agentId: string,
    subject: { kind: "user" | "team"; id: string },
  ) =>
    admins().add({
      actor: acting(by),
      receiptId: randomUUID(),
      agentId,
      subject,
      managerRoles: MANAGERS,
    });

  type Who = { userId: string | null; keyAgentId: string | null };

  // The decision the session start re-reads, and the predicate the list and
  // the hiding read: asked the same thing about the same rows.
  async function both(workspaceId: string, who: Who, agentId: string) {
    const [membership] = who.userId
      ? await db
          .select({ role: memberships.role })
          .from(memberships)
          .where(
            and(
              eq(memberships.workspaceId, workspaceId),
              eq(memberships.userId, who.userId),
            ),
          )
      : [];
    const decided = await usageOf(db, {
      workspaceId,
      agentId,
      who: {
        userId: who.userId,
        role: membership?.role ?? null,
        keyAgentId: who.keyAgentId,
      },
      lock: false,
    });
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          agentUsable(db, workspaceId, who, agents.id),
        ),
      );
    return { decision: decided.allowed, predicate: rows.length === 1 };
  }

  // A private agent on `usageTeam`, with every other way in set up apart:
  // a direct admin, a lent admin team, the managing team's members.
  async function world() {
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const wsAdmin = await person(ws, "admin");
    const insider = await person(ws);
    const outsider = await person(ws);
    const directAdmin = await person(ws);
    const lentMember = await person(ws);
    const managingMember = await person(ws);
    const former = await person(ws);
    const { agentId, releaseId } = await agent(ws);
    const other = await agent(ws);
    const usageTeam = await team(owner, [insider, former]);
    const lentTeam = await team(owner, [lentMember]);
    // Its own managing team, so its members are inside this agent alone.
    const managingTeamId = await team(owner, [managingMember]);
    await db
      .update(agents)
      .set({ managingTeamId })
      .where(eq(agents.id, agentId));
    await setUsage(owner, agentId, "private", [usageTeam]);
    await admin(owner, agentId, { kind: "user", id: idOf(directAdmin) });
    await admin(owner, agentId, { kind: "team", id: lentTeam });
    return {
      ws,
      owner,
      wsAdmin,
      insider,
      outsider,
      directAdmin,
      lentMember,
      managingMember,
      former,
      agentId,
      releaseId,
      other,
      usageTeam,
      managingTeamId,
    };
  }

  test("the predicate and the start decision agree for every requester kind", async () => {
    const w = await world();
    const person = (caller: Caller): Who => ({
      userId: idOf(caller),
      keyAgentId: null,
    });
    const table: [string, Who, boolean][] = [
      ["member of the usage team", person(w.insider), true],
      ["member outside the usage team", person(w.outsider), false],
      ["workspace owner", person(w.owner), true],
      ["workspace admin", person(w.wsAdmin), true],
      ["direct agent admin", person(w.directAdmin), true],
      ["member of a lent admin team", person(w.lentMember), true],
      ["member of the managing team", person(w.managingMember), true],
      ["unbound service key", { userId: null, keyAgentId: null }, false],
      [
        "key bound to this agent",
        { userId: null, keyAgentId: w.agentId },
        true,
      ],
      [
        "key bound to another agent",
        { userId: null, keyAgentId: w.other.agentId },
        false,
      ],
      [
        "person's key bound to another agent",
        { userId: idOf(w.outsider), keyAgentId: w.other.agentId },
        false,
      ],
    ];
    for (const [name, who, expected] of table) {
      const answer = await both(w.ws, who, w.agentId);
      expect({ name, ...answer }).toEqual({
        name,
        decision: expected,
        predicate: expected,
      });
    }

    // A team member who leaves, and a team that goes, stop using it: both
    // answers read the rows at this request.
    await removeMember(w.owner, w.usageTeam, w.insider);
    expect(await both(w.ws, person(w.insider), w.agentId)).toEqual({
      decision: false,
      predicate: false,
    });
    expect(await both(w.ws, person(w.former), w.agentId)).toEqual({
      decision: true,
      predicate: true,
    });
    await teams().delete({
      actor: acting(w.owner),
      receiptId: randomUUID(),
      teamId: w.usageTeam,
    });
    expect(await both(w.ws, person(w.former), w.agentId)).toEqual({
      decision: false,
      predicate: false,
    });
  });

  test("an agent open to the workspace is usable by everyone, a service key included", async () => {
    const w = await world();
    await setUsage(w.owner, w.agentId, "workspace", []);
    for (const who of [
      { userId: idOf(w.outsider), keyAgentId: null },
      { userId: null, keyAgentId: null },
      { userId: null, keyAgentId: w.other.agentId },
    ]) {
      expect(await both(w.ws, who, w.agentId)).toEqual({
        decision: true,
        predicate: true,
      });
    }
  });

  test("a usage row for a person lists no one, in both answers", async () => {
    const w = await world();
    await setUsage(w.owner, w.other.agentId, "private", [w.usageTeam]);
    await db.insert(agentUsageTargets).values({
      agentId: w.other.agentId,
      workspaceId: w.ws,
      userId: idOf(w.outsider),
    });
    expect(
      await both(
        w.ws,
        { userId: idOf(w.outsider), keyAgentId: null },
        w.other.agentId,
      ),
    ).toEqual({ decision: false, predicate: false });
  });

  test("listUsable gives a member exactly the agents a start would accept", async () => {
    const w = await world();
    const store = createPostgresAgentStore(db);
    const list = async (userId: string | null, keyAgentId: string | null) =>
      (await store.listUsable(w.ws, { userId, keyAgentId }, 200))
        .map((item) => item.id)
        .sort();
    const both = [w.agentId, w.other.agentId].sort();
    // Only those inside an agent start it: its managing team, its admins,
    // and the workspace's owners and admins. A usage grant alone is not in.
    expect(await list(idOf(w.owner), null)).toEqual(both);
    expect(await list(idOf(w.wsAdmin), null)).toEqual(both);
    expect(await list(idOf(w.managingMember), null)).toEqual([w.agentId]);
    expect(await list(idOf(w.directAdmin), null)).toEqual([w.agentId]);
    expect(await list(idOf(w.lentMember), null)).toEqual([w.agentId]);
    expect(await list(idOf(w.insider), null)).toEqual([]);
    expect(await list(idOf(w.outsider), null)).toEqual([]);
    expect(await list(null, null)).toEqual([]);
    expect(await list(null, w.agentId)).toEqual([w.agentId]);

    // Only active agents with an active release are listed.
    await db
      .update(agents)
      .set({ status: "paused" })
      .where(eq(agents.id, w.other.agentId));
    expect(await list(idOf(w.owner), null)).toEqual([w.agentId]);
  });

  // The agent list and its counts show an agent only to those inside it, and
  // of a private one only to those its usage also lets in.
  test("the agent list and counts show an agent only to those inside it", async () => {
    const w = await world();
    const store = createPostgresAgentStore(db);
    const hidden = await db
      .select({ name: agents.name, slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, w.agentId));
    // [who, sees the private agent, sees the other agent]
    const table: [string, Caller, boolean, boolean][] = [
      ["workspace owner", w.owner, true, true],
      ["workspace admin", w.wsAdmin, true, true],
      ["direct agent admin", w.directAdmin, true, false],
      ["member of a lent admin team", w.lentMember, true, false],
      ["member of the managing team", w.managingMember, true, false],
      ["member of the usage team", w.insider, false, false],
      ["member outside both teams", w.outsider, false, false],
      ["member who left the usage team", w.former, false, false],
    ];
    for (const [name, caller, mine, other] of table) {
      const reader = { userId: idOf(caller) };
      const listed = (await store.list(w.ws, { limit: 50 }, reader)).items;
      const counted = await store.count(w.ws, reader);
      expect({
        name,
        mine: listed.some((item) => item.id === w.agentId),
        other: listed.some((item) => item.id === w.other.agentId),
        all: counted.all,
      }).toEqual({ name, mine, other, all: Number(mine) + Number(other) });
      // What the list shows, the start decision's usage check lets in.
      if (mine) {
        expect(
          (
            await both(
              w.ws,
              { userId: idOf(caller), keyAgentId: null },
              w.agentId,
            )
          ).decision,
        ).toBe(true);
      }
    }

    // Nothing narrows its way back to a hidden agent, and a page boundary
    // does not show one.
    const outside = { userId: idOf(w.outsider) };
    for (const query of [
      { limit: 50, q: hidden[0]?.name ?? "" },
      { limit: 50, q: hidden[0]?.slug ?? "" },
      { limit: 50, ids: [w.agentId] },
      { limit: 1 },
    ]) {
      const page = await store.list(w.ws, query, outside);
      expect(page.items).toEqual([]);
      expect(page.next_cursor).toBeNull();
    }
  });

  test("a session of an agent the viewer may not use shows no agent, in the list and in the detail", async () => {
    const w = await world();
    // Inside the open agent only, so its sessions show their agent.
    await admin(w.owner, w.other.agentId, {
      kind: "user",
      id: idOf(w.outsider),
    });
    const start = async (by: Caller, releaseId: string) => {
      const created = await uow().acceptInputAtomic({
        principal: by,
        idempotencyKey: randomUUID(),
        payloadHash: "create",
        model: TEST_MODEL,
        repository: "none",
        agentReleaseId: releaseId,
        message: "start",
        limits: LIMITS,
      });
      if (created.outcome !== "accepted") throw new Error(created.outcome);
      const sessionId = created.response.session_id;
      await db.insert(sessionShares).values({
        sessionId,
        ownerId: w.ws,
        workspaceId: w.ws,
        scope: "people",
      });
      await db.insert(sessionShareTargets).values(
        [w.outsider, w.insider].map((to) => ({
          id: randomUUID(),
          workspaceId: w.ws,
          sessionId,
          userId: idOf(to),
        })),
      );
      return sessionId;
    };
    const privateId = await start(w.owner, w.releaseId);
    const publicId = await start(w.owner, w.other.releaseId);
    const viewer = (caller: Caller) => ({
      userId: idOf(caller),
      apiKeyId: null,
      keyAgentId: null,
    });

    const seenBy = async (caller: Caller) => {
      const listed = await createPostgresSessionReader(db).listSessions(
        w.ws,
        { limit: 100 },
        viewer(caller),
      );
      const byId = new Map(listed.items.map((item) => [item.id, item]));
      const detail = await createPostgresSessionReader(db).getSession(
        w.ws,
        privateId,
        viewer(caller),
      );
      return { byId, detail };
    };

    const outside = await seenBy(w.outsider);
    const hidden = outside.byId.get(privateId);
    const open = outside.byId.get(publicId);
    if (!hidden || !open) throw new Error("the shared sessions are listed");
    // Shared as they are, with the agent blanked and the marker set.
    expect(hidden.agent).toBeNull();
    expect(hidden.agent_hidden).toBe(true);
    expect(open.agent?.id).toBe(w.other.agentId);
    expect(open.agent_hidden).toBe(false);
    // Nothing else tells hidden from open: the same fields, the same types.
    expect(Object.keys(hidden).sort()).toEqual(Object.keys(open).sort());
    for (const key of Object.keys(open) as (keyof typeof open)[]) {
      if (key === "agent" || key === "agent_hidden") continue;
      expect(typeof hidden[key]).toBe(typeof open[key]);
    }
    expect(outside.detail?.agent).toBeNull();
    expect(outside.detail?.agent_hidden).toBe(true);
    expect(JSON.stringify(outside)).not.toContain(w.agentId);

    const inside = await seenBy(w.managingMember);
    expect(inside.detail?.agent?.id).toBe(w.agentId);
    expect(inside.detail?.agent_hidden).toBe(false);

    // On the usage team but outside both managing teams: the sessions shared
    // with them show no agent, the open agent's included.
    const usageOnly = await seenBy(w.insider);
    expect(usageOnly.byId.get(privateId)?.agent).toBeNull();
    expect(usageOnly.byId.get(privateId)?.agent_hidden).toBe(true);
    expect(usageOnly.byId.get(publicId)?.agent_hidden).toBe(true);
    expect(usageOnly.detail?.agent_hidden).toBe(true);

    // A read with no viewer (internal) shows it.
    expect(
      (await createPostgresSessionReader(db).getSession(w.ws, privateId))?.agent
        ?.id,
    ).toBe(w.agentId);

    // Filtering by an agent the viewer may not use reads as filtering by one
    // that is not there: no session, no cursor to tell them apart.
    const filtered = async (caller: Caller, agentId: string) =>
      createPostgresSessionReader(db).listSessions(
        w.ws,
        { limit: 100, agent_id: agentId },
        viewer(caller),
      );
    expect(await filtered(w.outsider, w.agentId)).toEqual(
      await filtered(w.outsider, randomUUID()),
    );
    // Someone on the usage team alone filters by it as by nothing.
    expect((await filtered(w.insider, w.agentId)).items).toEqual([]);
    expect(
      (await filtered(w.outsider, w.other.agentId)).items.map(
        (item) => item.id,
      ),
    ).toEqual([publicId]);
  });

  test("hiddenAgentRefs names the agents, releases and session agent a viewer may not use", async () => {
    const w = await world();
    await admin(w.owner, w.other.agentId, {
      kind: "user",
      id: idOf(w.outsider),
    });
    const reader = createPostgresSessionReader(db);
    const viewer = (caller: Caller) => ({
      userId: idOf(caller),
      apiKeyId: null,
      keyAgentId: null,
    });
    const asked = {
      agentIds: [w.agentId, w.other.agentId, randomUUID()],
      releaseIds: [w.releaseId, w.other.releaseId, "rel-nothing"],
      sessionId: null,
    };
    const outside = await reader.hiddenAgentRefs(
      w.ws,
      viewer(w.outsider),
      asked,
    );
    expect([...outside.agentIds]).toEqual([w.agentId]);
    expect([...outside.releaseIds]).toEqual([w.releaseId]);
    const inside = await reader.hiddenAgentRefs(w.ws, viewer(w.owner), asked);
    expect([...inside.agentIds]).toEqual([]);
    expect([...inside.releaseIds]).toEqual([]);
    // A managing team reaches its own agent only.
    const managing = await reader.hiddenAgentRefs(
      w.ws,
      viewer(w.managingMember),
      asked,
    );
    expect([...managing.agentIds]).toEqual([w.other.agentId]);
    // A usage team alone does not reach an agent outside its managing team.
    const usageOnly = await reader.hiddenAgentRefs(
      w.ws,
      viewer(w.insider),
      asked,
    );
    expect([...usageOnly.agentIds].sort()).toEqual(
      [w.agentId, w.other.agentId].sort(),
    );

    // A session of the private agent hides its agent and release too, with
    // nothing else named.
    const created = await uow().acceptInputAtomic({
      principal: w.owner,
      idempotencyKey: randomUUID(),
      payloadHash: "create",
      model: TEST_MODEL,
      repository: "none",
      agentReleaseId: w.releaseId,
      message: "start",
      limits: LIMITS,
    });
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    const bySession = await reader.hiddenAgentRefs(w.ws, viewer(w.outsider), {
      agentIds: [],
      releaseIds: [],
      sessionId: created.response.session_id,
    });
    expect([...bySession.agentIds]).toEqual([w.agentId]);
    expect([...bySession.releaseIds]).toEqual([w.releaseId]);

    // A malformed owner names nothing.
    expect(
      (await reader.hiddenAgentRefs("legacy-owner", viewer(w.outsider), asked))
        .agentIds.size,
    ).toBe(0);
  });
});
