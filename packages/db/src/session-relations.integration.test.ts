import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  type CountSessionsQuery,
  SESSION_RELATION_VALUES,
  SESSION_STATUS_VALUES,
  type SessionRelation,
} from "@werft-ai/contracts";
import type { SessionViewer } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresMemberStore } from "./members.ts";
import { createPostgresSessionReader } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentAdmins,
  agentAdminTeams,
  agentReleases,
  agents,
  agentVersions,
  apiKeys,
  memberships,
  memberTeamMembers,
  memberTeams,
  sessionShares,
  sessionShareTargets,
  sessions,
  turns,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { releaseSpecColumns, TEST_CONNECTION_ID } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// 94S-811: every relation, search and count is a subset of what the share
// already lets the viewer read.
integration("session list relations, search and counts on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = randomUUID();
  const people = {} as Record<
    "alice" | "bob" | "carol" | "dave",
    { id: string; name: string }
  >;
  const agentX = randomUUID();
  const agentY = randomUUID();
  const releaseX = `rel-x-${randomUUID()}`;
  // A second release of X: the agent filter takes every release of it.
  const releaseX2 = `rel-x2-${randomUUID()}`;
  const releaseY = `rel-y-${randomUUID()}`;
  const serviceKey = randomUUID();
  const ids = {} as Record<string, string>;

  const reader = () => createPostgresSessionReader(db);
  const viewer = (who: keyof typeof people): SessionViewer => ({
    userId: people[who].id,
    apiKeyId: null,
  });

  async function readAll(
    as: SessionViewer,
    query: CountSessionsQuery & {
      status?: (typeof SESSION_STATUS_VALUES)[number];
      agent_id?: string;
    },
  ) {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await reader().listSessions(
        workspaceId,
        { ...query, limit: 2, ...(cursor ? { cursor } : {}) },
        as,
      );
      found.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return found;
  }
  const named = (found: string[]) =>
    found
      .map((id) => Object.keys(ids).find((name) => ids[name] === id) ?? id)
      .sort();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_relations_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      name: "ws",
      // Outsiders of an agent's team keep seeing its workspace sessions.
      settings: { agent_outsider_session_visibility: "workspace" },
    });
    for (const [who, name] of [
      ["alice", "Alice Kim"],
      ["bob", "Bob Lee"],
      ["carol", "Carol Park"],
      ["dave", "Dave Choi"],
    ] as const) {
      const id = randomUUID();
      await db.insert(users).values({
        id,
        email: `${id}@example.invalid`,
        passwordHash: "argon2id$placeholder",
        displayName: name,
      });
      await db
        .insert(memberships)
        .values({ workspaceId, userId: id, role: "member" });
      people[who] = { id, name };
    }
    const team = async (members: (keyof typeof people)[], removed = false) => {
      const id = randomUUID();
      await db
        .insert(memberTeams)
        .values({ id, workspaceId, name: `team-${id.slice(0, 8)}` });
      for (const who of members) {
        await db.insert(memberTeamMembers).values({
          id: randomUUID(),
          workspaceId,
          teamId: id,
          userId: people[who].id,
          ...(removed ? { removedAt: new Date() } : {}),
        });
      }
      return id;
    };
    const reviewers = await team(["alice", "carol"]);
    const former = await team(["alice"], true);
    const admins = await team(["dave"]);

    // releaseX2 is made later in releaseX's second; releaseY just past
    // midnight in Seoul.
    for (const [agentId, releaseId, name, versionNo, createdAt] of [
      [agentX, releaseX, "Checkout fixer", 3, "2026-10-30T05:30:28.100Z"],
      [agentY, releaseY, "Docs writer", 1, "2026-10-29T15:00:00.000Z"],
    ] as const) {
      await db.insert(agents).values({
        id: agentId,
        workspaceId,
        managingTeamId: await fixtureTeam(db, workspaceId),
        slug: name.toLowerCase().replace(" ", "-"),
        name,
      });
      const versionId = randomUUID();
      await db.insert(agentVersions).values({
        id: versionId,
        agentId,
        versionNo,
        card: {},
        contentSha256: randomBytes(32).toString("hex"),
      });
      await db.insert(agentReleases).values({
        id: releaseId,
        agentId,
        versionId,
        cardSha256: "card",
        connectionId: TEST_CONNECTION_ID,
        ...releaseSpecColumns(),
        runtimeConfigSnapshot: {},
        effectiveTools: [],
        createdAt: new Date(createdAt),
      });
      if (agentId === agentX) {
        await db.insert(agentReleases).values({
          id: releaseX2,
          agentId,
          versionId,
          cardSha256: "card",
          connectionId: TEST_CONNECTION_ID,
          ...releaseSpecColumns(),
          runtimeConfigSnapshot: {},
          effectiveTools: [],
          createdAt: new Date("2026-10-30T05:30:28.700Z"),
        });
      }
    }
    // X now runs releaseX2, so sessions on releaseX are pinned to an older
    // one; Y has never been activated.
    await db
      .update(agents)
      .set({ activeReleaseId: releaseX2, activationRevision: 0 })
      .where(eq(agents.id, agentX));
    // alice administers X directly, dave through a team; nobody Y.
    await db
      .insert(agentAdmins)
      .values({ workspaceId, agentId: agentX, userId: people.alice.id });
    await db
      .insert(agentAdminTeams)
      .values({ workspaceId, agentId: agentX, teamId: admins });
    await db.insert(apiKeys).values({
      id: serviceKey,
      keyHash: randomBytes(32),
      ownerId: workspaceId,
      workspaceId,
      kind: "agent",
      agentId: agentX,
    });

    let at = Date.parse("2026-10-24T00:00:00Z");
    const session = async (
      name: string,
      row: {
        by: keyof typeof people | "service";
        title?: string;
        release?: string;
        status?: "queued" | "running" | "idle" | "failed" | "stopped";
        channel?: "web" | "api";
        share?: {
          scope: "private" | "people" | "team";
          users?: string[];
          teams?: string[];
        };
      },
    ) => {
      const id = randomUUID();
      ids[name] = id;
      at += 60_000;
      await db.insert(sessions).values({
        id,
        ownerId: workspaceId,
        workspaceId,
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
        title: row.title ?? name,
        status: row.status ?? "idle",
        agentReleaseId: row.release ?? null,
        channel: row.channel ?? null,
        createdByUserId: row.by === "service" ? null : people[row.by].id,
        createdByApiKeyId: row.by === "service" ? serviceKey : null,
        createdAt: new Date(at),
      });
      if (!row.share) return;
      await db.insert(sessionShares).values({
        sessionId: id,
        ownerId: workspaceId,
        workspaceId,
        scope: row.share.scope,
      });
      for (const userId of row.share.users ?? []) {
        await db
          .insert(sessionShareTargets)
          .values({ id: randomUUID(), workspaceId, sessionId: id, userId });
      }
      for (const teamId of row.share.teams ?? []) {
        await db
          .insert(sessionShareTargets)
          .values({ id: randomUUID(), workspaceId, sessionId: id, teamId });
      }
    };
    await session("mine", {
      by: "alice",
      title: "Fix checkout 100% of the time",
      release: releaseX,
      channel: "web",
    });
    await session("minePrivate", {
      by: "alice",
      status: "failed",
      share: { scope: "private" },
    });
    await session("bobPrivateX", {
      by: "bob",
      release: releaseX,
      share: { scope: "private" },
    });
    await session("toAlice", {
      by: "bob",
      release: releaseY,
      status: "running",
      channel: "api",
      share: { scope: "people", users: [people.alice.id] },
    });
    await session("toReviewers", {
      by: "bob",
      status: "failed",
      share: { scope: "team", teams: [reviewers] },
    });
    await session("bobWorkspaceX", {
      by: "bob",
      title: "fix_flaky",
      release: releaseX2,
    });
    await session("toFormer", {
      by: "bob",
      share: { scope: "team", teams: [former] },
    });
    await session("serviceKey", { by: "service", status: "stopped" });
    // No person started it, so the creator comparison is NULL, not false.
    await session("keyToAlice", {
      by: "service",
      share: { scope: "people", users: [people.alice.id] },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  test("each relation is a subset of what the viewer reads, out-of-share sessions in none", async () => {
    const expected: Record<
      "alice" | "dave",
      Record<SessionRelation, string[]>
    > = {
      alice: {
        all: [
          "bobWorkspaceX",
          "keyToAlice",
          "mine",
          "minePrivate",
          "serviceKey",
          "toAlice",
          "toReviewers",
        ],
        started: ["mine", "minePrivate"],
        shared: ["keyToAlice", "toAlice", "toReviewers"],
        // bobPrivateX is X's too, but outside its share.
        administered: ["bobWorkspaceX", "mine"],
      },
      dave: {
        all: ["bobWorkspaceX", "mine", "serviceKey"],
        started: [],
        shared: [],
        administered: ["bobWorkspaceX", "mine"],
      },
    };
    for (const who of ["alice", "dave"] as const) {
      const visible = await readAll(viewer(who), {});
      expect(named(visible)).toEqual(expected[who].all);
      for (const relation of SESSION_RELATION_VALUES) {
        const found = await readAll(viewer(who), { relation });
        expect(named(found)).toEqual(expected[who][relation]);
        expect(found.every((id) => visible.includes(id))).toBe(true);
        for (const hidden of ["bobPrivateX", "toFormer"]) {
          expect(found).not.toContain(ids[hidden]);
        }
      }
    }
  });

  test("a key no person stands behind starts only its own and is shared or administers nothing", async () => {
    const key = { userId: null, apiKeyId: serviceKey };
    expect(named(await readAll(key, { relation: "started" }))).toEqual([
      "keyToAlice",
      "serviceKey",
    ]);
    expect(await readAll(key, { relation: "shared" })).toEqual([]);
    expect(await readAll(key, { relation: "administered" })).toEqual([]);
  });

  test("q matches a title ignoring case, with % and _ taken literally, or an id prefix", async () => {
    const as = viewer("alice");
    expect(named(await readAll(as, { q: "FIX" }))).toEqual([
      "bobWorkspaceX",
      "mine",
    ]);
    expect(named(await readAll(as, { q: "100%" }))).toEqual(["mine"]);
    expect(named(await readAll(as, { q: "x_f" }))).toEqual(["bobWorkspaceX"]);
    expect(named(await readAll(as, { q: "%" }))).toEqual(["mine"]);
    const prefix = (ids.toAlice ?? "").slice(0, 8).toUpperCase();
    expect(named(await readAll(as, { q: prefix }))).toEqual(["toAlice"]);
    expect(await readAll(viewer("dave"), { q: prefix })).toEqual([]);
  });

  test("agent_id keeps the sessions of every release of that agent the viewer reads, page by page", async () => {
    const expected: [keyof typeof people, string, string[]][] = [
      // bob reads three, so limit 2 needs a second page.
      ["bob", agentX, ["bobPrivateX", "bobWorkspaceX", "mine"]],
      // bobPrivateX is X's too, but outside alice's and dave's share.
      ["alice", agentX, ["bobWorkspaceX", "mine"]],
      ["dave", agentX, ["bobWorkspaceX", "mine"]],
      ["alice", agentY, ["toAlice"]],
      ["dave", agentY, []],
      ["alice", randomUUID(), []],
    ];
    for (const [who, agentId, names] of expected) {
      expect([
        who,
        named(await readAll(viewer(who), { agent_id: agentId })),
      ]).toEqual([who, names]);
    }
    expect(
      named(
        await readAll(viewer("alice"), {
          agent_id: agentX,
          relation: "started",
        }),
      ),
    ).toEqual(["mine"]);
    expect(
      named(await readAll(viewer("bob"), { agent_id: agentX, status: "idle" })),
    ).toEqual(["bobPrivateX", "bobWorkspaceX", "mine"]);
  });

  test("counts equal the list read to its end, per status, for every filter", async () => {
    for (const who of ["alice", "bob", "dave"] as const) {
      for (const relation of SESSION_RELATION_VALUES) {
        for (const q of [undefined, "fix", "to"]) {
          const filter = { relation, ...(q ? { q } : {}) };
          const counted = await reader().countSessions(
            workspaceId,
            filter,
            viewer(who),
          );
          let total = 0;
          for (const status of SESSION_STATUS_VALUES) {
            const listed = await readAll(viewer(who), { ...filter, status });
            expect([who, relation, q, status, counted.counts[status]]).toEqual([
              who,
              relation,
              q,
              status,
              listed.length,
            ]);
            total += listed.length;
          }
          expect(counted.total).toBe(total);
        }
      }
    }
    expect(
      await reader().countSessions(workspaceId, {}, viewer("alice")),
    ).toEqual({
      counts: {
        queued: 0,
        running: 1,
        needs_input: 0,
        idle: 3,
        failed: 2,
        stopped: 1,
      },
      total: 7,
    });
  });

  test("a member who manages no agent reads only the agent's id, name and version on someone else's session", async () => {
    const page = await reader().listSessions(
      workspaceId,
      { limit: 50, q: "fix_flaky" },
      viewer("carol"),
    );
    expect(page.items.map((item) => item.id)).toEqual([
      ids.bobWorkspaceX ?? "",
    ]);
    expect(page.items[0]?.agent).toEqual({
      id: agentX,
      name: "Checkout fixer",
      release_version_no: 3,
      release_label: "2026-10-30_14:30:28-2",
      release_is_active: true,
    });
    expect(page.items[0]?.created_by).toEqual({
      user_id: people.bob.id,
      display_name: "Bob Lee",
    });
    expect(
      await readAll(viewer("carol"), { relation: "administered" }),
    ).toEqual([]);
    expect(await readAll(viewer("carol"), { q: "bobPrivateX" })).toEqual([]);
  });

  test("summary and detail carry the agent, who started it and the channel", async () => {
    const [mine] = (
      await reader().listSessions(
        workspaceId,
        { limit: 1, q: "checkout" },
        viewer("alice"),
      )
    ).items;
    expect(mine).toMatchObject({
      id: ids.mine,
      agent: {
        id: agentX,
        name: "Checkout fixer",
        release_version_no: 3,
        release_label: "2026-10-30_14:30:28",
        release_is_active: false,
      },
      created_by: { user_id: people.alice.id, display_name: "Alice Kim" },
      channel: "web",
    });
    const detail = await reader().getSession(workspaceId, ids.toAlice ?? "");
    expect(detail).toMatchObject({
      agent: {
        id: agentY,
        name: "Docs writer",
        release_version_no: 1,
        release_label: "2026-10-30_00:00:00",
        release_is_active: false,
      },
      created_by: { user_id: people.bob.id, display_name: "Bob Lee" },
      channel: "api",
    });
    const keyMade = await reader().getSession(
      workspaceId,
      ids.serviceKey ?? "",
    );
    expect(keyMade).toMatchObject({
      agent: null,
      created_by: null,
      channel: null,
    });
  });
});

