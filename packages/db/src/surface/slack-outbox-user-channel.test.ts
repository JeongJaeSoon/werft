import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SlackOutboxEntry, SlackOutboxKind } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  // The rows a row names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

function entryOf(kind: SlackOutboxKind, channelId: string): SlackOutboxEntry {
  return {
    workspaceId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    slackAppId: crypto.randomUUID(),
    installationId: crypto.randomUUID(),
    kind,
    channelId,
    threadTs: kind === "model_notice" ? "" : "100.000100",
    slackUserId: null,
    sessionId: null,
    body: { text: "Done." },
    dedupeKey: `${kind}:${channelId}`,
  };
}

const channels = async () =>
  (
    await client.query<{ channel_id: string }>(
      "SELECT channel_id FROM slack_outbox ORDER BY seq",
    )
  ).rows.map((row) => row.channel_id);

// Design v3 decision 45: the agent never opens a direct message first.
describe("enqueueing an outbox row whose channel is a Slack user id", () => {
  test("stores it as it stands", async () => {
    const outbox = createPostgresSlackOutboxStore(db);
    expect(await outbox.enqueue(entryOf("reply", "U0PERSON"))).toBe("enqueued");
    expect(await channels()).toEqual(["U0PERSON"]);
  });
});
