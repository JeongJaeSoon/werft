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
import * as schema from "../schema.ts";
import { slackInstallations, workspaces } from "../schema.ts";
import {
  findSlackInstallation,
  registerSlackInstallation,
  revokeSlackInstallation,
  verifySlackInstallation,
} from "./slack-installations.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("slack_installations on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  const newWorkspace = async () => {
    const id = randomUUID();
    await db.insert(workspaces).values({ id, slug: `ws-${id}`, name: "ws" });
    return id;
  };
  // Fixture ids shaped like Slack's; no Slack app is involved.
  const newKey = () => ({
    appId: `A${randomUUID().slice(0, 8).toUpperCase()}`,
    teamId: `T${randomUUID().slice(0, 8).toUpperCase()}`,
  });
  const rowsFor = (appId: string) =>
    db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.appId, appId));

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_inst_it" });
    pool = new Pool({ connectionString: database.url, max: 10 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  test("registers a pending row and finds it by app and team", async () => {
    const workspaceId = await newWorkspace();
    const key = newKey();

    const result = await registerSlackInstallation(db, { ...key, workspaceId });

    expect(result.outcome).toBe("registered");
    expect(result.installation).toMatchObject({
      ...key,
      workspaceId,
      status: "pending",
      botUserId: null,
      verifiedAt: null,
      revokedAt: null,
    });
    expect(await findSlackInstallation(db, key)).toEqual(result.installation);
    expect(
      await findSlackInstallation(db, { ...key, teamId: "T-other" }),
    ).toBeNull();
  });

  test("registering the same app and team twice keeps one row", async () => {
    const workspaceId = await newWorkspace();
    const key = newKey();

    const first = await registerSlackInstallation(db, { ...key, workspaceId });
    const second = await registerSlackInstallation(db, { ...key, workspaceId });

    expect(second).toEqual({
      outcome: "existing",
      installation: first.installation,
    });
    expect(await rowsFor(key.appId)).toHaveLength(1);
  });

  test("concurrent registrations of one app and team leave one row", async () => {
    const workspaceId = await newWorkspace();
    const key = newKey();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        registerSlackInstallation(db, { ...key, workspaceId }),
      ),
    );

    expect(results.filter((r) => r.outcome === "registered")).toHaveLength(1);
    expect(new Set(results.map((r) => r.installation.id)).size).toBe(1);
    expect(await rowsFor(key.appId)).toHaveLength(1);
  });

  test("the same app and team cannot be registered for a second workspace", async () => {
    const owner = await newWorkspace();
    const other = await newWorkspace();
    const key = newKey();
    const first = await registerSlackInstallation(db, {
      ...key,
      workspaceId: owner,
    });

    const second = await registerSlackInstallation(db, {
      ...key,
      workspaceId: other,
    });

    expect(second).toEqual({
      outcome: "workspace_conflict",
      installation: first.installation,
    });
    expect(await rowsFor(key.appId)).toHaveLength(1);
  });

  test("the same app in another team is its own installation", async () => {
    const workspaceId = await newWorkspace();
    const key = newKey();
    await registerSlackInstallation(db, { ...key, workspaceId });

    const other = await registerSlackInstallation(db, {
      ...key,
      teamId: `${key.teamId}2`,
      workspaceId,
    });

    expect(other.outcome).toBe("registered");
    expect(await rowsFor(key.appId)).toHaveLength(2);
  });

  test("verify records the bot user and can run again on the next start", async () => {
    const workspaceId = await newWorkspace();
    const key = newKey();
    await registerSlackInstallation(db, { ...key, workspaceId });

    const verified = await verifySlackInstallation(db, {
      ...key,
      botUserId: "U0BOT1",
    });
    expect(verified.outcome).toBe("verified");
    if (verified.outcome !== "verified") throw new Error("unreachable");
    expect(verified.installation).toMatchObject({
      status: "verified",
      botUserId: "U0BOT1",
    });
    expect(verified.installation.verifiedAt).toBeInstanceOf(Date);

    const again = await verifySlackInstallation(db, {
      ...key,
      botUserId: "U0BOT1",
    });
    if (again.outcome !== "verified") throw new Error(again.outcome);
    expect(again.installation.verifiedAt?.getTime()).toBeGreaterThanOrEqual(
      verified.installation.verifiedAt?.getTime() ?? Infinity,
    );
    // Registering a verified row leaves it verified.
    const reregistered = await registerSlackInstallation(db, {
      ...key,
      workspaceId,
    });
    expect(reregistered).toMatchObject({
      outcome: "existing",
      installation: { status: "verified", botUserId: "U0BOT1" },
    });
  });

  test("verify of an unknown installation is not_found", async () => {
    expect(
      await verifySlackInstallation(db, { ...newKey(), botUserId: "U0BOT" }),
    ).toEqual({ outcome: "not_found" });
  });

  test("revoke is final until the install is registered again, keeping its id", async () => {
    const workspaceId = await newWorkspace();
    const key = newKey();
    const { installation } = await registerSlackInstallation(db, {
      ...key,
      workspaceId,
    });
    await verifySlackInstallation(db, { ...key, botUserId: "U0BOT" });

    const revoked = await revokeSlackInstallation(db, key);
    if (revoked.outcome !== "revoked") throw new Error(revoked.outcome);
    expect(revoked.installation.status).toBe("revoked");
    const revokedAt = revoked.installation.revokedAt;
    expect(revokedAt).toBeInstanceOf(Date);

    const twice = await revokeSlackInstallation(db, key);
    if (twice.outcome !== "revoked") throw new Error(twice.outcome);
    expect(twice.installation.revokedAt).toEqual(revokedAt);

    const verify = await verifySlackInstallation(db, {
      ...key,
      botUserId: "U0BOT",
    });
    expect(verify).toMatchObject({
      outcome: "revoked",
      installation: { status: "revoked" },
    });

    // Another workspace cannot take the revoked install over.
    const other = await registerSlackInstallation(db, {
      ...key,
      workspaceId: await newWorkspace(),
    });
    expect(other.outcome).toBe("workspace_conflict");

    const reopened = await registerSlackInstallation(db, {
      ...key,
      workspaceId,
    });
    expect(reopened).toMatchObject({
      outcome: "registered",
      installation: {
        id: installation.id,
        status: "pending",
        botUserId: null,
        verifiedAt: null,
        revokedAt: null,
      },
    });
    expect(await rowsFor(key.appId)).toHaveLength(1);
  });

  test("verify racing a re-register reports the state it acted on", async () => {
    const workspaceId = await newWorkspace();
    for (let round = 0; round < 20; round++) {
      const key = newKey();
      await registerSlackInstallation(db, { ...key, workspaceId });
      await revokeSlackInstallation(db, key);

      const [verify] = await Promise.all([
        verifySlackInstallation(db, { ...key, botUserId: "U0BOT" }),
        registerSlackInstallation(db, { ...key, workspaceId }),
      ]);

      if (verify.outcome === "not_found") throw new Error("lost the row");
      expect(verify.installation.status).toBe(
        verify.outcome === "revoked" ? "revoked" : "verified",
      );
    }
  });

  test("revoke of an unknown installation is not_found", async () => {
    expect(await revokeSlackInstallation(db, newKey())).toEqual({
      outcome: "not_found",
    });
  });

  test("the table refuses rows whose status and timestamps disagree", async () => {
    const workspaceId = await newWorkspace();
    const insert = async (
      values: Partial<typeof slackInstallations.$inferInsert>,
    ) => {
      await db.insert(slackInstallations).values({
        id: randomUUID(),
        workspaceId,
        ...newKey(),
        ...values,
      });
    };

    await expect(insert({ status: "verified" })).rejects.toThrow();
    await expect(insert({ status: "revoked" })).rejects.toThrow();
    await expect(
      insert({ status: "pending", revokedAt: new Date() }),
    ).rejects.toThrow();
    await expect(
      // @ts-expect-error the column only takes the three states
      insert({ status: "active" }),
    ).rejects.toThrow();
    await expect(
      insert({ workspaceId: randomUUID(), status: "pending" }),
    ).rejects.toThrow();
  });
});
