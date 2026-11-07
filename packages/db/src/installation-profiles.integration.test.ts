import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  type CatalogProfileConfig,
  type CreateInstallationProfileInput,
  callerFor,
  catalogImports,
  catalogProfileConfigSchema,
  type TeamActor,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, count, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { findPgError } from "./control-shared.ts";
import { createPostgresInstallationProfileStore } from "./installation-profiles.ts";
import * as schema from "./schema.ts";
import {
  installationProfiles,
  memberships,
  receipts,
  users,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

function definition(
  overrides: Partial<Record<string, unknown>> = {},
): CatalogProfileConfig {
  return catalogProfileConfigSchema.parse({
    runtime_kind: "claude_agent_sdk",
    runtime_version: "1",
    model: "claude-sonnet",
    models: ["claude-sonnet", "claude-haiku"],
    tools: ["Read"],
    permission_mode: "default",
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "api_key", value_env: "ANTHROPIC_API_KEY" },
    },
    ...overrides,
  });
}

integration("installation profiles on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "installation_profiles_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const ids = () => randomUUID().slice(0, 8);
  const rowsOf = (prefix: string) =>
    db
      .select()
      .from(installationProfiles)
      .orderBy(asc(installationProfiles.id))
      .then((rows) => rows.filter((row) => row.id.startsWith(prefix)));

  // Seeding only acts on an empty table, so each seed test owns a database.
  async function emptyDatabase<T>(
    run: (db: NodePgDatabase<typeof schema>, url: string) => Promise<T>,
  ): Promise<T> {
    const fresh = await createTempDatabase({ prefix: "profile_seed_it" });
    const freshPool = new Pool({ connectionString: fresh.url, max: 4 });
    try {
      return await run(drizzle(freshPool, { schema }), fresh.url);
    } finally {
      await freshPool.end();
      await fresh.drop();
    }
  }

  const allRows = (on: NodePgDatabase<typeof schema>) =>
    on
      .select()
      .from(installationProfiles)
      .orderBy(asc(installationProfiles.id));

  const seedOf = (profiles: Record<string, CatalogProfileConfig>) => async () =>
    catalogImports(profiles);

  test("an empty table is seeded on an install with no owner or workspace yet", async () => {
    await emptyDatabase(async (fresh) => {
      const [people] = await fresh.select({ n: count() }).from(users);
      const [spaces] = await fresh.select({ n: count() }).from(workspaces);
      expect([people?.n, spaces?.n]).toEqual([0, 0]);
      const result = await createPostgresInstallationProfileStore(
        fresh,
      ).seedCatalog({
        entries: seedOf({ b: definition(), a: definition() }),
        repositoryIdsOf: (id) => (id === "a" ? ["app", "docs"] : []),
      });
      expect(result).toEqual({ seeded: ["a", "b"], migrated: [] });
      const [row] = await allRows(fresh);
      expect(row).toMatchObject({
        id: "a",
        origin: "catalog",
        name: null,
        version: 1,
        // A seeded row names no repository, whatever the document allowed.
        repositoryIds: null,
        githubAppRepositories: null,
        repositoryScope: null,
        createdBy: null,
        previousId: null,
        retiredAt: null,
        blockedAt: null,
        permissionMode: "default",
      });
    });
  }, 60_000);

  test("a populated table is not changed by the YAML: new ids, edited entries or a broken file", async () => {
    await emptyDatabase(async (fresh) => {
      const store = createPostgresInstallationProfileStore(fresh);
      await store.seedCatalog({
        entries: seedOf({ a: definition() }),
        repositoryIdsOf: () => ["app"],
      });
      const before = await allRows(fresh);
      let read = 0;
      const again = await store.seedCatalog({
        entries: async () => {
          read += 1;
          throw new Error("the seed is broken");
        },
        repositoryIdsOf: () => ["elsewhere"],
      });
      const edited = await store.seedCatalog({
        entries: seedOf({
          a: definition({ tools: [] }),
          z: definition(),
        }),
        repositoryIdsOf: () => ["elsewhere"],
      });
      expect([again, edited]).toEqual([
        { seeded: [], migrated: [] },
        { seeded: [], migrated: [] },
      ]);
      expect(read).toBe(0);
      expect(await allRows(fresh)).toEqual(before);
    });
  }, 60_000);

  test("replicas starting together seed the empty table once", async () => {
    await emptyDatabase(async (_fresh, url) => {
      const profiles = Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`p${i}`, definition()]),
      );
      const replicas = Array.from({ length: 4 }, () => {
        const replicaPool = new Pool({ connectionString: url, max: 2 });
        return {
          pool: replicaPool,
          store: createPostgresInstallationProfileStore(
            drizzle(replicaPool, { schema }),
          ),
        };
      });
      try {
        const results = await Promise.all(
          replicas.map(({ store }) =>
            store.seedCatalog({
              entries: seedOf(profiles),
              repositoryIdsOf: () => [],
            }),
          ),
        );
        expect(results.flatMap((result) => result.seeded).sort()).toEqual(
          Object.keys(profiles).sort(),
        );
        expect(
          results.filter((result) => result.seeded.length > 0),
        ).toHaveLength(1);
      } finally {
        await Promise.all(replicas.map(({ pool: p }) => p.end()));
      }
    });
  }, 60_000);

  test("imported rows from before the move get the document's allowance once", async () => {
    await emptyDatabase(async (fresh) => {
      const [entry] = catalogImports({ old: definition() });
      if (!entry) throw new Error("no entry");
      await fresh.insert(installationProfiles).values({
        id: entry.id,
        name: null,
        version: 1,
        origin: "catalog",
        definition: entry.definition as Record<string, unknown>,
        permissionMode: entry.permission_mode,
        fingerprint: entry.fingerprint,
        repositoryIds: null,
      });
      const store = createPostgresInstallationProfileStore(fresh);
      const first = await store.seedCatalog({
        entries: seedOf({ other: definition() }),
        repositoryIdsOf: (id) => (id === "old" ? ["app"] : ["wrong"]),
      });
      const afterFirst = await allRows(fresh);
      const second = await store.seedCatalog({
        entries: seedOf({ other: definition() }),
        repositoryIdsOf: () => ["changed-since"],
      });
      expect(first).toEqual({ seeded: [], migrated: ["old"] });
      expect(second).toEqual({ seeded: [], migrated: [] });
      expect(afterFirst.map((row) => [row.id, row.repositoryIds])).toEqual([
        ["old", ["app"]],
      ]);
      expect(await allRows(fresh)).toEqual(afterFirst);
    });
  }, 60_000);

  test("the table refuses rows outside the contract", async () => {
    const made = definition();
    const valid = {
      id: `bad-${ids()}`,
      name: null as string | null,
      version: 1,
      origin: "catalog",
      definition: made,
      permissionMode: "default",
      fingerprint: "sha256:x",
      repositoryIds: [] as string[] | null,
    };
    const refused = async (
      values: Partial<typeof valid>,
      constraint: string,
    ) => {
      const error = await db
        .insert(installationProfiles)
        .values({ ...valid, id: `bad-${ids()}`, ...values })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(findPgError(error, "23514")?.constraint).toBe(constraint);
    };
    await refused({ id: "ws_acme_x_v1" }, "installation_profiles_id_check");
    await refused({ name: "named" }, "installation_profiles_name_check");
    await refused(
      { origin: "yaml", name: "named" },
      "installation_profiles_origin_check",
    );
    await refused({ version: 0 }, "installation_profiles_version_check");
    await refused(
      { origin: "console", name: `nulls${ids()}`, repositoryIds: null },
      "installation_profiles_repository_ids_check",
    );
    await refused(
      { blockedAt: new Date() } as Partial<typeof valid>,
      "installation_profiles_blocked_check",
    );
    await refused(
      { permissionMode: "bypassPermissions" },
      "installation_profiles_definition_mode_check",
    );
    const console = {
      ...valid,
      origin: "console",
      name: `wide${ids()}`,
    };
    await db
      .insert(installationProfiles)
      .values({ ...console, id: `op_${console.name}_v1` });
    const duplicate = await db
      .insert(installationProfiles)
      .values({ ...console, id: `op_${console.name}_again` })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(findPgError(duplicate, "23505")?.constraint).toBe(
      "installation_profiles_console_version_key",
    );
  });

  async function imported(id: string) {
    const [entry] = catalogImports({ [id]: definition() });
    if (!entry) throw new Error("no entry");
    await db.insert(installationProfiles).values({
      id,
      name: null,
      version: 1,
      origin: "catalog",
      definition: entry.definition as Record<string, unknown>,
      permissionMode: entry.permission_mode,
      fingerprint: entry.fingerprint,
      repositoryIds: ["app"],
    });
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
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
    return { principal, workspaceId, userId } satisfies TeamActor;
  }

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `acme-${ids()}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  function save(
    actor: TeamActor,
    name: string,
    previousId: string | null,
    tools: string[] = ["Read"],
    scope: CreateInstallationProfileInput["scope"] = { kind: "installation" },
  ): CreateInstallationProfileInput {
    const made = definition({ permission_mode: "acceptEdits", tools });
    const [entry] = catalogImports({ x: made });
    if (!entry) throw new Error("no entry");
    return {
      actor,
      receiptId: randomUUID(),
      name,
      scope,
      previousId,
      definition: made,
      permission_mode: "acceptEdits",
      fingerprint: entry.fingerprint,
      deny: null,
      toolCatalogId: null,
      connectionId: "main",
    };
  }

  test("an owner saves versions in order, each naming the one before, with a receipt", async () => {
    const owner = await person(await workspace(), "owner");
    const store = createPostgresInstallationProfileStore(db);
    const name = `coding${ids()}`;
    const v1 = await store.create(save(owner, name, null));
    expect(v1).toMatchObject({
      outcome: "created",
      record: {
        id: `op_${name}_v1`,
        version: 1,
        origin: "console",
        previous_id: null,
        created_by: owner.userId,
        repository_ids: null,
        permission_mode: "acceptEdits",
      },
    });
    expect(await store.create(save(owner, name, null))).toEqual({
      outcome: "name_taken",
    });
    const input = save(owner, name, `op_${name}_v1`, ["Read", "Edit"]);
    const v2 = await store.create(input);
    expect(v2.outcome === "created" && v2.record.previous_id).toBe(
      `op_${name}_v1`,
    );
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, input.receiptId));
    expect(receipt).toMatchObject({
      ownerId: owner.workspaceId,
      operation: "create_installation_profile",
      status: "succeeded",
      result: {
        profile_id: `op_${name}_v2`,
        version: 2,
        previous_id: `op_${name}_v1`,
        connection_id: "main",
      },
    });
  });

  test("a deny-made version keeps its deny and catalog id beside the definition, and names them in its receipt", async () => {
    const owner = await person(await workspace(), "owner");
    const store = createPostgresInstallationProfileStore(db);
    const name = `deny${ids()}`;
    const input = {
      ...save(owner, name, null),
      deny: ["Bash"],
      toolCatalogId: "claude_agent_sdk@0.3.270+claude-code@2.1.270",
      previousDenyDrift: true,
    };
    const made = await store.create(input);
    expect(made).toMatchObject({
      outcome: "created",
      record: {
        deny: ["Bash"],
        tool_catalog_id: "claude_agent_sdk@0.3.270+claude-code@2.1.270",
      },
    });
    const listed = (await store.listAll()).find(
      (row) => row.id === `op_${name}_v1`,
    );
    expect(listed?.deny).toEqual(["Bash"]);
    expect(Object.keys(listed?.definition as object)).not.toContain("deny");
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, input.receiptId));
    expect(receipt?.result).toMatchObject({
      deny: ["Bash"],
      tool_catalog_id: "claude_agent_sdk@0.3.270+claude-code@2.1.270",
      previous_deny_drift: true,
    });
    const listedOnly = await store.create(
      save(owner, name, `op_${name}_v1`, ["Read", "Edit"]),
    );
    expect(listedOnly).toMatchObject({
      outcome: "created",
      record: { deny: null, tool_catalog_id: null },
    });
  });

  test("a new row names no repository: no definition key, three NULL columns, and nothing inherited from the version before", async () => {
    const owner = await person(await workspace(), "owner");
    const store = createPostgresInstallationProfileStore(db);
    const name = `norepo${ids()}`;
    await store.create(save(owner, name, null));
    // An older row that does hold values, as the rows written before U2 do.
    await db
      .update(installationProfiles)
      .set({
        repositoryIds: ["app"],
        githubAppRepositories: "installed",
        repositoryScope: "profile",
      })
      .where(eq(installationProfiles.id, `op_${name}_v1`));
    const second = save(owner, name, `op_${name}_v1`, ["Read", "Edit"]);
    await store.create(second);
    const [held] = await db
      .select()
      .from(installationProfiles)
      .where(eq(installationProfiles.id, `op_${name}_v2`));
    expect(held).toMatchObject({
      repositoryIds: null,
      githubAppRepositories: null,
      repositoryScope: null,
    });
    expect(Object.keys(held?.definition ?? {})).not.toContain("repository");
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, second.receiptId));
    expect(Object.keys(receipt?.result as object)).not.toContain(
      "repository_ids",
    );
  });

  test("a save that runs the same writes nothing and leaves the latest row alone; a retired or blocked latest takes a new version", async () => {
    const owner = await person(await workspace(), "owner");
    const store = createPostgresInstallationProfileStore(db);
    const name = `same${ids()}`;
    await store.create(save(owner, name, null));
    const before = await rowsOf(`op_${name}`);
    const again = save(owner, name, `op_${name}_v1`);
    const unchanged = await store.create(again);
    expect(unchanged).toMatchObject({
      outcome: "unchanged",
      record: { id: `op_${name}_v1`, version: 1 },
    });
    expect(await rowsOf(`op_${name}`)).toEqual(before);
    const written = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, again.receiptId));
    expect(written).toEqual([]);
    // Another spelling of the same form (the models in another order) too.
    const reordered = save(owner, name, `op_${name}_v1`);
    reordered.definition = {
      ...(reordered.definition as object),
      models: ["claude-haiku", "claude-sonnet"],
    };
    expect((await store.create(reordered)).outcome).toBe("unchanged");
    // A new profile under a name that has versions does not slip through as unchanged.
    expect((await store.create(save(owner, name, null))).outcome).toBe(
      "name_taken",
    );
    // Set by hand: the retire and block writes have receipts that other
    // tests in this file count.
    await db
      .update(installationProfiles)
      .set({ retiredAt: new Date(), retiredBy: owner.userId })
      .where(eq(installationProfiles.id, `op_${name}_v1`));
    const revived = await store.create(save(owner, name, `op_${name}_v1`));
    expect(revived).toMatchObject({
      outcome: "created",
      record: { id: `op_${name}_v2` },
    });
    await db
      .update(installationProfiles)
      .set({ blockedAt: new Date(), blockedBy: owner.userId })
      .where(eq(installationProfiles.id, `op_${name}_v2`));
    expect(
      (await store.create(save(owner, name, `op_${name}_v2`))).outcome,
    ).toBe("created");
  });

  test("an admin's profile is a wl_ lineage of one workspace, shown by its display name, and its versions keep the key", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const store = createPostgresInstallationProfileStore(db);
    const source = `src${ids()}`;
    await store.create(save(owner, source, null));
    const narrow = (previousId: string | null, tools: string[]) =>
      save(admin, `Mine ${source}`, previousId, tools, {
        kind: "workspace",
        workspaceId,
        derivedFrom: `op_${source}_v1`,
      });
    const v1 = await store.create(narrow(null, ["Read"]));
    expect(v1).toMatchObject({
      outcome: "created",
      record: {
        version: 1,
        workspace_id: workspaceId,
        display_name: `Mine ${source}`,
        derived_from: `op_${source}_v1`,
        repository_ids: null,
      },
    });
    if (v1.outcome !== "created") throw new Error("not created");
    expect(v1.record.name).toMatch(/^wl_[0-9a-f-]{36}$/);
    expect(v1.record.id).toBe(`op_${v1.record.name}_v1`);
    const v2 = await store.create(narrow(v1.record.id, ["Read", "Edit"]));
    expect(v2).toMatchObject({
      outcome: "created",
      record: {
        name: v1.record.name,
        version: 2,
        derived_from: `op_${source}_v1`,
        workspace_id: workspaceId,
      },
    });
    expect(await store.create(narrow(null, ["Read"]))).toMatchObject({
      outcome: "name_taken",
    });
    // A new lineage cannot take a name the workspace already sees.
    expect(
      await store.create({ ...narrow(null, ["Read"]), name: source }),
    ).toEqual({ outcome: "name_taken" });
    // An owner's installation-wide name cannot take a workspace's display name.
    expect(await store.create(save(owner, `Mine ${source}`, null))).toEqual({
      outcome: "name_taken",
    });
  });

  test("an admin writes only its own workspace, and sees nothing of another's versions", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const admin = await person(mine, "admin");
    const other = await person(theirs, "admin");
    const owner = await person(theirs, "owner");
    const store = createPostgresInstallationProfileStore(db);
    const source = `iso${ids()}`;
    await store.create(save(owner, source, null));
    const foreign = await store.create(
      save(other, `Theirs ${source}`, null, ["Read"], {
        kind: "workspace",
        workspaceId: theirs,
        derivedFrom: `op_${source}_v1`,
      }),
    );
    if (foreign.outcome !== "created") throw new Error("not created");
    const scoped = (derivedFrom: string, name: string) =>
      save(admin, name, null, ["Read"], {
        kind: "workspace",
        workspaceId: mine,
        derivedFrom,
      });
    // Another workspace's version is unknown, not forbidden or taken.
    expect(await store.create(scoped(foreign.record.id, "Any"))).toEqual({
      outcome: "unknown_previous",
    });
    // The same display name in another workspace is free.
    expect(
      (await store.create(scoped(`op_${source}_v1`, `Theirs ${source}`)))
        .outcome,
    ).toBe("created");
    // An admin names neither another workspace's scope nor an installation-wide one.
    expect(
      await store.create(
        save(admin, "Wide", null, ["Read"], {
          kind: "workspace",
          workspaceId: theirs,
          derivedFrom: `op_${source}_v1`,
        }),
      ),
    ).toEqual({ outcome: "actor_inactive" });
    expect(await store.create(save(admin, "Wide", null))).toEqual({
      outcome: "actor_inactive",
    });
  });

  test("a first version replaces an existing row or nothing, and never takes an imported id", async () => {
    const owner = await person(await workspace(), "owner");
    const store = createPostgresInstallationProfileStore(db);
    const taken = `op_taken${ids()}_v1`;
    await imported(taken);
    expect(await store.create(save(owner, taken.slice(3, -3), null))).toEqual({
      outcome: "id_taken",
      id: taken,
    });
    expect(await store.create(save(owner, `fresh${ids()}`, "nowhere"))).toEqual(
      { outcome: "unknown_previous" },
    );
    const replacing = await store.create(save(owner, `fresh${ids()}`, taken));
    expect(
      replacing.outcome === "created" && replacing.record.previous_id,
    ).toBe(taken);
  });

  test("only a live owner writes: an admin, or an owner since removed, is actor_inactive", async () => {
    const workspaceId = await workspace();
    const admin = await person(workspaceId, "admin");
    const owner = await person(workspaceId, "owner");
    const store = createPostgresInstallationProfileStore(db);
    const name = `guarded${ids()}`;
    expect(await store.create(save(admin, name, null))).toEqual({
      outcome: "actor_inactive",
    });
    await db.delete(memberships).where(eq(memberships.userId, owner.userId));
    expect(await store.create(save(owner, name, null))).toEqual({
      outcome: "actor_inactive",
    });
    expect(await rowsOf(`op_${name}`)).toEqual([]);
  });

  test("two owners saving the same name at once get v1 and one conflict", async () => {
    const workspaceId = await workspace();
    const [a, b] = await Promise.all([
      person(workspaceId, "owner"),
      person(workspaceId, "owner"),
    ]);
    const store = createPostgresInstallationProfileStore(db);
    const name = `race${ids()}`;
    const results = await Promise.all(
      [a, b].map((actor) => store.create(save(actor, name, null))),
    );
    expect(results.map((r) => r.outcome).sort()).toEqual([
      "created",
      "name_taken",
    ]);
    expect((await rowsOf(`op_${name}`)).map((row) => row.id)).toEqual([
      `op_${name}_v1`,
    ]);
  });

  test("retiring sets retired_at once with one receipt", async () => {
    const owner = await person(await workspace(), "owner");
    const store = createPostgresInstallationProfileStore(db);
    const id = `retire-${ids()}`;
    await imported(id);
    const input = { actor: owner, receiptId: randomUUID(), profileId: id };
    const first = await store.retire(input);
    expect(first).toMatchObject({
      outcome: "retired",
      record: { id, retired_by: owner.userId },
    });
    const again = await store.retire({ ...input, receiptId: randomUUID() });
    expect(again.outcome).toBe("unchanged");
    expect(
      await store.retire({ ...input, receiptId: randomUUID(), profileId: "x" }),
    ).toEqual({ outcome: "not_found" });
    const written = await db
      .select({ operation: receipts.operation })
      .from(receipts)
      .where(eq(receipts.operation, "retire_installation_profile"));
    expect(written).toHaveLength(1);
  });

  test("a block beside a write that holds the settings generation and goes on to the blocked row", async () => {
    const owner = await person(await workspace(), "owner");
    const store = createPostgresInstallationProfileStore(db);
    const first = `gen-a-${ids()}`;
    const second = `gen-b-${ids()}`;
    await imported(first);
    await imported(second);
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN");
      // As seeding several ceilings: one written, the generation held.
      await writer.query(
        "UPDATE installation_profiles SET version = version WHERE id = $1",
        [first],
      );
      const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      const blocking = store.setBlocked({
        actor: owner,
        receiptId: randomUUID(),
        profileId: second,
        blocked: true,
      });
      for (let waited = 0; ; waited += 1) {
        const { rows } = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> $1",
          [writerPid],
        );
        if (rows.length > 0) break;
        if (waited > 200) throw new Error("the block never waited");
        await Bun.sleep(10);
      }
      await writer.query(
        "UPDATE installation_profiles SET version = version WHERE id = $1",
        [second],
      );
      await writer.query("COMMIT");
      expect((await blocking).outcome).toBe("changed");
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      writer.release();
    }
  });

  test("blocking and unblocking each write one receipt, and only a live owner does it", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const store = createPostgresInstallationProfileStore(db);
    const id = `block-${ids()}`;
    await imported(id);
    const input = (blocked: boolean, actor = owner) => ({
      actor,
      receiptId: randomUUID(),
      profileId: id,
      blocked,
    });
    expect(await store.setBlocked(input(true, admin))).toEqual({
      outcome: "actor_inactive",
    });
    const blocking = input(true);
    expect(await store.setBlocked(blocking)).toMatchObject({
      outcome: "changed",
      record: { id, blocked_by: owner.userId },
    });
    expect((await store.setBlocked(input(true))).outcome).toBe("unchanged");
    const unblocking = input(false);
    expect(await store.setBlocked(unblocking)).toMatchObject({
      outcome: "changed",
      record: { id, blocked_by: null, blocked_at: null },
    });
    expect((await store.setBlocked(input(false))).outcome).toBe("unchanged");
    expect(
      await store.setBlocked({ ...input(true), profileId: "nowhere" }),
    ).toEqual({ outcome: "not_found" });
    const written = await db
      .select({ id: receipts.id, operation: receipts.operation })
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId));
    expect(written.map((row) => row.operation).sort()).toEqual([
      "block_installation_profile",
      "unblock_installation_profile",
    ]);
    expect(written.map((row) => row.id).sort()).toEqual(
      [blocking.receiptId, unblocking.receiptId].sort(),
    );
  });
});
