import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type CredentialRef,
  repositoryBinding,
  SecretKey,
  settingsSnapshot,
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
import * as schema from "./schema.ts";
import {
  attempts,
  catalogRepositories,
  mcpServers,
  providerConnections,
  pushRequests,
  receipts,
  secretValues,
  sessions,
  workerCredentials,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const KEY = SecretKey.fromHex("cd".repeat(32), "test key");
const APP_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const ENV = {
  PROVIDER_KEY: "example-provider-key-1234",
  APP_KEY: APP_PEM,
  MCP_TOKEN: "example-mcp-token-5678",
  REPO_TOKEN: "example-repo-token-9012",
};
const env = (name: string): string | undefined =>
  Object.hasOwn(ENV, name) ? ENV[name as keyof typeof ENV] : undefined;

const CONNECTION_AUTH = { kind: "bearer", value_env: "PROVIDER_KEY" };
const APP_AUTH = {
  kind: "github_app",
  app_id: 7,
  installation_id: 70,
  api_base: "https://ghes.example.invalid/api/v3",
  value_env: "APP_KEY",
};
const MCP_AUTH = { kind: "bearer", value_env: "MCP_TOKEN" };

integration("carrying env credentials into stored values", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "settings_carry_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  async function addWorkspace() {
    await db.insert(workspaces).values({
      id: randomUUID(),
      slug: `ws-${randomUUID().slice(0, 8)}`,
      name: "ws",
    });
  }

  beforeEach(async () => {
    await db.delete(workerCredentials);
    await db.delete(attempts);
    await db.delete(pushRequests);
    await db.delete(sessions);
    await db.delete(receipts);
    await db.delete(secretValues);
    await db.delete(providerConnections);
    await db.delete(catalogRepositories);
    await db.delete(mcpServers);
    await db.delete(workspaces);
    await db.insert(providerConnections).values({
      id: "main",
      definition: {
        kind: "litellm",
        endpoint: "http://10.0.0.5:4000",
        billing: "none",
        auth: CONNECTION_AUTH,
      },
      credentialSource: "external",
      origin: "import",
    });
    await db.insert(catalogRepositories).values([
      {
        id: "ghes",
        owner: "team",
        name: "ghes",
        url: "https://ghes.example.invalid/team/ghes.git",
        branch: "main",
        authKind: "github_app_explicit",
        auth: APP_AUTH,
        credentialSource: "external",
        source: "import",
      },
      {
        id: "url-repo",
        owner: "team",
        name: "url",
        url: "https://git.example.invalid/team/url.git",
        branch: "main",
        authKind: "bearer",
        auth: { kind: "bearer", value_env: "REPO_TOKEN" },
        credentialSource: "external",
        source: "import",
      },
    ]);
    await db.insert(mcpServers).values([
      {
        id: "docs",
        url: "https://mcp.example.invalid/docs",
        credentialRef: "docs_token",
        auth: MCP_AUTH,
        credentialSource: "external",
        workspaces: ["acme"],
        origin: "import",
      },
      {
        id: "old",
        url: "https://mcp.example.invalid/old",
        credentialRef: "old_token",
        auth: MCP_AUTH,
        credentialSource: "external",
        workspaces: ["acme"],
        origin: "import",
        disabledAt: new Date(),
      },
    ]);
  });

  test("a connection, an explicit App repository and an MCP server move once; the read opens them as stored", async () => {
    await addWorkspace();
    const store = createPostgresInstallationSettingsStore(db, KEY);
    expect(await store.carryEnvCredentials(env)).toEqual([
      { entry: "connection:main", env: "PROVIDER_KEY", outcome: "carried" },
      {
        entry: "repository:ghes",
        env: "APP_KEY",
        outcome: "carried",
        rebound: { push_requests: 0, worker_credentials: 0 },
      },
      { entry: "mcp:docs", env: "MCP_TOKEN", outcome: "carried" },
    ]);
    expect(await store.carryEnvCredentials(env)).toEqual([]);

    const [connection] = await db.select().from(providerConnections);
    expect(connection?.definition.auth).toEqual({
      kind: "bearer",
      stored: "connection:main",
    });
    expect(connection?.credentialSource).toBe("stored");
    expect(connection?.carriedAuth).toEqual(CONNECTION_AUTH);
    // The console's convert keeps this for re-imports; a carry does not.
    expect(connection?.replacesAuth).toBeNull();

    const [app] = await db
      .select()
      .from(catalogRepositories)
      .where(eq(catalogRepositories.id, "ghes"));
    const { value_env: _app, ...appNamed } = APP_AUTH;
    expect(app?.auth).toEqual({ ...appNamed, stored: "repository:ghes" });
    expect(app?.credentialSource).toBe("stored");
    expect(app?.carriedAuth).toEqual(APP_AUTH);
    expect(app?.version).toBe(2);

    const read = await store.read({ openStored: true });
    expect(read.invalid).toEqual(["repository:url-repo"]);
    expect(Object.fromEntries(read.stored)).toEqual({
      "connection:main": ENV.PROVIDER_KEY,
      // As the catalog takes it: `\n` escapes unfolded, trimmed.
      "repository:ghes": APP_PEM.trim(),
      "mcp:docs": ENV.MCP_TOKEN,
    });
    expect(read.repositories.map(({ id }) => id)).toEqual(["ghes"]);
  });

  test("each move leaves a receipt naming the variable, never the value", async () => {
    await addWorkspace();
    await createPostgresInstallationSettingsStore(db, KEY).carryEnvCredentials(
      env,
    );
    const written = await db
      .select({
        operation: receipts.operation,
        result: receipts.result,
        actor: receipts.actor,
      })
      .from(receipts);
    expect(written.map(({ result }) => result)).toEqual(
      expect.arrayContaining([
        {
          connection_id: "main",
          replaced: "value_env",
          value_env: "PROVIDER_KEY",
          by: "env_import",
        },
        {
          repository_id: "ghes",
          replaced: "value_env",
          value_env: "APP_KEY",
          by: "env_import",
          rebound: { push_requests: 0, worker_credentials: 0 },
        },
        {
          mcp_server_id: "docs",
          replaced: "value_env",
          value_env: "MCP_TOKEN",
          by: "env_import",
        },
      ]),
    );
    expect(written).toHaveLength(3);
    for (const receipt of written) {
      expect(receipt.operation).toBe("set_settings_credential");
      expect(receipt.actor).toBeNull();
    }
    const text = JSON.stringify(written);
    for (const value of Object.values(ENV)) expect(text).not.toContain(value);
  });

  test("a URL repository and a disabled server are not moved, and nothing names them", async () => {
    await addWorkspace();
    const outcomes = await createPostgresInstallationSettingsStore(
      db,
      KEY,
    ).carryEnvCredentials(env);
    expect(outcomes.map(({ entry }) => entry)).not.toContain(
      "repository:url-repo",
    );
    expect(outcomes.map(({ entry }) => entry)).not.toContain("mcp:old");
    const [url] = await db
      .select()
      .from(catalogRepositories)
      .where(eq(catalogRepositories.id, "url-repo"));
    expect(url?.credentialSource).toBe("external");
    expect(url?.carriedAuth).toBeNull();
    const [old] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "old"));
    expect(old?.credentialSource).toBe("external");
  });

  test("a variable with no value is missing and its row stays as it was", async () => {
    await addWorkspace();
    const store = createPostgresInstallationSettingsStore(db, KEY);
    const outcomes = await store.carryEnvCredentials((name) =>
      name === "PROVIDER_KEY" ? "" : undefined,
    );
    expect(outcomes.map(({ outcome }) => outcome)).toEqual([
      "missing",
      "missing",
      "missing",
    ]);
    const [connection] = await db.select().from(providerConnections);
    expect(connection?.credentialSource).toBe("external");
    expect(await db.select().from(secretValues)).toEqual([]);
  });

  test("with no workspace, or no secret store, the rows wait and move once there is one", async () => {
    const store = createPostgresInstallationSettingsStore(db, KEY);
    const waiting = await store.carryEnvCredentials(env);
    expect(waiting.map(({ outcome }) => outcome)).toEqual([
      "waiting",
      "waiting",
      "waiting",
    ]);
    await addWorkspace();
    const keyless = await createPostgresInstallationSettingsStore(
      db,
      null,
    ).carryEnvCredentials(env);
    expect(keyless.map(({ outcome }) => outcome)).toEqual([
      "waiting",
      "waiting",
      "waiting",
    ]);
    expect(await db.select().from(receipts)).toEqual([]);
    const carried = await store.carryEnvCredentials(env);
    expect(carried.map(({ outcome }) => outcome)).toEqual([
      "carried",
      "carried",
      "carried",
    ]);
  });

  test("replicas carrying at once move each row once", async () => {
    await addWorkspace();
    const runs = await Promise.all(
      Array.from({ length: 4 }, () =>
        createPostgresInstallationSettingsStore(db, KEY).carryEnvCredentials(
          env,
        ),
      ),
    );
    const carried = runs
      .flat()
      .filter(({ outcome }) => outcome === "carried")
      .map(({ entry }) => entry)
      .sort();
    expect(carried).toEqual(["connection:main", "mcp:docs", "repository:ghes"]);
    expect(runs.flat().filter(({ outcome }) => outcome !== "carried")).toEqual(
      [],
    );
    expect(await db.select().from(receipts)).toHaveLength(3);
  });

  test("a value the catalog would refuse is not sealed, so no last four characters show", async () => {
    await addWorkspace();
    const short: Record<string, string> = {
      PROVIDER_KEY: "abcd",
      APP_KEY: "not a key",
      MCP_TOKEN: "abc",
    };
    const outcomes = await createPostgresInstallationSettingsStore(
      db,
      KEY,
    ).carryEnvCredentials((name) => short[name]);
    expect(outcomes.map(({ outcome }) => outcome)).toEqual([
      "invalid",
      "invalid",
      "invalid",
    ]);
    const text = JSON.stringify(outcomes);
    for (const value of Object.values(short)) {
      expect(text).not.toContain(`"${value}"`);
    }
    expect(await db.select().from(secretValues)).toEqual([]);
    expect(await db.select().from(receipts)).toEqual([]);
    const [connection] = await db.select().from(providerConnections);
    expect(connection?.credentialSource).toBe("external");
  });

  // What the API's registry builds from a read, and the binding a session
  // and its push requests of `id` are held to (pull-request-service,
  // push-executor and worker-gateway compare exactly this).
  async function bindingNow(id: string): Promise<string> {
    const read = await createPostgresInstallationSettingsStore(db, KEY).read({
      openStored: true,
    });
    const snapshot = settingsSnapshot(read, (ref: CredentialRef) =>
      "value_env" in ref ? env(ref.value_env) : undefined,
    );
    const repository = snapshot.repositories[id];
    if (repository === undefined) throw new Error(`${id} is left out`);
    return repositoryBinding(id, repository);
  }

  async function heldBindings() {
    const session = async () => {
      const id = randomUUID();
      await db.insert(sessions).values({
        id,
        ownerId: "owner",
        repoUrl: "https://ghes.example.invalid/team/ghes.git",
        branch: "main",
        repositoryId: "ghes",
        checkpointRevision: 1,
      });
      return id;
    };
    const before = await bindingNow("ghes");
    const push = async (binding: string) => {
      const sessionId = await session();
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
        repositoryId: "ghes",
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
    const attemptId = randomUUID();
    await db.insert(attempts).values({
      id: attemptId,
      sessionId: await session(),
      executionId: "exec",
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 1,
      state: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const credential = (purpose: string, binding: string) =>
      db.insert(workerCredentials).values({
        tokenHash: randomBytes(32),
        attemptId,
        purpose,
        binding,
        expiresAt: new Date(Date.now() + 60_000),
      });
    const ghesPush = await push(before);
    const otherPush = await push("sha256:another-repository");
    await credential("repository", before);
    // Another purpose holding the same text is not a repository binding.
    await credential("provider", before);
    return { before, ghesPush, otherPush };
  }

  const pushBinding = async (id: string) =>
    (
      await db
        .select({ binding: pushRequests.repositoryBinding })
        .from(pushRequests)
        .where(eq(pushRequests.id, id))
    )[0]?.binding;
  const credentialBindings = async () =>
    Object.fromEntries(
      (
        await db
          .select({
            purpose: workerCredentials.purpose,
            binding: workerCredentials.binding,
          })
          .from(workerCredentials)
      ).map(({ purpose, binding }) => [purpose, binding]),
    );

  test("push requests and a running session's credential held to the old binding move to the new one, and nothing else", async () => {
    await addWorkspace();
    const { before, ghesPush, otherPush } = await heldBindings();
    const outcomes = await createPostgresInstallationSettingsStore(
      db,
      KEY,
    ).carryEnvCredentials(env);
    expect(
      outcomes.find(({ entry }) => entry === "repository:ghes"),
    ).toMatchObject({
      outcome: "carried",
      rebound: { push_requests: 1, worker_credentials: 1 },
    });
    const after = await bindingNow("ghes");
    expect(after).not.toBe(before);
    // A pull request opened, updated or merged from it compares this.
    expect(await pushBinding(ghesPush)).toBe(after);
    // A token reissued to the running session compares this.
    expect(await credentialBindings()).toEqual({
      repository: after,
      provider: before,
    });
    expect(await pushBinding(otherPush)).toBe("sha256:another-repository");
    const [app] = await db
      .select({ carriedBinding: catalogRepositories.carriedBinding })
      .from(catalogRepositories)
      .where(eq(catalogRepositories.id, "ghes"));
    expect(app?.carriedBinding).toEqual({ from: before, to: after });
  });

  test("the rollback SQL in the upgrade guide restores the env references and the old bindings", async () => {
    await addWorkspace();
    const { before, ghesPush, otherPush } = await heldBindings();
    await createPostgresInstallationSettingsStore(db, KEY).carryEnvCredentials(
      env,
    );
    const guide = readFileSync(
      new URL(
        "../../../apps/docs/content/docs/run-server/self-hosting/upgrade-compose.mdx",
        import.meta.url,
      ),
      "utf8",
    );
    const rollback = [...guide.matchAll(/```sql\n([\s\S]*?)```/g)]
      .map(([, sql]) => sql ?? "")
      .find((sql) => sql.includes("carried_binding"));
    if (rollback === undefined) throw new Error("no rollback SQL");
    await pool.query(rollback);

    const [connection] = await db.select().from(providerConnections);
    expect(connection?.definition.auth).toEqual(CONNECTION_AUTH);
    expect(connection?.credentialSource).toBe("external");
    const [app] = await db
      .select()
      .from(catalogRepositories)
      .where(eq(catalogRepositories.id, "ghes"));
    expect(app?.auth).toEqual(APP_AUTH);
    expect(app?.carriedBinding).toBeNull();
    const [docs] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "docs"));
    expect(docs?.auth).toEqual(MCP_AUTH);
    expect(await bindingNow("ghes")).toBe(before);
    expect(await pushBinding(ghesPush)).toBe(before);
    expect(await credentialBindings()).toEqual({
      repository: before,
      provider: before,
    });
    expect(await pushBinding(otherPush)).toBe("sha256:another-repository");
  });
});
