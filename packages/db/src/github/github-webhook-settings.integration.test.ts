import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { scopesForRole } from "@werft-ai/contracts";
import {
  callerFor,
  MANAGEMENT_ROLES,
  type SecretAudit,
  SecretKey,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { desc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  githubWebhookSettings,
  memberships,
  receipts,
  users,
  workspaces,
} from "../schema.ts";
import {
  createPostgresGitHubAppStore,
  listGitHubWebhookApps,
} from "./github-apps.ts";
import { createPostgresGitHubWebhookSettingsStore } from "./github-webhook-settings.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const BASE = "https://hooks.example.test/in";
const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];
const WEBHOOK_VALUE = "fixture-webhook-value-0001";

const pemOf = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString()
    .trim();

const profile = (appId: number) => ({
  appId,
  slug: `app-${appId}`,
  name: `App ${appId}`,
  htmlUrl: `https://github.com/apps/app-${appId}`,
  clientId: `Iv23li${appId}`,
  permissions: { contents: "write" as const, metadata: "read" as const },
  apiBase: "https://api.github.com",
});

integration("the installation's GitHub webhook settings", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: ReturnType<typeof createPostgresGitHubWebhookSettingsStore>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "github_webhook_settings" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    store = createPostgresGitHubWebhookSettingsStore(db);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await db.delete(githubWebhookSettings);
  });

  async function workspace() {
    const id = randomUUID();
    await db
      .insert(workspaces)
      .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "Acme" });
    return id;
  }

  async function owner(workspaceId: string) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: "owner person",
    });
    await db.insert(memberships).values({ workspaceId, userId, role: "owner" });
    const audit = (): SecretAudit => ({
      principal: callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role: "owner",
          scopes: [...scopesForRole("owner")],
        },
        { kind: "web" },
        randomUUID(),
      ),
      receiptId: randomUUID(),
      roles: MANAGERS,
    });
    return { userId, audit };
  }

  const settingsReceipts = (workspaceId: string) =>
    db
      .select({ result: receipts.result, actor: receipts.actor })
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId))
      .orderBy(receipts.createdAt)
      .then((rows) =>
        rows.filter(
          (row) =>
            (row.result as { webhook_public_url?: unknown })
              ?.webhook_public_url !== undefined,
        ),
      );

  test("no row until something is saved; a save leaves one receipt naming the one before, the same address none", async () => {
    const ws = await workspace();
    const { userId } = await owner(ws);
    const audit = () => ({ userId, workspaceId: ws, receiptId: randomUUID() });
    expect(await store.read()).toBe(null);
    expect(await store.setPublicUrl({ value: BASE, audit: audit() })).toEqual({
      changed: true,
    });
    expect(await store.setPublicUrl({ value: BASE, audit: audit() })).toEqual({
      changed: false,
    });
    expect(await store.setPublicUrl({ value: null, audit: audit() })).toEqual({
      changed: true,
    });
    expect(await store.read()).toEqual({ publicUrl: null });
    expect((await settingsReceipts(ws)).map((row) => row.result)).toEqual([
      { webhook_public_url: BASE, previous: null },
      { webhook_public_url: null, previous: BASE },
    ]);
  });

  test("the env is carried in once, without an actor, and never over a saved row", async () => {
    await workspace();
    expect(await store.importPublicUrl(BASE)).toBe(true);
    expect(await store.importPublicUrl("https://other.example.test")).toBe(
      false,
    );
    expect(await store.read()).toEqual({ publicUrl: BASE });
    // Kept under the installation's oldest workspace, whichever that is here.
    const [carried] = await db
      .select({ result: receipts.result, actor: receipts.actor })
      .from(receipts)
      .where(eq(receipts.operation, "update_github_webhook_settings"))
      .orderBy(desc(receipts.createdAt))
      .limit(1);
    expect(carried?.result).toEqual({
      webhook_public_url: BASE,
      previous: null,
      by: "env_import",
    });
    expect(carried?.actor).toBe(null);
  });

  test("two saves at once each name the address they replaced", async () => {
    const ws = await workspace();
    const { userId } = await owner(ws);
    const audit = () => ({ userId, workspaceId: ws, receiptId: randomUUID() });
    await Promise.all([
      store.setPublicUrl({ value: "https://a.example.test", audit: audit() }),
      store.setPublicUrl({ value: "https://b.example.test", audit: audit() }),
    ]);
    const results = (await settingsReceipts(ws)).map(
      (row) => row.result as { previous: string | null },
    );
    expect(results).toHaveLength(2);
    expect(results.map((one) => one.previous).sort()).toEqual(
      [
        null,
        (await store.read())?.publicUrl === "https://a.example.test"
          ? "https://b.example.test"
          : "https://a.example.test",
      ].sort(),
    );
  });

  test("the Apps a save sets: once per App with a webhook secret, in every workspace, key-only and removed ones left out", async () => {
    const apps = createPostgresGitHubAppStore(db, key);
    const first = await workspace();
    const second = await workspace();
    const a = await owner(first);
    const b = await owner(second);
    const put = async (
      ws: string,
      audit: () => SecretAudit,
      appId: number,
      kind: "add" | "role",
    ) => {
      const result = await apps.put(
        ws,
        kind === "role"
          ? { kind: "role", role: "author" }
          : { kind: "add", role: "reviewer" },
        profile(appId),
        pemOf(),
        audit(),
      );
      if (result.outcome !== "stored") throw new Error(result.outcome);
      return result.app;
    };
    const shared1 = await put(first, a.audit, 101, "role");
    const shared2 = await put(second, b.audit, 101, "role");
    await put(first, a.audit, 102, "add");
    const removed = await put(second, b.audit, 103, "add");
    for (const [ws, audit, connection] of [
      [first, a.audit, shared1.id],
      [second, b.audit, shared2.id],
      [second, b.audit, removed.id],
    ] as const) {
      const set = await apps.setWebhookSecret(
        ws,
        connection,
        WEBHOOK_VALUE,
        audit(),
      );
      expect(set.outcome).toBe("stored");
    }
    const gone = await apps.delete(
      second,
      { kind: "connection", id: removed.id },
      b.audit(),
    );
    expect(gone.outcome).toBe("deleted");

    const listed = (await listGitHubWebhookApps(db, key)).filter((one) =>
      [101, 102, 103].includes(one.appId),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      appId: 101,
      apiBase: "https://api.github.com",
      name: "App 101",
    });
    expect(listed[0]?.workspaceIds.sort()).toEqual([first, second].sort());
    expect(listed[0]?.privateKey).toStartWith(
      "-----BEGIN RSA PRIVATE KEY-----",
    );

    // Under another master key the App is still listed, with no key.
    const other = SecretKey.fromHex(randomBytes(32).toString("hex"), "OTHER");
    const unread = (await listGitHubWebhookApps(db, other)).find(
      (one) => one.appId === 101,
    );
    expect(unread?.privateKey).toBe(null);
  });
});
