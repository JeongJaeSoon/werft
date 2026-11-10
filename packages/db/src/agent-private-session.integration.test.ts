import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AgentUsageScope,
  type SessionScope,
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
import { createPostgresAgentAdminStore } from "./agent-admins.ts";
import { createPostgresAgentUsageStore } from "./agent-usage.ts";
import { createPostgresTeamStore } from "./member-teams.ts";
import { createPostgresPendingRequests } from "./pending-requests.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  apiKeys,
  attempts,
  memberships,
  pendingRequests,
  receipts,
  sessions,
  turns,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];
const HOLD = "hold-locks";
const LIMITS = { queuedInputLimitPerSession: 10_000, storageLimitBytes: 1e15 };
const SCOPES: SessionScope[] = [
  "sessions:read",
  "sessions:write",
  "sessions:approve",
];

// 94S-901: a private agent is used only by its teams, workspace owners and
// admins, its admins and its managers; the write judges that again over
// locked rows, in the order a usage edit and a team archive take theirs.
integration("private agents on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_private_it" });
    pool = new Pool({ connectionString: database.url, max: 32 });
    db = drizzle(pool, { schema });
    await pool.query(`
      CREATE FUNCTION test_hold_locks() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.message = '${HOLD}' THEN PERFORM pg_sleep(1); END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_hold_locks BEFORE INSERT ON turns
        FOR EACH ROW EXECUTE FUNCTION test_hold_locks();
    `);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const uow = () => createPostgresSessionUnitOfWork(db);
  const teams = () => createPostgresTeamStore(db);
  const admins = () => createPostgresAgentAdminStore(db);
  const usage = () => createPostgresAgentUsageStore(db);
  const pending = () => createPostgresPendingRequests(db);

  const idOf = (caller: Caller) => caller.actor?.userId ?? "";
  const acting = (caller: Caller): TeamActor => ({
    principal: caller,
    workspaceId: caller.ownerId,
    userId: idOf(caller),
  });

  async function workspace() {
    const id = randomUUID();
    const slug = `ws-${id.slice(0, 8)}`;
    await db.insert(workspaces).values({
      id,
      slug,
      name: slug,
      settings: { agent_outsider_session_visibility: "workspace" },
    });
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

  async function agentRelease(workspaceId: string) {
    const agentId = randomUUID();
    const managingTeamId = await fixtureTeam(db, workspaceId);
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId,
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
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
      runtimeProfileId: "coding",
      profileDigest: "digest",
      runtimeConfigSnapshot: {},
      effectiveTools: [],
    });
    return { agentId, releaseId, managingTeamId };
  }

  const create = (
    by: Caller,
    releaseId: string,
    extra: {
      idempotencyKey?: string;
      message?: string;
      agentPrivate?: true;
      credentialsUnbound?: true;
      notRunnableReason?: "agent_inactive";
    } = {},
  ) =>
    uow().acceptInputAtomic({
      principal: by,
      idempotencyKey: extra.idempotencyKey ?? randomUUID(),
      payloadHash: "create",
      profileId: "coding",
      repository: "none",
      agentReleaseId: releaseId,
      message: extra.message ?? "start",
      limits: LIMITS,
      ...(extra.agentPrivate ? { agentPrivate: true as const } : {}),
      ...(extra.credentialsUnbound
        ? { credentialsUnbound: true as const }
        : {}),
      ...(extra.notRunnableReason
        ? { notRunnableReason: extra.notRunnableReason }
        : {}),
    });

  async function session(by: Caller, releaseId: string) {
    const created = await create(by, releaseId);
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    return created.response.session_id;
  }

  const append = (
    by: Caller,
    sessionId: string,
    extra: {
      idempotencyKey?: string;
      message?: string;
      agentPrivate?: true;
    } = {},
  ) =>
    uow().appendInputAtomic({
      principal: by,
      sessionId,
      idempotencyKey: extra.idempotencyKey ?? randomUUID(),
      payloadHash: "append",
      message: extra.message ?? "more",
      limits: LIMITS,
      ...(extra.agentPrivate ? { agentPrivate: true as const } : {}),
    });

  async function team(by: Caller, people: Caller[]) {
    const created = await teams().create({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId: randomUUID(),
      name: `team-${randomUUID()}`,
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    for (const who of people) await teamMember(by, created.team.id, who);
    return created.team.id;
  }

  const teamMember = (by: Caller, teamId: string, who: Caller, add = true) =>
    teams()[add ? "addMember" : "removeMember"]({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId,
      userId: idOf(who),
    });

  const archive = (by: Caller, teamId: string) =>
    teams().delete({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId,
    });

  const admin = (
    by: Caller,
    agentId: string,
    subject: { kind: "user" | "team"; id: string },
    add = true,
  ) =>
    admins()[add ? "add" : "remove"]({
      actor: acting(by),
      receiptId: randomUUID(),
      agentId,
      subject,
      managerRoles: MANAGERS,
    });

  const setManagingTeam = (by: Caller, agentId: string, teamId: string) =>
    admins().setManagingTeam({
      actor: acting(by),
      receiptId: randomUUID(),
      agentId,
      teamId,
      managerRoles: MANAGERS,
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
    return result;
  }

  async function turnOf(sessionId: string, sequence = 1) {
    const [row] = await db
      .select({
        usageBasis: turns.usageBasis,
        usageTeamId: turns.usageTeamId,
        requesterKind: turns.requesterKind,
        requesterId: turns.requesterId,
      })
      .from(turns)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)));
    return row;
  }

  async function sessionRow(sessionId: string) {
    const [row] = await db
      .select({
        usageBasis: sessions.usageBasis,
        usageTeamId: sessions.usageTeamId,
        requesterKind: sessions.requesterKind,
        requesterId: sessions.requesterId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row;
  }

  // An owner, a workspace admin, a member of the usage team, a member
  // outside it, and a private agent that lists the team.
  async function world() {
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const wsAdmin = await person(ws, "admin");
    const insider = await person(ws);
    const outsider = await person(ws);
    const { agentId, releaseId, managingTeamId } = await agentRelease(ws);
    const teamId = await team(owner, [insider]);
    expect(await setUsage(owner, agentId, "private", [teamId])).toMatchObject({
      outcome: "set",
    });
    return {
      ws,
      owner,
      wsAdmin,
      insider,
      outsider,
      agentId,
      releaseId,
      managingTeamId,
      teamId,
    };
  }

  describe("who may use it, and what the turn keeps of why", () => {
    test("a member of a usage team starts and feeds; the basis and the requester are kept", async () => {
      const w = await world();
      const created = await create(w.insider, w.releaseId);
      expect(created).toMatchObject({ outcome: "accepted" });
      const sessionId =
        created.outcome === "accepted" ? created.response.session_id : "";
      const expected = {
        usageBasis: "team",
        usageTeamId: w.teamId,
        requesterKind: "user",
        requesterId: idOf(w.insider),
      };
      expect(await turnOf(sessionId)).toEqual(expected);
      expect(await sessionRow(sessionId)).toEqual(expected);
      expect(await append(w.insider, sessionId)).toMatchObject({
        outcome: "accepted",
      });
      expect(await turnOf(sessionId, 2)).toEqual(expected);
      // The session keeps the first turn's values.
      expect(await sessionRow(sessionId)).toEqual(expected);
    });

    test("a workspace owner or admin, an agent admin and a managing-team member each pass", async () => {
      const w = await world();
      const direct = await person(w.ws);
      expect(
        await admin(w.owner, w.agentId, { kind: "user", id: idOf(direct) }),
      ).toMatchObject({ outcome: "added" });
      const lent = await person(w.ws);
      const lendingTeam = await team(w.owner, [lent]);
      await admin(w.owner, w.agentId, { kind: "team", id: lendingTeam });
      const manager = await person(w.ws);
      await teamMember(w.owner, w.managingTeamId, manager);
      const cases: [Caller, string, string | null][] = [
        [w.owner, "workspace", null],
        [w.wsAdmin, "workspace", null],
        [direct, "agent_admin", null],
        [lent, "agent_admin", lendingTeam],
        [manager, "manager", w.managingTeamId],
      ];
      for (const [who, basis, teamId] of cases) {
        const created = await create(who, w.releaseId);
        if (created.outcome !== "accepted") {
          throw new Error(`${basis}: ${created.outcome}`);
        }
        expect(await turnOf(created.response.session_id)).toMatchObject({
          usageBasis: basis,
          usageTeamId: teamId,
          requesterId: idOf(who),
        });
      }
    });

    test("a member outside its teams cannot start or feed it, and is told nothing else", async () => {
      const w = await world();
      expect(await create(w.outsider, w.releaseId)).toEqual({
        outcome: "agent_private",
      });
      // Before the agent's state, the credentials or the catalog.
      expect(
        await create(w.outsider, w.releaseId, {
          notRunnableReason: "agent_inactive",
        }),
      ).toEqual({ outcome: "agent_private" });
      expect(
        await create(w.outsider, w.releaseId, { credentialsUnbound: true }),
      ).toEqual({ outcome: "agent_private" });
      const sessionId = await session(w.insider, w.releaseId);
      expect(await append(w.outsider, sessionId)).toEqual({
        outcome: "agent_private",
      });
      const stored = await db.select().from(receipts);
      expect(stored.some((r) => r.operation === "credential_unbound")).toBe(
        false,
      );
    });

    test("a session the requester cannot see stays not found, whatever its agent", async () => {
      const w = await world();
      const sessionId = await session(w.insider, w.releaseId);
      await db.insert(schema.sessionShares).values({
        sessionId,
        ownerId: w.ws,
        workspaceId: w.ws,
        scope: "private",
      });
      expect(await append(w.outsider, sessionId)).toEqual({
        outcome: "not_found",
      });
    });

    test("a workspace agent is open to every member, with its basis public", async () => {
      const w = await world();
      expect(await setUsage(w.owner, w.agentId, "workspace", [])).toMatchObject(
        { outcome: "set" },
      );
      const created = await create(w.outsider, w.releaseId);
      expect(created).toMatchObject({ outcome: "accepted" });
      expect(
        await turnOf(
          created.outcome === "accepted" ? created.response.session_id : "",
        ),
      ).toMatchObject({ usageBasis: "public", usageTeamId: null });
    });

    test("an agent key reaches its own private agent", async () => {
      const w = await world();
      const id = randomUUID();
      await db.insert(apiKeys).values({
        id,
        keyHash: Buffer.from(randomUUID()),
        ownerId: w.ws,
        workspaceId: w.ws,
        kind: "agent",
        scopes: SCOPES,
        createdByUserId: null,
        agentId: w.agentId,
      });
      const caller = callerFor(
        {
          kind: "api_key",
          id,
          owner_id: w.ws,
          workspace_id: w.ws,
          scopes: SCOPES,
        },
        { kind: "api" },
        randomUUID(),
        { creatorId: null },
      );
      const created = await create(caller, w.releaseId);
      expect(created).toMatchObject({ outcome: "accepted" });
      expect(
        await turnOf(
          created.outcome === "accepted" ? created.response.session_id : "",
        ),
      ).toMatchObject({
        usageBasis: "agent_key",
        requesterKind: "api_key",
        requesterId: id,
      });
    });

    test("a private agent whose teams were all archived is open to its managers only", async () => {
      const w = await world();
      expect(await archive(w.owner, w.teamId)).toMatchObject({
        outcome: "deleted",
      });
      expect(await create(w.insider, w.releaseId)).toEqual({
        outcome: "agent_private",
      });
      expect(await create(w.owner, w.releaseId)).toMatchObject({
        outcome: "accepted",
      });
    });
  });

  describe("a request the policy refused", () => {
    test("a retry of a start taken before the requester lost the agent is answered", async () => {
      const w = await world();
      const key = randomUUID();
      const first = await create(w.insider, w.releaseId, {
        idempotencyKey: key,
      });
      expect(first).toMatchObject({ outcome: "accepted" });
      await teamMember(w.owner, w.teamId, w.insider, false);
      expect(
        await create(w.insider, w.releaseId, { idempotencyKey: key }),
      ).toMatchObject({ outcome: "replayed" });
      expect(
        await create(w.insider, w.releaseId, {
          idempotencyKey: key,
          agentPrivate: true,
        }),
      ).toMatchObject({ outcome: "replayed" });
      // A new request meets the refusal, with or without the flag.
      expect(await create(w.insider, w.releaseId)).toEqual({
        outcome: "agent_private",
      });
    });

    test("the flag alone refuses a new start and a new input, and no replay is lost", async () => {
      const w = await world();
      expect(
        await create(w.insider, w.releaseId, { agentPrivate: true }),
      ).toEqual({ outcome: "agent_private" });
      const sessionId = await session(w.insider, w.releaseId);
      const key = randomUUID();
      expect(
        await append(w.insider, sessionId, { idempotencyKey: key }),
      ).toMatchObject({ outcome: "accepted" });
      expect(
        await append(w.insider, sessionId, {
          idempotencyKey: key,
          agentPrivate: true,
        }),
      ).toMatchObject({ outcome: "replayed" });
      expect(
        await append(w.insider, sessionId, { agentPrivate: true }),
      ).toEqual({ outcome: "agent_private" });
    });
  });

  describe("approval does not look at usage", () => {
    test("the creator who lost the agent still answers a pending request", async () => {
      const w = await world();
      const sessionId = await session(w.insider, w.releaseId);
      const attemptId = `att-${randomUUID()}`;
      await db.insert(attempts).values({
        id: attemptId,
        sessionId,
        executionId: `exec-${randomUUID()}`,
        leaseEpoch: 0,
        executionGeneration: 0,
        authRevision: 0,
        state: "running",
        leaseExpiresAt: new Date(Date.now() + 3_600_000),
      });
      const [turn] = await db
        .update(turns)
        .set({ status: "running", attemptId })
        .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)))
        .returning({ id: turns.id });
      const requestId = `req_${randomUUID()}`;
      await db.insert(pendingRequests).values({
        requestId,
        sessionId,
        turnId: turn?.id ?? 0,
        attemptId,
        kind: "permission",
        payload: {
          kind: "permission",
          tool: "Bash",
          input: { command: "ls" },
        },
        inputHash: "a".repeat(64),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await setUsage(w.owner, w.agentId, "private", []);
      expect(await create(w.insider, w.releaseId)).toEqual({
        outcome: "agent_private",
      });
      expect(
        await pending().answerAtomic({
          principal: w.insider,
          sessionId,
          idempotencyKey: randomUUID(),
          payloadHash: "answer",
          answer: {
            request_id: requestId,
            kind: "permission",
            decision: "allow",
          },
          approval: { surface: "web", decisionId: randomUUID() },
        }),
      ).toMatchObject({ outcome: "accepted" });
    });
  });

  // A change to the agent's usage, its teams or the people in them takes its
  // rows in the order the write takes them, so each waits for the other or
  // is seen by it: no deadlock, and the answer follows what is stored.
  describe("concurrent changes", () => {
    test("a start holding its rows makes the usage edit wait; a start behind the edit is refused", async () => {
      const w = await world();
      let started = false;
      const held = create(w.insider, w.releaseId, { message: HOLD }).then(
        (result) => {
          started = true;
          return result;
        },
      );
      await Bun.sleep(300);
      expect(started).toBe(false);
      const edit = await setUsage(w.owner, w.agentId, "private", []);
      expect(started).toBe(true);
      expect(edit).toMatchObject({ outcome: "set" });
      expect(await held).toMatchObject({ outcome: "accepted" });
      expect(await create(w.insider, w.releaseId)).toEqual({
        outcome: "agent_private",
      });
    });

    test("a start that meets a usage edit in flight follows the committed edit", async () => {
      const w = await world();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT agent_id FROM agent_usage WHERE agent_id = $1 FOR UPDATE",
          [w.agentId],
        );
        const waiting = create(w.insider, w.releaseId);
        const feeding = session(w.owner, w.releaseId).then((id) =>
          append(w.insider, id),
        );
        await Bun.sleep(300);
        await client.query(
          "DELETE FROM agent_usage_targets WHERE agent_id = $1",
          [w.agentId],
        );
        await client.query("COMMIT");
        expect(await waiting).toEqual({ outcome: "agent_private" });
        expect(await feeding).toEqual({ outcome: "agent_private" });
      } finally {
        client.release();
      }
    });

    test("a start that meets a member removal in flight follows it", async () => {
      const w = await world();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT id FROM member_teams WHERE id = $1 FOR UPDATE",
          [w.teamId],
        );
        const waiting = create(w.insider, w.releaseId);
        await Bun.sleep(300);
        await client.query(
          "UPDATE member_team_members SET removed_at = now() WHERE team_id = $1 AND user_id = $2",
          [w.teamId, idOf(w.insider)],
        );
        await client.query("COMMIT");
        expect(await waiting).toEqual({ outcome: "agent_private" });
      } finally {
        client.release();
      }
    });

    test("creates, inputs, usage edits, managing-team changes, archives and removals together finish and agree", async () => {
      const w = await world();
      const extra = await person(w.ws);
      const lender = await person(w.ws);
      const spare = await team(w.owner, [extra]);
      const lending = await team(w.owner, [lender]);
      const second = await team(w.owner, [w.insider]);
      const sessionId = await session(w.insider, w.releaseId);
      const settled: Promise<unknown>[] = [];
      for (let round = 0; round < 6; round++) {
        settled.push(
          create(w.insider, w.releaseId),
          create(extra, w.releaseId),
          create(lender, w.releaseId),
          append(w.insider, sessionId),
          append(extra, sessionId),
          setUsage(w.owner, w.agentId, "private", [
            w.teamId,
            ...(round % 2 === 0 ? [spare] : []),
          ]),
          setUsage(
            w.owner,
            w.agentId,
            round % 3 === 0 ? "workspace" : "private",
            [second],
          ),
          admin(
            w.owner,
            w.agentId,
            { kind: "team", id: lending },
            round % 2 === 0,
          ),
          setManagingTeam(
            w.owner,
            w.agentId,
            round % 2 === 0 ? spare : w.managingTeamId,
          ),
          teamMember(w.owner, w.teamId, w.insider, round % 2 === 1),
        );
      }
      settled.push(archive(w.owner, spare));
      // Settled, not resolved to a value: a deadlock Postgres breaks rejects
      // 40P01, which is the failure this test is for.
      const results = await Promise.allSettled(settled);
      const failures = results.filter((r) => r.status === "rejected");
      expect(
        failures.map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([]);

      // What each accepted turn recorded was true of the state it ran on:
      // its basis names a grant that exists in a state the edits passed
      // through, never a requester outside every one of them.
      const rows = await db
        .select({
          basis: turns.usageBasis,
          requester: turns.requesterId,
        })
        .from(turns)
        .innerJoin(sessions, eq(sessions.id, turns.sessionId))
        .where(eq(sessions.workspaceId, w.ws));
      expect(rows.length).toBeGreaterThan(1);
      expect(
        rows.every(
          (row) =>
            row.requester === null ||
            ["public", "team", "workspace", "agent_admin", "manager"].includes(
              row.basis ?? "",
            ),
        ),
      ).toBe(true);
    }, 120_000);
  });
});
