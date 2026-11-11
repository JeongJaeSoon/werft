import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPushRequests } from "../push-requests.ts";
import * as schema from "../schema.ts";
import { attempts, checkpoints, sessions } from "../schema.ts";
import { createPostgresCheckpointStore } from "./checkpoint-store.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/**
 * what checkpoint garbage collection reads from and writes to
 * PostgreSQL — which attempts can never commit again, and which rows it
 * retires before deleting their objects.
 */
integration("checkpoint collection store on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "ckpt_gc_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function session(fields: Partial<typeof sessions.$inferInsert> = {}) {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      branch: `session/${id}`,
      id,
      ownerId: "owner-gc",
      repoUrl: "https://example.invalid/app.git",
      authRevision: 1,
      executionGeneration: 2,
      leaseEpoch: 3,
      ...fields,
    });
    return id;
  }

  async function attempt(
    sessionId: string,
    fields: Partial<typeof attempts.$inferInsert> = {},
  ) {
    const id = `attempt-${crypto.randomUUID()}`;
    await db.insert(attempts).values({
      authRevision: 1,
      executionGeneration: 2,
      executionId: `exec-${id}`,
      id,
      leaseEpoch: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      sessionId,
      state: "running",
      ...fields,
    });
    return id;
  }

  test("an attempt is fenced once it ended or the session's epoch, generation or auth revision moved past it", async () => {
    const sessionId = await session({ checkpointFallbackRevision: 4 });
    const live = await attempt(sessionId);
    const expired = await attempt(sessionId, {
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    const exited = await attempt(sessionId, { state: "exited" });
    const lost = await attempt(sessionId, { state: "lost" });
    const oldEpoch = await attempt(sessionId, { leaseEpoch: 2 });
    const oldGeneration = await attempt(sessionId, { executionGeneration: 1 });
    const oldAuth = await attempt(sessionId, { authRevision: 0 });
    const store = createPostgresCheckpointStore(db);

    const fences = await store.readCollectionFences(sessionId);

    expect(fences?.fallbackRevision).toBe(4);
    expect(fences?.executionGeneration).toBe(2);
    expect([...(fences?.fencedAttemptIds ?? [])].sort()).toEqual(
      [exited, lost, oldEpoch, oldGeneration, oldAuth].sort(),
    );
    expect(fences?.fencedAttemptIds.has(live)).toBe(false);
    // A lapsed lease is the reconciler's to judge; until then it may renew.
    expect(fences?.fencedAttemptIds.has(expired)).toBe(false);
    expect(await store.readCollectionFences(crypto.randomUUID())).toBeNull();
  });

  test("listPinnedCommits names the commits push requests pinned, newest first, rejected ones left out", async () => {
    const sessionId = await session({
      checkpointRevision: 2,
      repositoryId: "sample-app",
    });
    const push = createPostgresPushRequests(db);
    const actor = {
      principal: { kind: "api_key" as const, id: "key-gc" },
      actor_user_id: null,
      agent_id: null,
    };
    const pin = (key: string, revision: number, commit: string) =>
      push.create({
        ownerId: "owner-gc",
        sessionId,
        actor,
        idempotencyKey: key,
        payloadHash: "h",
        repositoryId: "sample-app",
        repositoryBinding: "sha256:binding",
        checkpointRevision: revision,
        gitCommit: commit,
        policyApproval: null,
        policyFields: {},
      });
    const reject = async (id: string, commit: string, key: string) =>
      push.decide({
        ownerId: "owner-gc",
        sessionId,
        pushRequestId: id,
        actor,
        decision: "reject",
        gitCommit: commit,
        reason: null,
        idempotencyKey: key,
        payloadHash: "h",
      });
    const one = await pin("p-1", 2, "1".repeat(40));
    const two = "2".repeat(40);
    if (one.outcome !== "written") throw new Error("not written");
    await reject(one.request.id, "1".repeat(40), "p-1r");
    await db
      .update(sessions)
      .set({ checkpointRevision: 3 })
      .where(eq(sessions.id, sessionId));
    const second = await pin("p-2", 3, two);
    expect(second.outcome).toBe("written");
    const store = createPostgresCheckpointStore(db);

    expect(await store.listPinnedCommits(sessionId, 10)).toEqual([two]);
    expect(await store.listPinnedCommits(sessionId, 0)).toEqual([]);
    expect(await store.listPinnedCommits(crypto.randomUUID(), 10)).toEqual([]);
  });

  test("readPushPinnedRevisions names the revisions open push requests pinned", async () => {
    const sessionId = await session({
      checkpointRevision: 2,
      repositoryId: "sample-app",
    });
    const push = createPostgresPushRequests(db);
    const actor = {
      principal: { kind: "api_key" as const, id: "key-gc" },
      actor_user_id: null,
      agent_id: null,
    };
    const pin = (key: string, revision: number) =>
      push.create({
        ownerId: "owner-gc",
        sessionId,
        actor,
        idempotencyKey: key,
        payloadHash: "h",
        repositoryId: "sample-app",
        repositoryBinding: "sha256:binding",
        checkpointRevision: revision,
        gitCommit: "a".repeat(40),
        policyApproval: null,
        policyFields: {},
      });
    const first = await pin("k-1", 2);
    if (first.outcome !== "written") throw new Error("not written");
    await push.decide({
      ownerId: "owner-gc",
      sessionId,
      pushRequestId: first.request.id,
      actor,
      decision: "reject",
      gitCommit: "a".repeat(40),
      reason: null,
      idempotencyKey: "k-2",
      payloadHash: "h",
    });
    await db
      .update(sessions)
      .set({ checkpointRevision: 3 })
      .where(eq(sessions.id, sessionId));
    expect((await pin("k-3", 3)).outcome).toBe("written");
    const store = createPostgresCheckpointStore(db);

    expect(await store.readPushPinnedRevisions(sessionId)).toEqual([3]);
    expect(await store.readPushPinnedRevisions(crypto.randomUUID())).toEqual(
      [],
    );
  });

  test("markCollected retires the rows up to the pointer that are not kept, once", async () => {
    const sessionId = await session({ checkpointRevision: 3 });
    for (const revision of [0, 1, 2, 3]) {
      await db.insert(checkpoints).values({
        manifestRef: `sessions/${sessionId}/checkpoints/${revision}/manifest.json`,
        manifestSha256: "a".repeat(64),
        revision,
        sessionId,
      });
    }
    const store = createPostgresCheckpointStore(db);

    expect(
      await store.markCollected(sessionId, {
        keep: [3, 2],
        throughRevision: 3,
      }),
    ).toBe(2);
    expect(
      await store.markCollected(sessionId, { keep: [3], throughRevision: 3 }),
    ).toBe(1);
    expect(
      await store.markCollected(sessionId, { keep: [], throughRevision: 1 }),
    ).toBe(0);

    const marked = await db
      .select({ revision: checkpoints.revision })
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.sessionId, sessionId),
          isNotNull(checkpoints.collectedAt),
        ),
      );
    expect(marked.map((row) => row.revision).sort()).toEqual([0, 1, 2]);
  });

  test("markPurged stamps the collected rows the same options name, including an earlier pass's", async () => {
    const sessionId = await session({ checkpointRevision: 3 });
    for (const revision of [0, 1, 2, 3]) {
      await db.insert(checkpoints).values({
        manifestRef: `sessions/${sessionId}/checkpoints/${revision}/manifest.json`,
        manifestSha256: "a".repeat(64),
        revision,
        sessionId,
      });
    }
    const store = createPostgresCheckpointStore(db);
    // An earlier pass collected 0 and failed before its deletes finished.
    await store.markCollected(sessionId, {
      keep: [1, 2, 3],
      throughRevision: 3,
    });
    await store.markCollected(sessionId, { keep: [2, 3], throughRevision: 3 });
    await store.markPurged(sessionId, { keep: [2, 3], throughRevision: 3 });

    const stamped = await db
      .select({ revision: checkpoints.revision })
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.sessionId, sessionId),
          isNotNull(checkpoints.objectsPurgedAt),
        ),
      );
    expect(stamped.map((row) => row.revision).sort()).toEqual([0, 1]);
  });

  test("listSessionIds pages through every session in id order", async () => {
    const store = createPostgresCheckpointStore(db);
    const all = (await db.select({ id: sessions.id }).from(sessions))
      .map((row) => row.id)
      .sort();

    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page: string[] = await store.listSessionIds({ after, limit: 2 });
      seen.push(...page);
      if (page.length < 2) break;
      after = page.at(-1) ?? null;
    }

    expect(seen).toEqual(all);
  });

  test("settleCollection marks only a session closed over a day ago with no open push request, and listSessionIds then leaves it out", async () => {
    const store = createPostgresCheckpointStore(db);
    const closedAgo = async (interval: string) => {
      const id = await session({
        admissionState: "closed",
        checkpointRevision: 2,
        repositoryId: "sample-app",
      });
      await db.execute(
        sql`UPDATE sessions SET updated_at = now() - ${interval}::interval WHERE id = ${id}`,
      );
      return id;
    };
    const settled = await closedAgo("2 days");
    const recent = await closedAgo("1 hour");
    const active = await session({ checkpointRevision: 2 });
    await db.execute(
      sql`UPDATE sessions SET updated_at = now() - interval '2 days' WHERE id = ${active}`,
    );
    const pushed = await session({
      checkpointRevision: 2,
      repositoryId: "sample-app",
    });
    const created = await createPostgresPushRequests(db).create({
      ownerId: "owner-gc",
      sessionId: pushed,
      actor: {
        principal: { kind: "api_key", id: "key-gc" },
        actor_user_id: null,
        agent_id: null,
      },
      idempotencyKey: "settle-push",
      payloadHash: "h",
      repositoryId: "sample-app",
      repositoryBinding: "sha256:binding",
      checkpointRevision: 2,
      gitCommit: "a".repeat(40),
      policyApproval: null,
      policyFields: {},
    });
    expect(created.outcome).toBe("written");
    await db.execute(
      sql`UPDATE sessions SET admission_state = 'closed', updated_at = now() - interval '2 days' WHERE id = ${pushed}`,
    );

    expect(await store.settleCollection(settled)).toBe(true);
    expect(await store.settleCollection(settled)).toBe(false);
    expect(await store.settleCollection(recent)).toBe(false);
    expect(await store.settleCollection(active)).toBe(false);
    expect(await store.settleCollection(pushed)).toBe(false);

    const listed = await store.listSessionIds({ after: null, limit: 10_000 });
    expect(listed).not.toContain(settled);
    expect(listed).toEqual(expect.arrayContaining([recent, active, pushed]));
  });
});
