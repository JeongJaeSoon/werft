import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as schema from "@werft-ai/db";
import { bootstrapOwner, memberships, users } from "@werft-ai/db";
import { liveSetupLinkHash } from "@werft-ai/db/testing/setup-link";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hashPassword, verifyPassword } from "./auth.ts";
import {
  DEMO_ACCOUNTS,
  DEMO_PASSWORD,
  seedDemoAccounts,
} from "./demo-accounts.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

integration("seedDemoAccounts on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeEach(async () => {
    database = await createTempDatabase({ prefix: "demo_accounts" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterEach(async () => {
    await pool?.end();
    await database?.drop();
  });

  const roles = async () =>
    (
      await db
        .select({ email: users.email, role: memberships.role })
        .from(users)
        .leftJoin(memberships, eq(memberships.userId, users.id))
        .orderBy(users.email)
    ).map(({ email, role }) => `${email}:${role}`);

  async function otherOwner() {
    await bootstrapOwner(db, {
      userId: randomUUID(),
      email: "someone@example.test",
      passwordHash: await hashPassword("someone-else-password"),
      displayName: "Someone",
      workspaceId: randomUUID(),
      workspaceSlug: "someone",
      workspaceName: "Someone",
      setupTokenHash: await liveSetupLinkHash(db),
      receiptId: randomUUID(),
      loginMethodId: randomUUID(),
    });
  }

  test("an empty installation gets both accounts, and a second run adds nothing", async () => {
    expect(await seedDemoAccounts(db)).toEqual([
      { email: "demo-owner@example.test", outcome: "created" },
      { email: "demo-member@example.test", outcome: "created" },
    ]);
    expect(await roles()).toEqual([
      "demo-member@example.test:member",
      "demo-owner@example.test:owner",
    ]);
    for (const account of DEMO_ACCOUNTS) {
      const [row] = await db
        .select({ hash: users.passwordHash })
        .from(users)
        .where(eq(users.email, account.email));
      expect(await verifyPassword(DEMO_PASSWORD, row?.hash ?? null)).toBe(true);
    }
    const [workspace] = await db.select().from(schema.workspaces);
    expect(workspace?.slug).toBe("demo");

    const before = await db.select().from(users);
    expect(await seedDemoAccounts(db)).toEqual([
      { email: "demo-owner@example.test", outcome: "exists" },
      { email: "demo-member@example.test", outcome: "exists" },
    ]);
    expect(await db.select().from(users)).toEqual(before);
    expect(await db.select().from(schema.workspaces)).toHaveLength(1);
  });

  test("an installation with its own owner gets the demo accounts invited into its workspace", async () => {
    await otherOwner();
    await seedDemoAccounts(db);
    expect(await roles()).toEqual([
      "demo-member@example.test:member",
      "demo-owner@example.test:owner",
      "someone@example.test:owner",
    ]);
    expect(await db.select().from(schema.workspaces)).toHaveLength(1);
  });

  test("an existing demo address keeps its password and role", async () => {
    await otherOwner();
    await seedDemoAccounts(db);
    const changed = await hashPassword("changed-by-the-developer");
    await db
      .update(users)
      .set({ passwordHash: changed })
      .where(eq(users.email, "demo-member@example.test"));
    await seedDemoAccounts(db);
    const [row] = await db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.email, "demo-member@example.test"));
    expect(row?.hash).toBe(changed);
  });

  test("seeding beside a bootstrap waits for it and refuses instead of recovering", async () => {
    // Holds bootstrap's lock while a user appears and its owner goes away:
    // the state recovery would act on.
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext('auth.bootstrap'))",
      );
      const seeding = seedDemoAccounts(db);
      await Bun.sleep(200);
      const id = randomUUID();
      await holder.query(
        "INSERT INTO users (id, email, display_name, disabled_at) VALUES ($1, 'someone@example.test', 'Someone', now())",
        [id],
      );
      await holder.query("COMMIT");
      await expect(seeding).rejects.toThrow(
        "the installation has users but no live owner",
      );
    } finally {
      holder.release();
    }
    expect(await roles()).toEqual(["someone@example.test:null"]);
    expect(await db.select().from(schema.workspaces)).toHaveLength(0);
  });

  test("users without a live owner are refused instead of recovered", async () => {
    await otherOwner();
    await db.update(users).set({ disabledAt: new Date() });
    await expect(seedDemoAccounts(db)).rejects.toThrow(
      "the installation has users but no live owner",
    );
    expect(await roles()).toEqual(["someone@example.test:owner"]);
  });
});
