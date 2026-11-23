import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SurfaceOutboxEntry, SurfaceOutboxKind } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { slackOutbox } from "../schema.ts";
import {
  createPostgresSlackOutboxStore,
  SlackOutboxUserChannelError,
} from "./slack-outbox.ts";

let client: PGlite;
let db: Database;

beforeAll(async () => {
  client = await migratedPGlite();
  // The rows a row names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

afterEach(async () => {
  await client.exec("DELETE FROM slack_outbox");
});

afterAll(async () => {
  await client.close();
});

function entryOf(
  kind: SurfaceOutboxKind,
  channelId: string,
): SurfaceOutboxEntry {
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
    sessionLinkId: null,
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
  for (const channelId of ["U0PERSON", "W0GRIDPERSON"]) {
    test(`refuses a reply to ${channelId} and stores nothing`, async () => {
      const outbox = createPostgresSlackOutboxStore(db);
      await expect(
        outbox.enqueue(entryOf("reply", channelId)),
      ).rejects.toBeInstanceOf(SlackOutboxUserChannelError);
      expect(await channels()).toEqual([]);
    });
  }

  test("the table refuses one written around the store", async () => {
    const entry = entryOf("action_notice", "U0PERSON");
    const refused = await db
      .insert(slackOutbox)
      .values({ ...entry, id: crypto.randomUUID() })
      .then(
        () => null,
        (error: Error) => String(error.cause),
      );
    expect(refused).toContain("slack_outbox_channel_check");
    expect(await channels()).toEqual([]);
  });

  test("stores a model notice, the one direct message there is", async () => {
    const outbox = createPostgresSlackOutboxStore(db);
    expect(await outbox.enqueue(entryOf("model_notice", "U0PERSON"))).toBe(
      "enqueued",
    );
    expect(await channels()).toEqual(["U0PERSON"]);
  });
});

describe("enqueueing an outbox row whose channel is a conversation", () => {
  test("stores public, private and direct message channels", async () => {
    const outbox = createPostgresSlackOutboxStore(db);
    for (const channelId of ["C0PUBLIC", "G0PRIVATE", "D0DIRECT"]) {
      expect(await outbox.enqueue(entryOf("reply", channelId))).toBe(
        "enqueued",
      );
    }
    expect(await channels()).toEqual(["C0PUBLIC", "G0PRIVATE", "D0DIRECT"]);
  });
});
