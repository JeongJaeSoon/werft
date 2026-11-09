import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  callerFor,
  parseSettingsDocument,
  SecretKey,
  type SettingsImportAdd,
  type TeamActor,
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
  mcpServers,
  memberships,
  providerConnections,
  receipts,
  secretValues,
  users,
  workspaces,
} from "./schema.ts";
import { writeSecretInTx } from "./secret-values.ts";
import { createPostgresSettingsDocumentStore } from "./settings-document.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const KEY = SecretKey.fromHex("ef".repeat(32), "test key");

/** The entry as the console service hands it over: stored under its own id. */
function add(
  section: "connections" | "repositories" | "mcp_servers",
  id: string,
  entry: Record<string, unknown>,
): SettingsImportAdd {
  const parsed = parseSettingsDocument({
    version: 1,
    connections: {},
    repositories: {},
    mcp_servers: {},
    [section]: { [id]: entry },
  });
  if (section === "connections") {
    return { kind: "connection", id, entry: parsed.connections[id] as never };
  }
  if (section === "mcp_servers") {
    return { kind: "mcp", id, entry: parsed.mcp_servers[id] as never };
  }
  return { kind: "repository", id, entry: parsed.repositories[id] as never };
}

const CONNECTION = {
  kind: "anthropic",
  endpoint: "http://fake-model:8080",
  billing: "none",
  auth: { kind: "api_key", stored: true },
};
const MCP = {
  url: "https://mcp.example.invalid/docs",
  credential_ref: "docs_token",
  auth: { kind: "bearer", stored: true },
  workspaces: ["acme"],
};

