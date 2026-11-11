import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-folder.ts";
import { fixtureTeamSql } from "./testing/fixture-team.ts";
import {
  BEFORE_PROFILE_REMOVAL,
  migrationsThrough,
} from "./testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const anthropic = {
  kind: "anthropic",
  endpoint: "https://api.anthropic.com",
  auth: { kind: "api_key", env: "ANTHROPIC_API_KEY" },
};
const rotatedAuth = { kind: "api_key", env: "ANTHROPIC_API_KEY_OLD" };
const litellm = {
  kind: "litellm",
  endpoint: "https://llm.example.test",
  auth: { kind: "bearer", env: "LITELLM_KEY" },
};
const openai = {
  kind: "openai_responses",
  endpoint: "https://api.openai.com",
  auth: { kind: "api_key", env: "OPENAI_API_KEY" },
};
const families = {
  "claude-sonnet-5": { family: "sonnet", rank: 5 },
  "claude-sonnet-5-5": { family: "sonnet", rank: 6 },
};
const otherFamilies = {
  "claude-opus-5": { family: "opus", rank: 5 },
  "claude-opus-5-5": { family: "opus", rank: 6 },
};
const deep = { ...litellm, endpoint: "https://deep.example.test" };
const loop = { ...litellm, endpoint: "https://loop.example.test" };

/**
 * An installation from before 0254 holds connections without a model list
 * and profiles that named the models. 0270 drops the profiles and every
 * release, so a connection left at 0254's empty default takes no release
 * at all: each connection gets the models its profiles offered.
 */