integration("who started a session on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const ids = {} as Record<string, string>;
  const as = (userId: string): SessionViewer => ({ userId, apiKeyId: null });

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_starter_it" });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      name: "ws",
    });
    for (const [id, name] of [
      [alice, "Alice Kim"],
      [bob, "Bob Lee"],
    ] as const) {
      await db.insert(users).values({
        id,
        email: `${id}@example.invalid`,
        passwordHash: "argon2id$placeholder",
        displayName: name,
      });
      await db
        .insert(memberships)
        .values({ workspaceId, userId: id, role: "owner" });
    }
    let at = Date.parse("2026-10-24T00:00:00Z");
    const session = async (
      name: string,
      row: {
        createdBy: string | null;
        firstTurnBy?: string | null;
        private?: boolean;
      },
    ) => {
      const id = randomUUID();
      ids[name] = id;
      at += 60_000;
      await db.insert(sessions).values({
        id,
        ownerId: workspaceId,
        workspaceId,
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
        title: name,
        status: "idle",
        createdByUserId: row.createdBy,
        createdAt: new Date(at),
        // bob left; the takeover below hands these to alice.
        ...(row.createdBy === bob && row.firstTurnBy === bob
          ? { takeoverRequiredAt: new Date(at) }
          : {}),
      });
      if (row.firstTurnBy !== undefined) {
        await db.insert(turns).values({
          sessionId: id,
          sequence: 1,
          message: "start",
          status: "succeeded",
          actorId: row.firstTurnBy,
        });
      }
      if (row.private) {
        await db.insert(sessionShares).values({
          sessionId: id,
          ownerId: workspaceId,
          workspaceId,
          scope: "private",
        });
      }
    };
    await session("handedOver", { createdBy: bob, firstTurnBy: bob });
    await session("handedOverPrivate", {
      createdBy: bob,
      firstTurnBy: bob,
      private: true,
    });
    // Rows from before #427: turn 1 names no one, or there is no turn.
    await session("firstTurnNamesNoOne", {
      createdBy: alice,
      firstTurnBy: null,
    });
    await session("noTurn", { createdBy: bob });
    const members = createPostgresMemberStore(db);
    for (const name of ["handedOver", "handedOverPrivate"]) {
      const taken = await members.takeOver({
        principal: {
          ownerId: workspaceId,
          actor: {
            principal: { kind: "user", id: alice },
            userId: alice,
            workspaceId,
            apiKeyId: null,
          },
        },
        workspaceId,
        sessionId: ids[name] ?? "",
        newRequesterId: alice,
      });
      if (taken.outcome !== "taken_over") throw new Error(taken.outcome);
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  const reader = () => createPostgresSessionReader(db);
  const named = (found: { id: string }[]) =>
    found
      .map(({ id }) => Object.keys(ids).find((name) => ids[name] === id) ?? id)
      .sort();

  test("a takeover leaves who started it: started and created_by follow turn 1, reading follows the new holder", async () => {
    const list = async (userId: string, relation: SessionRelation) =>
      named(
        (
          await reader().listSessions(
            workspaceId,
            { limit: 100, relation },
            as(userId),
          )
        ).items,
      );
    const total = async (userId: string, relation: SessionRelation) =>
      (await reader().countSessions(workspaceId, { relation }, as(userId)))
        .total;
    expect(await list(alice, "all")).toEqual([
      "firstTurnNamesNoOne",
      "handedOver",
      "handedOverPrivate",
      "noTurn",
    ]);
    expect(await list(alice, "started")).toEqual(["firstTurnNamesNoOne"]);
    expect(await total(alice, "started")).toBe(1);
    // bob still started handedOverPrivate, but no longer holds it.
    expect(await list(bob, "all")).toEqual([
      "firstTurnNamesNoOne",
      "handedOver",
      "noTurn",
    ]);
    expect(await list(bob, "started")).toEqual(["handedOver", "noTurn"]);
    expect(await total(bob, "started")).toBe(2);
    const startedBy = async (name: string) =>
      (await reader().getSession(workspaceId, ids[name] ?? ""))?.created_by;
    const bobRef = { user_id: bob, display_name: "Bob Lee" };
    expect(await startedBy("handedOver")).toEqual(bobRef);
    expect(await startedBy("handedOverPrivate")).toEqual(bobRef);
    expect(await startedBy("firstTurnNamesNoOne")).toEqual({
      user_id: alice,
      display_name: "Alice Kim",
    });
    expect(await startedBy("noTurn")).toEqual(bobRef);
    const [summary] = (
      await reader().listSessions(
        workspaceId,
        { limit: 1, q: "handedOverPrivate" },
        as(alice),
      )
    ).items;
    expect(summary?.created_by).toEqual(bobRef);
  });
});