integration("settings console writes", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let workspaceId: string;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "settings_console_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    const [made] = await db
      .insert(workspaces)
      .values({ id: randomUUID(), slug: "acme", name: "acme" })
      .returning({ id: workspaces.id });
    if (!made) throw new Error("no workspace");
    workspaceId = made.id;
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  async function person(role: WorkspaceRole): Promise<TeamActor> {
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

  const store = () => createPostgresSettingsDocumentStore(db, KEY);
  const settings = () => createPostgresInstallationSettingsStore(db, KEY);
  const receiptsOf = async (operation: string) =>
    db
      .select()
      .from(receipts)
      .where(eq(receipts.operation, operation as never));

  test("a console connection is its row, its own sealed value and one receipt in one go, and the registry reads it", async () => {
    const owner = await person("owner");
    const made = await store().create(
      add("connections", "console-fake", CONNECTION),
      "example-key-1234",
      owner,
    );
    expect(made.outcome).toBe("done");
    const [row] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, "console-fake"));
    expect(row).toMatchObject({
      origin: "console",
      credentialSource: "stored",
      definition: { auth: { stored: "connection:console-fake" } },
    });
    const read = await settings().read({ openStored: true });
    expect(read.connections.map((item) => item.id)).toContain("console-fake");
    expect(read.stored.get("connection:console-fake")).toBe("example-key-1234");
    const [receipt] = await receiptsOf("create_connection");
    expect(receipt?.result).toMatchObject({
      connection_id: "console-fake",
      credential_source: "stored",
      source: "console",
    });
    expect(JSON.stringify(receipt?.result)).not.toContain("example-key");

    const listed = await store().listRows("connection");
    expect(listed.find((item) => item.id === "console-fake")).toMatchObject({
      origin: "console",
      last4: "1234",
      disabledAt: null,
    });
  });

  test("an id ever taken or a value already sealed under it is refused, and nothing is written", async () => {
    const owner = await person("owner");
    expect(
      await store().create(
        add("connections", "console-fake", CONNECTION),
        "another-key",
        owner,
      ),
    ).toEqual({ outcome: "conflict", reason: "already_exists" });
    // A value sealed under an id no row holds yet (made before S2's row
    // check): a new row on that id would take it.
    await db.transaction((tx) =>
      writeSecretInTx(
        tx,
        KEY,
        {
          workspaceId,
          owner: { kind: "connection", id: "orphan" },
          purpose: "settings_credential",
        },
        "someone-elses-key",
        null,
      ),
    );
    expect(
      await store().create(
        add("connections", "orphan", CONNECTION),
        "mine",
        owner,
      ),
    ).toEqual({ outcome: "conflict", reason: "already_exists" });
    expect(
      await db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, "orphan")),
    ).toEqual([]);
  });

  test("two creates of one id at once: one row, one receipt, and the other refused", async () => {
    const owner = await person("owner");
    const outcomes = await Promise.all(
      ["first-key-0001", "second-key-0002"].map((value) =>
        store().create(add("connections", "raced", CONNECTION), value, owner),
      ),
    );
    expect(outcomes.map((result) => result.outcome).sort()).toEqual([
      "conflict",
      "done",
    ]);
    expect(
      await db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, "raced")),
    ).toHaveLength(1);
    const made = (await receiptsOf("create_connection")).filter(
      (row) =>
        (row.result as { connection_id?: unknown }).connection_id === "raced",
    );
    expect(made).toHaveLength(1);
  });

  test("a connection's auto mode is set on its own column: the definition stays, one receipt is written, and disabled or missing ids are refused", async () => {
    const owner = await person("owner");
    await store().create(
      add("connections", "auto-fake", CONNECTION),
      "example-key-1234",
      owner,
    );
    const before = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, "auto-fake"));
    expect(before[0]?.autoMode).toBe("unknown");

    const set = await store().setConnectionAutoMode(
      "auto-fake",
      "supported",
      owner,
    );
    expect(set.outcome).toBe("done");
    const after = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.id, "auto-fake"));
    expect(after[0]?.autoMode).toBe("supported");
    // The fingerprint hashes the definition, so it must not move.
    expect(after[0]?.definition).toEqual(before[0]?.definition);
    expect(
      (await store().listRows("connection")).find(
        (item) => item.id === "auto-fake",
      ),
    ).toMatchObject({ autoMode: "supported" });
    const written = (await receiptsOf("set_connection_auto_mode")).filter(
      (receipt) =>
        (receipt.result as { connection_id?: string }).connection_id ===
        "auto-fake",
    );
    expect(written).toHaveLength(1);
    expect(written[0]?.result).toMatchObject({ auto_mode: "supported" });

    expect(
      await store().setConnectionAutoMode(
        "no-such-connection",
        "supported",
        owner,
      ),
    ).toEqual({ outcome: "not_found" });
    await store().disable({ kind: "connection", id: "auto-fake" }, owner);
    expect(
      await store().setConnectionAutoMode("auto-fake", "unsupported", owner),
    ).toEqual({ outcome: "conflict", reason: "disabled" });
  });

  test("an admin or member may not write a connection or MCP server", async () => {
    for (const role of ["admin", "member"] as const) {
      const someone = await person(role);
      expect(
        await store().create(
          add("connections", `by-${role}`, CONNECTION),
          "v",
          someone,
        ),
      ).toEqual({ outcome: "actor_inactive" });
      expect(
        await store().create(
          add("mcp_servers", `by-${role}`, MCP),
          "v",
          someone,
        ),
      ).toEqual({ outcome: "actor_inactive" });
    }
  });

  test("an operator's reference is only disabled: no value, no workspaces change", async () => {
    const owner = await person("owner");
    await db.insert(mcpServers).values({
      id: "operator-docs",
      url: "https://mcp.example.invalid/op",
      credentialRef: "op_token",
      auth: { kind: "bearer", value_env: "MCP_TOKEN" },
      credentialSource: "external",
      workspaces: ["acme"],
      origin: "import",
    });
    expect(
      await store().setValue({ kind: "mcp", id: "operator-docs" }, "v", owner),
    ).toEqual({ outcome: "conflict", reason: "not_stored" });
    expect(
      await store().setMcpWorkspaces("operator-docs", ["other"], owner),
    ).toEqual({ outcome: "conflict", reason: "not_stored" });
    expect(
      (await store().disable({ kind: "mcp", id: "operator-docs" }, owner))
        .outcome,
    ).toBe("done");
    expect(
      await store().disable({ kind: "mcp", id: "operator-docs" }, owner),
    ).toEqual({ outcome: "conflict", reason: "disabled" });
    expect(
      await store().setValue({ kind: "mcp", id: "nowhere" }, "v", owner),
    ).toEqual({ outcome: "not_found" });
  });

  test("a stored MCP server's value turns, its workspaces change in place, and a disabled row leaves the registry", async () => {
    const owner = await person("owner");
    expect(
      (await store().create(add("mcp_servers", "docs", MCP), "first", owner))
        .outcome,
    ).toBe("done");
    expect(
      (await store().setValue({ kind: "mcp", id: "docs" }, "second", owner))
        .outcome,
    ).toBe("done");
    expect(
      (await settings().read({ openStored: true })).stored.get("mcp:docs"),
    ).toBe("second");
    const [turned] = await receiptsOf("set_settings_credential");
    expect(turned?.result).toEqual({ mcp_server_id: "docs", last4: "cond" });

    expect(
      (await store().setMcpWorkspaces("docs", ["acme", "labs"], owner)).outcome,
    ).toBe("done");
    const [row] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, "docs"));
    expect(row?.workspaces).toEqual(["acme", "labs"]);

    expect(
      (await store().disable({ kind: "mcp", id: "docs" }, owner)).outcome,
    ).toBe("done");
    const read = await settings().read();
    expect(read.mcpServers.map((item) => item.id)).not.toContain("docs");
    expect(
      await store().setValue({ kind: "mcp", id: "docs" }, "third", owner),
    ).toEqual({ outcome: "conflict", reason: "disabled" });
    // Re-made under the same id: never.
    expect(
      await store().create(add("mcp_servers", "docs", MCP), "again", owner),
    ).toEqual({ outcome: "conflict", reason: "already_exists" });
  });

  describe("moving an env-referenced connection to a typed key", () => {
    const FROM_ENV = {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "api_key", value_env: "MOVE_ME_KEY" },
    };
    const importOptions = {
      dryRun: false,
      allowExternal: true,
      actor: null,
    } as const;
    const document = (connections: Record<string, unknown>) =>
      parseSettingsDocument({
        version: 1,
        connections,
        repositories: {},
        mcp_servers: {},
      });

    test("the row turns stored under its id, remembers the reference, and seals the typed value", async () => {
      const owner = await person("owner");
      await store().importEntries(
        document({ "move-main": FROM_ENV }),
        importOptions,
      );
      const moved = await store().convertConnection(
        "move-main",
        "typed-key-9876",
        owner,
      );
      expect(moved.outcome).toBe("done");

      const [row] = await db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, "move-main"));
      expect(row).toMatchObject({
        origin: "import",
        credentialSource: "stored",
        definition: {
          auth: { kind: "api_key", stored: "connection:move-main" },
        },
        replacesAuth: { kind: "api_key", value_env: "MOVE_ME_KEY" },
      });
      // A reference name, never a value.
      expect(JSON.stringify(row?.replacesAuth)).not.toContain("typed-key");

      const read = await settings().read({ openStored: true });
      const item = read.connections.find((one) => one.id === "move-main");
      expect(item?.provider.auth).toMatchObject({
        stored: "connection:move-main",
      });
      expect(item?.replaces?.auth).toMatchObject({ value_env: "MOVE_ME_KEY" });
      expect(read.stored.get("connection:move-main")).toBe("typed-key-9876");

      const receipt = (await receiptsOf("set_settings_credential")).find(
        (one) =>
          (one.result as { connection_id?: string }).connection_id ===
          "move-main",
      );
      expect(receipt?.result).toEqual({
        connection_id: "move-main",
        last4: "9876",
        replaced: "value_env",
      });
      expect(JSON.stringify(receipt?.result)).not.toContain("typed-key-");
    });

    test("a settings document that still names the old entry leaves the row alone", async () => {
      const again = await store().importEntries(
        document({ "move-main": FROM_ENV }),
        importOptions,
      );
      expect(again).toMatchObject({
        outcome: "applied",
        conflicts: [],
        kept: ["connection:move-main"],
      });
      const [row] = await db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.id, "move-main"));
      expect(row?.credentialSource).toBe("stored");
    });

    test("a document naming it with another reference is still a conflict", async () => {
      const refused = await store().importEntries(
        document({
          "move-main": {
            ...FROM_ENV,
            auth: { kind: "api_key", value_env: "SOMETHING_ELSE" },
          },
        }),
        importOptions,
      );
      expect(refused).toMatchObject({
        outcome: "refused",
        conflicts: ["connection:move-main"],
      });
    });

    test("a row that keeps its own value, a disabled one and a missing one are refused", async () => {
      const owner = await person("owner");
      await store().create(
        add("connections", "move-own", CONNECTION),
        "own-key-1111",
        owner,
      );
      expect(
        await store().convertConnection("move-own", "typed-key-2222", owner),
      ).toEqual({ outcome: "conflict", reason: "not_external" });
      expect(
        await store().convertConnection("move-main", "typed-key-3333", owner),
      ).toEqual({ outcome: "conflict", reason: "not_external" });
      expect(
        await store().convertConnection("move-nobody", "typed-key-4444", owner),
      ).toEqual({ outcome: "not_found" });

      await store().importEntries(
        document({
          "move-off": {
            ...FROM_ENV,
            auth: { kind: "api_key", value_env: "OFF_KEY" },
          },
        }),
        importOptions,
      );
      await store().disable({ kind: "connection", id: "move-off" }, owner);
      expect(
        await store().convertConnection("move-off", "typed-key-5555", owner),
      ).toEqual({ outcome: "conflict", reason: "disabled" });
    });

    test("a connection another row is exactly, now or before, is refused so two keys never mix", async () => {
      const owner = await person("owner");
      // `move-twin` names the same reference `move-first` does: a ceiling
      // made over that reference could belong to either.
      await store().importEntries(
        document({
          "move-first": {
            ...FROM_ENV,
            auth: { kind: "api_key", value_env: "TWIN_KEY" },
          },
          "move-twin": {
            ...FROM_ENV,
            auth: { kind: "api_key", value_env: "TWIN_KEY" },
          },
        }),
        importOptions,
      );
      expect(
        await store().convertConnection("move-first", "typed-key-6666", owner),
      ).toEqual({ outcome: "conflict", reason: "alias_taken" });
      expect(
        await db
          .select()
          .from(secretValues)
          .where(eq(secretValues.ownerRef, "connection:move-first")),
      ).toEqual([]);
    });
  });

  describe("enabling a connection again", () => {
    const external = (valueEnv: string) => ({
      kind: "anthropic",
      endpoint: "http://fake-model:8080",
      billing: "none",
      auth: { kind: "api_key", value_env: valueEnv },
    });
    const importExternal = (connections: Record<string, unknown>) =>
      store().importEntries(
        parseSettingsDocument({
          version: 1,
          connections,
          repositories: {},
          mcp_servers: {},
        }),
        { dryRun: false, allowExternal: true, actor: null },
      );
    const rowOf = async (id: string) =>
      (
        await db
          .select()
          .from(providerConnections)
          .where(eq(providerConnections.id, id))
      )[0];
    const enableReceipts = async (id: string) =>
      (await receiptsOf("enable_connection")).filter(
        (one) =>
          (one.result as { connection_id?: string }).connection_id === id,
      );
    const off = (owner: TeamActor, id: string) =>
      store().disable({ kind: "connection", id }, owner);

    test("a disabled stored connection is live again, with one receipt, and the registry reads it", async () => {
      const owner = await person("owner");
      await store().create(
        add("connections", "en-stored", CONNECTION),
        "stored-key-1111",
        owner,
      );
      await off(owner, "en-stored");
      expect(
        (await settings().read({ openStored: true })).connections.some(
          (one) => one.id === "en-stored",
        ),
      ).toBe(false);

      const enabled = await store().enableConnection("en-stored", owner);
      expect(enabled.outcome).toBe("done");
      expect(await rowOf("en-stored")).toMatchObject({
        disabledAt: null,
        disabledBy: null,
      });
      const read = await settings().read({ openStored: true });
      expect(read.connections.some((one) => one.id === "en-stored")).toBe(true);
      expect(read.stored.get("connection:en-stored")).toBe("stored-key-1111");
      const receipts = await enableReceipts("en-stored");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.result).toEqual({
        connection_id: "en-stored",
        source: "console",
      });
      expect(JSON.stringify(receipts[0]?.result)).not.toContain("stored-key");
    });

    test("one in use, a missing one, and a role that is not an owner's change nothing", async () => {
      const owner = await person("owner");
      const admin = await person("admin");
      await store().create(
        add("connections", "en-live", CONNECTION),
        "live-key-2222",
        owner,
      );
      expect(await store().enableConnection("en-live", owner)).toEqual({
        outcome: "conflict",
        reason: "not_disabled",
      });
      expect(await store().enableConnection("en-nobody", owner)).toEqual({
        outcome: "not_found",
      });

      await off(owner, "en-live");
      expect(await store().enableConnection("en-live", admin)).toEqual({
        outcome: "actor_inactive",
      });
      expect((await rowOf("en-live"))?.disabledAt).not.toBeNull();
      expect(await enableReceipts("en-live")).toEqual([]);
    });

    test("another connection in use holding the same definition refuses it; one disabled does not", async () => {
      const owner = await person("owner");
      await importExternal({
        "en-twin-a": external("EN_TWIN_KEY"),
        "en-twin-b": external("EN_TWIN_KEY"),
      });
      await off(owner, "en-twin-a");
      expect(await store().enableConnection("en-twin-a", owner)).toEqual({
        outcome: "conflict",
        reason: "definition_active",
      });
      expect((await rowOf("en-twin-a"))?.disabledAt).not.toBeNull();
      expect(await enableReceipts("en-twin-a")).toEqual([]);

      await off(owner, "en-twin-b");
      expect((await store().enableConnection("en-twin-a", owner)).outcome).toBe(
        "done",
      );
      // The twin now waits on the one in use, the same way.
      expect(await store().enableConnection("en-twin-b", owner)).toEqual({
        outcome: "conflict",
        reason: "definition_active",
      });
    });

    test("a live connection that is, or was, exactly this one's old reference refuses it", async () => {
      const owner = await person("owner");
      await importExternal({ "en-moved": external("EN_MOVED_KEY") });
      await store().convertConnection("en-moved", "moved-key-3333", owner);
      await off(owner, "en-moved");
      // The row now says `stored`; a live row spelled as the old reference
      // would be found by the ceilings made over it.
      const moved = await rowOf("en-moved");
      await db.insert(providerConnections).values({
        id: "en-spelled-old",
        definition: { ...moved?.definition, auth: moved?.replacesAuth },
        credentialSource: "external",
        origin: "import",
      });
      expect(await store().enableConnection("en-moved", owner)).toEqual({
        outcome: "conflict",
        reason: "definition_active",
      });
      await off(owner, "en-spelled-old");
      expect((await store().enableConnection("en-moved", owner)).outcome).toBe(
        "done",
      );
    });

    test("a stored connection whose value is gone needs one first; a deployment's reference is let through", async () => {
      const owner = await person("owner");
      await store().create(
        add("connections", "en-lost", CONNECTION),
        "lost-key-4444",
        owner,
      );
      await off(owner, "en-lost");
      await db
        .delete(secretValues)
        .where(eq(secretValues.ownerRef, "connection:en-lost"));
      expect(await store().enableConnection("en-lost", owner)).toEqual({
        outcome: "conflict",
        reason: "needs_value",
      });
      expect((await rowOf("en-lost"))?.disabledAt).not.toBeNull();
      expect(await enableReceipts("en-lost")).toEqual([]);

      await importExternal({ "en-ref": external("EN_REF_KEY") });
      await off(owner, "en-ref");
      expect((await store().enableConnection("en-ref", owner)).outcome).toBe(
        "done",
      );
    });

    test("two twins enabled at once: one is done and the other sees it, so never two live", async () => {
      const owner = await person("owner");
      await importExternal({
        "en-pair-a": external("EN_PAIR_KEY"),
        "en-pair-b": external("EN_PAIR_KEY"),
      });
      await off(owner, "en-pair-a");
      await off(owner, "en-pair-b");
      const results = await Promise.all([
        store().enableConnection("en-pair-a", owner),
        store().enableConnection("en-pair-b", owner),
      ]);
      expect(results.map((one) => one.outcome).sort()).toEqual([
        "conflict",
        "done",
      ]);
      const live = (await db.select().from(providerConnections)).filter(
        (one) => one.id.startsWith("en-pair-") && one.disabledAt === null,
      );
      expect(live).toHaveLength(1);
    });

    test("a live connection that once held the same old reference refuses it, though their definitions differ", async () => {
      const owner = await person("owner");
      await importExternal({ "en-old-a": external("EN_OLD_KEY") });
      await store().convertConnection("en-old-a", "old-key-7777", owner);
      await off(owner, "en-old-a");
      const first = await rowOf("en-old-a");
      await db.insert(providerConnections).values({
        id: "en-old-b",
        definition: {
          ...first?.definition,
          auth: { kind: "api_key", stored: "connection:en-old-b" },
        },
        credentialSource: "stored",
        origin: "console",
        replacesAuth: first?.replacesAuth ?? null,
      });
      expect(await store().enableConnection("en-old-a", owner)).toEqual({
        outcome: "conflict",
        reason: "definition_active",
      });
    });

    test("two enables at once: one is done, one is told it is no longer disabled, one receipt", async () => {
      const owner = await person("owner");
      await store().create(
        add("connections", "en-race", CONNECTION),
        "race-key-5555",
        owner,
      );
      await off(owner, "en-race");
      const results = await Promise.all([
        store().enableConnection("en-race", owner),
        store().enableConnection("en-race", owner),
      ]);
      expect(results.map((one) => one.outcome).sort()).toEqual([
        "conflict",
        "done",
      ]);
      expect(await enableReceipts("en-race")).toHaveLength(1);
    });
  });
});
