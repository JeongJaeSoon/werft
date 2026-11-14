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
import { createPostgresInstallationConfigStore } from "./installation-config.ts";
import * as schema from "./schema.ts";
import { installationConfig, receipts, workspaces } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("the installation's config by key", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let store: ReturnType<typeof createPostgresInstallationConfigStore>;
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const audit = () => ({ userId, workspaceId, receiptId: randomUUID() });
  const configReceipts = () =>
    db
      .select({ result: receipts.result, actor: receipts.actor })
      .from(receipts)
      .where(eq(receipts.operation, "update_installation_config"))
      .orderBy(receipts.createdAt);

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "installation_config" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    store = createPostgresInstallationConfigStore(db);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    await db.delete(receipts);
    await db.delete(installationConfig);
  });

  const withWorkspace = () =>
    db
      .insert(workspaces)
      .values({ id: workspaceId, name: "W", slug: `w-${workspaceId}` })
      .onConflictDoNothing();

  test("nothing is saved until a key is", async () => {
    expect(await store.readAll()).toEqual({});
  });

  test("a save keeps each key with one receipt naming only the changed ones; the same values again leave none", async () => {
    await withWorkspace();
    expect(
      await store.setValues({ values: { a: 60, b: "x" }, audit: audit() }),
    ).toEqual({ changed: true });
    expect(
      await store.setValues({ values: { a: 60, b: "x" }, audit: audit() }),
    ).toEqual({ changed: false });
    expect(
      await store.setValues({ values: { a: 90, b: "x" }, audit: audit() }),
    ).toEqual({ changed: true });
    expect(await store.readAll()).toEqual({ a: 90, b: "x" });
    const written = await configReceipts();
    expect(written.map((row) => row.result)).toEqual([
      { values: { a: 60, b: "x" }, previous: { a: null, b: null } },
      { values: { a: 90 }, previous: { a: 60 } },
    ]);
    expect(written[0]?.actor).toMatchObject({ actor_user_id: userId });
  });

  test("an empty save changes nothing", async () => {
    expect(await store.setValues({ values: {}, audit: audit() })).toEqual({
      changed: false,
    });
    expect(await configReceipts()).toEqual([]);
  });

  test("two saves at once each name the value the other replaced", async () => {
    await withWorkspace();
    await Promise.all([
      store.setValues({ values: { a: 1 }, audit: audit() }),
      store.setValues({ values: { a: 2 }, audit: audit() }),
    ]);
    const results = (await configReceipts()).map(
      (row) =>
        row.result as {
          values: { a: number };
          previous: { a: number | null };
        },
    );
    expect(results).toHaveLength(2);
    // Not by created_at: that is when each transaction began.
    const first = results.find((result) => result.previous.a === null);
    const second = results.find((result) => result !== first);
    expect(second?.previous.a).toBe(first?.values.a ?? -1);
  });

  test("an import lands once across processes, with an actor-less receipt, and never over a saved key", async () => {
    await withWorkspace();
    const landed = await Promise.all(
      [1, 2, 3].map(() => store.importValue("a", 90)),
    );
    expect(landed.filter(Boolean)).toHaveLength(1);
    expect(await store.readAll()).toEqual({ a: 90 });
    expect(await store.importValue("a", 30)).toBe(false);
    expect(await store.readAll()).toEqual({ a: 90 });
    expect(await configReceipts()).toEqual([
      {
        result: { values: { a: 90 }, previous: { a: null }, by: "env_import" },
        actor: null,
      },
    ]);
  });

  test("an import and a save at once leave receipts that agree with the order they landed in", async () => {
    await withWorkspace();
    for (let round = 0; round < 10; round++) {
      await db.delete(receipts);
      await db.delete(installationConfig);
      await Promise.all([
        store.importValue("a", 90),
        store.setValues({ values: { a: 60 }, audit: audit() }),
      ]);
      expect(await store.readAll()).toEqual({ a: 60 });
      // created_at is when each transaction began, not when it landed past
      // the lock, so the rows are put in landing order by what they say.
      const results: unknown = (await configReceipts())
        .map((row) => row.result as { by?: string })
        .sort(
          (x, y) => Number(x.by === undefined) - Number(y.by === undefined),
        );
      // Import first: the save names it. Save first: the import is skipped.
      expect<unknown[]>([
        [
          { values: { a: 90 }, previous: { a: null }, by: "env_import" },
          { values: { a: 60 }, previous: { a: 90 } },
        ],
        [{ values: { a: 60 }, previous: { a: null } }],
      ]).toContainEqual(results);
    }
  });

  test("an import before the first workspace keeps the value without a receipt", async () => {
    await db.delete(workspaces);
    expect(await store.importValue("a", 90)).toBe(true);
    expect(await store.readAll()).toEqual({ a: 90 });
    expect(await configReceipts()).toEqual([]);
  });
});
