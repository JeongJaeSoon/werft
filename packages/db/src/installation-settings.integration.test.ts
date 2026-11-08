import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentCard, agentCardSchema } from "@werft-ai/contracts";
import {
  type CatalogProfile,
  type CatalogProfileConfig,
  type CatalogRepository,
  type CredentialRef,
  cardContentSha256,
  catalogRows,
  createProfileRegistry,
  deriveReleaseId,
  mcpBinding,
  parseSettingsDocument,
  profileCatalog,
  profileFingerprint,
  repositoryBinding,
  resolveReleaseContent,
  resolveSessionCatalog,
  SecretKey,
  type SessionCatalogConfig,
  sessionCatalogConfigSchema,
  settingsDocumentOf,
  settingsSnapshot,
  withConsoleRepositories,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresCatalogRepositoryStore } from "./catalog-repositories.ts";
import { createPostgresInstallationSettingsStore } from "./installation-settings.ts";
import { migrate } from "./migrate.ts";
import * as schema from "./schema.ts";
import {
  catalogRepositories,
  mcpServers,
  providerConnections,
  settingsGeneration,
  workspaces,
} from "./schema.ts";
import { createPostgresSecretStore } from "./secret-values.ts";
import { createPostgresSettingsDocumentStore } from "./settings-document.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const KEY = SecretKey.fromHex("ab".repeat(32), "test key");
const { privateKey: APP_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const VALUES: Record<string, string> = {
  PROVIDER_KEY: "file-provider-key",
  "ghes/app-key": APP_PEM,
  MCP_TOKEN: "file-mcp-bearer-token",
};
const lookup = (ref: CredentialRef) =>
  "value_env" in ref
    ? VALUES[ref.value_env]
    : "secret_id" in ref
      ? VALUES[ref.secret_id]
      : undefined;

const MAIN: CatalogProfileConfig["provider"] = {
  kind: "litellm",
  endpoint: "http://10.0.0.5:4000",
  billing: "none",
  auth: { kind: "bearer", value_env: "PROVIDER_KEY" },
};
const FILE: SessionCatalogConfig = sessionCatalogConfigSchema.parse({
  profiles: {
    coding: {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read", "Edit"],
      permission_mode: "default",
      provider: MAIN,
      repository: "optional",
    },
  },
  repositories: {
    app: {
      url: "https://github.com/acme/app.git",
      branch: "main",
      profiles: ["coding"],
      auth: { kind: "github_app" },
    },
    ghes: {
      url: "https://ghes.example.invalid/team/ghes.git",
      branch: "main",
      profiles: ["coding"],
      auth: {
        kind: "github_app",
        app_id: 7,
        installation_id: 70,
        api_base: "https://ghes.example.invalid/api/v3",
        secret_id: "ghes/app-key",
      },
    },
  },
  mcp_servers: {
    docs: {
      url: "https://mcp.example.invalid/docs",
      credential_ref: "docs_token",
      auth: { kind: "bearer", value_env: "MCP_TOKEN" },
      workspaces: ["acme"],
    },
  },
});
const CONNECTIONS = { main: MAIN };

const CARD: AgentCard = agentCardSchema.parse({
  role: "docs",
  instructions: "Answer from the docs.",
  model: "claude-sonnet-5",
  capabilities: {
    mcp: [{ server: "docs" }],
    credential_refs: ["docs_token"],
    tool_policy: { per_tool: { mcp__docs__search: "allow" } },
    forbidden: [],
  },
});

async function catalogOver(
  db: NodePgDatabase<typeof schema>,
  file: {
    connections: Record<string, typeof MAIN>;
    config: SessionCatalogConfig;
  },
) {
  const resolvedFile = resolveSessionCatalog(
    { ...file.config, profiles: {} },
    lookup,
  );
  const store = createPostgresInstallationSettingsStore(db, KEY);
  const registry = createProfileRegistry<CatalogProfile>({
    workspaces: { listAll: async () => [] },
    installations: {
      listAll: async () => catalogRows(FILE.profiles, FILE.repositories),
    },
    repositories: createPostgresCatalogRepositoryStore(db),
    settings: {
      read: async () =>
        settingsSnapshot(await store.read({ openStored: true }), lookup),
    },
    sources: {
      connections: file.connections,
      allowUnattended: false,
      runtimeSupported: () => true,
      materialize: (id, definition, settings) => {
        const profile = resolveSessionCatalog(
          { profiles: { [id]: definition }, repositories: {} },
          (ref) => settings?.(ref) ?? lookup(ref),
        ).profiles[id];
        if (!profile) throw new Error(`no ${id}`);
        return profile;
      },
    },
  });
  await registry.refresh();
  return profileCatalog(resolvedFile, registry, (rows, settings) =>
    withConsoleRepositories(rows, {
      ...resolvedFile.repositories,
      ...settings?.repositories,
    }),
  );
}

function pins(catalog: Awaited<ReturnType<typeof catalogOver>>) {
  const profile = catalog.profiles.coding;
  if (!profile) {
    throw new Error(
      `coding does not run: ${catalog.installation.get("coding")?.state}`,
    );
  }
  const repositories = catalog.repositories as Record<
    string,
    CatalogRepository
  >;
  const content = resolveReleaseContent(
    CARD,
    "coding",
    profile,
    catalog.mcp_servers,
  );
  if (!content.ok) throw new Error(content.error.message);
  const docs = catalog.mcp_servers?.docs;
  if (!docs) throw new Error("no docs server");
  const releaseId = deriveReleaseId({
    agent_id: "agent-1",
    card_sha256: cardContentSha256(CARD),
    repository_id: "app",
    ...content.content,
  });
  return {
    fingerprint: profileFingerprint(profile),
    state: catalog.installation.get("coding")?.state,
    bindings: Object.fromEntries(
      Object.keys(FILE.repositories).map((id) => {
        const repository = repositories[id];
        return [id, repository ? repositoryBinding(id, repository) : null];
      }),
    ),
    mcp: mcpBinding(releaseId, "docs", docs),
    releaseId,
  };
}

// The operator's settings import (settings.ts) of what the files hold.
async function importFile(db: NodePgDatabase<typeof schema>) {
  const result = await createPostgresSettingsDocumentStore(db).importEntries(
    parseSettingsDocument(
      settingsDocumentOf({
        connections: CONNECTIONS,
        repositories: FILE.repositories,
        mcp_servers: FILE.mcp_servers ?? {},
      }),
    ),
    { dryRun: false, allowExternal: true, actor: null },
  );
  if (result.outcome !== "applied") {
    throw new Error(`import ${result.outcome}`);
  }
}

integration("installation settings", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "installation_settings_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  async function clear() {
    await db.delete(providerConnections);
    await db.delete(mcpServers);
    await db.delete(catalogRepositories);
  }

  test("rows imported from a document run its ceiling and pin its repositories", async () => {
    await clear();
    await importFile(db);
    const imported = pins(
      await catalogOver(db, {
        connections: {},
        config: { profiles: {}, repositories: {} },
      }),
    );
    expect(imported.state).toBe("usable");
    expect(Object.values(imported.bindings)).not.toContain(null);
  }, 30_000);

  test("an empty installation reads empty settings", async () => {
    await clear();
    const store = createPostgresInstallationSettingsStore(db, null);
    expect(await store.read({ openStored: true })).toMatchObject({
      connections: [],
      repositories: [],
      mcpServers: [],
      invalid: [],
    });
  });

  test("a stored value opens for its own row only, rotates without moving a pin, and no workspace route reaches it", async () => {
    await clear();
    const store = createPostgresInstallationSettingsStore(db, KEY);
    const [workspace] = await db
      .insert(workspaces)
      .values({
        id: randomUUID(),
        slug: `ws-${randomUUID().slice(0, 8)}`,
        name: "ws",
      })
      .onConflictDoNothing()
      .returning({ id: workspaces.id });
    expect(workspace).toBeDefined();
    await db.insert(providerConnections).values([
      {
        id: "console_main",
        definition: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.invalid",
          auth: { kind: "api_key", stored: "connection:console_main" },
        },
        credentialSource: "stored",
        origin: "console",
      },
      {
        id: "borrower",
        definition: {
          kind: "anthropic",
          endpoint: "https://elsewhere.invalid",
          auth: { kind: "api_key", stored: "connection:console_main" },
        },
        credentialSource: "stored",
        origin: "console",
      },
    ]);
    await store.putStoredValue(
      { kind: "connection", id: "console_main" },
      "a-console-stored-key",
      null,
    );

    const opened = await store.read({ openStored: true });
    expect(opened.invalid).toEqual(["connection:borrower"]);
    expect(opened.stored.get("connection:console_main")).toBe(
      "a-console-stored-key",
    );
    const snapshot = settingsSnapshot(opened, () => undefined);
    expect(Object.keys(snapshot.connections)).toEqual(["console_main"]);

    expect((await store.read()).stored.size).toBe(0);
    const keyless = await createPostgresInstallationSettingsStore(
      db,
      null,
    ).read({ openStored: true });
    expect(keyless.stored.size).toBe(0);
    expect(
      settingsSnapshot(keyless, () => undefined).left_out.map(
        ({ entry }) => entry,
      ),
    ).toContain("connection:console_main");

    await store.putStoredValue(
      { kind: "connection", id: "console_main" },
      "a-rotated-stored-key",
      null,
    );
    const rotated = await store.read({ openStored: true });
    expect(rotated.stored.get("connection:console_main")).toBe(
      "a-rotated-stored-key",
    );
    expect(rotated.generation).toBe(opened.generation);
    const rotatedSnapshot = settingsSnapshot(rotated, () => undefined);
    expect(rotatedSnapshot.connections).toEqual(snapshot.connections);
    expect(rotatedSnapshot.lookup({ stored: "connection:console_main" })).toBe(
      "a-rotated-stored-key",
    );

    // A value sealed under another key leaves out its own row only.
    await db.insert(providerConnections).values({
      id: "other_key",
      definition: {
        kind: "anthropic",
        endpoint: "https://other.invalid",
        auth: { kind: "api_key", stored: "connection:other_key" },
      },
      credentialSource: "stored",
      origin: "console",
    });
    await createPostgresInstallationSettingsStore(
      db,
      SecretKey.fromHex("cd".repeat(32), "another key"),
    ).putStoredValue(
      { kind: "connection", id: "other_key" },
      "sealed-elsewhere",
      null,
    );
    const mixed = settingsSnapshot(
      await store.read({ openStored: true }),
      () => undefined,
    );
    expect(Object.keys(mixed.connections)).toEqual(["console_main"]);
    expect(mixed.left_out.map(({ entry }) => entry)).toContain(
      "connection:other_key",
    );

    const secrets = createPostgresSecretStore(db, KEY);
    const slot = {
      workspaceId: workspace?.id ?? "",
      owner: { kind: "connection" as const, id: "console_main" },
      purpose: "settings_credential" as const,
    };
    await expect(secrets.get(slot)).rejects.toThrow(/installation's settings/);
    await expect(secrets.delete(slot)).rejects.toThrow(
      /installation's settings/,
    );
    await expect(secrets.put(slot, "x".repeat(16))).rejects.toThrow(
      /installation's settings/,
    );
  });

  test("the console cannot write an external reference", async () => {
    let refused = "accepted";
    await db
      .insert(providerConnections)
      .values({
        id: `console_${randomUUID().slice(0, 8)}`,
        definition: MAIN,
        credentialSource: "external",
        origin: "console",
      })
      .catch((error: Error) => {
        refused = String(
          (error as { cause?: Error }).cause?.message ?? error.message,
        );
      });
    expect(refused).toContain("provider_connections_console_stored_check");
  });

  test("every settings write raises the generation", async () => {
    const generation = async () =>
      (await db.select().from(settingsGeneration))[0]?.generation ?? -1;
    const start = await generation();
    await db.insert(providerConnections).values({
      id: `gen_${randomUUID().slice(0, 8)}`,
      definition: MAIN,
      credentialSource: "external",
      origin: "import",
    });
    const afterConnection = await generation();
    expect(afterConnection).toBeGreaterThan(start);
    const store = createPostgresInstallationSettingsStore(db, null);
    expect((await store.read()).generation).toBe(afterConnection);
  });
});