integration("0270 gives each connection the models of its profiles", () => {
  let database: TempDatabase;
  let pool: Pool;
  const folders: string[] = [];
  const workspaceId = randomUUID();
  let userId = "";

  const modelsOf = async (id: string) =>
    (
      await pool.query<{ models: unknown; model_families: unknown }>(
        "SELECT models, model_families FROM provider_connections WHERE id = $1",
        [id],
      )
    ).rows[0];

  const connection = async (
    id: string,
    definition: object,
    replacesAuth: object | null = null,
  ) => {
    await pool.query(
      `INSERT INTO provider_connections (id, definition, credential_source, origin, replaces_auth)
       VALUES ($1, $2, 'external', 'import', $3)`,
      [
        id,
        JSON.stringify(definition),
        replacesAuth === null ? null : JSON.stringify(replacesAuth),
      ],
    );
  };

  const profile = async (
    id: string,
    definition: Record<string, unknown>,
    extra: { retired?: boolean; blocked?: boolean; derivedFrom?: string } = {},
  ) => {
    await pool.query(
      `INSERT INTO installation_profiles (id, version, origin, definition, permission_mode, fingerprint, repository_ids, derived_from)
       VALUES ($1, 1, 'catalog', $2, 'default', 'fp', '[]', $3)`,
      [
        id,
        JSON.stringify({ permission_mode: "default", ...definition }),
        extra.derivedFrom ?? null,
      ],
    );
    if (extra.retired === true) {
      await pool.query(
        "UPDATE installation_profiles SET retired_at = now(), retired_by = $2 WHERE id = $1",
        [id, userId],
      );
    }
    if (extra.blocked === true) {
      await pool.query(
        "UPDATE installation_profiles SET blocked_at = now(), blocked_by = $2 WHERE id = $1",
        [id, userId],
      );
    }
  };

  /** An agent whose active release runs on `profileId`. */
  const agentOn = async (profileId: string) => {
    const agentId = randomUUID();
    const versionId = randomUUID();
    const releaseId = `sha256:${"r".repeat(64)}`;
    await pool.query(
      "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'bot', 'bot', $3)",
      [agentId, workspaceId, await fixtureTeamSql(pool, workspaceId)],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{"model":"claude-legacy"}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         runtime_profile_id, profile_digest, runtime_config_snapshot, effective_tools)
       VALUES ($1, $2, $3, $4, $5, 'digest', '{"model":"claude-legacy"}', '{}')`,
      [releaseId, agentId, versionId, "a".repeat(64), profileId],
    );
    await pool.query(
      "UPDATE agents SET active_release_id = $2, activation_revision = 0 WHERE id = $1",
      [agentId, releaseId],
    );
  };

  beforeAll(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "connection_models_it",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    const beforeModels = migrationsThrough("0254_profile_removal_read_compat", {
      exclusive: true,
    });
    folders.push(beforeModels);
    await migrate(drizzle(pool), { migrationsFolder: beforeModels });

    userId = randomUUID();
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, 'admin@example.test', 'admin')",
      [userId],
    );
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );

    // At 0253 a connection row has no models column yet.
    await connection("anthropic", anthropic);
    // The same provider again: the registry gave its profiles to the first by id.
    await connection("anthropic-copy", anthropic);
    await connection(
      "rotated",
      { ...anthropic, auth: { ...anthropic.auth, env: "NEW" } },
      rotatedAuth,
    );
    await connection("litellm", litellm);
    // Its former key is litellm's current provider, which litellm keeps.
    await connection(
      "litellm-moved",
      { ...litellm, auth: { ...litellm.auth, env: "NEW" } },
      litellm.auth,
    );
    await connection("unused", {
      ...litellm,
      endpoint: "https://other.example.test",
    });
    await connection("openai", openai);
    await connection("deep", deep);
    await connection("loop", loop);

    await profile("coding", {
      provider: anthropic,
      model: "claude-sonnet-5-5",
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      model_families: families,
    });
    await profile("review", { provider: anthropic, model: "claude-haiku-5-5" });
    await profile(
      "retired",
      { provider: anthropic, model: "claude-sonnet-4" },
      { retired: true },
    );
    await profile(
      "legacy",
      { provider: anthropic, model: "claude-legacy" },
      { retired: true },
    );
    await agentOn("legacy");
    await profile(
      "blocked-parent",
      { provider: anthropic, model: "claude-blocked" },
      { blocked: true },
    );
    await profile(
      "blocked-child",
      { provider: anthropic, model: "claude-blocked-child" },
      { derivedFrom: "blocked-parent" },
    );
    await profile("malformed", {
      provider: anthropic,
      model: "claude-ok",
      models: "not-a-list",
    });
    await profile(
      "old-base",
      { provider: anthropic, model: "claude-old-base" },
      { retired: true },
    );
    await profile("former-key", {
      provider: { ...anthropic, auth: rotatedAuth },
      model: "claude-opus-5-5",
      model_families: families,
    });
    await profile("former-key-2", {
      provider: { ...anthropic, auth: rotatedAuth },
      model: "claude-opus-5",
      model_families: families,
    });
    await profile("proxy", {
      provider: litellm,
      model: "proxy-model",
      model_families: families,
    });
    await profile("proxy-2", {
      provider: litellm,
      model: "proxy-model",
      model_families: otherFamilies,
    });
    // A lineage longer than any fixed depth still ends, and runs.
    for (let i = 0; i < 70; i++) {
      await profile(
        `deep-${i}`,
        { provider: deep, model: `deep-${i}` },
        i === 0 ? {} : { derivedFrom: `deep-${i - 1}` },
      );
    }
    await profile("loop-a", { provider: loop, model: "loop-a" });
    await profile(
      "loop-b",
      { provider: loop, model: "loop-b" },
      { derivedFrom: "loop-a" },
    );
    await pool.query(
      "UPDATE installation_profiles SET derived_from = 'loop-b' WHERE id = 'loop-a'",
    );
    await profile("codex", { provider: openai, model: "gpt-5" });
    await pool.query(
      `INSERT INTO workspace_profiles (id, workspace_id, name, version, base_profile_id,
         base_fingerprint, base_runtime_version, base_billing, base_repository_mode,
         model, models, tools, permission_mode, created_by)
       VALUES ('ws_team', $1, 'team', 1, 'review', 'fp', '1', 'metered', 'required',
         'claude-ws', '["claude-ws", "claude-haiku-5-5"]', '[]', 'default', $2)`,
      [workspaceId, userId],
    );
    // Live, on a base that retired: the base decides the connection only.
    await pool.query(
      `INSERT INTO workspace_profiles (id, workspace_id, name, version, base_profile_id,
         base_fingerprint, base_runtime_version, base_billing, base_repository_mode,
         model, models, tools, permission_mode, created_by)
       VALUES ('ws_live', $1, 'live', 1, 'old-base', 'fp', '1', 'metered', 'required',
         'claude-ws-live', '[]', '[]', 'default', $2)`,
      [workspaceId, userId],
    );

    const beforeRemoval = migrationsThrough(BEFORE_PROFILE_REMOVAL);
    folders.push(beforeRemoval);
    await migrate(drizzle(pool), { migrationsFolder: beforeRemoval });
    // A list an admin already wrote between 0254 and 0270 is theirs.
    await pool.query(
      `UPDATE provider_connections SET models = '["gpt-5-codex"]' WHERE id = 'openai'`,
    );

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
    for (const folder of folders) {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 60_000);

  test("a connection gets the models its runnable profiles offered, in the order offered", async () => {
    const row = await modelsOf("anthropic");
    expect(row?.models).toEqual([
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-haiku-5-5",
      // Retired, but an agent's active release ran on it.
      "claude-legacy",
      "claude-ok",
      "claude-ws",
      "claude-ws-live",
    ]);
    // "review" and others carry no series, so none is guessed.
    expect(row?.model_families).toBeNull();
  });

  test("model_families is copied when every counted profile carries the same one", async () => {
    const row = await modelsOf("rotated");
    expect(row?.models).toEqual(["claude-opus-5-5", "claude-opus-5"]);
    expect(row?.model_families).toEqual(families);
  });

  test("profiles that disagree on model_families leave it unset", async () => {
    expect((await modelsOf("litellm"))?.model_families).toBeNull();
  });

  test("a long lineage runs; a circular one does not", async () => {
    expect((await modelsOf("deep"))?.models).toEqual(
      Array.from({ length: 70 }, (_, i) => `deep-${i}`),
    );
    expect((await modelsOf("loop"))?.models).toEqual([]);
  });

  test("of two connections with one provider, only the first by id gets its profiles", async () => {
    expect((await modelsOf("anthropic-copy"))?.models).toEqual([]);
  });

  test("a former key another connection holds as its own goes to that one", async () => {
    expect((await modelsOf("litellm"))?.models).toEqual(["proxy-model"]);
    expect((await modelsOf("litellm-moved"))?.models).toEqual([]);
  });

  test("a connection no profile ran on stays empty", async () => {
    expect((await modelsOf("unused"))?.models).toEqual([]);
  });

  test("a list already written is kept", async () => {
    expect((await modelsOf("openai"))?.models).toEqual(["gpt-5-codex"]);
  });
});
