import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type SessionShareScope,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { type Caller, callerFor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import * as schema from "../schema.ts";
import {
  apiKeys,
  memberships,
  memberTeamMembers,
  memberTeams,
  receipts,
  sessions,
  users,
  workspaces,
} from "../schema.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import { createPostgresSessionShareStore } from "./session-shares.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("session share scopes on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_shares_it" });
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
  const asUser = (caller: Caller) => ({ userId: idOf(caller), apiKeyId: null });

  async function agentKey(workspaceId: string) {
    const id = randomUUID();
    const agentId = randomUUID();
    await db.insert(schema.agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: agentId,
      name: "bot",
    });
    await db.insert(apiKeys).values({
      id,
      keyHash: Buffer.from(randomUUID()),
      ownerId: workspaceId,
      workspaceId,
      kind: "agent",
      agentId,
      scopes: ["sessions:read"],
    });
    return id;
  }

  async function session(
    workspaceId: string,
    creator: { userId?: string; apiKeyId?: string },
  ) {
    const id = randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/repo.git",
      branch: "main",
      createdByUserId: creator.userId ?? null,
      createdByApiKeyId: creator.apiKeyId ?? null,
    });
    return id;
  }

  async function team(workspaceId: string, members: Caller[]) {
    const teamId = randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: `team-${teamId}` });
    for (const member of members) {
      await db.insert(memberTeamMembers).values({
        id: randomUUID(),
        workspaceId,
        teamId,
        userId: idOf(member),
      });
    }
    return teamId;
  }

  function share(
    by: Caller,
    sessionId: string,
    scope: SessionShareScope,
    targets: { userIds?: string[]; teamIds?: string[] } = {},
    expectedRevision?: number,
  ) {
    return shares().set({
      principal: by,
      ownerId: by.ownerId,
      workspaceId: by.ownerId,
      sessionId,
      scope,
      userIds: targets.userIds ?? [],
      teamIds: targets.teamIds ?? [],
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      updatedBy: idOf(by),
      receiptId: randomUUID(),
    });
  }

  test("a session never re-shared reads workspace and everyone in it sees it", async () => {
    const ws = await workspace();
    const a = await person(ws);
    const b = await person(ws);
    const id = await session(ws, { userId: idOf(a) });
    expect(await shares().get(ws, id)).toMatchObject({
      scope: "workspace",
      revision: 0,
      userIds: [],
      teamIds: [],
    });
    expect(await shares().visibleTo(ws, id, asUser(b))).toBe(true);
    expect(await shares().visibleTo(randomUUID(), id, asUser(b))).toBe(false);
  });

  test("private, people and team each admit exactly whom they name", async () => {
    const ws = await workspace();
    const [a, b, c, owner] = [
      await person(ws),
      await person(ws),
      await person(ws),
      await person(ws, "owner"),
    ];
    const id = await session(ws, { userId: idOf(a) });

    expect(await share(a, id, "private")).toMatchObject({
      outcome: "changed",
      share: { scope: "private", revision: 1 },
    });
    expect(await shares().visibleTo(ws, id, asUser(a))).toBe(true);
    for (const other of [b, c, owner]) {
      expect(await shares().visibleTo(ws, id, asUser(other))).toBe(false);
    }

    await share(a, id, "people", { userIds: [idOf(b)] });
    expect(await shares().visibleTo(ws, id, asUser(b))).toBe(true);
    expect(await shares().visibleTo(ws, id, asUser(c))).toBe(false);

    const teamId = await team(ws, [c]);
    expect(await share(a, id, "team", { teamIds: [teamId] })).toMatchObject({
      share: { scope: "team", teamIds: [teamId], userIds: [] },
    });
    expect(await shares().visibleTo(ws, id, asUser(c))).toBe(true);
    expect(await shares().visibleTo(ws, id, asUser(b))).toBe(false);

    // Membership is read at each decision: out of the team, out of sight.
    await db
      .update(memberTeamMembers)
      .set({ removedAt: new Date() })
      .where(eq(memberTeamMembers.teamId, teamId));
    expect(await shares().visibleTo(ws, id, asUser(c))).toBe(false);

    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.operation, "share_session"))
      .limit(1);
    expect(receipt?.targetRef).toEqual({
      session_id: id,
      turn_id: null,
      request_id: null,
    });
  });

  test("an archived team no longer shares", async () => {
    const ws = await workspace();
    const [a, b] = [await person(ws), await person(ws)];
    const id = await session(ws, { userId: idOf(a) });
    const teamId = await team(ws, [b]);
    await share(a, id, "team", { teamIds: [teamId] });
    await db
      .update(memberTeams)
      .set({ archivedAt: new Date() })
      .where(eq(memberTeams.id, teamId));
    expect(await shares().visibleTo(ws, id, asUser(b))).toBe(false);
  });

  test("an agent key sees its own sessions and workspace ones, not a person's private one", async () => {
    const ws = await workspace();
    const a = await person(ws);
    const keyId = await agentKey(ws);
    const otherKey = await agentKey(ws);
    const mine = await session(ws, { apiKeyId: keyId });
    const theirs = await session(ws, { userId: idOf(a) });
    const owner = await person(ws, "owner");
    await share(owner, mine, "private");
    await share(a, theirs, "private");
    const asKey = (apiKeyId: string) => ({ userId: null, apiKeyId });
    expect(await shares().visibleTo(ws, mine, asKey(keyId))).toBe(true);
    expect(await shares().visibleTo(ws, mine, asKey(otherKey))).toBe(false);
    expect(await shares().visibleTo(ws, theirs, asKey(keyId))).toBe(false);
    expect(await shares().originOf(ws, mine)).toEqual({
      creatorUserId: null,
      creatorApiKeyId: keyId,
    });
  });

  test("an unchanged share keeps its revision; a stale one conflicts", async () => {
    const ws = await workspace();
    const a = await person(ws);
    const id = await session(ws, { userId: idOf(a) });
    await share(a, id, "private");
    expect(await share(a, id, "private")).toMatchObject({
      outcome: "unchanged",
      share: { revision: 1 },
    });
    expect(await share(a, id, "workspace", {}, 0)).toEqual({
      outcome: "revision_conflict",
      currentRevision: 1,
    });
    expect(await share(a, id, "workspace", {}, 1)).toMatchObject({
      outcome: "changed",
      share: { scope: "workspace", revision: 2 },
    });
  });

  test("targets must be live members and live teams of the same workspace", async () => {
    const ws = await workspace();
    const elsewhere = await workspace();
    const [a, b] = [await person(ws), await person(ws)];
    const stranger = await person(elsewhere);
    const foreignTeam = await team(elsewhere, [stranger]);
    const id = await session(ws, { userId: idOf(a) });
    expect(await share(a, id, "people", { userIds: [idOf(stranger)] })).toEqual(
      { outcome: "invalid_target" },
    );
    expect(await share(a, id, "team", { teamIds: [foreignTeam] })).toEqual({
      outcome: "invalid_target",
    });
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, idOf(b)));
    expect(await share(a, id, "people", { userIds: [idOf(b)] })).toEqual({
      outcome: "invalid_target",
    });
    expect(await share(a, randomUUID(), "private")).toEqual({
      outcome: "not_found",
    });
  });

  test("two first changes at once both land, one after the other", async () => {
    const ws = await workspace();
    const a = await person(ws);
    const id = await session(ws, { userId: idOf(a) });
    const results = await Promise.all([
      share(a, id, "private"),
      share(a, id, "people", { userIds: [idOf(a)] }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "changed",
      "changed",
    ]);
    expect((await shares().get(ws, id))?.revision).toBe(2);
  });

  test("a read never mixes one change's scope with another's targets", async () => {
    const ws = await workspace();
    const a = await person(ws);
    const b = await person(ws);
    const id = await session(ws, { userId: idOf(a) });
    const teamId = await team(ws, [b]);
    let writing = true;
    const writer = (async () => {
      for (let i = 0; i < 40; i += 1) {
        await share(
          a,
          id,
          i % 2 === 0 ? "people" : "team",
          i % 2 === 0 ? { userIds: [idOf(b)] } : { teamIds: [teamId] },
        );
      }
      writing = false;
    })();
    const mixed: unknown[] = [];
    const reader = async () => {
      while (writing) {
        const read = await shares().get(ws, id);
        if (!read || read.scope === "workspace") continue;
        const consistent =
          read.scope === "people"
            ? read.userIds.length === 1 && read.teamIds.length === 0
            : read.teamIds.length === 1 && read.userIds.length === 0;
        if (!consistent) mixed.push(read);
      }
    };
    await Promise.all([writer, reader(), reader(), reader()]);
    expect(mixed).toEqual([]);
  });

  test("a change wakes the session's event listeners", async () => {
    const ws = await workspace();
    const a = await person(ws);
    const id = await session(ws, { userId: idOf(a) });
    const listener = new Client({ connectionString: database.url });
    await listener.connect();
    try {
      await listener.query("LISTEN session_events");
      const woke = new Promise<string | undefined>((resolve) =>
        listener.on("notification", (message) => resolve(message.payload)),
      );
      await share(a, id, "private");
      expect(await woke).toBe(id);
    } finally {
      await listener.end();
    }
  });
});
