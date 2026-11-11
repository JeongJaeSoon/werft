import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ExecutionBackend,
  reclaimWorkspaces,
  type SchedulerLogger,
  type WorkspaceRemovalResult,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import { createPostgresSchedulerStore } from "./scheduler/scheduler-store.ts";
import * as schema from "./schema.ts";
import { idempotencyKeys, receipts, sessions } from "./schema.ts";
import { fixtureRelease, sessionPinColumns } from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1_000;

const quiet: SchedulerLogger = {
  error() {},
  info() {},
  warn() {},
};

/**
 * a stopped session's workspace expires, and the expiry is
 * serialized with resume. Each test fixes one interleaving of the GC pass
 * and a resume against real PostgreSQL row locks; the daemon is a stand-in
 * whose removal can be held open or made to fail.
 */
integration("stopped workspace reclaim against resume on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "ws_reclaim_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () =>
    createPostgresSchedulerStore(db, {
      connectForLock: () => pool.connect(),
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    });

  /** Stopped a day and a minute ago, with a checkpoint to resume from. */
  async function expiredStoppedSession() {
    const id = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    await db.insert(sessions).values({
      agentReleaseId: await fixtureRelease(db),
      ...sessionPinColumns(),
      admissionState: "stopped",
      branch: `session/${id}`,
      checkpointRevision: 2,
      id,
      ownerId,
      repoUrl: "https://example.invalid/app.git",
      status: "stopped",
      updatedAt: new Date(Date.now() - DAY_MS - 60_000),
    });
    return { id, ownerId, workspace: `ap-ws-it-${id}-a1b2c3d4` };
  }

  async function sessionRow(id: string) {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    if (!row) throw new Error(`no session ${id}`);
    return row;
  }

  function resume(
    session: { id: string; ownerId: string },
    expectedRevision: number,
    idempotencyKey: string = crypto.randomUUID(),
  ) {
    return createPostgresSessionControl(db).resumeAtomic({
      expectedRevision,
      idempotencyKey,
      now: new Date(),
      payloadHash: "resume-payload",
      principal: { ownerId: session.ownerId },
      sessionId: session.id,
    });
  }

  /** A daemon holding exactly the given volumes; nothing else is asked of it. */
  function daemon(
    volumes: Map<string, string>,
    remove: (id: string) => Promise<WorkspaceRemovalResult>,
  ): ExecutionBackend {
    const unused = () => {
      throw new Error("not part of workspace reclaim");
    };
    return {
      assertReplaceable: unused,
      capabilities: () => ({ suspend: false }),
      ensureExecution: unused,
      inspect: unused,
      kind: "local_docker",
      listManaged: unused,
      async listWorkspaces() {
        return [...volumes.entries()].map(([id, sessionId]) => ({
          createdAt: new Date(0),
          id,
          sessionId,
        }));
      },
      removeWorkspace: remove,
      resolveImage: unused,
      terminate: unused,
    };
  }

  test("a resume that wins keeps its workspace: the claim sees it and backs off", async () => {
    const session = await expiredStoppedSession();
    const volumes = new Map([[session.workspace, session.id]]);
    const removed: string[] = [];
    const base = store();
    let resumed: Awaited<ReturnType<typeof resume>> | undefined;
    // The listing judges the session a candidate from an unlocked read; the
    // resume lands right after it, before the claim takes the lock.
    const racing = {
      ...base,
      async filterRetainedSessions(
        ids: string[],
        options: { stoppedTtlMs: number },
      ) {
        const retained = await base.filterRetainedSessions(ids, options);
        expect(retained).not.toContain(session.id);
        resumed = await resume(
          session,
          (await sessionRow(session.id)).revision,
        );
        return retained;
      },
    };

    const summary = await reclaimWorkspaces({
      backend: daemon(volumes, async (id) => {
        removed.push(id);
        return { outcome: "removed" };
      }),
      logger: quiet,
      stoppedWorkspaceTtlMs: DAY_MS,
      store: racing,
    });

    expect(resumed?.outcome).toBe("accepted");
    expect(removed).toEqual([]);
    expect(summary.workspacesReclaimed).toEqual([]);
    const row = await sessionRow(session.id);
    expect(row.admissionState).toBe("active");
    expect(row.workspaceReclaimId).toBeNull();
  });

  test("a claim that wins holds resume off until the removal settles", async () => {
    const session = await expiredStoppedSession();
    const volumes = new Map([[session.workspace, session.id]]);
    const before = await sessionRow(session.id);
    const key = crypto.randomUUID();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let removing!: () => void;
    const reached = new Promise<void>((resolve) => {
      removing = resolve;
    });

    const pass = reclaimWorkspaces({
      backend: daemon(volumes, async (id) => {
        removing();
        await held;
        volumes.delete(id);
        return { outcome: "removed" };
      }),
      logger: quiet,
      stoppedWorkspaceTtlMs: DAY_MS,
      store: store(),
    });
    await reached;

    // The volume is being removed right now: resume is refused, and leaves
    // nothing behind that would turn the retry into a replay of a refusal.
    expect((await resume(session, before.revision, key)).outcome).toBe(
      "workspace_reclaiming",
    );
    const during = await sessionRow(session.id);
    expect(during.admissionState).toBe("stopped");
    expect(during.revision).toBe(before.revision);
    expect(
      await db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, key)),
    ).toEqual([]);

    release();
    const summary = await pass;
    expect(summary.workspacesReclaimed).toEqual([session.workspace]);
    const reclaimed = await sessionRow(session.id);
    expect(reclaimed.workspaceReclaimId).toBeNull();
    expect(reclaimed.workspaceReclaimedAt).not.toBeNull();
    expect(reclaimed.updatedAt).toEqual(before.updatedAt);

    // The same request now goes through; the session comes back on a new
    // workspace restored from its checkpoint.
    const retried = await resume(session, before.revision, key);
    if (retried.outcome !== "accepted") throw new Error(retried.outcome);
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, retried.response.receipt_id));
    expect(receipt?.status).toBe("succeeded");
    const after = await sessionRow(session.id);
    expect(after.admissionState).toBe("active");
    expect(after.workspaceReclaimedAt).toBeNull();
  });

  test("a removal whose answer was lost keeps resume off until a later pass settles it", async () => {
    const session = await expiredStoppedSession();
    const volumes = new Map([[session.workspace, session.id]]);
    const before = await sessionRow(session.id);
    const asked: string[] = [];

    // The daemon removes the volume and the answer never arrives.
    const first = await reclaimWorkspaces({
      backend: daemon(volumes, async (id) => {
        asked.push(id);
        volumes.delete(id);
        throw new Error("Docker API timed out");
      }),
      logger: quiet,
      stoppedWorkspaceTtlMs: DAY_MS,
      store: store(),
    });
    expect(first.workspacesFailed).toEqual([session.workspace]);
    expect((await resume(session, before.revision)).outcome).toBe(
      "workspace_reclaiming",
    );

    // Nothing is listed any more; the pending claim is what is followed up.
    const second = await reclaimWorkspaces({
      backend: daemon(volumes, async (id) => {
        asked.push(id);
        return { outcome: "absent" };
      }),
      logger: quiet,
      stoppedWorkspaceTtlMs: DAY_MS,
      store: store(),
    });
    expect(second.workspacesReclaimed).toEqual([session.workspace]);
    expect(asked).toEqual([session.workspace, session.workspace]);
    expect((await resume(session, before.revision)).outcome).toBe("accepted");
  });

  test("a stopped session inside its TTL is not touched", async () => {
    const session = await expiredStoppedSession();
    await db
      .update(sessions)
      .set({ updatedAt: new Date() })
      .where(eq(sessions.id, session.id));
    const volumes = new Map([[session.workspace, session.id]]);

    const summary = await reclaimWorkspaces({
      backend: daemon(volumes, async () => {
        throw new Error("must not be removed");
      }),
      logger: quiet,
      stoppedWorkspaceTtlMs: DAY_MS,
      store: store(),
    });

    expect(summary.workspacesReclaimed).toEqual([]);
    expect(summary.workspacesFailed).toEqual([]);
    expect((await sessionRow(session.id)).workspaceReclaimId).toBeNull();
  });
});
