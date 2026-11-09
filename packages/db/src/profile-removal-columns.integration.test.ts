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
  const release = async (
    id: string,
    spec: [unknown, unknown, string, string],
  ) => {
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await client.query(
        `INSERT INTO agent_releases
           (id, agent_id, version_id, card_sha256, runtime_profile_id, profile_digest,
            runtime_config_snapshot, effective_tools, runtime_spec, spec_source,
            spec_source_digest, spec_digest)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'sha', 'p', 'd',
                 '{}'::jsonb, '{}'::jsonb, $2::jsonb, $3::jsonb, $4, $5)`,
        [
          id,
          spec[0] === null ? null : JSON.stringify(spec[0]),
          spec[1] === null ? null : JSON.stringify(spec[1]),
          spec[2],
          spec[3],
        ],
      );
    } finally {
      await client.query("SET session_replication_role = DEFAULT");
      client.release();
    }
  };

  test("a release holds all four spec columns or none", async () => {
    // An existing release: none of them.
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await client.query(
        `INSERT INTO agent_releases
           (id, agent_id, version_id, card_sha256, runtime_profile_id, profile_digest,
            runtime_config_snapshot, effective_tools)
         VALUES ('rel-none', gen_random_uuid(), gen_random_uuid(), 'sha', 'p', 'd',
                 '{}'::jsonb, '{}'::jsonb)`,
      );
    } finally {
      await client.query("SET session_replication_role = DEFAULT");
      client.release();
    }
    await release("rel-all", [{ a: 1 }, { b: 2 }, "sd", "d"]);
    // Each column set without the others is refused.
    await expect(
      release("rel-spec-only", [{ a: 1 }, null, "sd", "d"]),
    ).rejects.toThrow(/agent_releases_spec_check/);
    await expect(
      release("rel-digest-only", [null, null, "sd", "d"]),
    ).rejects.toThrow(/agent_releases_spec_check/);
  });
});
