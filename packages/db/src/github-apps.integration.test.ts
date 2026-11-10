import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  type GitHubAppRole,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import {
  callerFor,
  type GitHubAppStore,
  MANAGEMENT_ROLES,
  type SecretAudit,
  SecretKey,
} from "@werft-ai/platform";
import { fakeGitHubClientSecret } from "@werft-ai/platform/testing/github";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresGitHubAppManifestStore } from "./github-app-manifest-states.ts";
import { createPostgresGitHubAppStore } from "./github-apps.ts";
import { createPostgresGitHubOAuthStore } from "./github-oauth.ts";
import { createPostgresGitHubPinStore } from "./github-pins.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  catalogRepositoryGitHubApps,
  githubApps,
  githubWorkspaceSettings,
  memberships,
  receipts,
  secretValues,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { TEST_CONNECTION_ID, releaseSpecColumns } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];

const pemOf = () =>
  generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString()
    .trim();

const profile = (appId: number) => ({
  appId,
  slug: `app-${appId}`,
  name: `App ${appId}`,
  htmlUrl: `https://github.com/apps/app-${appId}`,
  clientId: `Iv23li${appId}`,
  permissions: { contents: "write" as const, metadata: "read" as const },
  apiBase: "https://api.github.com",
});

const AUTHOR = { kind: "role", role: "author" } as const;
const REVIEWER = { kind: "role", role: "reviewer" } as const;
const add = (role: GitHubAppRole) => ({ kind: "add", role }) as const;
const byId = (id: string) => ({ kind: "connection", id }) as const;

async function findRole(
  store: GitHubAppStore,
  workspaceId: string,
  role: GitHubAppRole,
) {
  return (await store.ofRole(workspaceId, role))[0] ?? null;
}