integration(
  "0158 fills a session's channel only where the row proves it",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;

    beforeAll(async () => {
      database = await createTempDatabase({ prefix: "session_channel_it" });
      pool = new Pool({ connectionString: database.url, max: 2 });
      db = drizzle(pool, { schema });
    }, 60_000);

    afterAll(async () => {
      await pool?.end();
      await database?.drop();
    }, 60_000);

    test("a key's session reads api, a person's without a key web, the rest null", async () => {
      const workspaceId = randomUUID();
      await db.insert(workspaces).values({
        id: workspaceId,
        slug: `ws-${workspaceId.slice(0, 8)}`,
        name: "ws",
      });
      const userId = randomUUID();
      await db.insert(users).values({
        id: userId,
        email: `${userId}@example.invalid`,
        passwordHash: "argon2id$placeholder",
        displayName: "person",
      });
      const keyId = randomUUID();
      await db.insert(apiKeys).values({
        id: keyId,
        keyHash: randomBytes(32),
        ownerId: workspaceId,
        workspaceId,
        kind: "personal",
        createdByUserId: userId,
      });
      const rows = {
        personalKey: { createdByUserId: userId, createdByApiKeyId: keyId },
        serviceKey: { createdByUserId: null, createdByApiKeyId: keyId },
        login: { createdByUserId: userId, createdByApiKeyId: null },
        legacy: { createdByUserId: null, createdByApiKeyId: null },
      };
      const ids = {} as Record<keyof typeof rows, string>;
      for (const [name, creator] of Object.entries(rows)) {
        const id = randomUUID();
        ids[name as keyof typeof rows] = id;
        await db.insert(sessions).values({
          id,
          ownerId: workspaceId,
          workspaceId,
          repoUrl: "https://example.invalid/app.git",
          branch: "main",
          ...creator,
        });
      }
      const migration = await Bun.file(
        new URL("../migrations/0158_session_channel.sql", import.meta.url),
      ).text();
      for (const statement of migration.split("--> statement-breakpoint")) {
        const update = statement
          .split("\n")
          .filter((line) => !line.startsWith("--"))
          .join("\n")
          .trim();
        if (update.startsWith("UPDATE")) await pool.query(update);
      }
      const reader = createPostgresSessionReader(db);
      const channelOf = async (id: string) =>
        (await reader.getSession(workspaceId, id))?.channel;
      expect({
        personalKey: await channelOf(ids.personalKey),
        serviceKey: await channelOf(ids.serviceKey),
        login: await channelOf(ids.login),
        legacy: await channelOf(ids.legacy),
      }).toEqual({
        personalKey: "api",
        serviceKey: "api",
        login: "web",
        legacy: null,
      });
    });
  },
);
