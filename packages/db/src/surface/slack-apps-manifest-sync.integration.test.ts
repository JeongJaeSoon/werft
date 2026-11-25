import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { SecretKey } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { agents, slackApps, workspaces } from "../schema.ts";
import { createPostgresSecretStore } from "../secrets/secret-values.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import { createPostgresSlackAppStore } from "./slack-apps.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("slack_apps manifest checks on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_manifest_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function agentApp(state: "created" | "deleted" = "created") {
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "Notes",
    });
    const slackAppId = randomUUID();
    await db.insert(slackApps).values({
      id: slackAppId,
      workspaceId,
      kind: "agent",
      agentId,
      state,
      appId: `A${randomBytes(4).toString("hex").toUpperCase()}`,
      clientId: "1.1",
      redirectUrl: "https://console.example/cb",
    });
    return { workspaceId, agentId, slackAppId };
  }

  test("lists every workspace's created agent apps and none other", async () => {
    const store = createPostgresSlackAppStore(db, key);
    const live = await agentApp();
    const gone = await agentApp("deleted");
    const listed = await store.listAgentAppsForManifestCheck();
    expect(listed).toContainEqual(live);
    expect(listed.map((app) => app.slackAppId)).not.toContain(gone.slackAppId);
  });

  test("one claim wins until it is stale, and the outcome reads back on the app", async () => {
    const store = createPostgresSlackAppStore(db, key);
    const app = await agentApp();
    const at = new Date("2026-11-25T00:00:00.000Z");
    const claim = (when: Date, staleBefore: Date) =>
      store.claimManifestCheck({
        workspaceId: app.workspaceId,
        slackAppId: app.slackAppId,
        at: when,
        staleBefore,
      });
    expect(
      (await store.find(app.workspaceId, app.slackAppId))?.manifestSync,
    ).toBeNull();
    const [first, second] = await Promise.all([
      claim(at, new Date(at.getTime() - 600_000)),
      claim(at, new Date(at.getTime() - 600_000)),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const before = (await store.find(app.workspaceId, app.slackAppId))
      ?.updatedAt;

    await store.setManifestSync(app.workspaceId, app.slackAppId, {
      error: "slack_refused",
      checkedAt: new Date(at.getTime() + 1_000),
    });
    const record = await store.find(app.workspaceId, app.slackAppId);
    expect(record?.manifestSync).toEqual({
      error: "slack_refused",
      checked_at: "2026-11-25T00:00:01.000Z",
    });
    // A check changes nothing the owner set.
    expect(record?.updatedAt).toEqual(before);

    const later = new Date(at.getTime() + 601_000);
    // The check written at +1 s is not older than a stale line at +0 s.
    expect(await claim(later, at)).toBe(false);
    expect(await claim(later, new Date(at.getTime() + 2_000))).toBe(true);
    // The claim keeps the last outcome until the check writes its own.
    expect(
      (await store.find(app.workspaceId, app.slackAppId))?.manifestSync,
    ).toEqual({ error: "slack_refused", checked_at: later.toISOString() });
  });

  test("an app no longer created is neither claimed nor written", async () => {
    const store = createPostgresSlackAppStore(db, key);
    const app = await agentApp("deleted");
    const at = new Date();
    expect(
      await store.claimManifestCheck({
        workspaceId: app.workspaceId,
        slackAppId: app.slackAppId,
        at,
        staleBefore: at,
      }),
    ).toBe(false);
    await store.setManifestSync(app.workspaceId, app.slackAppId, {
      error: null,
      checkedAt: at,
    });
    const [row] = await db
      .select({ checkedAt: slackApps.manifestSyncCheckedAt })
      .from(slackApps)
      .where(eq(slackApps.id, app.slackAppId));
    expect(row?.checkedAt).toBeNull();
  });

  test("a bot token's scopes are written with the token they were read with only, on a created app", async () => {
    const store = createPostgresSlackAppStore(db, key);
    const secrets = createPostgresSecretStore(db, key);
    const live = await agentApp();
    const gone = await agentApp("deleted");
    const slot = (app: { workspaceId: string; slackAppId: string }) => ({
      workspaceId: app.workspaceId,
      owner: { kind: "slack_app" as const, id: app.slackAppId },
      purpose: "slack_bot_token" as const,
    });
    const version = async (app: { workspaceId: string; slackAppId: string }) =>
      (await store.find(app.workspaceId, app.slackAppId))?.secrets
        .slack_bot_token?.secretVersion ?? 0;
    for (const app of [live, gone]) await secrets.put(slot(app), "fixture-one");
    const read = await version(live);
    for (const app of [live, gone])
      await store.setBotScopes(
        app.workspaceId,
        app.slackAppId,
        ["chat:write"],
        await version(app),
      );
    expect(
      (await store.find(live.workspaceId, live.slackAppId))?.botScopes,
    ).toEqual(["chat:write"]);
    // A new install stored another token after the scopes were read.
    await secrets.put(slot(live), "fixture-two");
    await store.setBotScopes(
      live.workspaceId,
      live.slackAppId,
      ["users:read"],
      read,
    );
    expect(
      (await store.find(live.workspaceId, live.slackAppId))?.botScopes,
    ).toEqual(["chat:write"]);
    const [row] = await db
      .select({ botScopes: slackApps.botScopes })
      .from(slackApps)
      .where(eq(slackApps.id, gone.slackAppId));
    expect(row?.botScopes).toBeNull();
  });

  test("scopes read with the old token wait for an install that holds the app and are dropped after it", async () => {
    const store = createPostgresSlackAppStore(db, key);
    const secrets = createPostgresSecretStore(db, key);
    const app = await agentApp();
    const slot = {
      workspaceId: app.workspaceId,
      owner: { kind: "slack_app" as const, id: app.slackAppId },
      purpose: "slack_bot_token" as const,
    };
    await secrets.put(slot, "fixture-one");
    const read =
      (await store.find(app.workspaceId, app.slackAppId))?.secrets
        .slack_bot_token?.secretVersion ?? 0;
    // A new install, as storeBotToken writes it: the app row locked, then
    // a new token version and its scopes, committed together.
    const install = await pool.connect();
    let late: Promise<void> | undefined;
    let committed = false;
    try {
      await install.query("BEGIN");
      await install.query(
        "SELECT id FROM slack_apps WHERE id = $1 FOR UPDATE",
        [app.slackAppId],
      );
      await install.query(
        "UPDATE secret_values SET secret_version = secret_version + 1 WHERE workspace_id = $1 AND purpose = 'slack_bot_token'",
        [app.workspaceId],
      );
      await install.query(
        "UPDATE slack_apps SET bot_scopes = ARRAY['chat:write', 'groups:write'] WHERE id = $1",
        [app.slackAppId],
      );
      late = store.setBotScopes(
        app.workspaceId,
        app.slackAppId,
        ["chat:write"],
        read,
      );
      // Commit only once the late write is queued behind the install's lock.
      for (let tries = 0; ; tries++) {
        const { rows } = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
        );
        if (rows[0].n > 0) break;
        if (tries > 100) throw new Error("the late write never waited");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await install.query("COMMIT");
      committed = true;
      await late;
    } finally {
      if (!committed) {
        await install.query("ROLLBACK");
        await late?.catch(() => {});
      }
      install.release();
    }
    expect(
      (await store.find(app.workspaceId, app.slackAppId))?.botScopes,
    ).toEqual(["chat:write", "groups:write"]);
  }, 20_000);

  test("the table refuses an error the contract does not name", async () => {
    const app = await agentApp();
    const refused = await db
      .execute(
        sql`UPDATE slack_apps SET manifest_sync_error = 'oops' WHERE id = ${app.slackAppId}`,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(
      String((refused as { cause?: unknown })?.cause ?? refused),
    ).toContain("slack_apps_manifest_sync_error_check");
  });
});
