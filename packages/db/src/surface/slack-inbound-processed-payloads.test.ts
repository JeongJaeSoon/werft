import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { SlackInboundEventStatus } from "@werft-ai/contracts";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "../migrate.ts";
import * as schema from "../schema.ts";
import {
  agents,
  slackApps,
  slackInboundEvents,
  workspaces,
} from "../schema.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import {
  countSlackInboundPayloads,
  purgeFailedSlackInboundPayloads,
  purgeProcessedSlackInboundPayloads,
} from "./slack-inbound-events.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: join(import.meta.dir, "../../migrations"),
  });
});

afterAll(async () => {
  await client.close();
});

const DAY_MS = 24 * 60 * 60_000;

/** Rows as the releases before payloads were cleared left them. */
async function seed() {
  const workspaceId = randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    workspaceId,
    managingTeamId: await fixtureTeam(db, workspaceId),
    slug: `a-${agentId.slice(0, 8)}`,
    name: "Notes",
  });
  const slackAppId = randomUUID();
  await db.insert(slackApps).values({
    id: slackAppId,
    workspaceId,
    kind: "agent",
    agentId,
    state: "created",
    appId: "A0D4",
    clientId: "1.1",
    redirectUrl: "https://console.example/cb",
  });
  let n = 0;
  const insert = async (
    status: SlackInboundEventStatus,
    input: { payload: boolean; daysAgo?: number },
  ) => {
    n += 1;
    const eventId = `Ev${n}`;
    await db.insert(slackInboundEvents).values({
      id: randomUUID(),
      workspaceId,
      agentId,
      slackAppId,
      teamId: "T0D4",
      appId: "A0D4",
      eventId,
      eventType: "app_mention",
      status,
      dropReason: status === "dropped" ? "bot_message" : null,
      payload: input.payload
        ? { event_id: eventId, event: { text: "hi" } }
        : null,
      receivedAt: new Date(Date.now() - (input.daysAgo ?? 30) * DAY_MS),
    });
    return eventId;
  };
  const processed = [];
  for (let i = 0; i < 5; i++)
    processed.push(await insert("processed", { payload: true }));
  return {
    processed,
    cleared: await insert("processed", { payload: false }),
    received: await insert("received", { payload: true }),
    failedRecent: await insert("failed", { payload: true, daysAgo: 6 }),
    failedOld: await insert("failed", { payload: true, daysAgo: 8 }),
    dropped: await insert("dropped", { payload: false }),
  };
}

async function payloadOf(eventId: string) {
  const [row] = await db
    .select({ payload: slackInboundEvents.payload })
    .from(slackInboundEvents)
    .where(eq(slackInboundEvents.eventId, eventId));
  if (row === undefined) throw new Error(`no row ${eventId}`);
  return row.payload;
}

test("clears processed rows' payloads in batches and leaves received and failed rows; a second run is the same", async () => {
  const rows = await seed();
  const receivedBefore = await payloadOf(rows.received);
  const before = { received: 1, dropped: 0, processed: 5, failed: 2 };
  expect(await countSlackInboundPayloads(db, { pageSize: 1000 })).toEqual(
    before,
  );
  // A page smaller than the table walks it in several statements.
  expect(await countSlackInboundPayloads(db, { pageSize: 3 })).toEqual(before);

  // Ten rows in batches of two.
  expect(
    await purgeProcessedSlackInboundPayloads(db, { batchSize: 2 }),
  ).toEqual({
    cleared: 5,
    batches: 5,
  });
  const after = { received: 1, dropped: 0, processed: 0, failed: 2 };
  expect(await countSlackInboundPayloads(db, { pageSize: 3 })).toEqual(after);
  for (const id of rows.processed) expect(await payloadOf(id)).toBeNull();
  expect(await payloadOf(rows.received)).toEqual(receivedBefore);
  expect(await payloadOf(rows.failedRecent)).not.toBeNull();
  // The reconciler's 7 days, not this pass, clear a failed row.
  expect(await payloadOf(rows.failedOld)).not.toBeNull();

  expect(
    await purgeProcessedSlackInboundPayloads(db, { batchSize: 2 }),
  ).toEqual({
    cleared: 0,
    batches: 5,
  });
  expect(await countSlackInboundPayloads(db, { pageSize: 1000 })).toEqual(
    after,
  );

  // The reconciler still takes the old failed row, and only it.
  expect(
    await purgeFailedSlackInboundPayloads(db, { limit: 100, dryRun: false }),
  ).toBe(1);
  expect(await payloadOf(rows.failedRecent)).not.toBeNull();
});

test("an empty inbox counts zero in every status and runs no batch", async () => {
  await db.execute(sql`DELETE FROM slack_inbound_events`);
  expect(await countSlackInboundPayloads(db, { pageSize: 10 })).toEqual({
    received: 0,
    dropped: 0,
    processed: 0,
    failed: 0,
  });
  expect(
    await purgeProcessedSlackInboundPayloads(db, { batchSize: 10 }),
  ).toEqual({
    cleared: 0,
    batches: 0,
  });
});
