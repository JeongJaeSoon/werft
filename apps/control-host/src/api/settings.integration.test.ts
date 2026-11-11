import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as schema from "@werft-ai/db";
import { createPostgresSettingsDocumentStore } from "@werft-ai/db";
import {
  releaseSpecColumns,
  sessionPinValues,
} from "@werft-ai/db/testing/spec-pins";
import { parseSettingsDocument } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { settingsCatalog } from "../test-support/settings.ts";

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
        allowExternal: true,
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

integration("sessions on a repository only the old file knew", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "settings_stranded_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);
  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  test("each path to a left-out id is found, a live row or an ended session is not", async () => {
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const agentId = randomUUID();
    const versionId = randomUUID();
    const releaseId = `sha256:${randomUUID()}`;
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    await pool.query(
      "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'owner')",
      [userId, `${userId}@example.invalid`],
    );
    await pool.query(
      "WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, github_enabled, managing_team_id) VALUES ($1, $2, $3, 'a', true, (SELECT id FROM t))",
      [agentId, workspaceId, `a-${agentId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    const spec = releaseSpecColumns();
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         connection_id, repository_id, runtime_config_snapshot,
         effective_tools, policy_pins, runtime_spec, spec_source,
         spec_source_digest, spec_digest)
       VALUES ($1, $2, $3, $4, 'test-connection', 'in-pin', '{}', '{}', $5,
         $6, $7, $8, $9)`,
      [
        releaseId,
        agentId,
        versionId,
        "a".repeat(64),
        JSON.stringify({ github: { repositories: ["old-policy", "live"] } }),
        JSON.stringify(spec.runtimeSpec),
        JSON.stringify(spec.specSource),
        spec.specSourceDigest,
        spec.specDigest,
      ],
    );
    await pool.query(
      `INSERT INTO catalog_repositories (id, url, branch, source, owner, name,
         auth_kind, github_repository_id)
       VALUES ('live', 'https://github.com/acme/live.git', 'main', 'console',
         'acme', 'live', 'github_app', 1)`,
    );

    const ids = new Map<string, string>();
    const idOf = (name: string) => ids.get(name) ?? "";
    const session = async (
      name: string,
      columns: {
        repository?: string;
        attached?: string[] | null;
        status?: string;
        release?: boolean;
      },
    ) => {
      const id = randomUUID();
      ids.set(name, id);
      const pin = sessionPinValues();
      await pool.query(
        `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
           attached_repository_ids, status, workspace_id, agent_release_id,
           created_by_user_id, github_policy_source, checkpoint_revision,
           model, runtime_spec, spec_source, spec_source_digest, spec_digest)
         VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', $3, $4, $5,
           $8, $6, $7, 'release', 1, $9, $10, $11, $12, $13)`,
        [
          id,
          workspaceId,
          columns.repository ?? null,
          columns.attached ?? null,
          columns.status ?? "queued",
          columns.release ? releaseId : null,
          userId,
          workspaceId,
          pin.model,
          pin.runtime_spec,
          pin.spec_source,
          pin.spec_source_digest,
          pin.spec_digest,
        ],
      );
    };
    await session("ses_primary", { repository: "old-primary", attached: [] });
    await session("ses_attached", { attached: ["old-attached", "live"] });
    await session("ses_policy", { release: true });
    await session("ses_ended", {
      repository: "old-primary",
      attached: [],
      status: "stopped",
    });

    const found = await createPostgresSettingsDocumentStore(
      db,
    ).sessionsOnRepositories([
      "old-primary",
      "old-attached",
      "old-policy",
      "live",
      "never-used",
    ]);
    expect([...found].sort((a, b) => a.via.localeCompare(b.via))).toEqual([
      {
        session_id: idOf("ses_attached"),
        repository_id: "old-attached",
        via: "attached",
      },
      {
        session_id: idOf("ses_policy"),
        repository_id: "old-policy",
        via: "policy",
      },
      {
        session_id: idOf("ses_primary"),
        repository_id: "old-primary",
        via: "primary",
      },
    ]);
    expect(
      await createPostgresSettingsDocumentStore(db).sessionsOnRepositories([]),
    ).toEqual([]);
  }, 60_000);
});
