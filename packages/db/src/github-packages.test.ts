import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import {
  callerFor,
  type GitHubPackagesStore,
  MANAGEMENT_ROLES,
  type SecretAudit,
  SecretKey,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresGitHubPackagesStore } from "./github-packages.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { memberships, receipts, users, workspaces } from "./schema.ts";
import { fixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

const BOT = "fake-bot-credential-for-tests";
const ENTRY = {
  registry: "npm" as const,
  owner: "acme",
  name: "*",
  repository_id: null,
  agent_id: null,
};
const FACTS = {
  login: "acme-packages-bot",
  expiresAt: new Date("2027-01-30T00:00:00Z"),
};

let client: PGlite;
let db: Database;
let store: GitHubPackagesStore;
let workspaceId: string;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  store = createPostgresGitHubPackagesStore(
    db,
    SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY"),
  );
  workspaceId = randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: "acme", name: "Acme" });
});

afterEach(async () => {
  await client.close();
});

async function auditAs(role: WorkspaceRole): Promise<SecretAudit> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    passwordHash: "x",
    displayName: role,
  });
  await db.insert(memberships).values({ workspaceId, userId, role });
  return {
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
    roles: MANAGEMENT_ROLES["workspace.manage"] ?? [],
  };
}

const operations = async () =>
  (
    await db
      .select()
      .from(receipts)
      .where(eq(receipts.ownerId, workspaceId))
      .orderBy(receipts.createdAt)
  ).map((row) => ({
    operation: row.operation,
    status: row.status,
    result: row.result,
  }));

describe("the GitHub Packages store", () => {
  test("a token is sealed, summarized by its last four, and audited without its value", async () => {
    expect(
      await store.putToken({
        workspaceId,
        token: BOT,
        facts: FACTS,
        audit: await auditAs("owner"),
      }),
    ).toEqual({ outcome: "stored" });
    const settings = await store.get(workspaceId);
    expect(settings.token).toMatchObject({
      last4: BOT.slice(-4),
      login: FACTS.login,
      expiresAt: FACTS.expiresAt,
    });
    const sealed = await client.query("SELECT * FROM secret_values");
    expect(JSON.stringify(sealed.rows)).not.toContain(BOT);
    expect(JSON.stringify(await operations())).not.toContain(BOT);

    expect(
      await store.deleteToken({ workspaceId, audit: await auditAs("admin") }),
    ).toEqual({ outcome: "deleted" });
    expect((await store.get(workspaceId)).token).toBeNull();
    expect(
      await store.deleteToken({ workspaceId, audit: await auditAs("admin") }),
    ).toEqual({ outcome: "not_found" });
    expect((await operations()).map((row) => row.operation)).toEqual([
      "set_github_packages_token",
      "delete_github_packages_token",
    ]);
  });

  test("a member is outranked and nothing is written", async () => {
    expect(
      await store.putToken({
        workspaceId,
        token: BOT,
        facts: FACTS,
        audit: await auditAs("member"),
      }),
    ).toEqual({ outcome: "outranked" });
    expect((await store.get(workspaceId)).token).toBeNull();
    expect(await operations()).toEqual([]);
  });

  test("the allowlist moves one revision at a time, before or after a token", async () => {
    const audit = await auditAs("owner");
    await store.putToken({ workspaceId, token: BOT, facts: FACTS, audit });
    expect(
      await store.putAllowlist({
        workspaceId,
        allowlist: [ENTRY],
        revision: 0,
        audit: await auditAs("owner"),
      }),
    ).toEqual({ outcome: "stored" });
    expect(
      await store.putAllowlist({
        workspaceId,
        allowlist: [],
        revision: 0,
        audit: await auditAs("owner"),
      }),
    ).toEqual({ outcome: "revision_conflict" });
    expect(await store.get(workspaceId)).toMatchObject({
      allowlist: [ENTRY],
      revision: 1,
    });
    expect(await store.allowlist(workspaceId.toUpperCase())).toEqual([ENTRY]);
  });

  test("an owner that is not a workspace has no token and allows nothing", async () => {
    expect(await store.allowlist("quickstart")).toEqual([]);
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: "quickstart" },
      idempotencyKey: randomUUID(),
      payloadHash: "hash",
      agentReleaseId: await fixtureRelease(db),
      model: TEST_MODEL,
      repository: {
        id: "app",
        url: "https://git.invalid/app.git",
        branch: "main",
      },
      message: "hello",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    expect(
      await store.sessionState(accepted.response.session_id),
    ).toMatchObject({ workspaceId: "quickstart", token: null, allowlist: [] });
  });

  test("a row that does not parse allows nothing", async () => {
    await client.query(
      `INSERT INTO github_packages_settings (workspace_id, allowlist) VALUES ($1, $2)`,
      [workspaceId, JSON.stringify([{ registry: "maven", owner: "acme" }])],
    );
    expect(await store.allowlist(workspaceId)).toEqual([]);
  });

  test("a session reads its workspace's token and allowlist, and its fetches are receipts", async () => {
    await store.putToken({
      workspaceId,
      token: BOT,
      facts: FACTS,
      audit: await auditAs("owner"),
    });
    await store.putAllowlist({
      workspaceId,
      allowlist: [ENTRY],
      revision: 0,
      audit: await auditAs("owner"),
    });
    const accepted = await createPostgresSessionUnitOfWork(
      db,
    ).acceptInputAtomic({
      limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
      principal: { ownerId: workspaceId },
      idempotencyKey: randomUUID(),
      payloadHash: "hash",
      agentReleaseId: await fixtureRelease(db),
      model: TEST_MODEL,
      repository: {
        id: "app",
        url: "https://git.invalid/app.git",
        branch: "main",
      },
      message: "hello",
    });
    if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
    const sessionId = accepted.response.session_id;
    expect(await store.sessionState(sessionId)).toMatchObject({
      workspaceId,
      token: { value: BOT, expiresAt: FACTS.expiresAt },
      allowlist: [ENTRY],
    });
    expect(await store.sessionState(randomUUID())).toBeNull();

    await store.recordFetch({
      id: randomUUID(),
      ownerId: workspaceId,
      sessionId,
      status: "failed",
      actor: null,
      result: {
        attempt_id: "att-1",
        agent_id: null,
        release_id: null,
        repository_id: "app",
        registry: "npm",
        owner: "acme",
        package: "other",
        version: null,
        reason_code: "package_not_allowed",
      },
    });
    const [fetched] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.operation, "fetch_github_package"));
    expect(fetched).toMatchObject({
      status: "failed",
      targetRef: { session_id: sessionId },
      error: { code: "FORBIDDEN" },
    });
  });
});