const MIGRATIONS = join(import.meta.dir, "../migrations");

async function migrationsThrough(lastTag: string): Promise<string> {
  const folder = await mkdtemp(
    join(tmpdir(), "installation-settings-migrations-"),
  );
  await mkdir(join(folder, "meta"));
  const journal: { entries: Array<{ tag: string }> } = JSON.parse(
    await readFile(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
  );
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last === -1) throw new Error(`no migration ${lastTag}`);
  const entries = journal.entries.slice(0, last + 1);
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const { tag } of entries) {
    await copyFile(join(MIGRATIONS, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  return folder;
}

integration(
  "installation settings migration over an installation's rows",
  () => {
    test("the console App's rows stay what they were, and the image from before still writes", async () => {
      const database = await createTempDatabase({
        migrate: false,
        prefix: "installation_settings_expand_it",
      });
      const pool = new Pool({ connectionString: database.url, max: 2 });
      const db = drizzle(pool, { schema });
      const before = await migrationsThrough("0224_push_follow_ups");
      try {
        await migrate(db, { migrationsFolder: before });
        await pool.query(
          `INSERT INTO catalog_repositories (id, owner, name, url, branch, profiles, source)
         VALUES ('app', 'team', 'app', 'https://github.com/team/app.git', 'main', '["coding"]', 'seed')`,
        );
        const store = createPostgresCatalogRepositoryStore(db);
        await migrate(db, { migrationsFolder: MIGRATIONS });
        const rows = await store.readCatalog();
        expect(
          rows?.map(({ id, profiles, url }) => ({ id, profiles, url })),
        ).toEqual([
          {
            id: "app",
            profiles: ["coding"],
            url: "https://github.com/team/app.git",
          },
        ]);
        expect(
          (
            await pool.query(
              "SELECT auth_kind, auth, credential_source FROM catalog_repositories",
            )
          ).rows,
        ).toEqual([
          { auth_kind: "github_app", auth: null, credential_source: null },
        ]);
        expect(
          (await pool.query("SELECT generation FROM settings_generation")).rows,
        ).toEqual([{ generation: "0" }]);

        await pool.query(
          `INSERT INTO catalog_repositories (id, github_repository_id, owner, name, url, branch, source)
         VALUES ('picked', 42, 'team', 'picked', 'https://github.com/team/picked.git', 'main', 'selection')`,
        );
        expect((await store.readCatalog())?.map(({ id }) => id)).toEqual([
          "app",
          "picked",
        ]);
        expect(
          (await pool.query("SELECT generation FROM settings_generation")).rows,
        ).toEqual([{ generation: "1" }]);
        let refused = "accepted";
        await pool
          .query(
            `INSERT INTO catalog_repositories (id, github_repository_id, owner, name, url, branch, source)
           VALUES ('dup', 43, 'Team', 'App', 'https://github.com/team/app.git', 'main', 'selection')`,
          )
          .catch((error: Error) => {
            refused = error.message;
          });
        expect(refused).toContain("catalog_repositories_full_name_key");
      } finally {
        await pool.end();
        await database.drop();
        await rm(before, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
