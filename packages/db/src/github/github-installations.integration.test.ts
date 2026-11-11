import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { scopesForRole } from "@werft-ai/contracts";
import {
  callerFor,
  type GitHubAppInstallationView,
  MANAGEMENT_ROLES,
  type SecretAudit,
  SecretKey,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  githubInstallationLinks,
  githubInstallationSnapshots,
  githubInstallationStates,
  memberships,
  receipts,
  users,
  workspaces,
} from "../schema.ts";
import { createPostgresGitHubAppStore } from "./github-apps.ts";
import { createPostgresGitHubInstallationStore } from "./github-installations.ts";

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

const view = (
  id: number,
  overrides: Partial<GitHubAppInstallationView> = {},
): GitHubAppInstallationView => ({
  id,
  account: `acct-${id}`,
  accountType: "organization",
  accountId: 5000 + id,
  repositorySelection: "selected",
  htmlUrl: `https://github.com/organizations/acct-${id}/settings/installations/${id}`,
  permissions: { contents: "write", metadata: "read" },
  createdAt: new Date("2026-10-01T09:00:00.000Z"),
  suspendedAt: null,
  ...overrides,
});

integration("GitHub installation records on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "github_installs_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function connected(appId: number) {
    const workspaceId = randomUUID();
    await db.insert(workspaces).values({
      id: workspaceId,
      slug: `ws-${workspaceId.slice(0, 8)}`,
      name: "Acme",
    });
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: "Jae",
    });
    await db.insert(memberships).values({ workspaceId, userId, role: "owner" });
    const audit = (): SecretAudit => ({
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
      receiptId: randomUUID(),
      roles: MANAGERS,
    });
    const apps = createPostgresGitHubAppStore(db, key);
    const put = await apps.put(
      workspaceId,
      { kind: "add", role: "author" },
      profile(appId),
      pemOf(),
      audit(),
    );
    if (put.outcome !== "stored") throw new Error(put.outcome);
    return { workspaceId, userId, apps, audit, connectionId: put.app.id };
  }

  test("a snapshot is kept per connection and App, newest first, and goes with the connection", async () => {
    const store = createPostgresGitHubInstallationStore(db);
    const { workspaceId, apps, audit, connectionId } = await connected(301);
    const at = new Date("2026-11-02T09:00:00.000Z");
    const listed = [
      view(1),
      view(2, {
        accountType: "user",
        accountId: null,
        htmlUrl: null,
        suspendedAt: new Date("2026-10-20T00:00:00.000Z"),
      }),
    ];
    await store.recordSnapshot(connectionId, 301, {
      installations: listed,
      readAt: at,
    });
    expect(await store.snapshot(connectionId, 301)).toEqual({
      installations: listed,
      readAt: at,
    });
    await store.recordSnapshot(connectionId, 999, {
      installations: [view(9)],
      readAt: new Date("2026-11-02T10:00:00.000Z"),
    });
    await store.recordSnapshot(connectionId, 301, {
      installations: [view(3)],
      readAt: new Date("2026-11-02T08:00:00.000Z"),
    });
    expect(await store.snapshot(connectionId, 301)).toEqual({
      installations: listed,
      readAt: at,
    });
    expect(await store.snapshot(connectionId, 999)).toBeNull();
    const later = new Date("2026-11-02T11:00:00.000Z");
    await store.recordSnapshot(connectionId, 301, {
      installations: [],
      readAt: later,
    });
    expect(await store.snapshot(connectionId, 301)).toEqual({
      installations: [],
      readAt: later,
    });

    await db
      .update(githubInstallationSnapshots)
      .set({ installations: [{ id: "x" }] })
      .where(eq(githubInstallationSnapshots.connectionId, connectionId));
    expect(await store.snapshot(connectionId, 301)).toBeNull();

    expect(
      await apps.delete(
        workspaceId,
        { kind: "connection", id: connectionId },
        audit(),
      ),
    ).toMatchObject({ outcome: "deleted" });
    expect(
      await db
        .select()
        .from(githubInstallationSnapshots)
        .where(eq(githubInstallationSnapshots.connectionId, connectionId)),
    ).toEqual([]);
  });

  test("a state is spent once, expired ones are dropped, and it goes with the connection", async () => {
    const store = createPostgresGitHubInstallationStore(db);
    const { workspaceId, userId, connectionId } = await connected(302);
    const now = new Date("2026-11-02T09:00:00.000Z");
    const state = {
      workspaceId,
      connectionId,
      appId: 302,
      actorUserId: userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    };
    const hash = randomBytes(32);
    const old = randomBytes(32);
    await store.issueState(old, { ...state, expiresAt: now }, now);
    await store.issueState(hash, state, new Date(now.getTime() + 1));
    expect(
      (await db.select().from(githubInstallationStates)).map((row) =>
        Buffer.from(row.stateHash).toString("hex"),
      ),
    ).toEqual([hash.toString("hex")]);
    const [first, second] = await Promise.all([
      store.consumeState(hash),
      store.consumeState(hash),
    ]);
    expect([first, second].filter((each) => each !== null)).toEqual([state]);
  });

  test("a link is written once, only for the connection's own App and workspace, and names the person", async () => {
    const store = createPostgresGitHubInstallationStore(db);
    const { workspaceId, userId, apps, audit, connectionId } =
      await connected(303);
    const other = await connected(304);
    const link = {
      workspaceId,
      connectionId,
      appId: 303,
      installationId: 77,
      connectedBy: userId,
    };
    expect(await store.recordLink({ ...link, appId: 999 })).toBe(false);
    expect(
      await store.recordLink({ ...link, workspaceId: other.workspaceId }),
    ).toBe(false);
    expect(await store.recordLink(link)).toBe(true);
    expect(await store.recordLink({ ...link, connectedBy: other.userId })).toBe(
      false,
    );
    const [listed, ...rest] = await store.links(workspaceId);
    expect(rest).toEqual([]);
    expect(listed).toMatchObject({
      connectionId,
      installationId: 77,
      connectedBy: { userId, displayName: "Jae" },
    });
    expect(await store.links(other.workspaceId)).toEqual([]);

    const audited = audit();
    expect(
      await apps.put(
        workspaceId,
        { kind: "connection", id: connectionId },
        profile(303),
        pemOf(),
        audited,
      ),
    ).toMatchObject({ outcome: "stored" });
    const [receipt] = await db
      .select({ result: receipts.result })
      .from(receipts)
      .where(eq(receipts.id, audited.receiptId));
    expect(receipt?.result).toMatchObject({
      app_id: 303,
      connection_id: connectionId,
      purpose: "private_key",
    });
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE KEY");
    expect(await store.links(workspaceId)).toHaveLength(1);

    expect(
      await apps.put(
        workspaceId,
        { kind: "role", role: "author" },
        profile(305),
        pemOf(),
        audit(),
      ),
    ).toMatchObject({ outcome: "stored" });
    expect(await store.links(workspaceId)).toEqual([]);

    expect(
      await apps.delete(
        workspaceId,
        { kind: "connection", id: connectionId },
        audit(),
      ),
    ).toMatchObject({ outcome: "deleted" });
    expect(
      await db
        .select()
        .from(githubInstallationLinks)
        .where(eq(githubInstallationLinks.connectionId, connectionId)),
    ).toEqual([]);
  });
});
