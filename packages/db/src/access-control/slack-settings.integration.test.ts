import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
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
import { receipts, slackSettings, workspaces } from "../schema.ts";
import { createPostgresSlackSettingsStore } from "./slack-settings.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const EVENTS = "https://events.example.test/in";

integration("the installation's Slack settings", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: ReturnType<typeof createPostgresSlackSettingsStore>;
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const audit = () => ({ userId, workspaceId, receiptId: randomUUID() });
  const settingsReceipts = () =>
    db
      .select({ result: receipts.result, actor: receipts.actor })
      .from(receipts)
      .where(eq(receipts.operation, "update_slack_settings"))
      .orderBy(receipts.createdAt);

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_settings" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    store = createPostgresSlackSettingsStore(db);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await db.delete(receipts);
    await db.delete(slackSettings);
  });

  const withWorkspace = () =>
    db
      .insert(workspaces)
      .values({ id: workspaceId, name: "W", slug: `w-${workspaceId}` })
      .onConflictDoNothing();

  test("no row until something is saved", async () => {
    expect(await store.read()).toBe(null);
  });

  test("a save keeps the address with one receipt naming the one before; the same address again leaves none", async () => {
    await withWorkspace();
    expect(
      await store.setEventsPublicUrl({ value: EVENTS, audit: audit() }),
    ).toEqual({ changed: true });
    expect(
      await store.setEventsPublicUrl({ value: EVENTS, audit: audit() }),
    ).toEqual({ changed: false });
    expect(
      await store.setEventsPublicUrl({ value: null, audit: audit() }),
    ).toEqual({ changed: true });
    expect(await store.read()).toEqual({ eventsPublicUrl: null });
    const written = await settingsReceipts();
    expect(written.map((row) => row.result)).toEqual([
      { events_public_url: EVENTS, previous: null },
      { events_public_url: null, previous: EVENTS },
    ]);
    expect(written[0]?.actor).toMatchObject({ actor_user_id: userId });
  });

  test("clearing with no row still leaves one, so an upgrade carries nothing in later", async () => {
    await withWorkspace();
    expect(
      await store.setEventsPublicUrl({ value: null, audit: audit() }),
    ).toEqual({ changed: false });
    expect(await store.read()).toEqual({ eventsPublicUrl: null });
    expect(await store.importEventsPublicUrl(EVENTS)).toBe(false);
    expect(await store.read()).toEqual({ eventsPublicUrl: null });
    expect(await settingsReceipts()).toEqual([]);
  });

  test("two saves at once each name the address the other replaced", async () => {
    await withWorkspace();
    await Promise.all([
      store.setEventsPublicUrl({ value: `${EVENTS}/a`, audit: audit() }),
      store.setEventsPublicUrl({ value: `${EVENTS}/b`, audit: audit() }),
    ]);
    const results = (await settingsReceipts()).map(
      (row) =>
        row.result as { events_public_url: string; previous: string | null },
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.previous).toBe(null);
    expect(results[1]?.previous).toBe(results[0]?.events_public_url);
  });

  test("an import lands once across replicas, with an actor-less receipt", async () => {
    await withWorkspace();
    const landed = await Promise.all(
      [1, 2, 3].map(() => store.importEventsPublicUrl(EVENTS)),
    );
    expect(landed.filter(Boolean)).toHaveLength(1);
    expect(await store.read()).toEqual({ eventsPublicUrl: EVENTS });
    const written = await settingsReceipts();
    expect(written).toEqual([
      {
        result: { events_public_url: EVENTS, previous: null, by: "env_import" },
        actor: null,
      },
    ]);
  });

  test("an import before the first workspace keeps the value without a receipt", async () => {
    await db.delete(workspaces);
    expect(await store.importEventsPublicUrl(EVENTS)).toBe(true);
    expect(await store.read()).toEqual({ eventsPublicUrl: EVENTS });
    expect(await settingsReceipts()).toEqual([]);
  });
});
