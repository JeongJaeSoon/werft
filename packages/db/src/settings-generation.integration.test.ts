import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole } from "@werft-ai/contracts";
import {
  type CatalogRegistry,
  callerFor,
  createCatalogRegistry,
  parseSettingsDocument,
  SecretKey,
  type SettingsImportAdd,
  settingsSnapshot,
  type TeamActor,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresInstallationSettingsStore,
  readSettingsGeneration,
} from "./installation-settings.ts";
import * as schema from "./schema.ts";
import { memberships, users, workspaces } from "./schema.ts";
import { createPostgresSettingsDocumentStore } from "./settings-document.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const KEY = SecretKey.fromHex("9a".repeat(32), "test key");

function connection(id: string): SettingsImportAdd {
  const parsed = parseSettingsDocument({
    version: 1,
    connections: {
      [id]: {
        kind: "anthropic",
        endpoint: `https://${id}.example.invalid`,
        auth: { kind: "api_key", stored: true },
      },
    },
    repositories: {},
  });
  return { kind: "connection", id, entry: parsed.connections[id] as never };
}

integration("the settings generation two API replicas judge on", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let owner: TeamActor;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "settings_generation_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "acme" });
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "owner",
    });
    await db.insert(memberships).values({ workspaceId, userId, role: "owner" });
    owner = {
      principal: callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role: "owner",
          scopes: [...scopesForRole("owner")],
        },
        { kind: "web" },
        randomUUID(),
      ),
      workspaceId,
      userId,
    };
  });
  afterAll(async () => {
    await pool.end();
    await database.drop();
  });

  const store = () => createPostgresSettingsDocumentStore(db, KEY);
  const generation = () => readSettingsGeneration(db);
  // Each registry as an API process wires it; here the test asks caughtUp
  // itself, where the gateway would before a grant.
  const replica = (): CatalogRegistry => {
    const settings = createPostgresInstallationSettingsStore(db, KEY);
    return createCatalogRegistry({
      generation: { read: generation },
      settings: {
        read: async () =>
          settingsSnapshot(await settings.read({ openStored: true })),
      },
    });
  };
  const keyOn = (registry: CatalogRegistry, id: string) => {
    const auth = registry.settings?.connections[id]?.provider.auth;
    return auth !== undefined && "value" in auth ? auth.value : undefined;
  };

  test("a key set raises the generation once, in its own write; a refused set does not", async () => {
    const id = "gen-key";
    expect(
      (await store().create(connection(id), "first-key-1111", owner)).outcome,
    ).toBe("done");
    const before = await generation();
    const owned = { kind: "connection" as const, id };
    expect(
      (await store().setValue(owned, "second-key-2222", owner)).outcome,
    ).toBe("done");
    expect(await generation()).toBe(before + 1);
    expect(
      (
        await store().setValue(
          { kind: "connection", id: "gen-nobody" },
          "third-key-3333",
          owner,
        )
      ).outcome,
    ).toBe("not_found");
    expect(await generation()).toBe(before + 1);
  });

  test("a key set again to the value it holds leaves the generation; another value raises it by one", async () => {
    const id = "gen-same-key";
    const owned = { kind: "connection" as const, id };
    expect(
      (await store().create(connection(id), "same-key-1111", owner)).outcome,
    ).toBe("done");
    const before = await generation();
    expect(
      (await store().setValue(owned, "same-key-1111", owner)).outcome,
    ).toBe("done");
    expect(await generation()).toBe(before);
    expect(
      (await store().setValue(owned, "next-key-2222", owner)).outcome,
    ).toBe("done");
    expect(await generation()).toBe(before + 1);
  });

  test("a stored value put again as it is leaves the generation; another raises it by one", async () => {
    const id = "gen-same-put";
    expect(
      (await store().create(connection(id), "put-key-1111", owner)).outcome,
    ).toBe("done");
    const settings = createPostgresInstallationSettingsStore(db, KEY);
    const owned = { kind: "connection" as const, id };
    const before = await generation();
    await settings.putStoredValue(owned, "put-key-1111", null);
    expect(await generation()).toBe(before);
    await settings.putStoredValue(owned, "put-key-2222", null);
    expect(await generation()).toBe(before + 1);
    const opened = await settings.read({ openStored: true });
    expect(opened.stored.get(`connection:${id}`)).toBe("put-key-2222");
  });

  test("a connection's models set again as they are leave the generation; other models raise it by one", async () => {
    const id = "gen-same-models";
    expect(
      (await store().create(connection(id), "models-key-1111", owner)).outcome,
    ).toBe("done");
    type Families = Record<string, { family: string; rank: number }>;
    const set = (models: string[], model_families?: Families) =>
      store().setConnectionModels(
        id,
        model_families === undefined ? { models } : { models, model_families },
        owner,
      );
    expect((await set(["claude-sonnet-5"])).outcome).toBe("done");
    const before = await generation();
    expect((await set(["claude-sonnet-5"])).outcome).toBe("done");
    expect(await generation()).toBe(before);
    expect((await set(["claude-sonnet-5", "claude-haiku-5"])).outcome).toBe(
      "done",
    );
    expect(await generation()).toBe(before + 1);
    // The same models with families they lacked, then again, then others.
    const sonnet = { "claude-sonnet-5": { family: "sonnet", rank: 5 } };
    const models = ["claude-sonnet-5", "claude-haiku-5"];
    expect((await set(models, sonnet)).outcome).toBe("done");
    expect(await generation()).toBe(before + 2);
    expect((await set(models, sonnet)).outcome).toBe("done");
    expect(await generation()).toBe(before + 2);
    expect((await set(models)).outcome).toBe("done");
    expect(await generation()).toBe(before + 2);
    const ranked = { "claude-sonnet-5": { family: "sonnet", rank: 6 } };
    expect((await set(models, ranked)).outcome).toBe("done");
    expect(await generation()).toBe(before + 3);
  });

  test("what one replica writes, the other judges on at its next request, its periodic read not yet come", async () => {
    const id = "gen-replicas";
    const [writer, other] = [replica(), replica()];
    expect(
      (await store().create(connection(id), "replica-key-1111", owner)).outcome,
    ).toBe("done");
    await Promise.all([writer.caughtUp(), other.caughtUp()]);
    expect(keyOn(other, id)).toBe("replica-key-1111");

    // A key changed on the writer: the other's next grant carries the new one.
    await store().setValue(
      { kind: "connection", id },
      "replica-key-2222",
      owner,
    );
    await writer.refresh();
    expect(keyOn(other, id)).toBe("replica-key-1111");
    await other.caughtUp();
    expect(keyOn(other, id)).toBe("replica-key-2222");
    expect(other.settings?.generation).toBe(await generation());

    // Disabled on the writer: gone from the other's next grant.
    expect(
      (await store().disable({ kind: "connection", id }, owner)).outcome,
    ).toBe("done");
    await other.caughtUp();
    expect(other.settings?.connections[id]).toBeUndefined();

    // Nothing written since: the next request reads no settings again.
    const held = other.settings;
    await other.caughtUp();
    expect(other.settings).toBe(held);
  });
});
