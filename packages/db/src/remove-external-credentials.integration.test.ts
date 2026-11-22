import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  type CatalogRepository,
  parseSettingsDocument,
  repositoryBinding,
  SecretKey,
  settingsDocumentOf,
  settingsView,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresInstallationSettingsStore } from "./installation-settings.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  providerConnections,
  pushRequests,
  receipts,
  workerCredentials,
  workspaces,
} from "./schema.ts";
import { writeSecretInTx } from "./secrets/secret-values.ts";
import { createPostgresSettingsDocumentStore } from "./settings-document.ts";
import { migrationsThrough } from "./testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const KEY = SecretKey.fromHex("9a".repeat(32), "test key");

type Refused = { code: string | undefined; constraint: string | undefined };

function refusedBy(error: unknown): Refused {
  const { code, constraint } = error as Partial<Refused>;
  return { code, constraint };
}

function refusal(
  pool: Pool,
  text: string,
  values: unknown[] = [],
): Promise<Refused | "accepted"> {
  return pool.query(text, values).then(() => "accepted" as const, refusedBy);
}

integration("only stored credentials", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let workspaceId: string;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "stored_credentials_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "acme" });
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  const connection = (id: string, auth: object, source = "stored") =>
    refusal(
      pool,
      `INSERT INTO provider_connections (id, definition, credential_source, origin)
       VALUES ($1, $2, $3, 'import')`,
      [
        id,
        JSON.stringify({
          kind: "anthropic",
          endpoint: "https://api.anthropic.invalid",
          auth,
        }),
        source,
      ],
    );
  const mcp = (id: string, auth: object, source = "stored") =>
    refusal(
      pool,
      `INSERT INTO mcp_servers (id, url, credential_ref, auth, credential_source, workspaces, origin)
       VALUES ($1, 'https://mcp.example.invalid/x', 'x_token', $2, $3, '["acme"]', 'import')`,
      [id, JSON.stringify(auth), source],
    );
  const repository = (
    id: string,
    authKind: string,
    auth: object | null,
    source: string | null,
  ) =>
    refusal(
      pool,
      `INSERT INTO catalog_repositories (id, owner, name, url, branch, auth_kind, auth, credential_source, source)
       VALUES ($1, 'acme', $1, 'https://git.example.invalid/acme/' || $1 || '.git', 'main', $2, $3, $4, 'import')`,
      [id, authKind, auth === null ? null : JSON.stringify(auth), source],
    );

  test("a connection holds only its stored value, never an env or Secrets Manager reference", async () => {
    const check = {
      code: "23514",
      constraint: "provider_connections_credential_source_check",
    };
    expect(
      await connection(
        "c-external",
        { kind: "api_key", stored: "connection:c-external" },
        "external",
      ),
    ).toEqual(check);
    expect(
      await connection("c-env", {
        kind: "api_key",
        stored: "connection:c-env",
        value_env: "SOME_KEY",
      }),
    ).toEqual(check);
    expect(
      await connection("c-sm", {
        kind: "api_key",
        stored: "connection:c-sm",
        secret_id: "some/key",
      }),
    ).toEqual(check);
    expect(
      await connection("c-none", { kind: "api_key", value_env: "SOME_KEY" }),
    ).toEqual(check);
    expect(
      await connection("c-ok", { kind: "api_key", stored: "connection:c-ok" }),
    ).toBe("accepted");
  });

  test("an MCP server row is not written again, whatever its value (0303)", async () => {
    const check = { code: "23514", constraint: undefined };
    expect(
      await mcp(
        "m-external",
        { kind: "bearer", stored: "mcp:m-external" },
        "external",
      ),
    ).toEqual(check);
    expect(
      await mcp("m-sm", {
        kind: "bearer",
        stored: "mcp:m-sm",
        secret_id: "some/token",
      }),
    ).toEqual(check);
    expect(
      await mcp("m-env", { kind: "bearer", value_env: "SOME_TOKEN" }),
    ).toEqual(check);
    expect(await mcp("m-ok", { kind: "bearer", stored: "mcp:m-ok" })).toEqual(
      check,
    );
  });

  test("a repository with a credential of its own holds it stored; the console App's and a public one hold none", async () => {
    const check = {
      code: "23514",
      constraint: "catalog_repositories_credential_check",
    };
    expect(
      await repository(
        "r-env",
        "bearer",
        { kind: "bearer", value_env: "REPO_TOKEN" },
        "stored",
      ),
    ).toEqual(check);
    expect(
      await repository(
        "r-external",
        "basic",
        { kind: "basic", username: "u", stored: "repository:r-external" },
        "external",
      ),
    ).toEqual(check);
    expect(
      await repository(
        "r-app-sm",
        "github_app_explicit",
        {
          kind: "github_app",
          app_id: 1,
          installation_id: 2,
          stored: "repository:r-app-sm",
          secret_id: "app/key",
        },
        "stored",
      ),
    ).toEqual(check);
    expect(await repository("r-null", "bearer", null, null)).toEqual(check);
    expect(
      await repository(
        "r-ok",
        "github_app_explicit",
        {
          kind: "github_app",
          app_id: 1,
          installation_id: 2,
          stored: "repository:r-ok",
        },
        "stored",
      ),
    ).toBe("accepted");
    expect(await repository("r-public", "none", null, null)).toBe("accepted");
    expect(
      await repository(
        "r-public-stored",
        "none",
        { kind: "bearer", stored: "repository:r-public-stored" },
        "stored",
      ),
    ).toEqual(check);
  });

  const exists = async (table: string, id: string) =>
    (await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]))
      .rowCount === 1;

  test("a console row in provider_connections without its value fails at commit, not at the insert", async () => {
    const id = `console-${randomUUID().slice(0, 8)}`;
    const client = await pool.connect();
    let failed: Refused | "committed";
    try {
      await client.query("BEGIN");
      // The insert itself passes: the value may still be sealed after it.
      await client.query(
        `INSERT INTO provider_connections (id, definition, credential_source, origin)
         VALUES ($1, $2, 'stored', 'console')`,
        [
          id,
          JSON.stringify({
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            auth: { kind: "api_key", stored: `connection:${id}` },
          }),
        ],
      );
      failed = await client
        .query("COMMIT")
        .then(() => "committed" as const, refusedBy);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(failed).toEqual({
      code: "23514",
      constraint: "provider_connections_console_value",
    });
    expect(await exists("provider_connections", id)).toBe(false);
  });

  test("a console connection sealed in the same transaction commits", async () => {
    const id = `console-${randomUUID().slice(0, 8)}`;
    await db.transaction(async (tx) => {
      await tx.insert(providerConnections).values({
        id,
        definition: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.invalid",
          auth: { kind: "api_key", stored: `connection:${id}` },
        },
        credentialSource: "stored",
        origin: "console",
      });
      await writeSecretInTx(
        tx,
        KEY,
        {
          workspaceId,
          owner: { kind: "connection", id },
          purpose: "settings_credential",
        },
        "a-console-value-1234",
        null,
      );
    });
    expect(await exists("provider_connections", id)).toBe(true);
  });

  test("an imported row without its value commits and needs one", async () => {
    expect(
      await connection("imported", {
        kind: "api_key",
        stored: "connection:imported",
      }),
    ).toBe("accepted");
    const plan = await createPostgresSettingsDocumentStore(
      db,
      KEY,
    ).importEntries(
      parseSettingsDocument({
        version: 1,
        connections: {
          imported: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            auth: { kind: "api_key", stored: true },
          },
        },
        repositories: {},
        mcp_servers: {},
      }),
      { dryRun: true, actor: null },
    );
    expect(plan).toMatchObject({
      outcome: "dry_run",
      conflicts: [],
      needs_value: ["connection:imported"],
    });
  });
});

