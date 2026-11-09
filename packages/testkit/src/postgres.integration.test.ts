import { expect, test } from "bun:test";
import { Pool } from "pg";
import {
  createTempDatabase,
  testDatabaseUrl,
  withTempDatabase,
} from "./postgres.ts";

const integrationTest = testDatabaseUrl() ? test : test.skip;

async function queryOne<T extends Record<string, unknown>>(
  url: string,
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    return (await pool.query<T>(sql, params)).rows[0];
  } finally {
    await pool.end();
  }
}

integrationTest(
  "creates a migrated database and drops it afterwards",
  async () => {
    const database = await createTempDatabase({ prefix: "testkit_it" });
    try {
      expect(database.name).toStartWith("testkit_it_");
      expect(new URL(database.url).pathname).toBe(`/${database.name}`);
      const tables = await queryOne<{
        sessions: string | null;
        journal: string;
      }>(
        database.url,
        `SELECT to_regclass('public.sessions')::text AS sessions,
                (SELECT count(*)::text FROM "drizzle"."__drizzle_migrations") AS journal`,
      );
      expect(tables?.sessions).toBe("sessions");
      expect(Number(tables?.journal)).toBeGreaterThan(0);
    } finally {
      await database.drop();
    }
    const admin = new URL(database.url);
    admin.pathname = "/postgres";
    const remaining = await queryOne<{ count: string }>(
      admin.toString(),
      "SELECT count(*)::text AS count FROM pg_database WHERE datname = $1",
      [database.name],
    );
    expect(remaining?.count).toBe("0");
    await database.drop();
  },
  30_000,
);

integrationTest(
  "leaves a raw database when migrate is disabled and drops it after the callback",
  async () => {
    let name = "";
    await withTempDatabase(
      async (database) => {
        name = database.name;
        const tables = await queryOne<{ sessions: string | null }>(
          database.url,
          "SELECT to_regclass('public.sessions')::text AS sessions",
        );
        expect(tables?.sessions).toBeNull();
      },
      { migrate: false },
    );
    const admin = new URL(testDatabaseUrl() ?? "");
    admin.pathname = "/postgres";
    const remaining = await queryOne<{ count: string }>(
      admin.toString(),
      "SELECT count(*)::text AS count FROM pg_database WHERE datname = $1",
      [name],
    );
    expect(remaining?.count).toBe("0");
  },
  30_000,
);

integrationTest(
  "copies a template database without migrating it again",
  async () => {
    const template = await createTempDatabase({ prefix: "testkit_tpl" });
    try {
      await queryOne(template.url, "CREATE TABLE marker (id int)");
      const copy = await createTempDatabase({
        prefix: "testkit_copy",
        template: template.name,
      });
      try {
        const tables = await queryOne<{
          sessions: string | null;
          marker: string | null;
        }>(
          copy.url,
          `SELECT to_regclass('public.sessions')::text AS sessions,
                  to_regclass('public.marker')::text AS marker`,
        );
        expect(tables).toEqual({ sessions: "sessions", marker: "marker" });
      } finally {
        await copy.drop();
      }
    } finally {
      await template.drop();
    }
  },
  30_000,
);
