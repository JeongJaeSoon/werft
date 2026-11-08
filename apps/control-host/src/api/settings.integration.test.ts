import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import * as schema from "@werft-ai/db";
import {
  createPostgresCatalogRepositoryStore,
  createPostgresInstallationSettingsStore,
  createPostgresSettingsDocumentStore,
} from "@werft-ai/db";
import {
  type CatalogProfile,
  type Connections,
  type CredentialRef,
  catalogRows,
  createProfileRegistry,
  parseSeedDocument,
  profileFingerprint,
  resolveSessionCatalog,
  settingsSnapshot,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const integration = testDatabaseUrl() ? describe : describe.skip;

const FAKE_MODEL = parseSeedDocument(
  await Bun.file(
    `${import.meta.dir}/../../../../tests/fixtures/settings/fake-model.json`,
  ).json(),
);
// Any reference resolves: what matters is which connection a ceiling finds.
const lookup = (_ref: CredentialRef) => "a-fake-provider-key";

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

  async function ceilings(connections: Connections) {
    const settings = createPostgresInstallationSettingsStore(db, null);
    const registry = createProfileRegistry<CatalogProfile>({
      workspaces: { listAll: async () => [] },
      installations: {
        listAll: async () =>
          catalogRows(
            FAKE_MODEL.profiles ?? {},
            FAKE_MODEL.entries.repositories,
          ),
      },
      repositories: createPostgresCatalogRepositoryStore(db),
      settings: {
        read: async () => settingsSnapshot(await settings.read(), lookup),
      },
      sources: {
        connections,
        allowUnattended: false,
        runtimeSupported: () => true,
        materialize: (id, definition, settingsLookup) => {
          const profile = resolveSessionCatalog(
            { profiles: { [id]: definition }, repositories: {} },
            (ref) => settingsLookup?.(ref) ?? lookup(ref),
          ).profiles[id];
          if (!profile) throw new Error(`no ${id}`);
          return profile;
        },
      },
    });
    await registry.refresh();
    const entry = registry.installation.get("claude-coding-local");
    const profile = registry.profiles["claude-coding-local"];
    return {
      state: entry?.state,
      fingerprint: profile ? profileFingerprint(profile) : null,
    };
  }

  test("the imported fake-messages connection runs the fake ceiling", async () => {
    expect(await ceilings({})).toMatchObject({ state: "connection_missing" });

    const result = await createPostgresSettingsDocumentStore(db).importEntries(
      FAKE_MODEL.entries,
      {
        dryRun: false,
        allowExternal: true,
        actor: null,
      },
    );
    expect(result.outcome).toBe("applied");

    const imported = await ceilings({});
    expect(imported.state).toBe("usable");
    expect(imported.fingerprint).toStartWith("sha256:");
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
    await pool.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         runtime_profile_id, repository_id, profile_digest,
         runtime_config_snapshot, effective_tools, policy_pins)
       VALUES ($1, $2, $3, $4, 'claude-coding-v1', 'in-pin', $5, '{}', '{}', $6)`,
      [
        releaseId,
        agentId,
        versionId,
        "a".repeat(64),
        `sha256:${"c".repeat(64)}`,
        JSON.stringify({ github: { repositories: ["old-policy", "live"] } }),
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
      await pool.query(
        `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
           attached_repository_ids, status, workspace_id, agent_release_id,
           created_by_user_id, github_policy_source, checkpoint_revision)
         VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', $3, $4, $5,
           $8, $6, $7, 'release', 1)`,
        [
          id,
          workspaceId,
          columns.repository ?? null,
          columns.attached ?? null,
          columns.status ?? "queued",
          columns.release ? releaseId : null,
          userId,
          workspaceId,
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
