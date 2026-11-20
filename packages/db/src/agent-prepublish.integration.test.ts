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
import { createPostgresPullRequests } from "./action/pull-requests.ts";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { agentUsable } from "./musterrolle/administers.ts";
import { createPostgresAgentAdminStore } from "./musterrolle/agent-admins.ts";
import { createDatabaseAgentAuthority } from "./musterrolle/agent-authority.ts";
import { createPostgresTeamStore } from "./musterrolle/member-teams.ts";
import { createPostgresSessionShareStore } from "./musterrolle/session-shares.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  memberships,
  memberTeamMembers,
  sessionShares,
  sessionShareTargets,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { createPostgresPendingRequests } from "./sessions/pending-requests.ts";
import {
  lockAgentUse,
  lockPreviewManager,
  lockRequester,
  lockSessionReach,
} from "./sessions/requester-locks.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
} from "./testing/spec-pins.ts";
import { createPostgresAgentUsageStore, usageOf } from "./usage/agent-usage.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];
const LIMITS = { queuedInputLimitPerSession: 10_000, storageLimitBytes: 1e15 };

// An agent with no active release is unpublished: only its admins and the
// workspace's owners and admins reach it, on every path that judges it.
integration("unpublished agents and preview sessions on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_prepublish_it" });
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

  // The agent with one release, never activated: unpublished.
  async function agent(workspaceId: string, managingTeamId?: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: managingTeamId ?? (await fixtureTeam(db, workspaceId)),
      slug: `a-${agentId.slice(0, 8)}`,
      name: `agent ${agentId.slice(0, 4)}`,
      status: "active",
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
    return { agentId, releaseId, versionId };
  }

  const publish = (agentId: string, releaseId: string) =>
    db
      .update(agents)
      .set({ activeReleaseId: releaseId, activationRevision: 1 })
      .where(eq(agents.id, agentId));

  async function team(by: Caller, people: Caller[]) {
    const created = await teams().create({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId: randomUUID(),
      name: `team-${randomUUID()}`,
    });
    if (created.outcome !== "created") throw new Error(created.outcome);
    for (const who of people) {
      await teams().addMember({
        actor: acting(by),
        receiptId: randomUUID(),
        teamId: created.team.id,
        userId: idOf(who),
      });
    }
    return created.team.id;
  }

  const admin = (by: Caller, agentId: string, userId: string) =>
    admins().add({
      actor: acting(by),
      receiptId: randomUUID(),
      agentId,
      subject: { kind: "user", id: userId },
      managerRoles: MANAGERS,
    });

  async function world() {
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const wsAdmin = await person(ws, "admin");
    const directAdmin = await person(ws);
    const lead = await person(ws);
    const managingMember = await person(ws);
    const usageMember = await person(ws);
    const outsider = await person(ws);
    const managingTeamId = await team(owner, [lead, managingMember]);
    await db
      .update(memberTeamMembers)
      .set({ role: "lead" })
      .where(
        and(
          eq(memberTeamMembers.teamId, managingTeamId),
          eq(memberTeamMembers.userId, idOf(lead)),
        ),
      );
    const usageTeam = await team(owner, [usageMember]);
    const made = await agent(ws, managingTeamId);
    await admin(owner, made.agentId, idOf(directAdmin));
    return {
      ws,
      owner,
      wsAdmin,
      directAdmin,
      lead,
      managingMember,
      usageMember,
      outsider,
      usageTeam,
      ...made,
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  // Every path that judges whether a person reaches the agent, asked the
  // same thing about the same rows.
  async function paths(w: World, caller: Caller) {
    const userId = idOf(caller);
    const role = (
      await db
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, w.ws),
            eq(memberships.userId, userId),
          ),
        )
    )[0]?.role as WorkspaceRole;
    const who = { userId, role, keyAgentId: null };
    const decision = await usageOf(db, {
      workspaceId: w.ws,
      agentId: w.agentId,
      who,
      lock: false,
    });
    const predicate =
      (
        await db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.id, w.agentId),
              agentUsable(db, w.ws, { userId, keyAgentId: null }, agents.id),
            ),
          )
      ).length === 1;
    const inside = await createDatabaseAgentAuthority(db).isInside?.(
      w.ws,
      w.agentId,
      userId,
    );
    const listed = (
      await createPostgresAgentStore(db).list(w.ws, { limit: 50 }, { userId })
    ).items.some((item) => item.id === w.agentId);
    const locked = await db.transaction(async (tx) => {
      const requester = await lockRequester(tx, caller, "sessions:write");
      if (!requester) return false;
      const usageLocked = await usageOf(tx, {
        workspaceId: w.ws,
        agentId: w.agentId,
        who,
        lock: true,
      });
      return (
        usageLocked.allowed &&
        (await lockAgentUse(tx, requester, w.ws, w.releaseId))
      );
    });
    return {
      usage: decision.allowed,
      predicate,
      inside: inside === true,
      listed,
      locked,
    };
  }

  const all = (value: boolean) => ({
    usage: value,
    predicate: value,
    inside: value,
    listed: value,
    locked: value,
  });

  test("every path hides an unpublished agent from its managing team's members and usage teams alike", async () => {
    const w = await world();
    // Open to the workspace: the scope does not reach past publishing.
    const table: [string, Caller, boolean][] = [
      ["workspace owner", w.owner, true],
      ["workspace admin", w.wsAdmin, true],
      ["direct agent admin", w.directAdmin, true],
      ["lead of the managing team", w.lead, true],
      ["member of the managing team", w.managingMember, false],
      ["member outside every team", w.outsider, false],
    ];
    for (const [name, caller, expected] of table) {
      expect({ name, ...(await paths(w, caller)) }).toEqual({
        name,
        ...all(expected),
      });
    }

    const current = await usage().get(w.ws, w.agentId);
    const set = await usage().put({
      actor: acting(w.owner),
      receiptId: randomUUID(),
      agentId: w.agentId,
      scope: "private",
      teamIds: [w.usageTeam],
      ifMatch: current?.revision ?? 1,
      managerRoles: MANAGERS,
    });
    expect(set).toMatchObject({ outcome: "set" });
    const usageOnly = await paths(w, w.usageMember);
    expect(usageOnly.usage).toBe(false);
    expect(usageOnly.predicate).toBe(false);

    // Published, the agent reads as it always did.
    await publish(w.agentId, w.releaseId);
    expect(await paths(w, w.managingMember)).toEqual(all(true));
    const published = await paths(w, w.usageMember);
    expect(published.usage).toBe(true);
    expect(published.predicate).toBe(true);
  });

  test("a key bound to the unpublished agent still uses it and reads its own row", async () => {
    const w = await world();
    const decision = await usageOf(db, {
      workspaceId: w.ws,
      agentId: w.agentId,
      who: { userId: null, role: null, keyAgentId: w.agentId },
      lock: false,
    });
    expect(decision).toEqual({
      allowed: true,
      basis: "agent_key",
      teamId: null,
    });
    const unbound = await usageOf(db, {
      workspaceId: w.ws,
      agentId: w.agentId,
      who: { userId: null, role: null, keyAgentId: null },
      lock: false,
    });
    expect(unbound.allowed).toBe(false);
    expect(
      (
        await db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.id, w.agentId),
              agentUsable(
                db,
                w.ws,
                { userId: null, keyAgentId: w.agentId },
                agents.id,
              ),
            ),
          )
      ).length,
    ).toBe(1);
  });

  // Sessions of an unpublished agent, as only rows could make them: the
  // write path makes only previews, which are private.
  async function sessionOf(w: World, scope: "workspace" | "people") {
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: w.ws,
      workspaceId: w.ws,
      createdByUserId: idOf(w.owner),
      repositoryMode: "none",
      ...sessionPinColumns(),
      agentReleaseId: w.releaseId,
    });
    await db.insert(sessionShares).values({
      sessionId,
      ownerId: w.ws,
      workspaceId: w.ws,
      scope,
    });
    if (scope === "people") {
      await db.insert(sessionShareTargets).values({
        id: randomUUID(),
        workspaceId: w.ws,
        sessionId,
        userId: idOf(w.managingMember),
      });
    }
    return sessionId;
  }

  // The reader does not judge shares; the policy asks visibleTo first.
  async function sessionPaths(w: World, caller: Caller, sessionId: string) {
    const viewer = { userId: idOf(caller), apiKeyId: null, keyAgentId: null };
    const visible = await createPostgresSessionShareStore(db).visibleTo(
      w.ws,
      sessionId,
      viewer,
    );
    const locked = await db.transaction(async (tx) => {
      const requester = await lockRequester(tx, caller, "sessions:read");
      if (!requester) return "gone";
      return lockSessionReach(tx, requester, {
        id: sessionId,
        workspaceId: w.ws,
        createdByUserId: idOf(w.owner),
        createdByApiKeyId: null,
        agentReleaseId: w.releaseId,
      });
    });
    return { visible, locked: locked === "ok" };
  }

  test("a workspace-wide session of an unpublished agent reaches its admins alone; a people share reaches whom it names", async () => {
    const w = await world();
    const wide = await sessionOf(w, "workspace");
    const sees = { visible: true, locked: true };
    const hidden = { visible: false, locked: false };
    expect(await sessionPaths(w, w.lead, wide)).toEqual(sees);
    expect(await sessionPaths(w, w.directAdmin, wide)).toEqual(sees);
    expect(await sessionPaths(w, w.managingMember, wide)).toEqual(hidden);
    expect(await sessionPaths(w, w.outsider, wide)).toEqual(hidden);

    const named = await sessionOf(w, "people");
    expect(await sessionPaths(w, w.managingMember, named)).toEqual(sees);
    expect(await sessionPaths(w, w.outsider, named)).toEqual(hidden);

    await publish(w.agentId, w.releaseId);
    expect(await sessionPaths(w, w.managingMember, wide)).toEqual(sees);
  });

  const startPreview = (by: Caller, releaseId: string) =>
    uow().acceptInputAtomic({
      principal: by,
      idempotencyKey: randomUUID(),
      payloadHash: "create",
      model: TEST_MODEL,
      repository: "none",
      agentReleaseId: releaseId,
      preview: true,
      shareScope: "private",
      message: "try it",
      limits: LIMITS,
    });

  test("only a person who manages the agent starts and feeds its preview, judged again at every input", async () => {
    const w = await world();
    await publish(w.agentId, w.releaseId);
    expect((await startPreview(w.managingMember, w.releaseId)).outcome).toBe(
      "preview_refused",
    );

    const started = await startPreview(w.directAdmin, w.releaseId);
    if (started.outcome !== "accepted") throw new Error(started.outcome);
    const sessionId = started.response.session_id;
    const [row] = await db
      .select({ preview: sessions.preview })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(row?.preview).toBe(true);
    const [share] = await db
      .select({ scope: sessionShares.scope })
      .from(sessionShares)
      .where(eq(sessionShares.sessionId, sessionId));
    expect(share?.scope).toBe("private");
    const summary = await createPostgresSessionReader(db).getSession(
      w.ws,
      sessionId,
    );
    expect(summary?.preview).toBe(true);

    const send = () =>
      uow().appendInputAtomic({
        principal: w.directAdmin,
        sessionId,
        idempotencyKey: randomUUID(),
        payloadHash: randomUUID(),
        message: "again",
        limits: LIMITS,
      });
    expect((await send()).outcome).toBe("accepted");

    const answer = () =>
      createPostgresPendingRequests(db).answerAtomic({
        principal: w.directAdmin,
        sessionId,
        idempotencyKey: randomUUID(),
        payloadHash: randomUUID(),
        answer: {
          request_id: "req_none",
          kind: "permission",
          decision: "allow",
        },
        approval: { surface: "web", decisionId: randomUUID() },
      });
    // Past the preview judgement, the request itself is not there.
    expect((await answer()).outcome).toBe("not_found");

    // No longer an admin: no new turn, no answer, no resume, though the
    // session is theirs.
    await admins().remove({
      actor: acting(w.owner),
      receiptId: randomUUID(),
      agentId: w.agentId,
      subject: { kind: "user", id: idOf(w.directAdmin) },
      managerRoles: MANAGERS,
    });
    expect((await send()).outcome).toBe("preview_refused");
    expect((await answer()).outcome).toBe("role");
    const resumed = await createPostgresSessionControl(db).resumeAtomic({
      principal: w.directAdmin,
      sessionId,
      idempotencyKey: randomUUID(),
      payloadHash: randomUUID(),
      expectedRevision: 0,
      now: new Date(),
    });
    expect(resumed.outcome).toBe("preview_refused");
  });

  test("before publishing too, an admin removed from the agent is refused as a preview's feeder, not as an outsider", async () => {
    const w = await world();
    const started = await startPreview(w.directAdmin, w.releaseId);
    if (started.outcome !== "accepted") throw new Error(started.outcome);
    const sessionId = started.response.session_id;
    const schedule = () =>
      createPostgresPullRequests(db).schedule({
        ownerId: w.ws,
        sessionId,
        ref: { pushRequestId: randomUUID() },
        content: {},
        actor: null,
        principal: w.directAdmin,
      });
    // Past the preview judgement, the push request itself is not there.
    expect(await schedule()).toMatchObject({
      kind: "refused",
      refusal: "not_found",
    });
    expect(
      await createPostgresPullRequests(db).previewAgent(w.ws, sessionId),
    ).toBe(w.agentId);

    await admins().remove({
      actor: acting(w.owner),
      receiptId: randomUUID(),
      agentId: w.agentId,
      subject: { kind: "user", id: idOf(w.directAdmin) },
      managerRoles: MANAGERS,
    });
    const sent = await uow().appendInputAtomic({
      principal: w.directAdmin,
      sessionId,
      idempotencyKey: randomUUID(),
      payloadHash: randomUUID(),
      message: "again",
      limits: LIMITS,
    });
    expect(sent.outcome).toBe("preview_refused");
    expect(await schedule()).toEqual({ kind: "preview_refused" });
  });

  test("a preview's admin rows stay held until the write commits: the lead's demotion waits", async () => {
    const w = await world();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let judged = (_: boolean) => {};
    const judgement = new Promise<boolean>((resolve) => {
      judged = resolve;
    });
    const writer = db.transaction(async (tx) => {
      const requester = await lockRequester(tx, w.lead, "sessions:write");
      if (!requester) throw new Error("no requester");
      judged(await lockPreviewManager(tx, w.lead, requester, w.ws, w.agentId));
      await held;
    });
    expect(await judgement).toBe(true);

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout = '300ms'");
      const demoted = await client
        .query(
          "update member_team_members set role = 'member' where user_id = $1 and removed_at is null",
          [idOf(w.lead)],
        )
        .then(
          () => "updated",
          (error: { code?: string }) => error.code,
        );
      // 55P03: lock_not_available, the share lock above still holds the row.
      expect(demoted).toBe("55P03");
      await client.query("rollback");
    } finally {
      client.release();
    }
    release();
    await writer;
  });

  test("an unapproved release runs only as a preview, and a preview is never shared wider", async () => {
    const w = await world();
    const started = await startPreview(w.owner, w.releaseId);
    if (started.outcome !== "accepted") throw new Error(started.outcome);
    const sessionId = started.response.session_id;
    const widen = await createPostgresSessionShareStore(db).set({
      principal: w.owner,
      ownerId: w.ws,
      workspaceId: w.ws,
      sessionId,
      scope: "workspace",
      userIds: [],
      teamIds: [],
      updatedBy: idOf(w.owner),
      receiptId: randomUUID(),
    });
    expect(widen.outcome).toBe("preview_fixed");
    // Nobody else on the team sees the preview, its admins included.
    const visibleTo = (who: Caller) =>
      createPostgresSessionShareStore(db).visibleTo(w.ws, sessionId, {
        userId: idOf(who),
        apiKeyId: null,
        keyAgentId: null,
      });
    expect(await visibleTo(w.owner)).toBe(true);
    expect(await visibleTo(w.lead)).toBe(false);
    expect(await visibleTo(w.managingMember)).toBe(false);
  });

  test("activating the release the draft holds clears the draft; a rollback leaves it", async () => {
    const w = await world();
    const release = async (versionNo: number, sha: string) => {
      const versionId = randomUUID();
      await db.insert(agentVersions).values({
        id: versionId,
        agentId: w.agentId,
        versionNo,
        card: {},
        contentSha256: sha.repeat(64),
      });
      const releaseId = `rel-${randomUUID()}`;
      await db.insert(agentReleases).values({
        id: releaseId,
        agentId: w.agentId,
        versionId,
        cardSha256: sha.repeat(64),
        connectionId: TEST_CONNECTION_ID,
        ...releaseSpecColumns(),
        runtimeConfigSnapshot: {},
        effectiveTools: [],
      });
      return { versionId, releaseId };
    };
    const current = await release(2, "c");
    const { versionId: draftVersion, releaseId: draftRelease } = await release(
      3,
      "b",
    );
    await publish(w.agentId, current.releaseId);
    await db
      .update(agents)
      .set({
        draftVersionId: draftVersion,
        draftConnectionId: TEST_CONNECTION_ID,
      })
      .where(eq(agents.id, w.agentId));
    const store = createPostgresAgentStore(db);
    const activate = async (releaseId: string) => {
      const [row] = await db
        .select({ revision: agents.activationRevision })
        .from(agents)
        .where(eq(agents.id, w.agentId));
      return store.activate({
        principal: w.owner,
        workspaceId: w.ws,
        agentId: w.agentId,
        releaseId,
        expectedRevision: row?.revision ?? 0,
        approvedBy: idOf(w.owner),
        managerRoles: MANAGERS,
        intent: { kind: "direct" },
      });
    };
    const draftOf = async () =>
      (
        await db
          .select({ draft: agents.draftVersionId })
          .from(agents)
          .where(eq(agents.id, w.agentId))
      )[0]?.draft ?? null;

    // A rollback to an older release leaves the saved change waiting.
    expect((await activate(w.releaseId)).outcome).toBe("activated");
    expect(await draftOf()).toBe(draftVersion);
    // Publishing the release the draft holds publishes the draft.
    expect((await activate(draftRelease)).outcome).toBe("activated");
    expect(await draftOf()).toBeNull();
  });

  test("the save-only check answers whether the save still holds the draft", async () => {
    const w = await world();
    await db
      .update(agents)
      .set({
        behaviorRevision: 7,
        draftVersionId: w.versionId,
        draftConnectionId: TEST_CONNECTION_ID,
      })
      .where(eq(agents.id, w.agentId));
    const store = createPostgresAgentStore(db);
    const holds = (behaviorRevision: number) =>
      store.holdsSave({
        workspaceId: w.ws,
        agentId: w.agentId,
        behaviorRevision,
        draftVersionId: w.versionId,
      });
    expect(await holds(7)).toBe(true);
    // A newer save bumped the revision: the older one is superseded.
    expect(await holds(6)).toBe(false);
  });
});
