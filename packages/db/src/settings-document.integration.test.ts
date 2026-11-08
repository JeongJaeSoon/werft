import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  callerFor,
  parseSettingsDocument,
  SecretKey,
  type SettingsEntries,
  settingsDocumentDigest,
  settingsDocumentOf,
  type TeamActor,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresInstallationSettingsStore } from "./installation-settings.ts";
import * as schema from "./schema.ts";
import {
  catalogRepositories,
  mcpServers,
  memberships,
  providerConnections,
  receipts,
  secretValues,
  settingsGeneration,
  users,
  workspaces,
} from "./schema.ts";
import { createPostgresSettingsDocumentStore } from "./settings-document.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const KEY = SecretKey.fromHex("cd".repeat(32), "test key");

const DOCUMENT = {
  version: 1,
  connections: {
    main: {
      kind: "litellm",
      endpoint: "http://10.0.0.5:4000",
      billing: "none",
      auth: { kind: "bearer", value_env: "PROVIDER_KEY" },
    },
    console: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key", stored: true },
    },
  },
  repositories: {
    open: {
      url: "https://github.com/agent/sample-app.git",
      branch: "main",
      auth: { kind: "github_app" },
    },
    app: {
      url: "https://github.com/acme/app.git",
      branch: "main",
      profiles: ["coding"],
      auth: { kind: "github_app" },
    },
    ghec: {
      url: "https://github.com/acme/ghec.git",
      branch: "trunk",
      auth: {
        kind: "github_app",
        app_id: 7,
        installation_id: 70,
        value_env: "GHEC_APP_KEY",
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
};

integration("settings document import and export", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "settings_document_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  async function clear() {
    await db.delete(receipts);
    await db.delete(secretValues);
    await db.delete(providerConnections);
    await db.delete(mcpServers);
    await db.delete(catalogRepositories);
  }

  const generation = async () =>
    (await db.select().from(settingsGeneration))[0]?.generation ?? -1;

  const rowCounts = async () => ({
    connections: (await db.select().from(providerConnections)).length,
    repositories: (await db.select().from(catalogRepositories)).length,
    mcp: (await db.select().from(mcpServers)).length,
  });

  async function owner(): Promise<TeamActor> {
    const [first] = await db.select().from(workspaces).limit(1);
    const workspaceId =
      first?.id ??
      (
        await db
          .insert(workspaces)
          .values({ id: randomUUID(), slug: "acme", name: "acme" })
          .returning({ id: workspaces.id })
      )[0]?.id;
    if (!workspaceId) throw new Error("no workspace");
    return person(workspaceId, "owner");
  }

  async function person(
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<TeamActor> {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    const principal = callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
    return { principal, workspaceId, userId };
  }

  const entries = (): SettingsEntries => parseSettingsDocument(DOCUMENT);
  const store = () => createPostgresSettingsDocumentStore(db);
  const operator = { dryRun: false, allowExternal: true, actor: null };

  test("an import, its export and the export imported again change nothing the second time", async () => {
    await clear();
    const first = await store().importEntries(entries(), operator);
    expect(first).toMatchObject({
      outcome: "applied",
      unchanged: [],
      conflicts: [],
      needs_value: ["connection:console"],
    });
    if (first.outcome === "actor_inactive") throw new Error("unreachable");
    expect(first.add.map((add) => `${add.kind}:${add.id}`).sort()).toEqual([
      "connection:console",
      "connection:main",
      "mcp:docs",
      "repository:app",
      "repository:ghec",
      "repository:open",
    ]);

    const exported = await store().exportEntries();
    const document = settingsDocumentOf(exported.entries, exported.last4);
    expect(document).toEqual(DOCUMENT as typeof document);

    const before = { generation: await generation(), rows: await rowCounts() };
    const again = await store().importEntries(
      parseSettingsDocument(document),
      operator,
    );
    expect(again).toMatchObject({
      outcome: "applied",
      add: [],
      conflicts: [],
      receipt_ids: [],
    });
    if (again.outcome === "actor_inactive") throw new Error("unreachable");
    expect(again.unchanged).toHaveLength(6);
    expect({
      generation: await generation(),
      rows: await rowCounts(),
    }).toEqual(before);
    const reexported = await store().exportEntries();
    expect(
      settingsDocumentDigest(
        settingsDocumentOf(reexported.entries, reexported.last4),
      ),
    ).toBe(settingsDocumentDigest(document));
  });

  test("rows are shaped as the S1 readers expect: kinds, sources, owner and name", async () => {
    await clear();
    await store().importEntries(entries(), operator);
    const rows = Object.fromEntries(
      (await db.select().from(catalogRepositories)).map((row) => [
        row.id,
        {
          authKind: row.authKind,
          credentialSource: row.credentialSource,
          source: row.source,
          owner: row.owner,
          name: row.name,
          auth: row.auth,
          profiles: row.profiles,
        },
      ]),
    );
    expect(rows).toEqual({
      open: {
        authKind: "github_app",
        credentialSource: null,
        source: "seed",
        owner: "agent",
        name: "sample-app",
        auth: null,
        profiles: null,
      },
      app: {
        authKind: "github_app",
        credentialSource: null,
        source: "seed",
        owner: "acme",
        name: "app",
        auth: null,
        profiles: ["coding"],
      },
      ghec: {
        authKind: "github_app_explicit",
        credentialSource: "external",
        source: "import",
        owner: "acme",
        name: "ghec",
        auth: DOCUMENT.repositories.ghec.auth,
        profiles: null,
      },
    });
    const read = await createPostgresInstallationSettingsStore(db, null).read();
    expect(read.invalid).toEqual([]);
    expect(read.connections.map(({ id }) => id)).toEqual(["console", "main"]);
    expect(read.repositories.map(({ id }) => id)).toEqual(["ghec"]);
  });

  test("a legacy URL repository row reads as invalid and stays as it was", async () => {
    await clear();
    await db.insert(catalogRepositories).values({
      id: "legacy",
      owner: "acme",
      name: "legacy",
      url: "https://git.example.invalid/acme/legacy.git",
      branch: "main",
      authKind: "bearer",
      auth: { kind: "bearer", value_env: "REPO_TOKEN" },
      credentialSource: "external",
      source: "import",
    });
    const row = () =>
      db
        .select()
        .from(catalogRepositories)
        .where(eq(catalogRepositories.id, "legacy"));
    const before = await row();
    const read = await createPostgresInstallationSettingsStore(db, null).read();
    expect(read.invalid).toEqual(["repository:legacy"]);
    expect(read.repositories).toEqual([]);
    expect(before).toHaveLength(1);
    expect(await row()).toEqual(before);
  });

  test("an old directory leaves a GitHub App repository the console moved; a document still conflicts", async () => {
    await clear();
    await store().importEntries(entries(), operator);
    await db
      .update(catalogRepositories)
      .set({ branch: "develop" })
      .where(eq(catalogRepositories.id, "app"));

    expect(await store().importEntries(entries(), operator)).toMatchObject({
      outcome: "refused",
      conflicts: ["repository:app"],
    });
    expect(
      await store().importEntries(entries(), {
        ...operator,
        databaseOwnsRepositories: true,
      }),
    ).toMatchObject({
      outcome: "applied",
      conflicts: [],
      kept: ["repository:app"],
    });
    const [row] = await db
      .select({ branch: catalogRepositories.branch })
      .from(catalogRepositories)
      .where(eq(catalogRepositories.id, "app"));
    expect(row?.branch).toBe("develop");
  });

  test("one entry held otherwise stops the whole import, and names it", async () => {
    await clear();
    await store().importEntries(entries(), operator);
    const before = { generation: await generation(), rows: await rowCounts() };
    const changed = entries();
    changed.repositories.open = {
      ...changed.repositories.open,
      branch: "dev",
    } as never;
    changed.connections.extra = changed.connections.main as never;
    const result = await store().importEntries(changed, operator);
    expect(result).toMatchObject({
      outcome: "refused",
      conflicts: ["repository:open"],
      receipt_ids: [],
    });
    expect({
      generation: await generation(),
      rows: await rowCounts(),
    }).toEqual(before);
    const dry = await store().importEntries(changed, {
      ...operator,
      dryRun: true,
    });
    expect(dry.outcome).toBe("refused");
  });

  test("a dry run writes nothing; an applied import leaves a receipt per row", async () => {
    await clear();
    const actor = await owner();
    const dry = await store().importEntries(entries(), {
      ...operator,
      dryRun: true,
    });
    expect(dry.outcome).toBe("dry_run");
    expect(await rowCounts()).toEqual({
      connections: 0,
      repositories: 0,
      mcp: 0,
    });

    const applied = await store().importEntries(entries(), operator);
    if (applied.outcome !== "applied") throw new Error(applied.outcome);
    expect(applied.receipt_ids).toHaveLength(6);
    const written = await db
      .select()
      .from(receipts)
      .where(inArray(receipts.id, applied.receipt_ids));
    expect(written.map((row) => row.operation).sort()).toEqual([
      "import_connection",
      "import_connection",
      "import_mcp_server",
      "import_repository",
      "import_repository",
      "import_repository",
    ]);
    // A receipt names its destination and where the credential lives, never
    // the credential's reference.
    const fields = {
      import_connection: [
        "connection_id",
        "credential_source",
        "endpoint",
        "kind",
      ],
      import_repository: [
        "auth_kind",
        "branch",
        "credential_source",
        // A row of the document is not tied to a GitHub id yet.
        "github_repository_id",
        "repository",
        "repository_id",
        "source",
        "url",
      ],
      import_mcp_server: [
        "credential_ref",
        "credential_source",
        "mcp_server_id",
        "url",
      ],
    } as Record<string, string[]>;
    for (const row of written) {
      expect(row.actor).toBeNull();
      expect(row.ownerId).toBe(actor.workspaceId);
      expect(Object.keys(row.result as object).sort()).toEqual(
        fields[row.operation] ?? [],
      );
    }
  });

  test("the API's import refuses a new external reference, takes stored ones, and an export never carries the value", async () => {
    await clear();
    const actor = await owner();
    const api = { dryRun: false, allowExternal: false, actor };
    const refused = await store().importEntries(entries(), api);
    expect(refused).toMatchObject({
      outcome: "refused",
      refused_external: ["connection:main", "repository:ghec", "mcp:docs"],
    });
    expect(await rowCounts()).toEqual({
      connections: 0,
      repositories: 0,
      mcp: 0,
    });

    const stored: SettingsEntries = {
      connections: { console: entries().connections.console as never },
      repositories: {
        open: entries().repositories.open as never,
        app: entries().repositories.app as never,
      },
      mcp_servers: {},
    };
    const applied = await store().importEntries(stored, api);
    expect(applied).toMatchObject({
      outcome: "applied",
      needs_value: ["connection:console"],
    });
    if (applied.outcome !== "applied") throw new Error(applied.outcome);
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, applied.receipt_ids[0] ?? ""));
    expect(receipt?.actor).toMatchObject({ actor_user_id: actor.userId });
    const [row] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, "console"));
    expect(row?.createdBy).toBe(actor.userId);

    const settings = createPostgresInstallationSettingsStore(db, KEY);
    await settings.putStoredValue(
      { kind: "connection", id: "console" },
      "sk-console-stored-value-1234",
      actor.userId,
    );
    const exported = await store().exportEntries();
    const text = JSON.stringify(
      settingsDocumentOf(exported.entries, exported.last4),
    );
    expect(text).not.toContain("sk-console-stored-value");
    expect(text).not.toContain("connection:console");
    expect(
      settingsDocumentOf(exported.entries, exported.last4).connections.console,
    ).toEqual({
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key", stored: true, last4: "1234" },
    });
    const again = await store().importEntries(stored, api);
    expect(again).toMatchObject({ outcome: "applied", needs_value: [] });

    const outranked = {
      ...api,
      actor: await person(actor.workspaceId, "admin"),
    };
    expect((await store().importEntries(stored, outranked)).outcome).toBe(
      "actor_inactive",
    );
  });

  test("a value left under an id no row holds is neither taken by a new row nor written without one", async () => {
    await clear();
    const actor = await owner();
    await store().importEntries(
      {
        connections: { console: entries().connections.console as never },
        repositories: {},
        mcp_servers: {},
      },
      operator,
    );
    const settings = createPostgresInstallationSettingsStore(db, KEY);
    await settings.putStoredValue(
      { kind: "connection", id: "console" },
      "a-value-for-the-first-endpoint",
      actor.userId,
    );
    // The row goes (an operator's manual delete), its value stays.
    await db
      .delete(providerConnections)
      .where(eq(providerConnections.id, "console"));
    const elsewhere = parseSettingsDocument({
      ...DOCUMENT,
      connections: {
        console: {
          kind: "anthropic",
          endpoint: "https://attacker.invalid",
          auth: { kind: "api_key", stored: true },
        },
      },
      repositories: {},
      mcp_servers: {},
    });
    expect(
      await store().importEntries(elsewhere, {
        ...operator,
        allowExternal: false,
        actor,
      }),
    ).toMatchObject({ outcome: "refused", conflicts: ["connection:console"] });
    await expect(
      settings.putStoredValue(
        { kind: "mcp", id: "nowhere" },
        "a-value-for-no-row-at-all",
        actor.userId,
      ),
    ).rejects.toThrow(/no settings row/);
  });
});
