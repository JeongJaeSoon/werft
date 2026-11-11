import { describe, expect, test } from "bun:test";
import {
  drainSlackInbox,
  noopSlackInboundHandler,
  type SlackInboxLogger,
  slackConversationKey,
  slackInboundBackoffMs,
} from "./slack-inbox.ts";
import { createMemorySlackInboundEventStore } from "./testing/slack-fakes.ts";

function recorder() {
  const lines: string[] = [];
  const logger: SlackInboxLogger = {
    info: (message) => lines.push(message),
    warn: (message) => lines.push(message),
  };
  return { lines, logger };
}

async function received(
  inbox: ReturnType<typeof createMemorySlackInboundEventStore>,
  eventId: string,
) {
  await inbox.store.record({
    workspaceId: "w",
    agentId: "a",
    slackAppId: "s",
    teamId: "T1",
    appId: "A1",
    eventId,
    eventType: "app_mention",
    eventSubtype: null,
    eventTime: null,
    status: "received",
    payload: {},
    conversationKey: null,
  });
}

describe("slackConversationKey", () => {
  test("a reply keys to its thread, a top-level message to itself", () => {
    expect(
      slackConversationKey("app", {
        channel: "C1",
        ts: "2.0",
        thread_ts: "1.0",
      }),
    ).toBe("app:C1:1.0");
    expect(slackConversationKey("app", { channel: "D1", ts: "2.0" })).toBe(
      "app:D1:2.0",
    );
    expect(slackConversationKey("app", { type: "app_uninstalled" })).toBeNull();
    expect(slackConversationKey("app", { channel: "C1" })).toBeNull();
  });

  // The database's backfill migration derives the same key in SQL; its test
  // lists these three inputs with these three results.
  test("an empty thread falls back to the message, and an empty or non-string field gives no key", () => {
    expect(
      slackConversationKey("app", { channel: "C1", ts: "5.0", thread_ts: "" }),
    ).toBe("app:C1:5.0");
    expect(slackConversationKey("app", { channel: "", ts: "6.0" })).toBeNull();
    expect(slackConversationKey("app", { channel: "C1", ts: 7 })).toBeNull();
  });
});

describe("slackInboundBackoffMs", () => {
  test("backoff doubles from 30s and stops at 5 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(slackInboundBackoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
  });
});

describe("drainSlackInbox", () => {
  test("a handler that throws gives the event back with its backoff", async () => {
    let clock = 1_000_000;
    const inbox = createMemorySlackInboundEventStore({ now: () => clock });
    await received(inbox, "Ev1");
    const { lines, logger } = recorder();
    const drain = await drainSlackInbox({
      inbox: inbox.store,
      handler: async () => {
        throw new Error("boom");
      },
      logger,
      batchSize: 5,
      leaseMs: 60_000,
      deadline: Number.POSITIVE_INFINITY,
      now: () => clock,
    });
    expect(drain).toMatchObject({ claimed: 1, retried: 1, processed: 0 });
    expect(lines).toEqual([
      "Slack event claimed",
      "Slack event failed; retried later",
    ]);
    const row = [...inbox.lease.values()][0];
    expect(row).toMatchObject({ state: "received", attempts: 1 });
    expect(row?.nextAttemptAt).toBe(clock + 30_000);
    clock += 30_000;
    const after = await drainSlackInbox({
      inbox: inbox.store,
      handler: async () => {},
      logger,
      batchSize: 5,
      leaseMs: 60_000,
      deadline: Number.POSITIVE_INFINITY,
      now: () => clock,
    });
    expect(after).toMatchObject({ claimed: 1, processed: 1 });
  });

  test("an install revoked while the event waited drops it without calling the handler", async () => {
    const inbox = createMemorySlackInboundEventStore({
      installationStatus: () => "revoked",
    });
    await received(inbox, "Ev1");
    const handled: string[] = [];
    const drain = await drainSlackInbox({
      inbox: inbox.store,
      handler: async (event) => {
        handled.push(event.eventId);
      },
      logger: recorder().logger,
      batchSize: 10,
      leaseMs: 60_000,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(handled).toEqual([]);
    expect(drain).toMatchObject({ claimed: 1, dropped: 1, processed: 0 });
    expect([...inbox.lease.values()][0]).toMatchObject({
      state: "dropped",
      dropped: "installation_revoked",
    });
  });

  test("the no-op handler marks every claimed event processed", async () => {
    const inbox = createMemorySlackInboundEventStore();
    await received(inbox, "Ev1");
    await received(inbox, "Ev2");
    const drain = await drainSlackInbox({
      inbox: inbox.store,
      handler: noopSlackInboundHandler,
      logger: recorder().logger,
      batchSize: 1,
      leaseMs: 60_000,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(drain).toMatchObject({ claimed: 2, processed: 2 });
    expect([...inbox.lease.values()].map((row) => row.state)).toEqual([
      "processed",
      "processed",
    ]);
  });

  test("a lease lost under the handler writes nothing and says so", async () => {
    let clock = 1_000_000;
    const inbox = createMemorySlackInboundEventStore({ now: () => clock });
    await received(inbox, "Ev1");
    const { lines, logger } = recorder();
    const drain = await drainSlackInbox({
      inbox: inbox.store,
      handler: async () => {
        clock += 61_000;
      },
      logger,
      batchSize: 1,
      leaseMs: 60_000,
      deadline: 1_000_001,
      now: () => clock,
    });
    expect(drain).toMatchObject({ claimed: 1, processed: 0, lost: 1 });
    expect(lines).toContain("Slack event lease lost; left to its next claim");
    expect([...inbox.lease.values()][0]?.state).toBe("received");
  });

  test("the deadline ends the pass between batches", async () => {
    let clock = 0;
    const inbox = createMemorySlackInboundEventStore({ now: () => clock });
    for (const id of ["Ev1", "Ev2", "Ev3"]) await received(inbox, id);
    const drain = await drainSlackInbox({
      inbox: inbox.store,
      handler: async () => {
        clock += 10;
      },
      logger: recorder().logger,
      batchSize: 1,
      leaseMs: 60_000,
      deadline: 15,
      now: () => clock,
    });
    expect(drain).toMatchObject({ claimed: 2, processed: 2 });
  });
});
