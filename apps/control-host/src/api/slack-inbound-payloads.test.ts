import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import {
  agents,
  slackApps,
  slackInboundEvents,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  parseSlackInboundPayloadsCommand,
  runSlackInboundPayloads,
  SLACK_INBOUND_PAYLOADS_EXIT,
} from "./slack-inbound-payloads.ts";

let client: PGlite;
beforeAll(async () => {
  client = await migratedPGlite();
}, 60_000);
afterAll(async () => {
  await client.close();
});

function io(
  env: Record<string, string | undefined> = {
    DATABASE_URL: "postgres://unused",
  },
) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = 0;
  return {
    out,
    err,
    io: {
      env,
      out: (line: string) => out.push(line),
      err: (line: string) => err.push(line),
      openDatabase: async () => ({
        db: drizzle(client, { schema }),
        close: async () => {},
      }),
      now: () => {
        clock += 250;
        return clock;
      },
    },
  };
}

async function seed() {
  const db = drizzle(client, { schema });
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
    appId: `A${randomUUID().slice(0, 8)}`,
    clientId: "1.1",
    redirectUrl: "https://console.example/cb",
  });
  const rows = [
    ...Array.from({ length: 3 }, () => ["processed", true] as const),
    ["received", true] as const,
    ["failed", true] as const,
  ];
  await db.insert(slackInboundEvents).values(
    rows.map(([status, payload], n) => ({
      id: randomUUID(),
      workspaceId,
      agentId,
      slackAppId,
      teamId: "T0D4",
      appId: "A0D4",
      eventId: `Ev${randomUUID()}-${n}`,
      eventType: "app_mention",
      status,
      payload: payload ? { event: { text: "hi" } } : null,
    })),
  );
}

test("the batch size defaults to 1000 and takes 1 to 10000", () => {
  expect(parseSlackInboundPayloadsCommand([])).toEqual({ batchSize: 1000 });
  expect(parseSlackInboundPayloadsCommand(["--batch-size", "250"])).toEqual({
    batchSize: 250,
  });
  expect(parseSlackInboundPayloadsCommand(["--batch-size=10000"])).toEqual({
    batchSize: 10_000,
  });
  for (const argv of [
    ["--batch-size", "0"],
    ["--batch-size", "10001"],
    ["--batch-size", "1.5"],
    ["--batch-size", "-1"],
    ["--dry-run"],
    ["clear"],
  ]) {
    expect(() => parseSlackInboundPayloadsCommand(argv)).toThrow("Usage:");
  }
});

test("usage errors and a missing DATABASE_URL exit 2 without opening the database", async () => {
  const bad = io();
  expect(await runSlackInboundPayloads(["--batch-size", "0"], bad.io)).toBe(
    SLACK_INBOUND_PAYLOADS_EXIT.usage,
  );
  expect(bad.out).toEqual([]);
  const noUrl = io({});
  expect(await runSlackInboundPayloads([], noUrl.io)).toBe(
    SLACK_INBOUND_PAYLOADS_EXIT.usage,
  );
  expect(noUrl.err).toEqual([
    "slack-inbound-payloads: DATABASE_URL is required",
  ]);
});

test("prints one JSON line with counts before and after; a second run clears nothing", async () => {
  await seed();
  const first = io();
  expect(await runSlackInboundPayloads(["--batch-size", "2"], first.io)).toBe(
    SLACK_INBOUND_PAYLOADS_EXIT.ok,
  );
  expect(first.out.map((line) => JSON.parse(line))).toEqual([
    {
      outcome: "cleared",
      before: { received: 1, dropped: 0, processed: 3, failed: 1 },
      after: { received: 1, dropped: 0, processed: 0, failed: 1 },
      cleared: 3,
      batches: 3,
      batch_size: 2,
      duration_ms: 250,
    },
  ]);
  const second = io();
  expect(await runSlackInboundPayloads([], second.io)).toBe(
    SLACK_INBOUND_PAYLOADS_EXIT.ok,
  );
  expect(JSON.parse(second.out[0] ?? "")).toMatchObject({
    outcome: "cleared",
    before: { received: 1, dropped: 0, processed: 0, failed: 1 },
    after: { received: 1, dropped: 0, processed: 0, failed: 1 },
    cleared: 0,
    batches: 1,
    batch_size: 1000,
  });
});

test("a processed row that keeps its payload afterwards exits 3", async () => {
  await seed();
  // Stands in for a host on an earlier release completing rows meanwhile.
  await client.exec(`
    CREATE FUNCTION keep_payload() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.payload := OLD.payload; RETURN NEW; END $$;
    CREATE TRIGGER keep_payload BEFORE UPDATE ON slack_inbound_events
      FOR EACH ROW EXECUTE FUNCTION keep_payload();`);
  try {
    const run = io();
    expect(await runSlackInboundPayloads([], run.io)).toBe(
      SLACK_INBOUND_PAYLOADS_EXIT.incomplete,
    );
    expect(JSON.parse(run.out[0] ?? "")).toMatchObject({
      outcome: "incomplete",
      before: { processed: 3 },
      after: { processed: 3 },
    });
  } finally {
    await client.exec(
      "DROP TRIGGER keep_payload ON slack_inbound_events; DROP FUNCTION keep_payload()",
    );
  }
});
