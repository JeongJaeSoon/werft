import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as schema from "@werft-ai/db";
import {
  queueMessages,
  sessions,
  turns,
  unassignedSessions,
  workers,
} from "@werft-ai/db";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const integration = testDatabaseUrl() ? describe : describe.skip;

// The child reconciler sweeps every orphan in the database it is pointed at
// and the test asserts on the whole sweep (`reconciled_count`, session_ids).
// Pointed at the shared QUEUE_DATABASE_URL, that sweep also picks up any
// session whose worker is stale or missing: rows left by an interrupted run
// or seeded by another checkout running this suite at the same time. The
// test then fails once and passes on the next run, because the failing sweep
// cleared the leftovers. A database of its own is the only state
// these assertions can speak for.
integration("reconciler process on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const sessionId = crypto.randomUUID();
  const podId = `reconciler-${crypto.randomUUID()}`;
  // Heartbeated a minute ago under a 120-second TTL the API was given: past
  // any 30-second default, still inside its own deadline.
  const liveSessionId = crypto.randomUUID();
  const livePodId = `reconciler-live-${crypto.randomUUID()}`;
  // Open, on no worker, and holding a variable value copied 31 days ago.
  const staleEnvSessionId = crypto.randomUUID();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "reconciler_it" });
    pool = new Pool({ connectionString: database.url });
    db = drizzle(pool, { schema });
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: "reconciler-owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${sessionId}`,
      podId,
      status: "running",
    });
    await db.insert(workers).values({
      podId,
      lastSeen: new Date(Date.now() - 60_000),
      leaseExpiresAt: new Date(Date.now() - 30_000),
    });
    await db.insert(sessions).values({
      id: liveSessionId,
      ownerId: "reconciler-owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${liveSessionId}`,
      podId: livePodId,
      status: "running",
    });
    await db.insert(workers).values({
      podId: livePodId,
      lastSeen: new Date(Date.now() - 60_000),
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await db.insert(sessions).values({
      id: staleEnvSessionId,
      ownerId: "reconciler-owner",
      repoUrl: "https://example.invalid/repo.git",
      branch: `session/${staleEnvSessionId}`,
      envStart: {
        entries: [
          {
            name: "STALE_ONE",
            scope: "agent",
            kind: "plain",
            version: 1,
            value: "stale-value",
          },
        ],
        skipped: [],
        captured_at: new Date(
          Date.now() - 31 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    });
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId,
        sequence: 1,
        message: "resume after crash",
        status: "queued",
      })
      .returning({ id: turns.id });
    await db.insert(queueMessages).values({
      sessionId,
      turnId: turn?.id,
      kind: "message",
      payload: { message: "resume after crash" },
      claimedBy: podId,
      claimToken: crypto.randomUUID(),
      visibleAt: new Date(Date.now() + 60_000),
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await pool.end();
    } finally {
      await database.drop();
    }
  }, 60_000);

  async function runChild(extra: Record<string, string>) {
    // HEARTBEAT_TTL_SEC comes only from `extra`: whatever the shell running
    // the suite holds must not decide which case this is.
    const { HEARTBEAT_TTL_SEC: _inherited, ...inherited } = process.env;
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        `${import.meta.dir}/../main.ts`,
        "reconciler",
        "--once",
      ],
      {
        env: {
          ...inherited,
          DATABASE_URL: database.url,
          RECONCILER_BATCH_SIZE: "10",
          RECONCILER_DRY_RUN: "false",
          ...extra,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(5_000).then(() => {
        child.kill();
        throw new Error("Reconciler process did not exit");
      }),
    ]);
    return {
      exitCode,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    };
  }

  test("a HEARTBEAT_TTL_SEC of its own stops the process before it touches a row", async () => {
    const { exitCode, stderr } = await runChild({ HEARTBEAT_TTL_SEC: "1" });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("HEARTBEAT_TTL_SEC is read by the API only");
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session).toMatchObject({ podId, status: "running" });
  });

  test("requeues once, logs the session, and exits zero", async () => {
    const { exitCode, stdout, stderr } = await runChild({});

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("Orphan session reconciliation completed");
    expect(stdout).toContain(sessionId);
    expect(stdout).toContain('"reconciled_count":1');
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(session).toMatchObject({ podId: null, status: "queued" });
    expect(
      await db
        .select()
        .from(unassignedSessions)
        .where(eq(unassignedSessions.sessionId, sessionId)),
    ).toHaveLength(1);
    // Judged by the deadline its heartbeat stored, not by a default TTL.
    expect(stdout).not.toContain(liveSessionId);
    const [live] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, liveSessionId));
    expect(live).toMatchObject({ podId: livePodId, status: "running" });
    // The same pass drops the value an open session kept past retention and
    // leaves the name.
    expect(stdout).toContain("Expired session variable values purged");
    expect(stdout).toContain('"purged_count":1');
    const [stale] = await db
      .select({ snapshot: sessions.envStart })
      .from(sessions)
      .where(eq(sessions.id, staleEnvSessionId));
    expect(stale?.snapshot).toMatchObject({ entries: [{ name: "STALE_ONE" }] });
    expect(JSON.stringify(stale?.snapshot)).not.toContain("stale-value");
  });
});
