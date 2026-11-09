import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresInstallationProfileStore } from "./installation-profiles.ts";
import type { Database } from "./queries.ts";

let client: PGlite;

beforeEach(async () => {
  client = await migratedPGlite();
});

afterEach(async () => {
  await client.close();
});

const insert = (id: string, origin: string, scope: string | null) =>
  client.query(
    `INSERT INTO installation_profiles (id, name, version, origin, definition, permission_mode, fingerprint, repository_scope)
     VALUES ($1, $2, 1, $3, '{"permission_mode":"default"}'::jsonb, 'default', 'fp', $4)`,
    [id, origin === "catalog" ? null : id, origin, scope],
  );

describe("seedCatalog fills repository_ids", () => {
  test("of a row with a scope, never of one that names no repository", async () => {
    await insert("imported", "catalog", "profile");
    await insert("quiet", "catalog", null);
    const store = createPostgresInstallationProfileStore(
      drizzle(client) as unknown as Database,
    );

    const result = await store.seedCatalog({
      entries: async () => [],
      repositoryIdsOf: (id) => [`repo-for-${id}`],
    });

    expect(result).toEqual({ seeded: [], migrated: ["imported"] });
    const { rows } = await client.query(
      `SELECT id, repository_ids FROM installation_profiles ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: "imported", repository_ids: ["repo-for-imported"] },
      { id: "quiet", repository_ids: null },
    ]);
  });
});
