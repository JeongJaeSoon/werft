import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

// 94S-2538: the thread a close button's press is checked against.

let client: PGlite;
let db: Database;
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();

beforeAll(async () => {
  client = await migratedPGlite();
  // The rows a link names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function link(
  sessionId: string,
  over: {
    channelId?: string;
    threadId?: string;
    role?: "primary" | "mirror";
    createdAt?: string;
    closed?: boolean;
  } = {},
) {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id, surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id, release_id, role, created_at, closed_at, closed_reason)
     VALUES ($1, $2, 'owner', $3, $4, $5, $6, $7, $8, '1.0', $9, 'r1', $10, $11, $12, $13)`,
    [
      id,
      WORKSPACE,
      sessionId,
      INSTALL,
      crypto.randomUUID(),
      `ref-${id}`,
      over.channelId ?? "C0ROOM",
      over.threadId ?? "1.0",
      AGENT,
      over.role ?? "primary",
      over.createdAt ?? new Date().toISOString(),
      over.closed ? new Date().toISOString() : null,
      over.closed ? "completed" : null,
    ],
  );
  return id;
}

describe("a session's progress link", () => {
  test("is its primary link with a thread, closed or not; a mirror or a link with no thread is not", async () => {
    const sessionId = crypto.randomUUID();
    // One open link per session: the others are closed history.
    await link(sessionId, {
      role: "mirror",
      channelId: "C0MIRROR",
      closed: true,
      createdAt: "2099-01-01T00:00:00Z",
    });
    await link(sessionId, {
      threadId: "",
      channelId: "C0TOP",
      closed: true,
      createdAt: "2099-01-01T00:00:00Z",
    });
    const primary = await link(sessionId, { closed: true });
    expect(
      await createPostgresSlackOutboxStore(db).progressLink(sessionId),
    ).toEqual({
      id: primary,
      agentId: AGENT,
      channelId: "C0ROOM",
      threadId: "1.0",
    });
  });

  test("is the newest of several, and none for a session without one or an id that is none", async () => {
    const sessionId = crypto.randomUUID();
    await link(sessionId, { createdAt: "2026-01-01T00:00:00Z", closed: true });
    const newer = await link(sessionId, {
      createdAt: "2026-02-01T00:00:00Z",
      threadId: "2.0",
    });
    const outbox = createPostgresSlackOutboxStore(db);
    expect((await outbox.progressLink(sessionId))?.id).toBe(newer);
    expect(await outbox.progressLink(crypto.randomUUID())).toBeNull();
    expect(await outbox.progressLink("not-a-session")).toBeNull();
  });
});
