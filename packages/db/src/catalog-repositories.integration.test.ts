import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentGitHubStore } from "./agent-github.ts";
import { createPostgresCatalogRepositoryStore } from "./catalog-repositories.ts";
import * as schema from "./schema.ts";
import {
  agentAdmins,
  agentReleases,
  agents,
  agentVersions,
  catalogRepositories,
  memberships,
  receipts,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { TEST_CONNECTION_ID, releaseSpecColumns } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("catalog repositories on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "catalog_repos_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function person(workspaceId: string, role: WorkspaceRole | null) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: `${role ?? "outside"} person`,
    });
    if (role !== null) {
      await db.insert(memberships).values({ workspaceId, userId, role });
    }
    return {
      workspaceId,
      userId,
      actor: {
        principal: { kind: "user" as const, id: userId },
        actor_user_id: userId,
        agent_id: null,
      },
      requestId: null,
    };
  }

  const repo = (n: number) => ({
    githubRepositoryId: 1000 + n,
    owner: "Acme",
    name: `App${n}`,
    url: `https://github.com/Acme/App${n}.git`,
    branch: "main",
  });

  test("resolves picks to one row each and renames a branch", async () => {
    const store = createPostgresCatalogRepositoryStore(db);
    expect(await store.readCatalog()).toBeNull();
    await db.insert(catalogRepositories).values({
      id: "seeded",
      owner: "acme",
      name: "seeded",
      url: "https://github.com/acme/seeded.git",
      branch: "trunk",
      source: "seed",
    });
    expect((await store.readCatalog())?.map((row) => row.id)).toEqual([
      "seeded",
    ]);

    const workspaceId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      name: "Acme",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: "picker",
      name: "Picker",
    });
    // Picked for that agent: the right to manage it is read again.
    const pick = { agentId, managerRoles: ["owner", "admin"] as const };
    const owner = { ...(await person(workspaceId, "owner")), ...pick };
    const member = { ...(await person(workspaceId, "member")), ...pick };
    const outsider = { ...(await person(workspaceId, null)), ...pick };

    expect(
      await store.resolve({
        ...outsider,
        receiptId: randomUUID(),
        base: "app1",
        ...repo(1),
      }),
    ).toEqual({ outcome: "actor_inactive" });

    // A member who does not administer the agent (any more) is refused.
    expect(
      await store.resolve({
        ...member,
        receiptId: randomUUID(),
        base: "app1",
        ...repo(1),
      }),
    ).toEqual({ outcome: "outranked" });
    await db.insert(agentAdmins).values({
      workspaceId,
      agentId,
      userId: member.userId,
    });

    // The agent's admin may resolve.
    const receiptId = randomUUID();
    const first = await store.resolve({
      ...member,
      receiptId,
      base: "app1",
      ...repo(1),
    });
    expect(first).toMatchObject({
      outcome: "resolved",
      created: true,
      repository: {
        id: "app1",
        github_repository_id: 1001,
        source: "selection",
        version: 1,
      },
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(receipt).toMatchObject({
      operation: "resolve_repository",
      ownerId: workspaceId,
      result: {
        repository_id: "app1",
        full_name: "Acme/App1",
        // The name a person reads and the id that outlives a rename.
        repository: "Acme/App1",
        github_repository_id: 1001,
        branch: "main",
      },
    });

    // The same GitHub repository, its name in another case, is the same
    // row, and leaves no receipt.
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "x",
        ...repo(1),
        owner: "acme",
        name: "app1",
      }),
    ).toMatchObject({
      outcome: "resolved",
      created: false,
      changed: false,
      repository: { id: "app1", github_repository_id: 1001, version: 1 },
    });
    // Another repository under that name never takes the row.
    const newcomer = { ...repo(9), name: "App1" };
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "app1",
        ...newcomer,
      }),
    ).toEqual({ outcome: "name_held", id: "app1" });
    // Picking the renamed one moves its row to the new name and URL, with a
    // receipt, which frees the old name.
    const renameReceipt = randomUUID();
    expect(
      await store.resolve({
        ...owner,
        receiptId: renameReceipt,
        base: "x",
        ...repo(1),
        name: "App1-old",
        url: "https://github.com/Acme/App1-old.git",
      }),
    ).toMatchObject({
      outcome: "resolved",
      created: false,
      changed: true,
      repository: {
        id: "app1",
        name: "App1-old",
        url: "https://github.com/Acme/App1-old.git",
        version: 2,
      },
    });
    const [renamed] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, renameReceipt));
    expect(renamed).toMatchObject({
      operation: "resolve_repository",
      result: {
        repository_id: "app1",
        full_name: "Acme/App1-old",
        repository: "Acme/App1-old",
        github_repository_id: 1001,
        previous_full_name: "Acme/App1",
      },
    });
    // A seeded row with no GitHub id under the name a picked row was renamed
    // to: neither row is taken for the other.
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "x",
        ...repo(1),
        name: "Seeded",
        owner: "acme",
        url: "https://github.com/acme/Seeded.git",
      }),
    ).toEqual({ outcome: "name_held", id: "seeded" });
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "app1",
        ...newcomer,
      }),
    ).toMatchObject({
      outcome: "resolved",
      created: true,
      repository: { id: "app1-2", github_repository_id: 1009 },
    });
    // A seeded row found by name gets its GitHub id filled in.
    expect(
      await store.resolve({
        ...owner,
        receiptId: randomUUID(),
        base: "seeded",
        githubRepositoryId: 5000,
        owner: "ACME",
        name: "Seeded",
        url: "https://github.com/ACME/Seeded.git",
        branch: "main",
      }),
    ).toMatchObject({
      outcome: "resolved",
      created: false,
      repository: { id: "seeded", github_repository_id: 5000, branch: "trunk" },
    });
    // Two first picks at once: one row, one receipt.
    const picks = await Promise.all(
      [0, 1, 2].map(() =>
        store.resolve({
          ...owner,
          receiptId: randomUUID(),
          base: "app3",
          ...repo(3),
        }),
      ),
    );
    expect(
      new Set(
        picks.map((pick) =>
          pick.outcome === "resolved" ? pick.repository.id : null,
        ),
      ),
    ).toEqual(new Set(["app3"]));
    expect(
      picks.filter((pick) => pick.outcome === "resolved" && pick.created),
    ).toHaveLength(1);

    expect(
      await store.setBranch({
        ...member,
        receiptId: randomUUID(),
        id: "app1",
        branch: "develop",
        version: 1,
      }),
    ).toEqual({ outcome: "actor_inactive" });
    expect(
      await store.setBranch({
        ...owner,
        receiptId: randomUUID(),
        id: "app1",
        branch: "develop",
        version: 1,
      }),
    ).toEqual({ outcome: "revision_conflict" });
    const branchReceipt = randomUUID();
    expect(
      await store.setBranch({
        ...owner,
        receiptId: branchReceipt,
        id: "app1",
        branch: "develop",
        version: 2,
      }),
    ).toMatchObject({
      outcome: "stored",
      repository: { branch: "develop", version: 3 },
    });
    const [branched] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, branchReceipt));
    expect(branched).toMatchObject({
      operation: "set_repository_branch",
      result: {
        repository: "Acme/App1-old",
        github_repository_id: 1001,
        branch: "develop",
      },
    });
    expect((await store.listActive()).map((row) => row.id)).toEqual([
      "app1",
      "app1-2",
      "app3",
      "seeded",
    ]);
    // No agent has an active release here.
    expect((await store.agentCounts()).size).toBe(0);
  });

  test("names a row the catalog removed, and leaves out an id no row held", async () => {
    await db.insert(catalogRepositories).values([
      {
        id: "names-live",
        owner: "Acme",
        name: "Live",
        url: "https://github.com/Acme/Live.git",
        branch: "main",
        source: "seed",
      },
      {
        id: "names-gone",
        owner: "Acme",
        name: "Gone",
        url: "https://github.com/Acme/Gone.git",
        branch: "main",
        source: "seed",
        removedAt: new Date(),
      },
    ]);
    const names = await createPostgresAgentGitHubStore(db).repositoryNames([
      "names-live",
      "names-gone",
      "names-never",
    ]);
    expect([...names.entries()].sort()).toEqual([
      ["names-gone", "Acme/Gone"],
      ["names-live", "Acme/Live"],
    ]);
    expect(
      (await createPostgresAgentGitHubStore(db).repositoryNames([])).size,
    ).toBe(0);
  });

  test("an agent can be given a console App row or one with an App of its own, never a PAT or removed one", async () => {
    const own = { source: "seed" as const, branch: "main" };
    await db.insert(catalogRepositories).values([
      {
        ...own,
        id: "choose-console",
        owner: "Acme",
        name: "Console",
        url: "https://github.com/Acme/Console.git",
      },
      {
        ...own,
        id: "choose-explicit",
        owner: "Acme",
        name: "Explicit",
        url: "https://ghe.example.invalid/Acme/Explicit.git",
        authKind: "github_app_explicit",
        auth: { kind: "github_app", app_id: 1, installation_id: 2 },
        credentialSource: "external",
      },
      {
        ...own,
        id: "choose-pat",
        owner: "Acme",
        name: "Pat",
        url: "https://github.com/Acme/Pat.git",
        authKind: "basic",
        auth: { kind: "basic", username: "u" },
        credentialSource: "external",
      },
      {
        ...own,
        id: "choose-removed",
        owner: "Acme",
        name: "Removed",
        url: "https://github.com/Acme/Removed.git",
        removedAt: new Date(),
      },
    ]);
    const store = createPostgresCatalogRepositoryStore(db);
    const ids = (rows: { id: string }[]) =>
      rows.map((row) => row.id).filter((id) => id.startsWith("choose-"));
    expect(ids(await store.listAgentChoosable())).toEqual([
      "choose-console",
      "choose-explicit",
    ]);
    // The console App's list leaves the explicit one out.
    expect(ids(await store.listActive())).toEqual(["choose-console"]);
  });

  test("counts agents by the repositories their active release names, reviewers apart", async () => {
    const store = createPostgresCatalogRepositoryStore(db);
    const workspaceId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      name: "Acme",
    });
    const agent = async (pins: unknown, repositoryId: string | null) => {
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        workspaceId,
        managingTeamId: await fixtureTeam(db, workspaceId),
        slug: `a-${agentId.slice(0, 8)}`,
        name: "Agent",
      });
      const versionId = randomUUID();
      await db.insert(agentVersions).values({
        id: versionId,
        agentId,
        versionNo: 1,
        card: {},
        contentSha256: "0".repeat(64),
      });
      const releaseId = `rel-${agentId}`;
      await db.insert(agentReleases).values({
        id: releaseId,
        agentId,
        versionId,
        cardSha256: "sha",
        connectionId: TEST_CONNECTION_ID,
        ...releaseSpecColumns(),
        runtimeConfigSnapshot: {},
        effectiveTools: [],
        policyPins: pins,
        repositoryId,
      });
      await db
        .update(agents)
        .set({ activeReleaseId: releaseId, activationRevision: 0 })
        .where(eq(agents.id, agentId));
    };
    await agent({ github: { repositories: ["count-a", "count-b"] } }, null);
    await agent(
      {
        github: { repositories: ["count-a"], features: { review: true } },
      },
      "count-a",
    );
    await agent({ github: { features: { review: false } } }, "count-c");

    const counts = await store.agentCounts();
    expect(counts.get("count-a")).toEqual({ author: 2, reviewer: 1 });
    expect(counts.get("count-b")).toEqual({ author: 1, reviewer: 0 });
    expect(counts.get("count-c")).toEqual({ author: 1, reviewer: 0 });
  });
});
