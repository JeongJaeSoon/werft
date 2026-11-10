import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
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
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentAdminStore } from "./agent-admins.ts";
import { createPostgresWorkspaceKeyStore } from "./api-keys.ts";
import { createPostgresInviteStore } from "./invites.ts";
import { createPostgresLinkedAccountStore } from "./linked-accounts.ts";
import { createPostgresTeamStore } from "./member-teams.ts";
import { createPostgresMemberStore } from "./members.ts";
import { createPostgresPendingRequests } from "./pending-requests.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import { findApiKey, touchApiKey } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  apiKeys,
  attempts,
  linkedAccounts,
  memberships,
  pendingRequests,
  turns,
  users,
  workspaces,
} from "./schema.ts";
import { createPostgresSessionShareStore } from "./session-shares.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import {
  fixtureRelease,
  releaseSpecColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];
// A write whose turn or answer carries this pauses inside its transaction,
// every lock it took held (the trigger installed in beforeAll).
const HOLD = "hold-locks";
const LIMITS = { queuedInputLimitPerSession: 10_000, storageLimitBytes: 1e15 };

// 94S-834: the policy decides before the write opens. Each test here lets a
// revocation commit after that decision and before the write, the window the
// write must re-judge.
integration("session writes re-judge their requester on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_write_races_it" });
    pool = new Pool({ connectionString: database.url, max: 24 });
    db = drizzle(pool, { schema });
    await pool.query(`
      CREATE FUNCTION test_hold_locks() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_TABLE_NAME = 'turns' THEN
          IF NEW.message = '${HOLD}' THEN PERFORM pg_sleep(1); END IF;
        ELSIF NEW.answer->>'reason' = '${HOLD}' THEN
          PERFORM pg_sleep(1);
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_hold_locks BEFORE INSERT ON turns
        FOR EACH ROW EXECUTE FUNCTION test_hold_locks();
      CREATE TRIGGER test_hold_locks BEFORE UPDATE ON pending_requests
        FOR EACH ROW EXECUTE FUNCTION test_hold_locks();
    `);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const uow = () => createPostgresSessionUnitOfWork(db);
  const shares = () => createPostgresSessionShareStore(db);
  const teams = () => createPostgresTeamStore(db);
  const admins = () => createPostgresAgentAdminStore(db);
  const keys = () => createPostgresWorkspaceKeyStore(db);
  const links = () => createPostgresLinkedAccountStore(db);
  const members = () => createPostgresMemberStore(db);
  const invites = () => createPostgresInviteStore(db);
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
    // Workspace sessions stay visible to people outside an agent's team, so
    // these tests reach the role check rather than the visibility one.
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

  const SCOPES: SessionScope[] = [
    "sessions:read",
    "sessions:write",
    "sessions:approve",
  ];

  async function key(
    workspaceId: string,
    kind: { agentId?: string } | { personalOf: Caller },
  ) {
    const id = randomUUID();
    const personal = "personalOf" in kind;
    // No key reaches a whole workspace: one without a person is an agent's,
    // and starts sessions on that agent's release.
    const release = personal
      ? null
      : kind.agentId
        ? { agentId: kind.agentId, releaseId: undefined }
        : await agentRelease(workspaceId);
    await db.insert(apiKeys).values({
      id,
      keyHash: Buffer.from(randomUUID()),
      ownerId: workspaceId,
      workspaceId,
      kind: personal ? "personal" : "agent",
      scopes: SCOPES,
      createdByUserId: personal ? idOf(kind.personalOf) : null,
      agentId: release?.agentId ?? null,
    });
    const caller = callerFor(
      {
        kind: "api_key",
        id,
        owner_id: workspaceId,
        workspace_id: workspaceId,
        scopes: SCOPES,
      },
      { kind: "api" },
      randomUUID(),
      { creatorId: personal ? idOf(kind.personalOf) : null },
    );
    return { id, caller, releaseId: release?.releaseId };
  }

  // A person speaking through Slack, as the channel would hand the write.
  async function slackLink(who: Caller) {
    const id = randomUUID();
    await db.insert(linkedAccounts).values({
      id,
      workspaceId: who.ownerId,
      userId: idOf(who),
      provider: "slack",
      externalTenant: "T0",
      externalUserId: `U${id.slice(0, 8)}`,
      verifiedVia: "slack_oidc",
      verifiedAt: new Date(),
    });
    const actor = who.actor;
    if (!actor) throw new Error("no actor");
    const caller: Caller = {
      ...who,
      actor: { ...actor, linkedAccount: { id, revision: 1 } },
    };
    return { id, caller };
  }

  async function agentRelease(workspaceId: string, createdBy?: Caller) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
      createdBy: createdBy ? idOf(createdBy) : null,
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
    return { agentId, releaseId };
  }

  async function create(
    by: Caller,
    releaseId?: string,
    idempotencyKey?: string,
  ) {
    return uow().acceptInputAtomic({
      principal: by,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      payloadHash: "create",
      model: TEST_MODEL,
      repository: "none",
      agentReleaseId: releaseId ?? (await fixtureRelease(db)),
      message: "start",
      limits: LIMITS,
    });
  }

  async function session(by: Caller, releaseId?: string) {
    const created = await create(by, releaseId);
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    return created.response.session_id;
  }

  const append = (
    by: Caller,
    sessionId: string,
    idempotencyKey?: string,
    message = "more",
  ) =>
    uow().appendInputAtomic({
      principal: by,
      sessionId,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      payloadHash: "append",
      message,
      limits: LIMITS,
    });

  const share = (
    by: Caller,
    sessionId: string,
    scope: "workspace" | "private" | "people" | "team",
    targets: { userIds?: string[]; teamIds?: string[] } = {},
  ) =>
    shares().set({
      principal: by,
      ownerId: by.ownerId,
      workspaceId: by.ownerId,
      sessionId,
      scope,
      userIds: targets.userIds ?? [],
      teamIds: targets.teamIds ?? [],
      updatedBy: idOf(by),
      receiptId: randomUUID(),
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

  const revokeKey = (by: Caller, keyId: string) =>
    keys().revoke({
      principal: by,
      workspaceId: by.ownerId,
      keyId,
      receiptId: randomUUID(),
      revokerRoles: MANAGERS,
    });

  const unlink = (who: Caller, linkedAccountId: string) =>
    links().unlink({
      principal: who,
      workspaceId: who.ownerId,
      userId: idOf(who),
      linkedAccountId,
    });

  const setDisabled = (by: Caller, who: Caller, disabled: boolean) =>
    members().setAccess({
      actor: acting(by),
      userId: idOf(who),
      scope: "membership",
      disabled,
      reason: null,
      receiptId: randomUUID(),
    });

  const setRole = (by: Caller, who: Caller, role: "admin" | "member") =>
    invites().changeMemberRole({
      actor: acting(by),
      userId: idOf(who),
      role,
      receiptId: randomUUID(),
    });

  // A permission request the session's running turn is waiting on.
  async function waitingRequest(sessionId: string) {
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
    if (!turn) throw new Error("no first turn");
    const requestId = `req_${randomUUID()}`;
    await db.insert(pendingRequests).values({
      requestId,
      sessionId,
      turnId: turn.id,
      attemptId,
      kind: "permission",
      payload: { kind: "permission", tool: "Bash", input: { command: "ls" } },
      inputHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return requestId;
  }

  const answer = (
    by: Caller,
    sessionId: string,
    requestId: string,
    idempotencyKey?: string,
    hold = false,
  ) =>
    pending().answerAtomic({
      principal: by,
      sessionId,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      payloadHash: "answer",
      answer: hold
        ? {
            request_id: requestId,
            kind: "permission",
            decision: "deny",
            reason: HOLD,
          }
        : { request_id: requestId, kind: "permission", decision: "allow" },
      approval: { surface: "web", decisionId: randomUUID() },
    });

  async function answeredAt(requestId: string) {
    const [row] = await db
      .select({ answeredAt: pendingRequests.answeredAt })
      .from(pendingRequests)
      .where(eq(pendingRequests.requestId, requestId));
    return row?.answeredAt ?? null;
  }

  describe("the requester", () => {
    test("an agent key revoked after the decision creates and appends nothing", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const live = await key(ws, {});
      const sessionId = await session(live.caller, live.releaseId);
      expect(await revokeKey(owner, live.id)).toMatchObject({
        outcome: "revoked",
      });
      expect(await create(live.caller, live.releaseId)).toEqual({
        outcome: "actor_inactive",
      });
      expect(await append(live.caller, sessionId)).toEqual({
        outcome: "actor_inactive",
      });
    });

    test("a personal key revoked after the decision creates and appends nothing", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const holder = await person(ws);
      const personal = await key(ws, { personalOf: holder });
      const sessionId = await session(personal.caller);
      expect(await revokeKey(owner, personal.id)).toMatchObject({
        outcome: "revoked",
      });
      expect(await create(personal.caller)).toEqual({
        outcome: "actor_inactive",
      });
      expect(await append(personal.caller, sessionId)).toEqual({
        outcome: "actor_inactive",
      });
    });

    test("a key that expired after the decision creates nothing", async () => {
      const ws = await workspace();
      const live = await key(ws, {});
      await db
        .update(apiKeys)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(apiKeys.id, live.id));
      expect(await create(live.caller, live.releaseId)).toEqual({
        outcome: "actor_inactive",
      });
    });

    test("a key bound to an agent creates nothing on another agent's release", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const mine = await agentRelease(ws, owner);
      const other = await agentRelease(ws, owner);
      const bound = await key(ws, { agentId: mine.agentId });
      expect(await create(bound.caller, mine.releaseId)).toMatchObject({
        outcome: "accepted",
      });
      expect(await create(bound.caller, other.releaseId)).toEqual({
        outcome: "actor_inactive",
      });
    });

    test("a Slack link removed after the decision creates and appends nothing", async () => {
      const ws = await workspace();
      const speaker = await person(ws);
      const slack = await slackLink(speaker);
      const sessionId = await session(slack.caller);
      expect(await unlink(speaker, slack.id)).toMatchObject({
        outcome: "unlinked",
      });
      expect(await create(slack.caller)).toEqual({ outcome: "actor_inactive" });
      expect(await append(slack.caller, sessionId)).toEqual({
        outcome: "actor_inactive",
      });
      // The person on the web is still themselves.
      expect(await append(speaker, sessionId)).toMatchObject({
        outcome: "accepted",
      });
    });

    test("a Slack link relinked since the decision is not the one decided on", async () => {
      const ws = await workspace();
      const speaker = await person(ws);
      const slack = await slackLink(speaker);
      const sessionId = await session(slack.caller);
      await db
        .update(linkedAccounts)
        .set({ revision: 2 })
        .where(eq(linkedAccounts.id, slack.id));
      expect(await append(slack.caller, sessionId)).toEqual({
        outcome: "actor_inactive",
      });
    });
  });

  describe("the share", () => {
    test("an input after the share narrowed to other people is not found", async () => {
      const ws = await workspace();
      const creator = await person(ws);
      const viewer = await person(ws);
      const other = await person(ws);
      const sessionId = await session(creator);
      expect(
        await share(creator, sessionId, "people", {
          userIds: [idOf(other)],
        }),
      ).toMatchObject({ outcome: "changed" });
      expect(await append(viewer, sessionId)).toEqual({ outcome: "not_found" });
      expect(await append(other, sessionId)).toMatchObject({
        outcome: "accepted",
      });
      expect(await append(creator, sessionId)).toMatchObject({
        outcome: "accepted",
      });
    });

    test("an input after leaving the share's team, or the team's archive, is not found", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const creator = await person(ws);
      const leaver = await person(ws);
      const stayer = await person(ws);
      const teamId = await team(owner, [leaver, stayer]);
      const sessionId = await session(creator);
      await share(creator, sessionId, "team", { teamIds: [teamId] });
      expect(await append(leaver, sessionId)).toMatchObject({
        outcome: "accepted",
      });
      expect(await teamMember(owner, teamId, leaver, false)).toMatchObject({
        outcome: "removed",
      });
      expect(await append(leaver, sessionId)).toEqual({ outcome: "not_found" });
      expect(await append(stayer, sessionId)).toMatchObject({
        outcome: "accepted",
      });
      expect(
        await teams().delete({
          actor: acting(owner),
          receiptId: randomUUID(),
          teamId,
        }),
      ).toMatchObject({ outcome: "deleted" });
      expect(await append(stayer, sessionId)).toEqual({ outcome: "not_found" });
    });

    test("a key's own session stays its own under any share", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const service = await key(ws, {});
      const sessionId = await session(service.caller, service.releaseId);
      await db.insert(schema.sessionShares).values({
        sessionId,
        ownerId: ws,
        workspaceId: ws,
        scope: "private",
        revision: 1,
      });
      expect(await append(service.caller, sessionId)).toMatchObject({
        outcome: "accepted",
      });
      expect(await append(owner, sessionId)).toEqual({ outcome: "not_found" });
    });

    test("a retry of an input accepted before the share narrowed replays; a new one is refused", async () => {
      const ws = await workspace();
      const creator = await person(ws);
      const viewer = await person(ws);
      const sessionId = await session(creator);
      const first = await append(viewer, sessionId, "retry-key");
      expect(first).toMatchObject({ outcome: "accepted" });
      await share(creator, sessionId, "private");
      const again = await append(viewer, sessionId, "retry-key");
      expect(again).toMatchObject({ outcome: "replayed" });
      if (first.outcome === "accepted" && again.outcome === "replayed") {
        expect(again.response.turn_id).toBe(first.response.turn_id);
      }
      expect(await append(viewer, sessionId)).toEqual({ outcome: "not_found" });
    });

    test("a retry of a create accepted before the key was revoked replays; a new one is refused", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const live = await key(ws, {});
      expect(
        await create(live.caller, live.releaseId, "create-key"),
      ).toMatchObject({
        outcome: "accepted",
      });
      await revokeKey(owner, live.id);
      expect(
        await create(live.caller, live.releaseId, "create-key"),
      ).toMatchObject({
        outcome: "replayed",
      });
      expect(await create(live.caller, live.releaseId)).toEqual({
        outcome: "actor_inactive",
      });
    });

    // The first change used to queue only at its placeholder insert's
    // foreign key check, and a later one, with the row there, not at all.
    test("a share change, first or later, waits for an input that holds the session row", async () => {
      const ws = await workspace();
      const creator = await person(ws);
      const sessionId = await session(creator);
      for (const scope of ["private", "workspace"] as const) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE",
            [sessionId],
          );
          let settled = false;
          const change = share(creator, sessionId, scope).then((result) => {
            settled = true;
            return result;
          });
          await Bun.sleep(300);
          expect({ scope, settled }).toEqual({ scope, settled: false });
          await client.query("COMMIT");
          expect(await change).toMatchObject({ outcome: "changed" });
        } finally {
          client.release();
        }
      }
    });
  });

  describe("the answer", () => {
    async function answerable() {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const creator = await person(ws);
      const { agentId, releaseId } = await agentRelease(ws, owner);
      const sessionId = await session(creator, releaseId);
      const requestId = await waitingRequest(sessionId);
      return { ws, owner, creator, agentId, sessionId, requestId };
    }

    test("a key of the session's agent answers; a key of another agent, or a revoked one, does not (GA-8)", async () => {
      const { ws, owner, agentId, sessionId, requestId } = await answerable();
      const other = await key(ws, {});
      expect(await answer(other.caller, sessionId, requestId)).toEqual({
        outcome: "role",
      });
      const revoked = await key(ws, { agentId });
      await revokeKey(owner, revoked.id);
      expect(await answer(revoked.caller, sessionId, requestId)).toEqual({
        outcome: "actor_inactive",
      });
      expect(await answeredAt(requestId)).toBeNull();
      const team = await key(ws, { agentId });
      expect(await answer(team.caller, sessionId, requestId)).toMatchObject({
        outcome: "accepted",
      });
      expect(await answeredAt(requestId)).not.toBeNull();
    });

    test("an agent admin removed after the decision answers nothing", async () => {
      const { ws, owner, agentId, sessionId, requestId } = await answerable();
      const helper = await person(ws);
      await admin(owner, agentId, { kind: "user", id: idOf(helper) });
      await admin(owner, agentId, { kind: "user", id: idOf(helper) }, false);
      expect(await answer(helper, sessionId, requestId)).toEqual({
        outcome: "role",
      });
      expect(await answeredAt(requestId)).toBeNull();
    });

    test("an admin through a team answers until they leave it, or it leaves the agent", async () => {
      const { ws, owner, agentId, sessionId } = await answerable();
      const helper = await person(ws);
      const teamId = await team(owner, [helper]);
      await admin(owner, agentId, { kind: "team", id: teamId });
      const kept = await waitingRequest(sessionId);
      expect(await answer(helper, sessionId, kept)).toMatchObject({
        outcome: "accepted",
      });

      const left = await waitingRequest(sessionId);
      await teamMember(owner, teamId, helper, false);
      expect(await answer(helper, sessionId, left)).toEqual({
        outcome: "role",
      });
      expect(await answeredAt(left)).toBeNull();

      await teamMember(owner, teamId, helper);
      await admin(owner, agentId, { kind: "team", id: teamId }, false);
      expect(await answer(helper, sessionId, left)).toEqual({
        outcome: "role",
      });
      expect(await answeredAt(left)).toBeNull();
    });

    test("a workspace admin demoted after the decision answers nothing", async () => {
      const { ws, owner, sessionId, requestId } = await answerable();
      const manager = await person(ws, "admin");
      expect(await setRole(owner, manager, "member")).toMatchObject({
        outcome: "changed",
      });
      expect(await answer(manager, sessionId, requestId)).toEqual({
        outcome: "role",
      });
      expect(await answeredAt(requestId)).toBeNull();
    });

    test("a member disabled after the decision answers nothing", async () => {
      const { owner, creator, sessionId, requestId } = await answerable();
      expect(await setDisabled(owner, creator, true)).toMatchObject({
        outcome: "changed",
      });
      expect(await answer(creator, sessionId, requestId)).toEqual({
        outcome: "actor_inactive",
      });
      expect(await answeredAt(requestId)).toBeNull();
    });

    test("a manager outside a narrowed share does not find it", async () => {
      const { owner, creator, sessionId, requestId } = await answerable();
      await share(creator, sessionId, "private");
      expect(await answer(owner, sessionId, requestId)).toEqual({
        outcome: "not_found",
      });
      expect(await answeredAt(requestId)).toBeNull();
      expect(await answer(creator, sessionId, requestId)).toMatchObject({
        outcome: "accepted",
      });
    });

    test("a retry of an answer accepted before the demotion replays", async () => {
      const { ws, owner, sessionId, requestId } = await answerable();
      const manager = await person(ws, "admin");
      expect(
        await answer(manager, sessionId, requestId, "answer-key"),
      ).toMatchObject({ outcome: "accepted" });
      await setRole(owner, manager, "member");
      expect(
        await answer(manager, sessionId, requestId, "answer-key"),
      ).toMatchObject({ outcome: "replayed" });
      const next = await waitingRequest(sessionId);
      expect(await answer(manager, sessionId, next)).toEqual({
        outcome: "role",
      });
    });
  });

  // The other side of each race: a write that already holds its rows makes
  // the revocation wait, so it is judged wholly before the revocation.
  describe("a write that holds its rows", () => {
    async function revocationWaits(
      write: Promise<{ outcome: string }>,
      revoke: () => Promise<unknown>,
    ) {
      let written = false;
      const done = write.then((result) => {
        written = true;
        return result;
      });
      await Bun.sleep(300);
      expect(written).toBe(false);
      await revoke();
      expect(written).toBe(true);
      expect(await done).toMatchObject({ outcome: "accepted" });
    }

    test("a key revoke and a Slack unlink wait for an input", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const speaker = await person(ws);
      const live = await key(ws, {});
      const keySession = await session(live.caller, live.releaseId);
      await revocationWaits(
        append(live.caller, keySession, undefined, HOLD),
        () => revokeKey(owner, live.id),
      );
      const slack = await slackLink(speaker);
      const slackSession = await session(slack.caller);
      await revocationWaits(
        append(slack.caller, slackSession, undefined, HOLD),
        () => unlink(speaker, slack.id),
      );
    }, 30_000);

    // 94S-881: the other way round, authenticating a key never waits for an
    // input that holds its row; recording the use skips the row instead.
    test("a key's auth and last-use touch neither wait for nor deadlock with an input holding the key", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      for (let round = 0; round < 10; round++) {
        const live =
          round % 2 === 0
            ? await key(ws, {})
            : await key(ws, { personalOf: owner });
        const sessionId = await session(live.caller, live.releaseId);
        const [stored] = await db
          .select({ hash: apiKeys.keyHash })
          .from(apiKeys)
          .where(eq(apiKeys.id, live.id));
        if (!stored) throw new Error("no key row");
        let written = false;
        const write = append(live.caller, sessionId, undefined, HOLD).then(
          (result) => {
            written = true;
            return result;
          },
        );
        await Bun.sleep(300);

        const started = performance.now();
        expect((await findApiKey(db, stored.hash))?.touchDue).toBe(true);
        expect(await touchApiKey(db, live.id)).toBe(false);
        const elapsed = performance.now() - started;
        expect(elapsed).toBeLessThan(250);
        // The row was held: a plain update has to wait for it.
        const plain = db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
          await tx
            .update(apiKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(apiKeys.id, live.id));
        });
        expect(plain).rejects.toMatchObject({ cause: { code: "55P03" } });
        await plain.catch(() => undefined);
        expect(written).toBe(false);

        expect(await write).toMatchObject({ outcome: "accepted" });
        expect(await touchApiKey(db, live.id)).toBe(true);
      }
    }, 60_000);

    test("a share change, a team member's removal and a team's archive wait for an input", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const creator = await person(ws);
      const viewer = await person(ws);
      const teamId = await team(owner, [viewer]);
      const sessionId = await session(creator);
      await share(creator, sessionId, "team", { teamIds: [teamId] });
      await revocationWaits(append(viewer, sessionId, undefined, HOLD), () =>
        teamMember(owner, teamId, viewer, false),
      );
      await teamMember(owner, teamId, viewer);
      await revocationWaits(append(viewer, sessionId, undefined, HOLD), () =>
        teams().delete({
          actor: acting(owner),
          receiptId: randomUUID(),
          teamId,
        }),
      );
      await share(creator, sessionId, "workspace");
      await revocationWaits(append(viewer, sessionId, undefined, HOLD), () =>
        share(creator, sessionId, "private"),
      );
    }, 30_000);

    test("an admin's removal, a demotion and a disable wait for an answer", async () => {
      const ws = await workspace();
      const owner = await person(ws, "owner");
      const creator = await person(ws);
      const helper = await person(ws);
      const viaTeam = await person(ws);
      const manager = await person(ws, "admin");
      const { agentId, releaseId } = await agentRelease(ws, owner);
      const sessionId = await session(creator, releaseId);
      await admin(owner, agentId, { kind: "user", id: idOf(helper) });
      const teamId = await team(owner, [viaTeam]);
      await admin(owner, agentId, { kind: "team", id: teamId });

      const held = async (by: Caller) =>
        answer(by, sessionId, await waitingRequest(sessionId), undefined, true);
      await revocationWaits(held(helper), () =>
        admin(owner, agentId, { kind: "user", id: idOf(helper) }, false),
      );
      await revocationWaits(held(viaTeam), () =>
        admin(owner, agentId, { kind: "team", id: teamId }, false),
      );
      await revocationWaits(held(manager), () =>
        setRole(owner, manager, "member"),
      );
      await revocationWaits(held(creator), () =>
        setDisabled(owner, creator, true),
      );
    }, 30_000);

    test("a key that lapses while its row is locked creates nothing", async () => {
      const ws = await workspace();
      const live = await key(ws, {});
      const lapsesAt = Date.now() + 1_500;
      await db
        .update(apiKeys)
        .set({ expiresAt: new Date(lapsesAt) })
        .where(eq(apiKeys.id, live.id));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          "SELECT pg_backend_pid() AS pid FROM api_keys WHERE id = $1 FOR UPDATE",
          [live.id],
        );
        const holder = rows[0]?.pid;
        const created = create(live.caller, live.releaseId);
        // The create must be queued on the key row before the key lapses,
        // or this would not tell a check before the lock from one after it.
        let queued = false;
        while (!queued && Date.now() < lapsesAt) {
          const waiting = await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))",
            [holder],
          );
          queued = (waiting.rowCount ?? 0) > 0;
          if (!queued) await Bun.sleep(20);
        }
        expect(queued).toBe(true);
        await Bun.sleep(Math.max(0, lapsesAt - Date.now()) + 200);
        await client.query("COMMIT");
        expect(await created).toEqual({ outcome: "actor_inactive" });
      } finally {
        client.release();
      }
    }, 30_000);
  });

  test("concurrent uses record a key once, and a revoke in flight leaves it unrecorded", async () => {
    const ws = await workspace();
    for (let round = 0; round < 10; round++) {
      const live = await key(ws, {});
      const touched = await Promise.all(
        Array.from({ length: 8 }, () => touchApiKey(db, live.id)),
      );
      expect(touched.filter(Boolean)).toHaveLength(1);

      const revoked = await key(ws, {});
      const revoker = await pool.connect();
      try {
        await revoker.query("BEGIN");
        await revoker.query("SELECT 1 FROM api_keys WHERE id = $1 FOR UPDATE", [
          revoked.id,
        ]);
        await revoker.query(
          "UPDATE api_keys SET revoked_at = clock_timestamp() WHERE id = $1",
          [revoked.id],
        );
        expect(await touchApiKey(db, revoked.id)).toBe(false);
        await revoker.query("COMMIT");
      } finally {
        revoker.release();
      }
      expect(await touchApiKey(db, revoked.id)).toBe(false);
      const [row] = await db
        .select({ at: apiKeys.lastUsedAt })
        .from(apiKeys)
        .where(eq(apiKeys.id, revoked.id));
      expect(row?.at).toBeNull();
    }
  }, 60_000);

  // Every write in the lock order run against each other, round after round:
  // a cycle among them would end one with a deadlock (40P01).
  test("inputs, answers and every revocation they race run together without deadlock", async () => {
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const creator = await person(ws);
    const helper = await person(ws);
    const viewer = await person(ws);
    const { agentId, releaseId } = await agentRelease(ws, owner);
    const teamId = await team(owner, [helper, viewer]);
    const sessionId = await session(creator, releaseId);
    const failures: unknown[] = [];
    for (let round = 0; round < 15; round++) {
      const service = await key(ws, { agentId });
      const personal = await key(ws, { personalOf: viewer });
      const slack = await slackLink(viewer);
      const requestId = await waitingRequest(sessionId);
      const flip = round % 2 === 0;
      const results = await Promise.allSettled([
        append(creator, sessionId),
        append(viewer, sessionId),
        append(helper, sessionId),
        append(service.caller, sessionId),
        append(personal.caller, sessionId),
        append(slack.caller, sessionId),
        create(service.caller, releaseId),
        create(slack.caller),
        answer(helper, sessionId, requestId),
        answer(owner, sessionId, requestId),
        share(creator, sessionId, flip ? "team" : "people", {
          teamIds: [teamId],
          userIds: [idOf(viewer)],
        }),
        teamMember(owner, teamId, viewer, !flip),
        admin(owner, agentId, { kind: "team", id: teamId }, flip),
        admin(owner, agentId, { kind: "user", id: idOf(helper) }, !flip),
        revokeKey(owner, service.id),
        revokeKey(owner, personal.id),
        touchApiKey(db, service.id),
        touchApiKey(db, personal.id),
        unlink(viewer, slack.id),
        setRole(owner, helper, flip ? "admin" : "member"),
        setDisabled(owner, viewer, flip),
      ]);
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      // Bring the viewer back for the next round.
      await setDisabled(owner, viewer, false);
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
