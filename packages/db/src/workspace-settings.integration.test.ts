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
import { createPostgresSlackGuestSetting } from "./musterrolle/workspace-settings.ts";
import * as schema from "./schema.ts";
import { memberships, users, workspaces } from "./schema.ts";

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
});
