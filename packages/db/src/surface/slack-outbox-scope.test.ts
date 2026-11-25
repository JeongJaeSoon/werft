import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SurfaceOutboxEntry } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

// v1-b/G1 (A3): a claimed row carries the scope of the conversation its
// session belongs to, read by the server, not by the text.

let client: PGlite;
let db: Database;
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();

beforeAll(async () => {
  client = await migratedPGlite();
  // The rows a row names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0APP', 'T0INSTALL')",
    [INSTALL, WORKSPACE],
  );
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function sessionIn(
  conversation: {
    kind: "channel" | "dm";
    teamId: string | null;
    channelId: string | null;
  } | null,
) {
  const sessionId = crypto.randomUUID();
  let parent: string | null = null;
  if (conversation !== null) {
    parent = crypto.randomUUID();
    await client.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id, person_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        parent,
        WORKSPACE,
        AGENT,
        conversation.kind,
        conversation.teamId,
        conversation.channelId,
        conversation.kind === "dm" ? crypto.randomUUID() : null,
      ],
    );
  }
  await client.query(
    "INSERT INTO sessions (id, owner_id, repository_mode, parent_conversation_id) VALUES ($1, 'owner', 'none', $2)",
    [sessionId, parent],
  );
  return sessionId;
}

// A model notice needs no link, so the claim reads only what is under test.
function entryOf(sessionId: string | null): SurfaceOutboxEntry {
  return {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    slackAppId: crypto.randomUUID(),
    installationId: INSTALL,
    kind: "model_notice",
    channelId: "U0PERSON",
    threadTs: "",
    slackUserId: null,
    sessionId,
    sessionLinkId: null,
    body: { text: "Done." },
    dedupeKey: crypto.randomUUID(),
  };
}

async function claimedScope(sessionId: string | null) {
  await client.exec("DELETE FROM slack_outbox");
  const outbox = createPostgresSlackOutboxStore(db);
  expect(await outbox.enqueue(entryOf(sessionId))).toBe("enqueued");
  const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
  return claim?.conversationScope;
}

describe("claiming an outbox row", () => {
  test("reads its session's channel conversation", async () => {
    const session = await sessionIn({
      kind: "channel",
      teamId: "T0ACME",
      channelId: "C0ROOM",
    });
    expect(await claimedScope(session)).toEqual({
      kind: "channel",
      teamId: "T0ACME",
      channelId: "C0ROOM",
    });
  });

  test("gives a DM conversation its install's team", async () => {
    const session = await sessionIn({
      kind: "dm",
      teamId: null,
      channelId: null,
    });
    expect(await claimedScope(session)).toEqual({
      kind: "dm",
      teamId: "T0INSTALL",
      channelId: null,
    });
  });

  test("has none without a session or its parent conversation", async () => {
    expect(await claimedScope(null)).toBeNull();
    expect(await claimedScope(await sessionIn(null))).toBeNull();
  });
});
