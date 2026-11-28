import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresSlackGuestSetting,
  createPostgresWebFetchPreflightSetting,
} from "./access-control/workspace-settings.ts";
import * as schema from "./schema.ts";
import { memberships, receipts, users, workspaces } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("the Slack guest setting on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_guest_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function workspace(settings: Record<string, unknown> = {}) {
    const id = randomUUID();
    await db
      .insert(workspaces)
      .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "Acme", settings });
    return id;
  }

  async function joined(workspaceId: string, role: string, disabled = false) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: role,
    });
    await db.insert(memberships).values({
      workspaceId,
      userId,
      role,
      disabledAt: disabled ? new Date() : null,
    });
    return userId;
  }

  test("off until a stored true says otherwise", async () => {
    const setting = createPostgresSlackGuestSetting(db);
    expect(await setting.enabled(await workspace())).toBe(false);
    expect(
      await setting.enabled(await workspace({ slack_guest_enabled: "true" })),
    ).toBe(false);
    expect(
      await setting.enabled(await workspace({ slack_guest_enabled: true })),
    ).toBe(true);
    expect(await setting.enabled(randomUUID())).toBe(false);
  });

  test("only an active owner or admin writes it, beside the other settings", async () => {
    const workspaceId = await workspace({ audit_retention_days: 45 });
    const setting = createPostgresSlackGuestSetting(db);
    const set = (actorUserId: string, enabled: boolean, id = workspaceId) =>
      setting.setSlackGuestEnabled({ workspaceId: id, actorUserId, enabled });

    expect(await set(await joined(workspaceId, "member"), true)).toBe(false);
    expect(await set(await joined(workspaceId, "admin", true), true)).toBe(
      false,
    );
    expect(await setting.enabled(workspaceId)).toBe(false);

    const admin = await joined(workspaceId, "admin");
    expect(await set(admin, true)).toBe(true);
    expect(await setting.enabled(workspaceId)).toBe(true);
    const owner = await joined(workspaceId, "owner");
    expect(await set(owner, false)).toBe(true);
    expect(await setting.enabled(workspaceId)).toBe(false);

    const [row] = await db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    expect(row?.settings).toEqual({
      audit_retention_days: 45,
      slack_guest_enabled: false,
    });
    // An admin of one workspace is no one in another.
    expect(await set(admin, true, await workspace())).toBe(false);
  });
  test("the WebFetch host check: only an active owner or admin writes it, with a receipt naming them", async () => {
    const workspaceId = await workspace({ slack_guest_enabled: true });
    const setting = createPostgresWebFetchPreflightSetting(db);
    const set = (actorUserId: string, enabled: boolean, id = workspaceId) =>
      setting.setWebFetchPreflight({
        workspaceId: id,
        actorUserId,
        principal: {
          ownerId: id,
          requestId: "req-1",
          actor: {
            principal: { kind: "user", id: actorUserId },
            userId: actorUserId,
            workspaceId: id,
            apiKeyId: null,
          },
        },
        enabled,
      });
    const stored = async () => {
      const [row] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      return row?.settings as Record<string, unknown> | undefined;
    };

    expect(await set(await joined(workspaceId, "member"), false)).toBeNull();
    expect(
      await set(await joined(workspaceId, "admin", true), false),
    ).toBeNull();
    expect(await stored()).toEqual({ slack_guest_enabled: true });

    const admin = await joined(workspaceId, "admin");
    const receiptId = await set(admin, false);
    expect(receiptId).toEqual(expect.any(String));
    expect(await stored()).toEqual({
      slack_guest_enabled: true,
      web_fetch_preflight: false,
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId ?? ""));
    expect(receipt).toMatchObject({
      ownerId: workspaceId,
      operation: "set_web_fetch_preflight",
      status: "succeeded",
      requestId: "req-1",
      actor: expect.objectContaining({ actor_user_id: admin }),
      targetRef: {
        resource: { kind: "workspace", id: workspaceId },
        workspace_id: workspaceId,
      },
      result: { web_fetch_preflight: false },
    });

    const owner = await joined(workspaceId, "owner");
    expect(await set(owner, true)).toEqual(expect.any(String));
    expect((await stored())?.web_fetch_preflight).toBe(true);
    // An admin of one workspace is no one in another, and nothing is recorded.
    const before = (await db.select().from(receipts)).length;
    expect(await set(admin, false, await workspace())).toBeNull();
    expect((await db.select().from(receipts)).length).toBe(before);
  });
});
