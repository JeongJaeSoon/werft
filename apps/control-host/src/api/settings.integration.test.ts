import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@werft-ai/db";
import { createPostgresSettingsDocumentStore } from "@werft-ai/db";
import { parseSettingsDocument } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { settingsCatalog } from "../testing/settings.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const FAKE_MODEL = parseSettingsDocument(
  await Bun.file(
    `${import.meta.dir}/../../../../tests/fixtures/settings/fake-model.json`,
  ).json(),
);

integration("the fake-model stack's settings through a document", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "settings_cli_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  test("the imported fake-messages connection offers its models to the catalog", async () => {
    expect((await settingsCatalog(db)).connections).toEqual({});

    const result = await createPostgresSettingsDocumentStore(db).importEntries(
      FAKE_MODEL,
      {
        dryRun: false,
        actor: null,
      },
    );
    expect(result.outcome).toBe("applied");

    const catalog = await settingsCatalog(db);
    expect(catalog.connections["fake-messages"]?.models).toContain(
      "claude-sonnet-5",
    );
    expect(catalog.connections["fake-messages"]?.provider.endpoint).toBe(
      FAKE_MODEL.connections["fake-messages"]?.endpoint,
    );
  }, 30_000);
});
