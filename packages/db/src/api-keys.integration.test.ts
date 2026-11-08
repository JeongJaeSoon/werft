import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type ApiKeyService,
  type Caller,
  callerFor,
  createApiKeyService,
  createAuthorizationPolicy,
  InvalidCursorError,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresWorkspaceKeyStore } from "./api-keys.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import * as schema from "./schema.ts";
import {
  agentAdmins,
  agents,
  memberships,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

type Seed = {
  kind: "personal" | "agent";
  by: string;
  agentId?: string;
  at: string;
};

integration("GET /v1/api-keys pages on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let keys: ApiKeyService;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "api_key_pages_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    keys = createApiKeyService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresWorkspaceKeyStore(db),
      mint: () => {
        throw new Error("these tests list keys, never issue one");
      },
    });
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

  async function person(
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<{ id: string; caller: Caller }> {
    const id = randomUUID();
    await db.insert(users).values({
      id,
      email: `${id}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId: id, role });
    const caller = callerFor(
      {
        kind: "user",
        id,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
    return { id, caller };
  }

  async function agent(workspaceId: string, adminId?: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${id.slice(0, 8)}`,
      name: "a",
    });
    if (adminId) {
      await db
        .insert(agentAdmins)
        .values({ workspaceId, agentId: id, userId: adminId });
    }
    return id;
  }

  // Rows straight into api_keys, so created_at can tie and differ by 1µs.
  async function seedKeys<const S extends readonly Seed[]>(
    workspaceId: string,
    seeds: S,
  ): Promise<{ [K in keyof S]: string }> {
    const ids = seeds.map(() => randomUUID());
    await pool.query(
      `INSERT INTO api_keys
         (id, key_hash, owner_id, workspace_id, kind, created_by_user_id, agent_id, scopes, created_at)
       SELECT id, decode(md5(id::text), 'hex'), $1::text, $1::text::uuid, kind, by, agent, ARRAY['sessions:read'], at
       FROM unnest($2::uuid[], $3::text[], $4::uuid[], $5::uuid[], $6::timestamptz[])
         AS seed(id, kind, by, agent, at)`,
      [
        workspaceId,
        ids,
        seeds.map((seed) => seed.kind),
        seeds.map((seed) => seed.by),
        seeds.map((seed) => seed.agentId ?? null),
        seeds.map((seed) => seed.at),
      ],
    );
    return ids as { [K in keyof S]: string };
  }

  async function walk(caller: Caller, limit: number) {
    const pages: { ids: string[]; next_cursor: string | null }[] = [];
    let cursor: string | undefined;
    do {
      const page = await keys.list(caller, {
        limit,
        ...(cursor ? { cursor } : {}),
      });
      pages.push({
        ids: page.items.map((key) => key.id),
        next_cursor: page.next_cursor,
      });
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return pages;
  }

  // created_at, id newest first: what the list promises.
  async function newestFirst(ids: readonly string[]) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM api_keys WHERE id = ANY($1::uuid[])
       ORDER BY created_at DESC, id DESC`,
      [ids],
    );
    return rows.map((row) => row.id);
  }

  test("pages walk created_at, id newest first through ties and microseconds, and only the last page has no next_cursor", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const bot = await agent(workspaceId);
    const tie = "2026-01-01 00:00:00.000001+00";
    const ids = await seedKeys(workspaceId, [
      { kind: "personal", by: owner.id, at: tie },
      { kind: "agent", by: owner.id, agentId: bot, at: tie },
      { kind: "personal", by: owner.id, at: tie },
      {
        kind: "agent",
        by: owner.id,
        agentId: bot,
        at: "2026-01-01 00:00:00.000002+00",
      },
      { kind: "personal", by: owner.id, at: "2026-01-01 00:00:00+00" },
      { kind: "agent", by: owner.id, agentId: bot, at: tie },
      { kind: "personal", by: owner.id, at: "2026-01-02 00:00:00+00" },
    ]);
    const pages = await walk(owner.caller, 3);
    expect(pages.map((page) => page.ids.length)).toEqual([3, 3, 1]);
    expect(pages.map((page) => page.next_cursor === null)).toEqual([
      false,
      false,
      true,
    ]);
    expect(pages.flatMap((page) => page.ids)).toEqual(await newestFirst(ids));

    // Exactly limit keys: one full page, nothing after it.
    const exact = await workspace();
    const exactOwner = await person(exact, "owner");
    const exactIds = await seedKeys(exact, [
      { kind: "personal", by: exactOwner.id, at: tie },
      { kind: "personal", by: exactOwner.id, at: tie },
      { kind: "personal", by: exactOwner.id, at: tie },
    ]);
    expect(await walk(exactOwner.caller, 3)).toEqual([
      { ids: await newestFirst(exactIds), next_cursor: null },
    ]);
  });

  test("more than the old 200 cap are all listed, and no cursor reads the newest 50", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const ids = await seedKeys(
      workspaceId,
      Array.from({ length: 201 }, (_, i) => ({
        kind: "personal" as const,
        by: owner.id,
        at: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      })),
    );
    const all = await newestFirst(ids);
    const first = await keys.list(owner.caller, { limit: 50 });
    expect(first.items.map((key) => key.id)).toEqual(all.slice(0, 50));
    expect(first.next_cursor).not.toBeNull();
    const pages = await walk(owner.caller, 100);
    expect(pages.map((page) => page.ids.length)).toEqual([100, 100, 1]);
    expect(pages.flatMap((page) => page.ids)).toEqual(all);
  });

  test("personal and agent keys mix on one page under the same rule on every page, and nobody sees another's personal key", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const member = await person(workspaceId, "member");
    const outsider = await person(workspaceId, "member");
    const mine = await agent(workspaceId, member.id);
    const theirs = await agent(workspaceId, owner.id);
    const at = (second: number) =>
      `2026-01-01 00:00:${String(second).padStart(2, "0")}+00`;
    const [
      ownerPersonal,
      memberPersonal1,
      mineKey1,
      theirsKey1,
      adminPersonal,
      memberPersonal2,
      mineKey2,
      theirsKey2,
    ] = await seedKeys(workspaceId, [
      { kind: "personal", by: owner.id, at: at(1) },
      { kind: "personal", by: member.id, at: at(2) },
      { kind: "agent", by: member.id, agentId: mine, at: at(3) },
      { kind: "agent", by: owner.id, agentId: theirs, at: at(4) },
      { kind: "personal", by: admin.id, at: at(5) },
      { kind: "personal", by: member.id, at: at(6) },
      { kind: "agent", by: member.id, agentId: mine, at: at(7) },
      { kind: "agent", by: owner.id, agentId: theirs, at: at(8) },
    ]);
    const seen = async (who: { caller: Caller }) =>
      (await walk(who.caller, 2)).flatMap((page) => page.ids);

    // Their own personal keys, plus their agent's keys only.
    expect(await seen(member)).toEqual([
      mineKey2,
      memberPersonal2,
      mineKey1,
      memberPersonal1,
    ]);
    // Every agent key, and their own personal key only.
    expect(await seen(owner)).toEqual([
      theirsKey2,
      mineKey2,
      theirsKey1,
      mineKey1,
      ownerPersonal,
    ]);
    expect(await seen(admin)).toEqual([
      theirsKey2,
      mineKey2,
      adminPersonal,
      theirsKey1,
      mineKey1,
    ]);
    expect(await walk(outsider.caller, 2)).toEqual([
      { ids: [], next_cursor: null },
    ]);
  });

  test("a page read after a role change follows the new role, and the walk never repeats a key", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const bot = await agent(workspaceId, owner.id);
    const at = (second: number) =>
      `2026-01-01 00:00:${String(second).padStart(2, "0")}+00`;
    const [k1, p1, k3, p2, k5] = await seedKeys(workspaceId, [
      { kind: "agent", by: owner.id, agentId: bot, at: at(1) },
      { kind: "personal", by: admin.id, at: at(2) },
      { kind: "agent", by: owner.id, agentId: bot, at: at(3) },
      { kind: "personal", by: admin.id, at: at(4) },
      { kind: "agent", by: owner.id, agentId: bot, at: at(5) },
    ]);
    const idsOf = (page: { items: { id: string }[] }) =>
      page.items.map((key) => key.id);
    const setRole = (role: WorkspaceRole) =>
      db
        .update(memberships)
        .set({ role })
        .where(
          and(
            eq(memberships.workspaceId, workspaceId),
            eq(memberships.userId, admin.id),
          ),
        );

    const first = await keys.list(admin.caller, { limit: 2 });
    expect(idsOf(first)).toEqual([k5, p2]);
    await setRole("member");
    // Demoted mid-walk: the older agent keys are no longer theirs to see.
    const demoted = await keys.list(admin.caller, {
      limit: 2,
      cursor: first.next_cursor ?? "",
    });
    expect(idsOf(demoted)).toEqual([p1]);
    expect(demoted.next_cursor).toBeNull();

    // Promoted mid-walk: the rest of the walk shows the agent keys again.
    const asMember = await keys.list(admin.caller, { limit: 1 });
    expect(idsOf(asMember)).toEqual([p2]);
    await setRole("admin");
    const promoted = await keys.list(admin.caller, {
      limit: 2,
      cursor: asMember.next_cursor ?? "",
    });
    expect(idsOf(promoted)).toEqual([k3, p1]);
    const rest = await keys.list(admin.caller, {
      limit: 2,
      cursor: promoted.next_cursor ?? "",
    });
    expect(idsOf(rest)).toEqual([k1]);
    expect(rest.next_cursor).toBeNull();
  });

  test("a cursor only positions: another workspace's cursor shows nothing of that workspace, and a forged one is refused", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const me = await person(mine, "owner");
    const them = await person(theirs, "owner");
    const [myKey] = await seedKeys(mine, [
      { kind: "personal", by: me.id, at: "2026-01-01 00:00:00+00" },
    ]);
    await seedKeys(theirs, [
      { kind: "personal", by: them.id, at: "2026-01-02 00:00:00+00" },
      { kind: "personal", by: them.id, at: "2026-01-03 00:00:00+00" },
    ]);
    const theirCursor = (await keys.list(them.caller, { limit: 1 }))
      .next_cursor;
    expect(theirCursor).not.toBeNull();
    const page = await keys.list(me.caller, {
      limit: 50,
      cursor: theirCursor ?? "",
    });
    expect(page.items.map((key) => key.id)).toEqual([myKey]);

    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const forged of [
      "not-a-cursor",
      encode({ created_at: "2026-01-01", id: randomUUID() }),
      encode({ created_at: "2026-13-01 00:00:00+00", id: randomUUID() }),
      encode({ created_at: "2026-01-01 00:00:00+00", id: "x" }),
    ]) {
      const refused = await keys
        .list(them.caller, { limit: 1, cursor: forged })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused, forged).toBeInstanceOf(InvalidCursorError);
    }
  });
});