integration("the GitHub App on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "github_apps_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function workspace() {
    const id = randomUUID();
    await db
      .insert(workspaces)
      .values({ id, slug: `ws-${id.slice(0, 8)}`, name: "Acme" });
    return id;
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: `${role} person`,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return (): SecretAudit => ({
      principal: callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role,
          scopes: [...scopesForRole(role)],
        },
        { kind: "web" },
        randomUUID(),
      ),
      receiptId: randomUUID(),
      roles: MANAGERS,
    });
  }

  async function stored(result: Awaited<ReturnType<GitHubAppStore["put"]>>) {
    if (result.outcome !== "stored") throw new Error(result.outcome);
    return result.app;
  }

  test("registers, replaces and removes the App with its key sealed, one receipt each", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const first = pemOf();
    expect(await findRole(store, ws, "author")).toBeNull();

    const set = owner();
    const made = await store.put(ws, AUTHOR, profile(11), first, set);
    expect(made).toMatchObject({
      outcome: "stored",
      app: {
        workspaceId: ws,
        appId: 11,
        slug: "app-11",
        privateKey: { updatedBy: { displayName: "owner person" } },
      },
      pinsCleared: 0,
      pinsRestored: 0,
    });
    const app = await stored(made);
    const [sealed] = await db
      .select()
      .from(secretValues)
      .where(eq(secretValues.ownerRef, `github_app:${app.id}`));
    expect(sealed?.purpose).toBe("github_app_private_key");
    expect(Buffer.from(sealed?.ciphertext ?? []).toString()).not.toContain(
      first.split("\n")[1] ?? "",
    );
    expect(await store.credentials("author")).toContainEqual(
      expect.objectContaining({ id: app.id, appId: 11, privateKey: first }),
    );

    const second = pemOf();
    const replaced = await store.put(ws, AUTHOR, profile(12), second, owner());
    expect(replaced).toMatchObject({
      outcome: "stored",
      app: { id: app.id, appId: 12 },
    });
    const held = (await store.credentials("author")).find(
      (each) => each.workspaceId === ws,
    );
    expect(held?.privateKey).toBe(second);
    expect(held?.updatedAt.getTime()).toBeGreaterThan(app.updatedAt.getTime());

    expect(await store.delete(ws, AUTHOR, owner())).toEqual({
      outcome: "deleted",
      appId: 12,
      usage: {
        pinned_repository_count: 0,
        agent_count: 0,
        active_session_count: 0,
        user_link: true,
      },
    });
    expect(await findRole(store, ws, "author")).toBeNull();
    expect(
      (await store.credentials("author")).some(
        (each) => each.workspaceId === ws,
      ),
    ).toBe(false);
    const leftover = await db
      .select()
      .from(secretValues)
      .where(eq(secretValues.ownerRef, `github_app:${app.id}`));
    expect(leftover).toEqual([]);
    expect(await store.delete(ws, AUTHOR, owner())).toEqual({
      outcome: "not_found",
    });

    const written = await db
      .select({
        operation: receipts.operation,
        result: receipts.result,
        status: receipts.status,
      })
      .from(receipts)
      .where(eq(receipts.ownerId, ws));
    expect(written).toEqual([
      {
        operation: "set_github_app",
        result: {
          app_id: 11,
          connection_id: app.id,
          role: "author",
          permissions: { contents: "write", metadata: "read" },
          warnings: [],
        },
        status: "succeeded",
      },
      {
        operation: "set_github_app",
        result: {
          app_id: 12,
          connection_id: app.id,
          role: "author",
          permissions: { contents: "write", metadata: "read" },
          warnings: [],
        },
        status: "succeeded",
      },
      {
        operation: "delete_github_app",
        result: {
          app_id: 12,
          connection_id: app.id,
          role: "author",
          pinned_repository_count: 0,
          agent_count: 0,
          active_session_count: 0,
          user_link: true,
        },
        status: "succeeded",
      },
    ]);
    for (const row of await db.select().from(receipts)) {
      expect(JSON.stringify(row)).not.toContain(first.split("\n")[1] ?? "");
    }
  });

  test("a member, or someone who left, changes nothing", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const member = await person(ws, "member");
    expect(await store.put(ws, AUTHOR, profile(21), pemOf(), member())).toEqual(
      { outcome: "outranked" },
    );
    const admin = await person(ws, "admin");
    const audit = admin();
    await db
      .delete(memberships)
      .where(eq(memberships.userId, audit.principal.actor?.userId ?? ""));
    expect(await store.put(ws, AUTHOR, profile(21), pemOf(), audit)).toEqual({
      outcome: "actor_inactive",
    });
    expect(
      await db.select().from(githubApps).where(eq(githubApps.workspaceId, ws)),
    ).toEqual([]);
  });

  test("two registrations by role at once leave one App", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const results = await Promise.all([
      store.put(ws, AUTHOR, profile(31), pemOf(), owner()),
      store.put(ws, AUTHOR, profile(32), pemOf(), owner()),
    ]);
    expect(results.map(({ outcome }) => outcome)).toEqual(["stored", "stored"]);
    const rows = await db
      .select()
      .from(githubApps)
      .where(eq(githubApps.workspaceId, ws));
    expect(rows).toHaveLength(1);
  });

  test("two Apps of one role are two connections; a role address then refuses, a connection id does not", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const a = await stored(
      await store.put(ws, AUTHOR, profile(101), pemOf(), owner()),
    );
    const b = await stored(
      await store.put(ws, add("author"), profile(102), pemOf(), owner()),
    );
    expect(b.id).not.toBe(a.id);
    expect(
      (await store.ofRole(ws.toUpperCase(), "author")).map((each) => each.id),
    ).toEqual([a.id, b.id]);
    expect(
      (await store.credentials("author", ws)).map((each) => each.appId),
    ).toEqual([101, 102]);

    expect(await store.put(ws, AUTHOR, profile(103), pemOf(), owner())).toEqual(
      { outcome: "ambiguous_role" },
    );
    expect(await store.delete(ws, AUTHOR, owner())).toEqual({
      outcome: "ambiguous_role",
    });
    expect(
      await store.put(ws, byId(b.id), profile(103), pemOf(), owner()),
    ).toEqual({ outcome: "app_id_mismatch" });
    const rotated = pemOf();
    const kept = await stored(
      await store.put(
        ws,
        byId(b.id.toUpperCase()),
        profile(102),
        rotated,
        owner(),
      ),
    );
    expect(kept.id).toBe(b.id);
    expect(
      (await store.credentials("author", ws)).find((each) => each.id === b.id)
        ?.privateKey,
    ).toBe(rotated);
    expect(
      await store.put(ws, byId(randomUUID()), profile(102), pemOf(), owner()),
    ).toEqual({ outcome: "not_found" });

    expect(
      await store.put(ws, add("reviewer"), profile(101), pemOf(), owner()),
    ).toEqual({ outcome: "same_app" });
    const duplicate = await db
      .insert(githubApps)
      .values({
        id: randomUUID(),
        workspaceId: ws,
        role: "reviewer",
        ...profile(101),
        permissionsCheckedAt: new Date(),
      })
      .then(
        () => null,
        (error: unknown) => error as { cause?: { constraint?: string } },
      );
    expect(duplicate?.cause?.constraint).toBe("github_apps_workspace_app_uniq");
    const unknownRole = pool.query(
      `INSERT INTO github_apps (id, workspace_id, role, app_id, slug, name, html_url, api_base)
       VALUES ($1, $2, 'admin', 54, 's', 'n', 'https://github.com/apps/s', 'https://api.github.com')`,
      [randomUUID(), ws],
    );
    await expect(unknownRole).rejects.toThrow(/github_apps_role_check/);

    expect((await store.delete(ws, byId(b.id), owner())).outcome).toBe(
      "deleted",
    );
    expect((await findRole(store, ws, "author"))?.id).toBe(a.id);
  });

  test("a reviewer App needs an author App first; the author's calls never reach the reviewer's row or key", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const reviewerKey = pemOf();
    expect(
      await store.put(ws, REVIEWER, profile(51), reviewerKey, owner()),
    ).toEqual({ outcome: "no_author_app" });
    expect(await findRole(store, ws, "reviewer")).toBeNull();

    const author = await stored(
      await store.put(ws, AUTHOR, profile(52), pemOf(), owner()),
    );
    expect(
      await store.put(ws, REVIEWER, profile(52), pemOf(), owner()),
    ).toEqual({ outcome: "same_app" });
    const reviewer = await stored(
      await store.put(ws, REVIEWER, profile(51), reviewerKey, owner()),
    );
    expect(await store.put(ws, AUTHOR, profile(51), pemOf(), owner())).toEqual({
      outcome: "same_app",
    });
    expect(
      (await store.list(ws.toUpperCase())).map((app) => [app.role, app.id]),
    ).toEqual([
      ["author", author.id],
      ["reviewer", reviewer.id],
    ]);
    expect(await store.list(await workspace())).toEqual([]);
    const replaced = await store.put(ws, AUTHOR, profile(55), pemOf(), owner());
    expect(replaced).toMatchObject({
      outcome: "stored",
      app: { id: author.id, appId: 55 },
    });
    await store.delete(ws, AUTHOR, owner());

    const [kept] = await store.credentials("reviewer", ws);
    expect(kept).toMatchObject({ id: reviewer.id, appId: 51 });
    expect(kept?.privateKey).toBe(reviewerKey);
    expect(await findRole(store, ws, "reviewer")).toMatchObject({
      id: reviewer.id,
      updatedAt: reviewer.updatedAt,
    });
  });

  test("one App put into both roles at once lands in one role only", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    await store.put(ws, AUTHOR, profile(61), pemOf(), owner());
    const outcomes = await Promise.all([
      store.put(ws, add("author"), profile(62), pemOf(), owner()),
      store.put(ws, REVIEWER, profile(62), pemOf(), owner()),
    ]);
    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual([
      "same_app",
      "stored",
    ]);
    const rows = await db
      .select({ role: githubApps.role, appId: githubApps.appId })
      .from(githubApps)
      .where(eq(githubApps.workspaceId, ws));
    expect(rows.filter((row) => row.appId === 62)).toHaveLength(1);
  });

  // The key read can land after a delete that committed past the row read.
  test("a row whose key is already gone reads as no App", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const app = await stored(
      await store.put(ws, AUTHOR, profile(41), pemOf(), owner()),
    );
    await db
      .delete(secretValues)
      .where(eq(secretValues.ownerRef, `github_app:${app.id}`));
    expect(await findRole(store, ws, "author")).toBeNull();
    expect(await store.get(ws, app.id)).toBeNull();
    expect(await store.list(ws)).toEqual([]);
  });

  test("user linking reads the author App's client id; a reviewer App or none gives no client", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const oauth = createPostgresGitHubOAuthStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    expect(await oauth.status(ws)).toEqual({
      authorApp: false,
      connectionId: null,
      clientId: null,
      clientSecretSet: false,
    });
    const author = await stored(
      await store.put(ws, AUTHOR, profile(62), pemOf(), owner()),
    );
    await store.put(ws, REVIEWER, profile(61), pemOf(), owner());
    expect(await oauth.status(ws.toUpperCase())).toEqual({
      authorApp: true,
      connectionId: author.id,
      clientId: "Iv23li62",
      clientSecretSet: false,
    });
    // No secret is set, so there is no client to link with yet.
    expect(await oauth.client(ws)).toBeNull();
    expect(
      await createPostgresGitHubOAuthStore(db, null).client(ws),
    ).toBeNull();
  });

  test("a read of the App a replacement took out does not land on the new one", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const oauth = createPostgresGitHubOAuthStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const first = await stored(
      await store.put(ws, AUTHOR, profile(71), pemOf(), owner()),
    );
    const second = await stored(
      await store.put(ws, AUTHOR, profile(72), pemOf(), owner()),
    );
    expect(second.id).toBe(first.id);

    const read = { contents: "read" as const, metadata: "read" as const };
    await store.recordPermissions(first.id, 71, read, "Iv23listale");
    expect((await oauth.status(ws)).clientId).toBe("Iv23li72");
    expect((await findRole(store, ws, "author"))?.permissions).toEqual(
      profile(72).permissions,
    );

    await store.recordPermissions(first.id, 72, read, "Iv23linew");
    expect((await oauth.status(ws)).clientId).toBe("Iv23linew");
    expect((await findRole(store, ws, "author"))?.permissions).toEqual(read);
  });

  test("a client secret is sealed under the author App, kept across a new key, dropped with another App", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const oauth = createPostgresGitHubOAuthStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const app = await stored(
      await store.put(ws, AUTHOR, profile(91), pemOf(), owner()),
    );
    const typed = fakeGitHubClientSecret();
    const audit = owner();
    expect(await oauth.putClientSecret(ws, typed, audit, "Iv23li91")).toEqual({
      outcome: "stored",
    });
    expect((await oauth.status(ws)).clientSecretSet).toBe(true);
    const client = await oauth.client(ws);
    expect(client?.clientId).toBe("Iv23li91");
    expect(client?.connectionId).toBe(app.id);
    expect(client?.clientSecret === typed).toBe(true);

    const sealed = await db
      .select()
      .from(secretValues)
      .where(eq(secretValues.workspaceId, ws));
    expect(sealed.length > 0).toBe(true);
    expect(JSON.stringify(sealed).includes(typed)).toBe(false);
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, audit.receiptId));
    const result = receipt?.result as { purpose?: string; last4?: string };
    expect(result.purpose).toBe("oauth_client_secret");
    expect(result.last4?.length === 4 && typed.endsWith(result.last4)).toBe(
      true,
    );
    expect(JSON.stringify(receipt).includes(typed)).toBe(false);

    await store.put(ws, AUTHOR, profile(91), pemOf(), owner());
    expect((await oauth.client(ws))?.clientSecret === typed).toBe(true);

    await store.put(ws, AUTHOR, profile(92), pemOf(), owner());
    expect(await oauth.status(ws)).toEqual({
      authorApp: true,
      connectionId: app.id,
      clientId: "Iv23li92",
      clientSecretSet: false,
    });
    // A boolean: a client left behind would print its secret.
    expect((await oauth.client(ws)) === null).toBe(true);
  });

  test("a client secret typed for an App a replacement took out is refused, nothing stored", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const oauth = createPostgresGitHubOAuthStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    await store.put(ws, AUTHOR, profile(81), pemOf(), owner());
    await store.put(ws, AUTHOR, profile(82), pemOf(), owner());
    const audit = owner();
    // Refused under the lock before the value is sealed, so none is needed.
    expect(await oauth.putClientSecret(ws, "", audit, "Iv23li81")).toEqual({
      outcome: "client_changed",
    });
    expect((await oauth.status(ws)).clientSecretSet).toBe(false);
    expect(
      await db.select().from(receipts).where(eq(receipts.id, audit.receiptId)),
    ).toEqual([]);
  });

  test("people link with the first author connection until another is chosen; its secret stays its own", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const oauth = createPostgresGitHubOAuthStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const a = await stored(
      await store.put(ws, AUTHOR, profile(111), pemOf(), owner()),
    );
    await oauth.putClientSecret(
      ws,
      fakeGitHubClientSecret(),
      owner(),
      "Iv23li111",
    );
    const b = await stored(
      await store.put(ws, add("author"), profile(112), pemOf(), owner()),
    );
    const reviewer = await stored(
      await store.put(ws, REVIEWER, profile(113), pemOf(), owner()),
    );
    expect(await oauth.status(ws)).toEqual({
      authorApp: true,
      connectionId: a.id,
      clientId: "Iv23li111",
      clientSecretSet: true,
    });
    expect(await store.usage(ws, a.id)).toMatchObject({ user_link: true });
    expect(await store.usage(ws, b.id)).toMatchObject({ user_link: false });

    expect(await store.delete(ws, byId(a.id), owner())).toEqual({
      outcome: "in_use_for_user_link",
    });
    expect(await store.setUserLink(ws, reviewer.id, owner())).toEqual({
      outcome: "role_mismatch",
    });
    expect(await store.setUserLink(ws, randomUUID(), owner())).toEqual({
      outcome: "not_found",
    });
    const moved = owner();
    expect(await store.setUserLink(ws, b.id.toUpperCase(), moved)).toEqual({
      outcome: "stored",
      before: a.id,
      changed: true,
    });
    expect(await oauth.status(ws)).toEqual({
      authorApp: true,
      connectionId: b.id,
      clientId: "Iv23li112",
      clientSecretSet: false,
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, audit(moved)));
    expect(receipt?.result).toMatchObject({
      purpose: "user_link",
      before: a.id,
      after: b.id,
    });
    const again = owner();
    expect(await store.setUserLink(ws, b.id, again)).toEqual({
      outcome: "stored",
      before: b.id,
      changed: false,
    });
    expect(
      await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, audit(again))),
    ).toEqual([]);

    expect((await store.delete(ws, byId(a.id), owner())).outcome).toBe(
      "deleted",
    );
    expect(await store.delete(ws, byId(b.id), owner())).toMatchObject({
      outcome: "deleted",
      usage: { user_link: true },
    });
    expect(await oauth.status(ws)).toMatchObject({
      authorApp: false,
      connectionId: null,
    });
    const [settings] = await db
      .select({ chosen: githubWorkspaceSettings.userLinkConnectionId })
      .from(githubWorkspaceSettings)
      .where(eq(githubWorkspaceSettings.workspaceId, ws));
    expect(settings?.chosen).toBeNull();
  });

  test("pins: the usage counts them, removal empties them, the same App added back fills them, another App by role clears them", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const pins = createPostgresGitHubPinStore(db);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const a = await stored(
      await store.put(ws, AUTHOR, profile(121), pemOf(), owner()),
    );
    const b = await stored(
      await store.put(ws, add("author"), profile(122), pemOf(), owner()),
    );
    const repo = (name: string) => `${name}-${ws.slice(0, 8)}`;
    for (const name of ["one", "two"]) {
      expect(
        await pins.pinFirst({
          repositoryId: repo(name),
          role: "author",
          connectionId: b.id,
          appId: 122,
          pinnedBy: "first_mint",
        }),
      ).toMatchObject({ created: true, pin: { connectionId: b.id } });
    }
    const held = await pins.pinFirst({
      repositoryId: repo("one"),
      role: "author",
      connectionId: a.id,
      appId: 121,
      pinnedBy: "selection",
      audit: {
        ownerId: ws,
        actor: {
          principal: { kind: "user", id: randomUUID() },
          actor_user_id: null,
          agent_id: null,
        },
        receiptId: randomUUID(),
      },
    });
    expect(held).toMatchObject({ created: false, pin: { connectionId: b.id } });
    // Read as App 120 before a replacement made it 121: no pin is left.
    expect(
      await pins.pinFirst({
        repositoryId: repo("stale"),
        role: "author",
        connectionId: a.id,
        appId: 120,
        pinnedBy: "first_mint",
      }),
    ).toEqual({ pin: null, created: false });
    expect(
      await pins.pinFirst({
        repositoryId: repo("stale"),
        role: "reviewer",
        connectionId: a.id,
        appId: 121,
        pinnedBy: "first_mint",
      }),
    ).toEqual({ pin: null, created: false });
    expect(await pins.get(repo("stale"), "author")).toBeNull();

    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId: ws,
      managingTeamId: await fixtureTeam(db, ws),
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
    await db.insert(agentReleases).values({
      id: `rel-${agentId}`,
      agentId,
      versionId,
      cardSha256: "sha",
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: [],
      policyPins: { github: { repositories: [repo("two")] } },
      repositoryId: repo("two"),
    });
    await db
      .update(agents)
      .set({
        activeReleaseId: `rel-${agentId}`,
        activationRevision: 0,
        githubEnabled: true,
      })
      .where(eq(agents.id, agentId));
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repository_id, status, profile_id, repo_url, branch)
       VALUES ($1, $2, $3, 'running', 'coding', 'https://example.invalid/r.git', 'main')`,
      [randomUUID(), ws, repo("one")],
    );
    expect(await store.usage(ws, b.id)).toEqual({
      pinned_repository_count: 2,
      agent_count: 1,
      active_session_count: 1,
      user_link: false,
    });
    expect(await store.usage(ws, a.id)).toMatchObject({
      pinned_repository_count: 0,
    });
    expect(await store.usage(await workspace(), b.id)).toBeNull();

    expect(await store.delete(ws, byId(b.id), owner())).toMatchObject({
      outcome: "deleted",
      usage: { pinned_repository_count: 2, agent_count: 1 },
    });
    expect(await pins.get(repo("one"), "author")).toEqual({
      repositoryId: repo("one"),
      role: "author",
      connectionId: null,
      appId: 122,
      pinnedBy: "first_mint",
    });
    const actor = {
      principal: { kind: "user" as const, id: randomUUID() },
      actor_user_id: null,
      agent_id: null,
    };
    expect(
      await pins.set({
        workspaceId: ws,
        repositoryId: repo("one"),
        role: "reviewer",
        connectionId: a.id,
        actor,
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "role_mismatch" });
    expect(
      await pins.set({
        workspaceId: await workspace(),
        repositoryId: repo("one"),
        role: "author",
        connectionId: a.id,
        actor,
        receiptId: randomUUID(),
      }),
    ).toEqual({ outcome: "not_found" });
    const pinReceipt = randomUUID();
    expect(
      await pins.set({
        workspaceId: ws,
        repositoryId: repo("one"),
        role: "author",
        connectionId: a.id,
        actor,
        receiptId: pinReceipt,
      }),
    ).toEqual({ outcome: "stored", before: null, changed: true });
    const [written] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, pinReceipt));
    expect(written).toMatchObject({
      operation: "set_repository_github_app",
      result: {
        repository_id: repo("one"),
        role: "author",
        pinned_by: "admin",
        before: null,
        after: a.id,
      },
    });

    const back = await store.put(
      ws,
      add("author"),
      profile(122),
      pemOf(),
      owner(),
    );
    expect(back).toMatchObject({ outcome: "stored", pinsRestored: 1 });
    const c = await stored(back);
    expect((await pins.get(repo("two"), "author"))?.connectionId).toBe(c.id);
    expect((await pins.get(repo("one"), "author"))?.connectionId).toBe(a.id);

    await store.delete(ws, byId(c.id), owner());
    const replaced = await store.put(
      ws,
      AUTHOR,
      profile(123),
      pemOf(),
      owner(),
    );
    expect(replaced).toMatchObject({ outcome: "stored", pinsCleared: 1 });
    expect(await pins.get(repo("one"), "author")).toBeNull();
    const setReceipts = await db
      .select({ result: receipts.result })
      .from(receipts)
      .where(
        and(eq(receipts.ownerId, ws), eq(receipts.operation, "set_github_app")),
      )
      .orderBy(receipts.createdAt);
    expect(setReceipts.at(-1)?.result).toMatchObject({
      app_id: 123,
      pins_cleared: 1,
    });
    const pinRows = await db
      .select()
      .from(catalogRepositoryGitHubApps)
      .where(eq(catalogRepositoryGitHubApps.repositoryId, repo("two")));
    expect(pinRows).toHaveLength(1);
    expect(pinRows[0]?.connectionId).toBeNull();
    expect(
      await db.select().from(sessions).where(eq(sessions.ownerId, ws)),
    ).toHaveLength(1);
  });

  test("an App from a manifest is another author connection; its client secret is kept only when it links", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const oauth = createPostgresGitHubOAuthStore(db, key);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const secret = fakeGitHubClientSecret();
    const audit = owner();
    const made = await stored(
      await store.put(ws, add("author"), profile(131), pemOf(), audit, {
        clientSecret: secret,
        owner: "acme",
        public: false,
      }),
    );
    const client = await oauth.client(ws);
    expect(client?.clientId).toBe("Iv23li131");
    expect(client?.connectionId).toBe(made.id);
    expect(client?.clientSecret === secret).toBe(true);
    const written = await db
      .select()
      .from(receipts)
      .where(eq(receipts.ownerId, ws));
    expect(written.map((receipt) => receipt.operation)).toEqual([
      "set_github_app",
    ]);
    expect(written[0]?.result).toMatchObject({
      app_id: 131,
      connection_id: made.id,
      role: "author",
      source: "manifest",
      owner: "acme",
      public: false,
    });
    expect(JSON.stringify(written).includes(secret)).toBe(false);

    const second = fakeGitHubClientSecret();
    const next = await stored(
      await store.put(ws, add("author"), profile(132), pemOf(), owner(), {
        clientSecret: second,
        owner: "acme",
        public: true,
      }),
    );
    expect((await store.ofRole(ws, "author")).map((each) => each.id)).toEqual([
      made.id,
      next.id,
    ]);
    expect((await oauth.client(ws))?.clientSecret === secret).toBe(true);
    const sealed = await db
      .select()
      .from(secretValues)
      .where(eq(secretValues.ownerRef, `github_app:${next.id}`));
    expect(sealed.map((row) => row.purpose)).toEqual([
      "github_app_private_key",
    ]);
  });

  test("a manifest state is spent by the first read; expired ones go at the next start", async () => {
    const states = createPostgresGitHubAppManifestStore(db);
    const ws = await workspace();
    const state = {
      workspaceId: ws,
      actorUserId: randomUUID(),
      role: "author" as const,
      ownerLogin: "acme",
      public: false,
      replacesAppId: 7,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const hash = randomBytes(32);
    await states.issueState(hash, state, new Date());
    const [first, second] = await Promise.all([
      states.consumeState(hash),
      states.consumeState(hash),
    ]);
    expect([first, second].filter((read) => read !== null)).toEqual([state]);

    const old = randomBytes(32);
    await states.issueState(
      old,
      { ...state, expiresAt: new Date(Date.now() - 1000) },
      new Date(),
    );
    await states.issueState(randomBytes(32), state, new Date());
    expect(await states.consumeState(old)).toBeNull();
  });

  test("a claim's pin writes pinned_by claim and its pinned_at_claim receipt in one transaction", async () => {
    const store = createPostgresGitHubAppStore(db, key);
    const pins = createPostgresGitHubPinStore(db);
    const ws = await workspace();
    const owner = await person(ws, "owner");
    const a = await stored(
      await store.put(ws, AUTHOR, profile(131), pemOf(), owner()),
    );
    const repositoryId = `claim-${ws.slice(0, 8)}`;
    const sessionId = randomUUID();
    const receiptOf = async (id: string) =>
      (
        await db
          .select({
            ownerId: receipts.ownerId,
            operation: receipts.operation,
            status: receipts.status,
            actor: receipts.actor,
            result: receipts.result,
          })
          .from(receipts)
          .where(eq(receipts.id, id))
      )[0];

    const receiptId = randomUUID();
    expect(
      await pins.pinFirst({
        repositoryId,
        role: "author",
        connectionId: a.id,
        appId: 131,
        pinnedBy: "claim",
        audit: { sessionId, receiptId },
      }),
    ).toMatchObject({ created: true, pin: { pinnedBy: "claim" } });
    expect(await receiptOf(receiptId)).toEqual({
      ownerId: ws,
      operation: "set_repository_github_app",
      status: "succeeded",
      actor: null,
      result: {
        event: "pinned_at_claim",
        repository_id: repositoryId,
        role: "author",
        pinned_by: "claim",
        app_id: 131,
        session_id: sessionId,
        before: null,
        after: a.id,
      },
    });

    // Already pinned: the pin holds and no second receipt is written.
    const again = randomUUID();
    expect(
      await pins.pinFirst({
        repositoryId,
        role: "author",
        connectionId: a.id,
        appId: 131,
        pinnedBy: "claim",
        audit: { sessionId, receiptId: again },
      }),
    ).toMatchObject({ created: false });
    expect(await receiptOf(again)).toBeUndefined();

    // The receipt failing (its id taken) takes the pin back with it.
    const other = `claim-b-${ws.slice(0, 8)}`;
    await expect(
      pins.pinFirst({
        repositoryId: other,
        role: "author",
        connectionId: a.id,
        appId: 131,
        pinnedBy: "claim",
        audit: { sessionId, receiptId },
      }),
    ).rejects.toThrow();
    expect(await pins.get(other, "author")).toBeNull();
  });
});

const audit = (made: SecretAudit) => made.receiptId;
