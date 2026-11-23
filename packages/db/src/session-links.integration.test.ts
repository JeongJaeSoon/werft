import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SessionLinkReservation } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";
import { sessionLinks } from "./schema.ts";
import { createPostgresSessionLinkStore } from "./session-links.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

/**
 * Reserving a Slack thread's link on a real database, where reservations
 * race: one open link per thread, and closed links kept as its history.
 */
integration("session link reservation on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const installationId = randomUUID();
  const workspaceId = randomUUID();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_links" });
    // The agent, release and binding rows a link names are not under test.
    pool = new Pool({
      connectionString: database.url,
      max: 10,
      options: "-c session_replication_role=replica",
    });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const store = () => createPostgresSessionLinkStore(db);
  const threadOf = (threadId: string): SessionLinkReservation => ({
    workspaceId,
    installationId,
    surfaceBindingId: randomUUID(),
    surfaceRef: `C1:${threadId}`,
    channelId: "C1",
    threadId,
    openedByTs: threadId,
    agentId: randomUUID(),
    releaseId: "rel-1",
    createdBy: null,
  });
  const linksOf = (surfaceRef: string) =>
    db
      .select()
      .from(sessionLinks)
      .where(eq(sessionLinks.surfaceRef, surfaceRef))
      .orderBy(asc(sessionLinks.createdAt));
  test("reservations of one thread at once make one link, reserved once", async () => {
    const input = threadOf("100.000100");
    const taken = await Promise.all(
      Array.from({ length: 8 }, () => store().reserve(input)),
    );
    const [link, ...others] = await linksOf(input.surfaceRef);
    expect(others).toEqual([]);
    expect(taken.filter((t) => t.reserved)).toHaveLength(1);
    expect(new Set(taken.map((t) => t.link.id))).toEqual(
      new Set([link?.id ?? ""]),
    );
  });

  // No writer in the support window skips the advisory lock; one that did
  // would still leave the thread one link.
  test("a reservation that waits on an insert outside the lock takes that link", async () => {
    const input = threadOf("250.000100");
    const old = await pool.connect();
    try {
      await old.query("BEGIN");
      const theirs = randomUUID();
      await old.query(
        `INSERT INTO session_links (id, workspace_id, owner_id, installation_id,
           surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts,
           agent_id, release_id)
         VALUES ($1, $2::uuid, $2::text, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          theirs,
          input.workspaceId,
          input.installationId,
          input.surfaceBindingId,
          input.surfaceRef,
          input.channelId,
          input.threadId,
          input.openedByTs,
          input.agentId,
          input.releaseId,
        ],
      );
      const ours = store().reserve(input);
      // Ours has seen no open row and waits on the uncommitted insert.
      await Bun.sleep(200);
      await old.query("COMMIT");
      expect(await ours).toMatchObject({
        reserved: false,
        link: { id: theirs },
      });
    } finally {
      old.release();
    }
    expect(await linksOf(input.surfaceRef)).toHaveLength(1);
  });

  test("a revoked link keeps its thread: found, and reserving it takes it back", async () => {
    const input = threadOf("300.000100");
    const { link } = await store().reserve(input);
    await db
      .update(sessionLinks)
      .set({ revokedAt: new Date() })
      .where(eq(sessionLinks.id, link.id));

    const found = await store().find(installationId, input.surfaceRef);
    expect(found?.id).toBe(link.id);
    expect(found?.revokedAt).toBeInstanceOf(Date);
    const again = await store().reserve(input);
    expect(again).toMatchObject({ reserved: false, link: { id: link.id } });
    expect(await linksOf(input.surfaceRef)).toHaveLength(1);
  });

  describe("with only the open-only uniques", () => {
    test("a thread whose link closed gets a new open link; the closed one stays as it was", async () => {
      const input = threadOf("400.000100");
      const closedId = randomUUID();
      const closedAt = new Date("2026-11-01T00:00:00Z");
      await db.insert(sessionLinks).values({
        ...input,
        id: closedId,
        ownerId: workspaceId,
        sessionId: randomUUID(),
        closedAt,
        closedReason: "completed",
      });
      const [closed] = await linksOf(input.surfaceRef);

      expect(await store().find(installationId, input.surfaceRef)).toBeNull();
      const taken = await Promise.all(
        Array.from({ length: 4 }, () => store().reserve(input)),
      );
      expect(taken.filter((t) => t.reserved)).toHaveLength(1);
      const opened = taken[0]?.link;
      expect(opened?.id).not.toBe(closedId);
      expect(opened?.sessionId).toBeNull();
      expect(await linksOf(input.surfaceRef)).toEqual([
        closed,
        expect.objectContaining({ id: opened?.id, closedAt: null }),
      ] as never);
      expect((await store().find(installationId, input.surfaceRef))?.id).toBe(
        opened?.id ?? "",
      );
    });
  });
});