const PROVIDER_AUTH = { kind: "bearer", value_env: "PROVIDER_KEY" };
const MCP_AUTH = { kind: "bearer", secret_id: "mcp/docs-token" };
const GHES_AUTH = {
  kind: "github_app",
  app_id: 7,
  installation_id: 70,
  api_base: "https://ghes.example.invalid/api/v3",
  value_env: "APP_KEY",
};
// No api_base: the binding hashes the default.
const GHEC_AUTH = {
  kind: "github_app",
  app_id: 8,
  installation_id: 80,
  secret_id: "ghec/app-key",
};
const REPOSITORIES = {
  ghes: { url: "https://ghes.example.invalid/team/ghes.git", auth: GHES_AUTH },
  ghec: { url: "https://github.com/acme/ghec.git", auth: GHEC_AUTH },
} as const;

/**
 * The repository as the api held it before 0288: the App's key named by
 * env or Secrets Manager, resolved to some value the binding leaves out.
 */
function bindingBefore(id: keyof typeof REPOSITORIES): string {
  const { url, auth } = REPOSITORIES[id];
  const {
    kind: _kind,
    app_id,
    installation_id,
    ...named
  } = auth as unknown as {
    kind: string;
    app_id: number;
    installation_id: number;
    api_base?: string;
  };
  const { api_base, ...ref } = named;
  return repositoryBinding(id, {
    url,
    branch: "main",
    auth: {
      kind: "github_app",
      app_id,
      installation_id,
      api_base: api_base ?? "https://api.github.com",
      value: "any",
      ref,
    },
  } as unknown as CatalogRepository);
}

