import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresWerftStatusStore } from "./status.ts";

// 94S-2292: the status facts carry where the session's answers go, read as
// the outbox claim reads it (A3): the session's parent conversation.

let client: PGlite;
let db: Database;
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const RELEASE = "release-1";

beforeAll(async () => {
  client = await migratedPGlite();
  // The rows a row names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
  await client.query(
    "INSERT INTO agent_releases (id, agent_id, version_id, card_sha256, connection_id, runtime_config_snapshot, effective_tools, runtime_spec, spec_source, spec_source_digest, spec_digest) VALUES ($1, $2, $3, 'sha', 'conn', '{}', '{}', '{}', '{}', 'd', 'd')",
    [RELEASE, AGENT, crypto.randomUUID()],
  );
}, 60_000);

afterAll(async () => {
  await client.close();
});

async function replyToOf(
  conversation:
    | { id: string; kind: "channel"; channelId: string }
    | { id: string; kind: "dm"; person: string }
    | null,
) {
  const sessionId = crypto.randomUUID();
  const parent = conversation?.id ?? null;
  if (conversation !== null) {
    await client.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id, person_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [
        parent,
        WORKSPACE,
        AGENT,
        conversation.kind,
        conversation.kind === "channel" ? "T0ACME" : null,
        conversation.kind === "channel" ? conversation.channelId : null,
        conversation.kind === "dm" ? conversation.person : null,
      ],
    );
  }
  await client.query(
    "INSERT INTO sessions (id, owner_id, repository_mode, agent_release_id, parent_conversation_id) VALUES ($1, $2, 'none', $3, $4)",
    [sessionId, WORKSPACE, RELEASE, parent],
  );
  const facts = await createPostgresWerftStatusStore(db).factsOf({
    sessionId,
    attemptId: "att_1",
    requestId: "request-1",
  });
  return facts?.replyTo;
}

describe("the status facts' reply place", () => {
  test("a channel thread's session answers in its channel's conversation", async () => {
    const id = crypto.randomUUID();
    expect(
      await replyToOf({ id, kind: "channel", channelId: "C0SECRET" }),
    ).toEqual({ kind: "channel", conversationId: id });
  });

  test("a DM's session answers to its person", async () => {
    const person = crypto.randomUUID();
    expect(
      await replyToOf({ id: crypto.randomUUID(), kind: "dm", person }),
    ).toEqual({ kind: "dm", personUserId: person });
  });

  test("a session with no parent conversation has no reply place", async () => {
    expect(await replyToOf(null)).toBeNull();
  });
});
