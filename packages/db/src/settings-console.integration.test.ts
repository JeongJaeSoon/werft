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
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresInstallationSettingsStore } from "./installation-settings.ts";
import * as schema from "./schema.ts";
import {
  memberships,
  providerConnections,
  receipts,
  secretValues,
  users,
  workspaces,
} from "./schema.ts";
import { writeSecretInTx } from "./secrets/secret-values.ts";
import { createPostgresSettingsDocumentStore } from "./settings-document.ts";
import { backendPid, waitsOn } from "./testing/lock-wait.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const KEY = SecretKey.fromHex("ef".repeat(32), "test key");

/** The entry as the console service hands it over: stored under its own id. */
function add(
  section: "connections" | "repositories",
  id: string,
  entry: Record<string, unknown>,
): SettingsImportAdd {
  const parsed = parseSettingsDocument({
    version: 1,
    connections: {},
    repositories: {},
    [section]: { [id]: entry },
  });
  if (section === "connections") {
    return { kind: "connection", id, entry: parsed.connections[id] as never };
  }
  return { kind: "repository", id, entry: parsed.repositories[id] as never };
}

const CONNECTION = {
  kind: "anthropic",
  endpoint: "http://fake-model:8080",
  billing: "none",
  auth: { kind: "api_key", stored: true },
};
const DECISION = {
  kind: "openai_decisions",
  endpoint: "https://api.openai.com",
  auth: { kind: "api_key", stored: true },
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
    expect(receipt?.result).toEqual({
      connection_id: "console-fake",
      kind: "anthropic",
      endpoint: "http://fake-model:8080",
      host_port: "fake-model:8080",
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

  describe("a new decision model and the workspace's judge", () => {
    const judgeOf = async () => {
      const [row] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      return (row?.settings as { achievement_judge?: Record<string, unknown> })
        .achievement_judge;
    };
    const noJudge = () =>
      db
        .update(workspaces)
        .set({ settings: sql`${workspaces.settings} - 'achievement_judge'` })
        .where(eq(workspaces.id, workspaceId));
    const judgeReceipts = async () =>
      (await receiptsOf("set_achievement_judge")).map(
        (row) =>
          (row.result as { achievement_judge: unknown }).achievement_judge,
      );

    test("a judge that names none takes it with a receipt; one that names a connection keeps it", async () => {
      const owner = await person("owner");
      await noJudge();
      expect(await judgeReceipts()).toEqual([]);
      expect(
        (
          await store().create(
            add("connections", "luna-first", DECISION),
            "first-key-0001",
            owner,
          )
        ).outcome,
      ).toBe("done");
      expect(await judgeOf()).toEqual({ connection_id: "luna-first" });
      expect(await judgeReceipts()).toEqual([
        expect.objectContaining({ connection_id: "luna-first" }),
      ]);
      expect(
        (
          await store().create(
            add("connections", "luna-second", DECISION),
            "second-key-0002",
            owner,
          )
        ).outcome,
      ).toBe("done");
      expect(await judgeOf()).toEqual({ connection_id: "luna-first" });
      expect(await judgeReceipts()).toHaveLength(1);
      // Any other kind leaves the judge alone.
      await noJudge();
      await store().create(
        add("connections", "not-a-judge", CONNECTION),
        "third-key-0003",
        owner,
      );
      expect(await judgeOf()).toBeUndefined();
    });

    test("a judge a person saves while the create waits on the workspace row is never overwritten", async () => {
      const owner = await person("owner");
      await noJudge();
      let held: () => void = () => {};
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      let proceed: () => void = () => {};
      const go = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      let blocker = 0;
      // As a judge save: the workspace row locked, the judge set, not committed.
      const save = db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM workspaces WHERE id = ${workspaceId} FOR NO KEY UPDATE`,
        );
        await tx
          .update(workspaces)
          .set({
            settings: sql`jsonb_set(${workspaces.settings}, '{achievement_judge}', '{"connection_id":"luna-picked"}'::jsonb)`,
          })
          .where(eq(workspaces.id, workspaceId));
        blocker = await backendPid(tx);
        held();
        await go;
      });
      let create: ReturnType<ReturnType<typeof store>["create"]> | null = null;
      try {
        await holding;
        let settled = false;
        create = store()
          .create(
            add("connections", "luna-raced", DECISION),
            "raced-key-0004",
            owner,
          )
          .finally(() => {
            settled = true;
          });
        // The create's judge write waits on the save's row lock.
        expect(await waitsOn(db, blocker, () => settled)).toBe(true);
        proceed();
        await save;
        expect((await create).outcome).toBe("done");
        expect(await judgeOf()).toEqual({ connection_id: "luna-picked" });
      } finally {
        proceed();
        await save.catch(() => {});
        await create?.catch(() => null);
      }
    });

    test("a judge stored as JSON null, or naming no connection, takes the new decision model", async () => {
      const owner = await person("owner");
      for (const [id, judge] of [
        ["luna-after-null", "null"],
        ["luna-after-unset", '{"connection_id":null,"threshold":0.8}'],
      ] as const) {
        await db
          .update(workspaces)
          .set({
            settings: sql`jsonb_set(${workspaces.settings}, '{achievement_judge}', ${judge}::jsonb)`,
          })
          .where(eq(workspaces.id, workspaceId));
        expect(
          (
            await store().create(
              add("connections", id, DECISION),
              `${id}-key`,
              owner,
            )
          ).outcome,
        ).toBe("done");
        expect(await judgeOf()).toEqual(
          judge === "null"
            ? { connection_id: id }
            : { connection_id: id, threshold: 0.8 },
        );
      }
    });
  });

  test("an admin or member may not write a connection", async () => {
    for (const role of ["admin", "member"] as const) {
      const someone = await person(role);
      expect(
        await store().create(
          add("connections", `by-${role}`, CONNECTION),
          "v",
          someone,
        ),
      ).toEqual({ outcome: "actor_inactive" });
    }
  });

  test("a document naming an env or Secrets Manager reference is refused, naming the field", () => {
    for (const field of ["value_env", "secret_id"]) {
      expect(() =>
        parseSettingsDocument({
          version: 1,
          connections: {
            "from-env": {
              ...CONNECTION,
              auth: { kind: "api_key", [field]: "SOME_NAME" },
            },
          },
          repositories: {},
          mcp_servers: {},
        }),
      ).toThrow(`connections.from-env.auth.${field} is no longer supported`);
    }
  });

  describe("enabling a connection again", () => {
    const importStored = (connections: Record<string, unknown>) =>
      store().importEntries(
        parseSettingsDocument({
          version: 1,
          connections,
          repositories: {},
          mcp_servers: {},
        }),
        { dryRun: false, actor: null },
      );
    // Rows holding one definition can only be written directly: each import
    // or console row names its own value. Each still has its own value set.
    const twins = async (ids: string[]) => {
      for (const id of ids) {
        await db.insert(providerConnections).values({
          id,
          definition: {
            ...CONNECTION,
            auth: { kind: "api_key", stored: `connection:${ids[0]}` },
          },
          credentialSource: "stored",
          origin: "import",
        });
        await db.transaction((tx) =>
          writeSecretInTx(
            tx,
            KEY,
            {
              workspaceId,
              owner: { kind: "connection", id },
              purpose: "settings_credential",
            },
            `${id}-key-0000`,
            null,
          ),
        );
      }
    };
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
        endpoint: "http://fake-model:8080",
        host_port: "fake-model:8080",
        source: "console",
      });
      const disabled = (await receiptsOf("disable_connection")).filter(
        (one) =>
          (one.result as { connection_id?: string }).connection_id ===
          "en-stored",
      );
      expect(disabled.map((one) => one.result)).toEqual([
        {
          connection_id: "en-stored",
          endpoint: "http://fake-model:8080",
          host_port: "fake-model:8080",
          source: "console",
        },
      ]);
      expect(JSON.stringify(receipts[0]?.result)).not.toContain("stored-key");
    });

    test("a row written before the endpoint check keeps its credential out of the receipts", async () => {
      const owner = await person("owner");
      // Only a direct write holds such an endpoint: the catalog refuses
      // userinfo and a query string.
      await db.insert(providerConnections).values({
        id: "en-legacy",
        definition: {
          ...CONNECTION,
          endpoint:
            "https://user:pass-word@Models.EXAMPLE.com./v1?token=abc#frag",
          auth: { kind: "api_key", stored: "connection:en-legacy" },
        },
        credentialSource: "stored",
        origin: "import",
      });
      await db.transaction((tx) =>
        writeSecretInTx(
          tx,
          KEY,
          {
            workspaceId,
            owner: { kind: "connection", id: "en-legacy" },
            purpose: "settings_credential",
          },
          "en-legacy-key-0000",
          null,
        ),
      );
      expect((await off(owner, "en-legacy")).outcome).toBe("done");
      expect((await store().enableConnection("en-legacy", owner)).outcome).toBe(
        "done",
      );
      const written = [
        ...(await receiptsOf("disable_connection")),
        ...(await receiptsOf("enable_connection")),
      ].filter(
        (one) =>
          (one.result as { connection_id?: string }).connection_id ===
          "en-legacy",
      );
      expect(written.map((one) => one.result)).toEqual([
        {
          connection_id: "en-legacy",
          endpoint: "https://models.example.com./v1",
          host_port: "models.example.com:443",
          source: "console",
        },
        {
          connection_id: "en-legacy",
          endpoint: "https://models.example.com./v1",
          host_port: "models.example.com:443",
          source: "console",
        },
      ]);
      for (const secret of ["user", "pass-word", "token", "abc", "frag"]) {
        expect(JSON.stringify(written.map((one) => one.result))).not.toContain(
          secret,
        );
      }
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
      await twins(["en-twin-a", "en-twin-b"]);
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

    test("a connection whose value is gone, or an imported one never given one, needs one first", async () => {
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

      await importStored({ "en-imported": CONNECTION });
      await off(owner, "en-imported");
      expect(await store().enableConnection("en-imported", owner)).toEqual({
        outcome: "conflict",
        reason: "needs_value",
      });
      expect((await rowOf("en-imported"))?.disabledAt).not.toBeNull();

      // Still disabled, it takes its first value, but no second one.
      const first = { kind: "connection" as const, id: "en-imported" };
      expect(
        (await store().setValue(first, "first-key-1111", owner)).outcome,
      ).toBe("done");
      expect(await store().setValue(first, "again-key-2222", owner)).toEqual({
        outcome: "conflict",
        reason: "disabled",
      });
      expect(
        (await store().enableConnection("en-imported", owner)).outcome,
      ).toBe("done");
      expect(
        (await settings().read({ openStored: true })).stored.get(
          "connection:en-imported",
        ),
      ).toBe("first-key-1111");
    });

    test("two twins enabled at once: one is done and the other sees it, so never two live", async () => {
      const owner = await person("owner");
      await twins(["en-pair-a", "en-pair-b"]);
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
