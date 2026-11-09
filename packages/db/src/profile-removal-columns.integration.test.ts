import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { Pool } from "pg";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("columns the profile removal reads before it writes", () => {
  let database: TempDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "profile_removal_cols" });
    pool = new Pool({ connectionString: database.url, max: 1 });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const connection = (id: string, autoMode?: string) =>
    pool.query(
      `INSERT INTO provider_connections (id, definition, credential_source, origin${
        autoMode === undefined ? "" : ", auto_mode"
      }) VALUES ($1, '{}'::jsonb, 'stored', 'console'${
        autoMode === undefined ? "" : ", $2"
      })`,
      autoMode === undefined ? [id] : [id, autoMode],
    );

  test("an existing connection row reads as no models and an unknown auto mode", async () => {
    await connection("conn-default");
    const { rows } = await pool.query(
      "SELECT models, model_families, auto_mode FROM provider_connections WHERE id = 'conn-default'",
    );
    expect(rows).toEqual([
      { models: [], model_families: null, auto_mode: "unknown" },
    ]);
  });

  test("auto_mode takes only supported, unsupported or unknown", async () => {
    await connection("conn-supported", "supported");
    await expect(connection("conn-bad", "sometimes")).rejects.toThrow(
      /provider_connections_auto_mode_check/,
    );
  });

  // The release row's foreign keys are not what this test is about.
  const insertRelease = async (id: string, spec: boolean[] | null) => {
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      const [runtimeSpec, specSource, sourceDigest, specDigest] = spec ?? [];
      await client.query(
        `INSERT INTO agent_releases
           (id, agent_id, version_id, card_sha256, runtime_profile_id, profile_digest,
            runtime_config_snapshot, effective_tools, runtime_spec, spec_source,
            spec_source_digest, spec_digest)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'sha', 'p', 'd',
                 '{}'::jsonb, '{}'::jsonb, $2::jsonb, $3::jsonb, $4, $5)`,
        [
          id,
          runtimeSpec ? "{}" : null,
          specSource ? "{}" : null,
          sourceDigest ? "d" : null,
          specDigest ? "d" : null,
        ],
      );
    } finally {
      await client.query("SET session_replication_role = DEFAULT");
      client.release();
    }
  };

  test("a release holds all four spec columns or none", async () => {
    // A release written before the columns existed sets none of them.
    await insertRelease("rel-legacy", null);

    // Every set/null combination of the four columns: only 0000 and 1111 pass.
    for (let mask = 0; mask < 16; mask++) {
      const spec = [0, 1, 2, 3].map((bit) => (mask & (1 << bit)) !== 0);
      const attempt = insertRelease(`rel-${mask}`, spec);
      if (mask === 0 || mask === 15) {
        await attempt;
      } else {
        await expect(attempt).rejects.toThrow(/agent_releases_spec_check/);
      }
    }
  });

  test("the checks are added NOT VALID, so the migration never scans the tables", async () => {
    const { rows } = await pool.query(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE conname IN ('agent_releases_spec_check', 'provider_connections_auto_mode_check')
       ORDER BY conname`,
    );
    expect(rows).toEqual([
      { conname: "agent_releases_spec_check", convalidated: false },
      { conname: "provider_connections_auto_mode_check", convalidated: false },
    ]);
  });
});