integration(
  "0288 moves env and Secrets Manager credentials to stored values",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;
    const folders: string[] = [];
    const held: Record<string, { push: string; other: string }> = {};
    const before = {
      ghes: bindingBefore("ghes"),
      ghec: bindingBefore("ghec"),
    };

    beforeAll(async () => {
      database = await createTempDatabase({
        migrate: false,
        prefix: "remove_external_it",
      });
      pool = new Pool({ connectionString: database.url, max: 2 });
      db = drizzle(pool, { schema });
      const through = migrationsThrough("0287_agent_workspace_mcp_servers");
      folders.push(through);
      await migrate(drizzle(pool), { migrationsFolder: through });

      await pool.query(
        "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
        [randomUUID()],
      );
      await pool.query(
        `INSERT INTO provider_connections (id, definition, credential_source, origin)
       VALUES ('main', $1, 'external', 'import')`,
        [
          JSON.stringify({
            kind: "litellm",
            endpoint: "http://10.0.0.5:4000",
            billing: "none",
            auth: PROVIDER_AUTH,
          }),
        ],
      );
      await pool.query(
        `INSERT INTO mcp_servers (id, url, credential_ref, auth, credential_source, workspaces, origin)
       VALUES ('docs', 'https://mcp.example.invalid/docs', 'docs_token', $1, 'external', '["acme"]', 'import')`,
        [JSON.stringify(MCP_AUTH)],
      );
      for (const [id, { url, auth }] of Object.entries(REPOSITORIES)) {
        await pool.query(
          `INSERT INTO catalog_repositories (id, owner, name, url, branch, auth_kind, auth, credential_source, source)
         VALUES ($1, 'acme', $1, $2, 'main', 'github_app_explicit', $3, 'external', 'import')`,
          [id, url, JSON.stringify(auth)],
        );
      }

      const session = async (repositoryId: string) => {
        const id = randomUUID();
        // Raw: the schema of today names columns 0287 does not have yet.
        await pool.query(
          `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id, checkpoint_revision)
         VALUES ($1, 'owner', $2, 'main', $3, 1)`,
          [
            id,
            REPOSITORIES[repositoryId as keyof typeof REPOSITORIES].url,
            repositoryId,
          ],
        );
        return id;
      };
      const push = async (repositoryId: string, binding: string) => {
        const sessionId = await session(repositoryId);
        const receiptId = randomUUID();
        await db.insert(receipts).values({
          id: receiptId,
          ownerId: "owner",
          operation: "create_push_request",
          targetRef: { session_id: sessionId },
        });
        const id = randomUUID();
        await db.insert(pushRequests).values({
          id,
          ownerId: "owner",
          sessionId,
          repositoryId,
          checkpointRevision: 1,
          gitCommit: "a".repeat(40),
          targetBranch: `agent/${sessionId}`,
          state: "requested",
          requestedBy: { kind: "user", id: "u" },
          requestReceiptId: receiptId,
          repositoryBinding: binding,
        });
        return id;
      };
      for (const id of ["ghes", "ghec"] as const) {
        held[id] = {
          push: await push(id, before[id]),
          other: await push(id, "sha256:another-repository"),
        };
        const attemptId = randomUUID();
        await db.insert(attempts).values({
          id: attemptId,
          sessionId: await session(id),
          executionId: `exec-${id}`,
          leaseEpoch: 1,
          executionGeneration: 1,
          authRevision: 1,
          state: "running",
          leaseExpiresAt: new Date(Date.now() + 60_000),
        });
        for (const purpose of ["repository", "provider"]) {
          await db.insert(workerCredentials).values({
            tokenHash: randomBytes(32),
            attemptId,
            purpose: purpose as never,
            binding: before[id],
            expiresAt: new Date(Date.now() + 60_000),
          });
        }
      }

      await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
    }, 120_000);

    afterAll(async () => {
      await pool.end();
      await database.drop();
      for (const folder of folders)
        rmSync(folder, { recursive: true, force: true });
    }, 60_000);

    const row = async (text: string, id: string) =>
      (await pool.query(text, [id])).rows[0] as Record<string, unknown>;

    test("each row names its own stored value and keeps its old auth for a rollback", async () => {
      expect(
        await row(
          "SELECT definition->'auth' AS auth, carried_auth, credential_source FROM provider_connections WHERE id = $1",
          "main",
        ),
      ).toEqual({
        auth: { kind: "bearer", stored: "connection:main" },
        carried_auth: PROVIDER_AUTH,
        credential_source: "stored",
      });
      // 0303 retired the catalog row; its restore record keeps no value.
      expect(
        await row(
          "SELECT auth, carried_auth, credential_source FROM mcp_servers WHERE id = $1",
          "docs",
        ),
      ).toBeUndefined();
      expect(
        await row(
          "SELECT url, credential_ref FROM retired_catalog_mcp WHERE name = $1",
          "docs",
        ),
      ).toEqual({
        url: "https://mcp.example.invalid/docs",
        credential_ref: "docs_token",
      });
      const { value_env: _env, ...ghesNamed } = GHES_AUTH;
      const { secret_id: _sm, ...ghecNamed } = GHEC_AUTH;
      for (const [id, named, carried] of [
        ["ghes", ghesNamed, GHES_AUTH],
        ["ghec", ghecNamed, GHEC_AUTH],
      ] as const) {
        expect(
          await row(
            "SELECT auth, carried_auth, credential_source, version FROM catalog_repositories WHERE id = $1",
            id,
          ),
        ).toEqual({
          auth: { ...named, stored: `repository:${id}` },
          carried_auth: carried,
          credential_source: "stored",
          version: 2,
        });
      }
    });

    test("the store reads every moved row as needing a value", async () => {
      const read = await createPostgresInstallationSettingsStore(db, KEY).read({
        openStored: true,
      });
      expect(read.invalid).toEqual([]);
      expect(read.stored.size).toBe(0);
      const store = createPostgresSettingsDocumentStore(db, KEY);
      const exported = await store.exportEntries();
      const plan = await store.importEntries(
        parseSettingsDocument(settingsDocumentOf(exported.entries)),
        { dryRun: true, actor: null },
      );
      expect(plan).toMatchObject({ outcome: "dry_run", conflicts: [] });
      if (plan.outcome !== "dry_run") return;
      expect([...plan.needs_value].sort()).toEqual([
        "connection:main",
        "repository:ghec",
        "repository:ghes",
      ]);
    });

    test("repository credentials held to the old binding hold the api's new one, and push requests once the key is set; nothing else moves", async () => {
      const read = await createPostgresInstallationSettingsStore(
        db,
        null,
      ).read();
      const store = createPostgresInstallationSettingsStore(db, KEY);
      const view = settingsView(read, () => "any");
      for (const id of ["ghes", "ghec"] as const) {
        const repository = view.repositories[id];
        if (repository === undefined) throw new Error(`${id} is left out`);
        const after = repositoryBinding(id, repository);
        expect(after).not.toBe(before[id]);
        expect(
          (
            await row(
              "SELECT carried_binding FROM catalog_repositories WHERE id = $1",
              id,
            )
          ).carried_binding,
        ).toEqual({ from: before[id], to: after });

        const bindingOf = async (pushId: string) =>
          (
            await db
              .select({ binding: pushRequests.repositoryBinding })
              .from(pushRequests)
              .where(eq(pushRequests.id, pushId))
          )[0]?.binding;
        expect(await bindingOf(held[id]?.push ?? "")).toBe(before[id]);
        await store.putStoredValue(
          { kind: "repository", id },
          "-----BEGIN PRIVATE KEY-----",
          null,
        );
        expect(await bindingOf(held[id]?.push ?? "")).toBe(after);
        expect(await bindingOf(held[id]?.other ?? "")).toBe(
          "sha256:another-repository",
        );

        const credentials = await pool.query<{
          purpose: string;
          binding: string;
        }>(
          `SELECT w.purpose, w.binding FROM worker_credentials w
         JOIN attempts a ON a.id = w.attempt_id WHERE a.execution_id = $1`,
          [`exec-${id}`],
        );
        expect(
          Object.fromEntries(
            credentials.rows.map(({ purpose, binding }) => [purpose, binding]),
          ),
        ).toEqual({ repository: after, provider: before[id] });
      }
    });
  },
);
