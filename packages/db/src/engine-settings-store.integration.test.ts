import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type StoredEngineSettings,
  scopesForRole,
  type ToolCatalogView,
} from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  createEngineSettingsService,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresEngineSettingsStore } from "./engine-settings-store.ts";
import { createDatabaseIdentityReader } from "./musterrolle/identity-reader.ts";
import * as schema from "./schema.ts";
import {
  agentEngineSettings,
  agents,
  memberships,
  receipts,
  users,
  workspaceEngineSettings,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const CATALOG: ToolCatalogView = {
  id: "test",
  tools: ["Read", "Bash", "WebFetch"].map((name) => ({
    name,
    boundary: "local" as const,
  })),
};

const rules = (
  permissions: StoredEngineSettings["permissions"] = {},
): StoredEngineSettings => ({ permissions, auto_mode: {} });

/** The error code and reason of a refused call, or "saved". */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const failure = error as {
      code?: string;
      details?: { reason_code?: string } | null;
    };
    return `${failure.code}:${failure.details?.reason_code ?? ""}`;
  }
  return "saved";
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Whether `promise` is still waiting after `ms`. */
async function stillWaiting(promise: Promise<unknown>, ms = 400) {
  const marker = Symbol("done");
  const first = await Promise.race([promise.then(() => marker), sleep(ms)]);
  return first !== marker;
}

integration("the engine settings writer on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "engine_settings_it" });
    pool = new Pool({ connectionString: database.url, max: 12 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const service = () =>
    createEngineSettingsService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresEngineSettingsStore(db),
      catalogs: [CATALOG],
    });

  async function person(workspaceId: string, role: "owner" | "member") {
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

  const callerOf = (
    workspaceId: string,
    userId: string,
    role: "owner" | "member",
    surface: "web" | "api" = "web",
  ): Caller =>
    callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: surface },
      randomUUID(),
    );

  async function setup() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    const ownerId = await person(workspaceId, "owner");
    const memberId = await person(workspaceId, "member");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
    });
    return {
      workspaceId,
      agentId,
      ownerId,
      owner: callerOf(workspaceId, ownerId, "owner"),
      member: callerOf(workspaceId, memberId, "member"),
    };
  }

  const request = (
    expected_revision: number | null,
    settings: StoredEngineSettings = rules({ deny: ["Bash"] }),
  ) => ({ expected_revision, settings });

  const receiptsOf = (operation: string, targetId: string) =>
    db
      .select()
      .from(receipts)
      .where(
        sql`${receipts.operation} = ${operation} AND ${receipts.targetRef} -> 'resource' ->> 'id' = ${targetId}`,
      );

  test("a save stores and records", async () => {
    const { agentId, owner } = await setup();
    const saved = await service().putAgent(owner, agentId, request(null));
    expect(saved.settings_revision).toBe(1);
    expect(saved.receipt_id).toBeString();
    const read = await service().getAgent(owner, agentId);
    expect(read).toMatchObject({
      settings: rules({ deny: ["Bash"] }),
      settings_revision: 1,
    });
  });

  test("the receipt counts rules and never carries their text", async () => {
    const { workspaceId, owner } = await setup();
    await service().putWorkspace(
      owner,
      workspaceId,
      request(null, rules({ deny: ["Bash", "WebFetch"], ask: ["Read"] })),
    );
    const [receipt] = await receiptsOf(
      "set_workspace_engine_settings",
      workspaceId,
    );
    expect(receipt?.result).toMatchObject({
      scope: "workspace",
      revision_before: null,
      revision_after: 1,
      after: { permissions: { deny: 2, ask: 1 } },
    });
    expect(JSON.stringify(receipt?.result)).not.toContain("WebFetch");
  });

  test("saving the same rules again changes nothing and writes no receipt", async () => {
    const { agentId, owner } = await setup();
    const first = await service().putAgent(owner, agentId, request(null));
    const again = await service().putAgent(owner, agentId, request(1));
    expect(again).toEqual({ settings_revision: 1, receipt_id: null });
    expect(first.settings_revision).toBe(1);
    expect(await receiptsOf("set_agent_engine_settings", agentId)).toHaveLength(
      1,
    );
    const changed = await service().putAgent(
      owner,
      agentId,
      request(1, rules({ deny: ["Bash", "WebFetch"] })),
    );
    expect(changed.settings_revision).toBe(2);
  });

  test("a stale or missing revision is a conflict", async () => {
    const { workspaceId, owner } = await setup();
    await service().putWorkspace(owner, workspaceId, request(null));
    expect(
      await refusal(service().putWorkspace(owner, workspaceId, request(null))),
    ).toBe("REVISION_CONFLICT:");
    expect(
      await refusal(service().putWorkspace(owner, workspaceId, request(7))),
    ).toBe("REVISION_CONFLICT:");
  });

  test("a member who manages nothing is refused, and an API key is too", async () => {
    const { workspaceId, agentId, member, ownerId } = await setup();
    expect(
      await refusal(service().putAgent(member, agentId, request(null))),
    ).toStartWith("FORBIDDEN");
    expect(
      await refusal(service().putWorkspace(member, workspaceId, request(null))),
    ).toStartWith("FORBIDDEN");
    const byKey = callerOf(workspaceId, ownerId, "owner", "api");
    expect(
      await refusal(service().putAgent(byKey, agentId, request(null))),
    ).toStartWith("FORBIDDEN");
    expect(await db.select().from(workspaceEngineSettings)).not.toContainEqual(
      expect.objectContaining({ workspaceId }),
    );
  });

  test("two saves from the same revision: one wins, one conflicts, one receipt", async () => {
    const { agentId, owner } = await setup();
    const results = await Promise.all(
      [rules({ deny: ["Bash"] }), rules({ deny: ["WebFetch"] })].map(
        (settings) =>
          refusal(service().putAgent(owner, agentId, request(null, settings))),
      ),
    );
    expect([...results].sort()).toEqual(["REVISION_CONFLICT:", "saved"]);
    expect(await receiptsOf("set_agent_engine_settings", agentId)).toHaveLength(
      1,
    );
  });

  test("a save waits for a session start's lock on the agent and then goes through", async () => {
    const { agentId, owner } = await setup();
    const held = await pool.connect();
    await held.query("BEGIN");
    // What `captureEngineSettingsStart` holds while it reads the snapshot.
    await held.query("SELECT id FROM agents WHERE id = $1 FOR SHARE", [
      agentId,
    ]);
    const save = service().putAgent(owner, agentId, request(null));
    expect(await stillWaiting(save)).toBe(true);
    await held.query("COMMIT");
    held.release();
    expect((await save).settings_revision).toBe(1);
  });

  test("a manager disabled while a save waits is refused, not saved", async () => {
    const { agentId, ownerId, owner } = await setup();
    const suspending = await pool.connect();
    await suspending.query("BEGIN");
    // What offboarding does: the account row, then the membership.
    await suspending.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [
      ownerId,
    ]);
    const save = refusal(service().putAgent(owner, agentId, request(null)));
    expect(await stillWaiting(save)).toBe(true);
    await suspending.query(
      "UPDATE memberships SET disabled_at = now() WHERE user_id = $1",
      [ownerId],
    );
    await suspending.query("COMMIT");
    suspending.release();
    expect(await save).toStartWith("FORBIDDEN");
    expect(
      await db
        .select()
        .from(agentEngineSettings)
        .where(eq(agentEngineSettings.agentId, agentId)),
    ).toEqual([]);
  });
});
