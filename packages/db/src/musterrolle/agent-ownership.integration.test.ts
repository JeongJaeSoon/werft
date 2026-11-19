import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import { type Caller, callerFor, type TeamActor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentStore } from "../agents.ts";
import * as schema from "../schema.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agents,
  memberships,
  memberTeamMembers,
  memberTeams,
  users,
  workspaces,
} from "../schema.ts";
import { createPostgresAgentAdminStore } from "./agent-admins.ts";
import { reconcileAgentOwnership } from "./agent-ownership.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];

integration("agent ownership on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_ownership_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  const admins = () => createPostgresAgentAdminStore(db);
  const pass = () =>
    reconcileAgentOwnership(db, { limit: 1000, dryRun: false });

  async function person(workspaceId: string, role: WorkspaceRole = "member") {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return userId;
  }

  async function setup() {
    const workspaceId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      name: "ws",
    });
    const ownerId = await person(workspaceId, "owner");
    const owner: Caller = callerFor(
      {
        kind: "user",
        id: ownerId,
        workspace_id: workspaceId,
        role: "owner",
        scopes: [...scopesForRole("owner")],
      },
      { kind: "web" },
      randomUUID(),
    );
    const actor: TeamActor = {
      principal: owner,
      workspaceId,
      userId: ownerId,
    };
    return { workspaceId, ownerId, actor };
  }

  async function team(
    workspaceId: string,
    members: { userId: string; role?: "lead" | "member" }[] = [],
  ) {
    const teamId = randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: `team-${teamId.slice(0, 8)}` });
    for (const { userId, role } of members) {
      await db.insert(memberTeamMembers).values({
        id: randomUUID(),
        workspaceId,
        teamId,
        userId,
        role: role ?? "member",
      });
    }
    return teamId;
  }

  async function agent(workspaceId: string, managingTeamId: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      workspaceId,
      managingTeamId,
      slug: `agent-${id.slice(0, 8)}`,
      name: "agent",
    });
    return id;
  }

  async function since(agentId: string): Promise<Date | null> {
    const [row] = await db
      .select({ at: agents.ownerlessSince })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row?.at ?? null;
  }

  // An agent whose one owner is a member who holds it through `how`.
  async function ownedOnce(how: "direct" | "lead" | "admin_team") {
    const ctx = await setup();
    const userId = await person(ctx.workspaceId);
    const managing = await team(
      ctx.workspaceId,
      how === "lead" ? [{ userId, role: "lead" }] : [{ userId }],
    );
    const agentId = await agent(ctx.workspaceId, managing);
    let lentTeam: string | null = null;
    if (how === "direct") {
      await db
        .insert(agentAdmins)
        .values({ workspaceId: ctx.workspaceId, agentId, userId });
    } else if (how === "admin_team") {
      lentTeam = await team(ctx.workspaceId, [{ userId }]);
      await db.insert(agentAdminTeams).values({
        workspaceId: ctx.workspaceId,
        agentId,
        teamId: lentTeam,
      });
    }
    await pass();
    expect(await since(agentId)).toBeNull();
    return { ...ctx, userId, managing, agentId, lentTeam };
  }

  async function flaggedAfterPass(agentId: string) {
    const result = await pass();
    expect(result.flagged).toContain(agentId);
    expect(await since(agentId)).toBeInstanceOf(Date);
  }

  test("disabling the account of the only admin flags the agent", async () => {
    const { userId, agentId } = await ownedOnce("direct");
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, userId));
    await flaggedAfterPass(agentId);
  });

  test("disabling the membership of the only admin flags the agent", async () => {
    const { userId, agentId, workspaceId } = await ownedOnce("direct");
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, userId),
        ),
      );
    await flaggedAfterPass(agentId);
  });

  test("the only lead leaving the managing team flags the agent", async () => {
    const { userId, managing, agentId } = await ownedOnce("lead");
    await db
      .update(memberTeamMembers)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(memberTeamMembers.teamId, managing),
          eq(memberTeamMembers.userId, userId),
        ),
      );
    await flaggedAfterPass(agentId);
  });

  test("demoting the only lead flags the agent", async () => {
    const { userId, managing, agentId } = await ownedOnce("lead");
    await db
      .update(memberTeamMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(memberTeamMembers.teamId, managing),
          eq(memberTeamMembers.userId, userId),
        ),
      );
    await flaggedAfterPass(agentId);
  });

  test("removing the only direct admin flags the agent", async () => {
    const { userId, agentId, actor } = await ownedOnce("direct");
    const removed = await admins().remove({
      actor,
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "user", id: userId },
      managerRoles: MANAGERS,
    });
    expect(removed.outcome).toBe("removed");
    await flaggedAfterPass(agentId);
  });

  test("removing or archiving the only admin team flags the agent", async () => {
    const removedCase = await ownedOnce("admin_team");
    const removed = await admins().remove({
      actor: removedCase.actor,
      receiptId: randomUUID(),
      agentId: removedCase.agentId,
      subject: { kind: "team", id: removedCase.lentTeam ?? "" },
      managerRoles: MANAGERS,
    });
    expect(removed.outcome).toBe("removed");
    await flaggedAfterPass(removedCase.agentId);

    const archivedCase = await ownedOnce("admin_team");
    await db
      .update(memberTeams)
      .set({ archivedAt: new Date() })
      .where(eq(memberTeams.id, archivedCase.lentTeam ?? ""));
    await flaggedAfterPass(archivedCase.agentId);
  });

  test("moving the agent to a team without a lead flags it", async () => {
    const { workspaceId, userId, agentId, actor } = await ownedOnce("lead");
    const leaderless = await team(workspaceId, [{ userId }]);
    const moved = await admins().setManagingTeam({
      actor,
      receiptId: randomUUID(),
      agentId,
      teamId: leaderless,
      managerRoles: MANAGERS,
    });
    expect(moved.outcome).toBe("set");
    if (moved.outcome === "set") expect(moved.agent.ownerless).toBe(true);
    await flaggedAfterPass(agentId);
  });

  test("an owner on another branch keeps the agent unflagged; workspace owners do not count", async () => {
    const { workspaceId, userId, managing, agentId } =
      await ownedOnce("direct");
    const lead = await person(workspaceId);
    await db.insert(memberTeamMembers).values({
      id: randomUUID(),
      workspaceId,
      teamId: managing,
      userId: lead,
      role: "lead",
    });
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, userId));
    const result = await pass();
    expect(result.flagged).not.toContain(agentId);
    expect(await since(agentId)).toBeNull();

    // The workspace owner is a live member here and administers nothing of it.
    await db
      .update(memberTeamMembers)
      .set({ role: "member" })
      .where(eq(memberTeamMembers.userId, lead));
    await flaggedAfterPass(agentId);
    const row = await createPostgresAgentStore(db).get(workspaceId, agentId);
    expect(row?.agent.ownerless).toBe(true);
    expect(row?.agent.ownerless_since).not.toBeNull();
  });

  // Each starts from an agent flagged by a pass.
  async function flagged() {
    const ctx = await ownedOnce("direct");
    await db.delete(agentAdmins).where(eq(agentAdmins.agentId, ctx.agentId));
    await flaggedAfterPass(ctx.agentId);
    return ctx;
  }

  test("adding an admin user or an admin team clears the mark in the same write", async () => {
    const byUser = await flagged();
    const added = await admins().add({
      actor: byUser.actor,
      receiptId: randomUUID(),
      agentId: byUser.agentId,
      subject: { kind: "user", id: byUser.userId },
      managerRoles: MANAGERS,
    });
    expect(added.outcome).toBe("added");
    expect(await since(byUser.agentId)).toBeNull();

    const byTeam = await flagged();
    const lent = await team(byTeam.workspaceId, [{ userId: byTeam.userId }]);
    const addedTeam = await admins().add({
      actor: byTeam.actor,
      receiptId: randomUUID(),
      agentId: byTeam.agentId,
      subject: { kind: "team", id: lent },
      managerRoles: MANAGERS,
    });
    expect(addedTeam.outcome).toBe("added");
    expect(await since(byTeam.agentId)).toBeNull();
  });

  test("moving to a team with a live lead clears the mark in the same write", async () => {
    const ctx = await flagged();
    const led = await team(ctx.workspaceId, [
      { userId: ctx.userId, role: "lead" },
    ]);
    const moved = await admins().setManagingTeam({
      actor: ctx.actor,
      receiptId: randomUUID(),
      agentId: ctx.agentId,
      teamId: led,
      managerRoles: MANAGERS,
    });
    expect(moved.outcome).toBe("set");
    if (moved.outcome === "set") {
      expect(moved.agent.ownerless).toBe(false);
      expect(moved.agent.ownerless_since).toBeNull();
    }
    expect(await since(ctx.agentId)).toBeNull();
  });

  test("naming a lead of the managing team clears the mark at the next pass", async () => {
    const ctx = await flagged();
    await db
      .update(memberTeamMembers)
      .set({ role: "lead" })
      .where(
        and(
          eq(memberTeamMembers.teamId, ctx.managing),
          eq(memberTeamMembers.userId, ctx.userId),
        ),
      );
    expect(await since(ctx.agentId)).toBeInstanceOf(Date);
    const result = await pass();
    expect(result.cleared).toContain(ctx.agentId);
    expect(await since(ctx.agentId)).toBeNull();
  });

  test("a succession then a removal before the next pass starts a fresh period", async () => {
    const ctx = await flagged();
    const first = await since(ctx.agentId);
    await admins().add({
      actor: ctx.actor,
      receiptId: randomUUID(),
      agentId: ctx.agentId,
      subject: { kind: "user", id: ctx.userId },
      managerRoles: MANAGERS,
    });
    await admins().remove({
      actor: ctx.actor,
      receiptId: randomUUID(),
      agentId: ctx.agentId,
      subject: { kind: "user", id: ctx.userId },
      managerRoles: MANAGERS,
    });
    await flaggedAfterPass(ctx.agentId);
    const fresh = await since(ctx.agentId);
    expect(fresh?.getTime()).toBeGreaterThan(first?.getTime() ?? Infinity);
  });

  test("a team-side succession no pass saw keeps the same period", async () => {
    const ctx = await flagged();
    const first = await since(ctx.agentId);
    const lead = (role: "lead" | "member") =>
      db
        .update(memberTeamMembers)
        .set({ role })
        .where(
          and(
            eq(memberTeamMembers.teamId, ctx.managing),
            eq(memberTeamMembers.userId, ctx.userId),
          ),
        );
    await lead("lead");
    await lead("member");
    await pass();
    expect(await since(ctx.agentId)).toEqual(first);
  });

  test("a dry run writes nothing, and archived or deleted agents are left alone", async () => {
    const { workspaceId, ownerId } = await setup();
    const leaderless = await team(workspaceId);
    const live = await agent(workspaceId, leaderless);
    const archived = await agent(workspaceId, leaderless);
    const deleted = await agent(workspaceId, leaderless);
    await db
      .update(agents)
      .set({ status: "archived" })
      .where(eq(agents.id, archived));
    await db
      .update(agents)
      .set({ status: "archived", deletedAt: new Date(), deletedBy: ownerId })
      .where(eq(agents.id, deleted));

    const dry = await reconcileAgentOwnership(db, {
      limit: 1000,
      dryRun: true,
    });
    expect(dry.flagged).toContain(live);
    expect(await since(live)).toBeNull();

    const result = await pass();
    expect(result.flagged).toContain(live);
    expect(result.flagged).not.toContain(archived);
    expect(result.flagged).not.toContain(deleted);
    expect(await since(archived)).toBeNull();
    expect(await since(deleted)).toBeNull();
  });

  test("a dry run keeps a mark it would clear, and each side stops at the limit", async () => {
    const first = await flagged();
    const owned = [first, await flagged()];
    for (const ctx of owned) {
      await db.insert(agentAdmins).values({
        workspaceId: ctx.workspaceId,
        agentId: ctx.agentId,
        userId: ctx.userId,
      });
    }
    const ids = owned.map(({ agentId }) => agentId);
    const dry = await reconcileAgentOwnership(db, {
      limit: 1000,
      dryRun: true,
    });
    expect(dry.cleared).toEqual(expect.arrayContaining(ids));
    for (const id of ids) expect(await since(id)).toBeInstanceOf(Date);

    const leaderless = await team(first.workspaceId);
    await agent(first.workspaceId, leaderless);
    await agent(first.workspaceId, leaderless);
    const one = await reconcileAgentOwnership(db, { limit: 1, dryRun: false });
    expect(one.flagged).toHaveLength(1);
    expect(one.cleared).toHaveLength(1);
    const next = await reconcileAgentOwnership(db, {
      limit: 1,
      dryRun: false,
    });
    expect(next.flagged).toHaveLength(1);
    expect(next.cleared).toHaveLength(1);
    expect([...one.cleared, ...next.cleared].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(await since(id)).toBeNull();
  });
});
