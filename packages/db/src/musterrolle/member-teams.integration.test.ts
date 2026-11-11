import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  InvalidCursorError,
  type TeamActor,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  memberships,
  memberTeamMembers,
  memberTeams,
  receipts,
  users,
  workspaces,
} from "../schema.ts";
import { createPostgresTeamStore } from "./member-teams.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const PAGE = { limit: 50 };

integration("teams and teams as agent admins on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "member_teams_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

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

  const idOf = (caller: Caller) => caller.actor?.userId ?? "";

  function acting(caller: Caller): TeamActor {
    return {
      principal: caller,
      workspaceId: caller.ownerId,
      userId: idOf(caller),
    };
  }

  const teams = () => createPostgresTeamStore(db);

  async function newTeam(by: Caller, name = `team-${randomUUID()}`) {
    const result = await teams().create({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId: randomUUID(),
      name,
    });
    if (result.outcome !== "created") throw new Error(result.outcome);
    return result.team;
  }

  const member = (by: Caller, teamId: string, who: Caller, add = true) =>
    teams()[add ? "addMember" : "removeMember"]({
      actor: acting(by),
      receiptId: randomUUID(),
      teamId,
      userId: idOf(who),
    });

  test("owners and admins create, rename and delete teams; names are unique while live", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const plain = await person(workspaceId, "member");

    const team = await newTeam(owner, "research");
    expect(team).toMatchObject({ name: "research", memberCount: 0 });
    expect(
      await teams().create({
        actor: acting(admin),
        receiptId: randomUUID(),
        teamId: randomUUID(),
        name: "research",
      }),
    ).toEqual({ outcome: "name_taken" });
    expect(
      await teams().create({
        actor: acting(plain),
        receiptId: randomUUID(),
        teamId: randomUUID(),
        name: "mine",
      }),
    ).toEqual({ outcome: "actor_inactive" });

    const other = await newTeam(admin, "ops");
    expect(
      await teams().rename({
        actor: acting(admin),
        receiptId: randomUUID(),
        teamId: other.id,
        name: "research",
      }),
    ).toEqual({ outcome: "name_taken" });
    const renamed = await teams().rename({
      actor: acting(admin),
      receiptId: randomUUID(),
      teamId: other.id,
      name: "operations",
    });
    expect(renamed).toMatchObject({
      outcome: "renamed",
      team: { name: "operations", revision: 2 },
    });
    expect(
      await teams().rename({
        actor: acting(plain),
        receiptId: randomUUID(),
        teamId: other.id,
        name: "x",
      }),
    ).toEqual({ outcome: "actor_inactive" });

    expect(
      await teams().delete({
        actor: acting(plain),
        receiptId: randomUUID(),
        teamId: team.id,
      }),
    ).toEqual({ outcome: "actor_inactive" });
    expect(
      await teams().delete({
        actor: acting(owner),
        receiptId: randomUUID(),
        teamId: team.id,
      }),
    ).toEqual({ outcome: "deleted" });
    expect(await teams().get(workspaceId, team.id)).toBeNull();
    expect(
      await teams().delete({
        actor: acting(owner),
        receiptId: randomUUID(),
        teamId: team.id,
      }),
    ).toEqual({ outcome: "not_found" });
    // A deleted team's name is free again.
    await newTeam(owner, "research");
    expect(
      (await teams().list(workspaceId, PAGE)).items.map((t) => t.name),
    ).toEqual(["operations", "research"]);

    // Another workspace's team does not exist here.
    const elsewhere = await workspace();
    const stranger = await person(elsewhere, "owner");
    expect(
      await teams().rename({
        actor: acting(stranger),
        receiptId: randomUUID(),
        teamId: other.id,
        name: "taken over",
      }),
    ).toEqual({ outcome: "not_found" });
  });

  test("members join at once, leave at once, and the receipt names the person", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const joiner = await person(workspaceId, "member");
    const disabled = await person(workspaceId, "member");
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, idOf(disabled)));
    const outsider = await person(await workspace(), "member");
    const team = await newTeam(owner);

    const added = await member(owner, team.id, joiner);
    expect(added).toMatchObject({ outcome: "added", team: { memberCount: 1 } });
    expect(await member(owner, team.id, joiner)).toMatchObject({
      outcome: "unchanged",
    });
    expect(await member(owner, team.id, disabled)).toEqual({
      outcome: "not_member",
    });
    expect(await member(owner, team.id, outsider)).toEqual({
      outcome: "not_member",
    });
    expect(await member(joiner, team.id, owner)).toEqual({
      outcome: "actor_inactive",
    });

    const detail = await teams().get(workspaceId, team.id);
    expect(detail?.members.map((m) => m.userId)).toEqual([idOf(joiner)]);
    expect(detail?.members[0]?.addedBy).toBe(idOf(owner));

    const written = await db
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.ownerId, workspaceId),
          eq(receipts.operation, "add_team_member"),
        ),
      );
    expect(written).toHaveLength(1);
    expect(written[0]?.targetRef).toEqual({
      user_id: idOf(joiner),
      workspace_id: workspaceId,
    });
    expect(written[0]?.result).toEqual({
      team_id: team.id,
      team_name: team.name,
    });
    expect(written[0]?.actor).toMatchObject({ actor_user_id: idOf(owner) });
    expect(written[0]?.requestId).toBe(owner.requestId);

    expect(await member(owner, team.id, joiner, false)).toMatchObject({
      outcome: "removed",
      team: { memberCount: 0 },
    });
    expect(await member(owner, team.id, joiner, false)).toMatchObject({
      outcome: "unchanged",
    });
    // Rejoining is a new row; the old one stays as history.
    await member(owner, team.id, joiner);
    expect(
      await db
        .select()
        .from(memberTeamMembers)
        .where(eq(memberTeamMembers.teamId, team.id)),
    ).toHaveLength(2);
  });

  test("the team list counts each team's current members", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const first = await person(workspaceId, "member");
    const second = await person(workspaceId, "member");
    const team = await newTeam(owner, "a-staffed");
    const empty = await newTeam(owner, "b-empty");

    await member(owner, team.id, first);
    await member(owner, team.id, second);
    await member(owner, team.id, first, false);

    expect(
      (await teams().list(workspaceId, PAGE)).items.map((t) => [
        t.id,
        t.memberCount,
      ]),
    ).toEqual([
      [team.id, 1],
      [empty.id, 0],
    ]);
  });

  test("a person's joined teams are the live teams they are in now; isMember agrees", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const mine = await person(workspaceId, "member");
    const other = await person(workspaceId, "member");
    const kept = await newTeam(owner, "b-kept");
    const left = await newTeam(owner, "c-left");
    const deleted = await newTeam(owner, "a-deleted");
    const theirs = await newTeam(owner, "d-theirs");
    for (const team of [kept, left, deleted])
      await member(owner, team.id, mine);
    await member(owner, theirs.id, other);
    await member(owner, left.id, mine, false);
    await teams().delete({
      actor: acting(owner),
      receiptId: randomUUID(),
      teamId: deleted.id,
    });

    const joined = async (caller: Caller) =>
      (await teams().listJoined(workspaceId, idOf(caller), PAGE)).items;
    expect(await joined(mine)).toEqual([
      { id: kept.id, name: "b-kept", role: "member" },
    ]);
    expect(await joined(other)).toEqual([
      { id: theirs.id, name: "d-theirs", role: "member" },
    ]);
    expect(
      await teams().listJoined(await workspace(), idOf(mine), PAGE),
    ).toEqual({ items: [], nextCursor: null });
    const isMember = (caller: Caller, teamId: string, at = workspaceId) =>
      teams().isMember(at, teamId, idOf(caller));
    expect(await isMember(mine, kept.id)).toBe(true);
    expect(await isMember(mine, kept.id.toUpperCase())).toBe(true);
    // Left, deleted, someone else's, or asked from another workspace: no.
    expect(await isMember(mine, left.id)).toBe(false);
    expect(await isMember(mine, deleted.id)).toBe(false);
    expect(await isMember(mine, theirs.id)).toBe(false);
    expect(await isMember(owner, kept.id)).toBe(false);
    expect(await isMember(mine, kept.id, await workspace())).toBe(false);
    expect(await isMember(mine, "not-a-team")).toBe(false);

    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, idOf(mine)));
    expect(await joined(mine)).toEqual([]);
    expect(await isMember(mine, kept.id)).toBe(false);
  });

  test("a disabled member's team row is frozen: no removal, no role change, no receipt", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const off = await person(workspaceId, "member");
    const suspended = await person(workspaceId, "member");
    const team = await newTeam(owner);
    await member(owner, team.id, off);
    await member(owner, team.id, suspended);
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, idOf(off)));
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, idOf(suspended)));

    // The detail reads either kind of off as inactive, so the page offers
    // neither edit on the row.
    const detail = await teams().get(workspaceId, team.id);
    expect(
      Object.fromEntries(
        (detail?.members ?? []).map((m) => [m.userId, m.disabledAt !== null]),
      ),
    ).toEqual({ [idOf(off)]: true, [idOf(suspended)]: true });

    const receiptsBefore = await db
      .select()
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId));
    for (const who of [off, suspended]) {
      expect(await member(owner, team.id, who, false)).toEqual({
        outcome: "member_disabled",
      });
      expect(
        await teams().setMemberRole({
          actor: acting(owner),
          receiptId: randomUUID(),
          teamId: team.id,
          userId: idOf(who),
          role: "lead",
        }),
      ).toEqual({ outcome: "member_disabled" });
    }

    const rows = await db
      .select()
      .from(memberTeamMembers)
      .where(eq(memberTeamMembers.teamId, team.id));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.removedAt).toBeNull();
      expect(row.role).toBe("member");
    }
    const receiptsAfter = await db
      .select()
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId));
    expect(receiptsAfter).toHaveLength(receiptsBefore.length);

    // Reactivation is not blocked: the same removal then goes through.
    await db
      .update(memberships)
      .set({ disabledAt: null })
      .where(eq(memberships.userId, idOf(off)));
    expect(await member(owner, team.id, off, false)).toMatchObject({
      outcome: "removed",
    });
  });

  // Seeds live teams straight into the table; 200+ creates through the store
  // would spend a receipt each.
  async function seedTeams(workspaceId: string, names: string[]) {
    const rows = names.map((name) => ({ id: randomUUID(), workspaceId, name }));
    await db.insert(memberTeams).values(rows);
    return rows;
  }

  type Page = {
    items: { id: string; name: string }[];
    nextCursor: string | null;
  };

  async function walk(read: (cursor?: string) => Promise<Page>) {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await read(cursor);
      pages.push(page.items.map((team) => team.name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  }

  const names = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => `team-${String(i).padStart(3, "0")}`,
    );

  test("the team list pages past 200 by name, each live team once", async () => {
    const workspaceId = await workspace();
    const all = names(205);
    await seedTeams(workspaceId, [...all].reverse());
    await db.insert(memberTeams).values({
      id: randomUUID(),
      workspaceId,
      name: "team-100",
      archivedAt: new Date(),
    });

    const list = (limit: number) => (cursor?: string) =>
      teams().list(workspaceId, { limit, cursor });
    const byHundred = await walk(list(100));
    expect(byHundred.map((page) => page.length)).toEqual([100, 100, 5]);
    expect(byHundred.flat()).toEqual(all);
    // A last page that is exactly full says there is no next one.
    const byFortyOne = await walk(list(41));
    expect(byFortyOne.map((page) => page.length)).toEqual([41, 41, 41, 41, 41]);
    expect(byFortyOne.flat()).toEqual(all);
  });

  test("q keeps the live teams whose name contains it, ignoring case, and pages by the same cursor", async () => {
    const workspaceId = await workspace();
    await seedTeams(workspaceId, ["Ops-East", "ops-west", "sales", "50%_off"]);
    await db.insert(memberTeams).values({
      id: randomUUID(),
      workspaceId,
      name: "ops-archived",
      archivedAt: new Date(),
    });
    const found = (q: string, limit = 50) =>
      walk((cursor) => teams().list(workspaceId, { limit, q, cursor }));
    expect(await found("OPS", 1)).toEqual([["Ops-East"], ["ops-west"]]);
    // `%` and `_` are the characters themselves, not wildcards.
    expect(await found("%_")).toEqual([["50%_off"]]);
    expect(await found("_")).toEqual([["50%_off"]]);
    expect(await found("nobody")).toEqual([[]]);
  });

  test("one's own teams page by name too", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const mine = await person(workspaceId, "member");
    const joined = await seedTeams(workspaceId, ["c", "a", "e", "b", "d"]);
    for (const team of joined)
      if (team.name !== "b") await member(owner, team.id, mine);

    expect(
      await walk((cursor) =>
        teams().listJoined(workspaceId, idOf(mine), { limit: 2, cursor }),
      ),
    ).toEqual([
      ["a", "c"],
      ["d", "e"],
    ]);
  });

  test("a rename mid-walk moves that team only; the others show once", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const [, , early] = await seedTeams(workspaceId, ["b", "c", "a", "d", "e"]);
    const first = await teams().list(workspaceId, { limit: 2 });
    expect(first.items.map((team) => team.name)).toEqual(["a", "b"]);

    // "a" was read; renamed past the cursor it shows a second time.
    await teams().rename({
      actor: acting(owner),
      receiptId: randomUUID(),
      teamId: early?.id ?? "",
      name: "z",
    });
    const rest = await walk((cursor) =>
      teams().list(workspaceId, {
        limit: 2,
        cursor: cursor ?? first.nextCursor ?? "",
      }),
    );
    expect(rest).toEqual([
      ["c", "d"],
      ["e", "z"],
    ]);
  });

  test("a cursor reads only the caller's workspace, and a forged one is refused", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    await seedTeams(mine, ["a", "m", "z"]);
    await seedTeams(theirs, ["k", "n"]);
    const theirCursor = (await teams().list(theirs, { limit: 1 })).nextCursor;
    expect(theirCursor).not.toBeNull();
    expect(
      (
        await teams().list(mine, { limit: 50, cursor: theirCursor ?? "" })
      ).items.map((team) => team.name),
    ).toEqual(["m", "z"]);

    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const reads: ((cursor: string) => Promise<unknown>)[] = [
      (cursor) => teams().list(mine, { limit: 1, cursor }),
      (cursor) => teams().listJoined(mine, randomUUID(), { limit: 1, cursor }),
    ];
    for (const read of reads) {
      for (const forged of [
        "not-a-cursor",
        encode({ name: "a", id: "x" }),
        encode({ name: "", id: randomUUID() }),
        encode({ name: "a\0", id: randomUUID() }),
        encode({ name: "x".repeat(101), id: randomUUID() }),
        encode({ name: 1, id: randomUUID() }),
      ]) {
        const refused = await read(forged).then(
          () => null,
          (error: unknown) => error,
        );
        expect(refused, forged).toBeInstanceOf(InvalidCursorError);
      }
    }
  });

  test("adding a member queues behind a suspension of them instead of deadlocking it", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    // The suspension below locks the lower user_id first; make that the
    // joiner, the order in which the add used to deadlock.
    let joiner = await person(workspaceId, "member");
    while (idOf(joiner) > idOf(owner))
      joiner = await person(workspaceId, "member");
    const team = await newTeam(owner);

    // Replays setAccess's lock order: both users, then memberships in
    // user_id order.
    const suspender = await pool.connect();
    try {
      await suspender.query("BEGIN");
      await suspender.query(
        "SELECT id FROM users WHERE id = ANY($1) ORDER BY id FOR SHARE",
        [[idOf(owner), idOf(joiner)]],
      );
      await suspender.query(
        "SELECT user_id FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
        [workspaceId, idOf(joiner)],
      );
      const added = member(owner, team.id, joiner);
      const waiting = async () =>
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          )
        ).rowCount;
      for (let i = 0; i < 100 && !(await waiting()); i++) {
        await Bun.sleep(20);
      }
      expect(await waiting()).toBeGreaterThan(0);
      await suspender.query(
        "SELECT user_id FROM memberships WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE",
        [workspaceId, idOf(owner)],
      );
      await suspender.query("COMMIT");
      expect(await added).toMatchObject({ outcome: "added" });
    } finally {
      suspender.release();
    }
  });

  test("a reused receipt id fails the write rather than reading as a name clash", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const receiptId = randomUUID();
    const create = (name: string) =>
      teams().create({
        actor: acting(owner),
        receiptId,
        teamId: randomUUID(),
        name,
      });
    expect(await create("first")).toMatchObject({ outcome: "created" });
    await expect(create("second")).rejects.toThrow();
    const team = await newTeam(owner);
    await expect(
      teams().rename({
        actor: acting(owner),
        receiptId,
        teamId: team.id,
        name: "third",
      }),
    ).rejects.toThrow();
  });
});
