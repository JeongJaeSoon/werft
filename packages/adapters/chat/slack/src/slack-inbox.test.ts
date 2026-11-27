import { describe, expect, test } from "bun:test";
import {
  drainSlackInbox,
  SlackInboundDropped,
  type SlackInboxLogger,
  slackConversationKey,
  slackInboundBackoffMs,
} from "./slack-inbox.ts";
import { createMemorySlackInboundEventStore } from "./testing/slack-fakes.ts";

const noopSlackInboundHandler = async () => {};

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
      concurrency: 5,
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
      concurrency: 5,
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
      concurrency: 10,
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

  test("the input a handler returns completes with its row; a failed or dropped event takes none", async () => {
    const inbox = createMemorySlackInboundEventStore();
    for (const id of ["Ev1", "Ev2", "Ev3"]) await received(inbox, id);
    const input = {
      topicId: "019a0000-0000-7000-8000-0000000000c1",
      channelId: "C1",
      ts: "100.000100",
      turn: { sessionId: "019a0000-0000-7000-8000-0000000000c2", sequence: 7 },
      engagement: "mention",
    } as const;
    const drain = await drainSlackInbox({
      inbox: inbox.store,
      handler: async (event) => {
        if (event.eventId === "Ev2") throw new Error("boom");
        if (event.eventId === "Ev3")
          throw new SlackInboundDropped("channel_left");
        return input as never;
      },
      logger: recorder().logger,
      concurrency: 5,
      leaseMs: 60_000,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(drain).toMatchObject({ processed: 1, retried: 1, dropped: 1 });
    expect(inbox.inputs).toEqual([input as never]);
  });

  test("the no-op handler marks every claimed event processed", async () => {
    const inbox = createMemorySlackInboundEventStore();
    await received(inbox, "Ev1");
    await received(inbox, "Ev2");
    const drain = await drainSlackInbox({
      inbox: inbox.store,
      handler: noopSlackInboundHandler,
      logger: recorder().logger,
      concurrency: 1,
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
      concurrency: 1,
      leaseMs: 60_000,
      deadline: 1_000_001,
      now: () => clock,
    });
    expect(drain).toMatchObject({ claimed: 1, processed: 0, lost: 1 });
    expect(lines).toContain("Slack event lease lost; left to its next claim");
    expect([...inbox.lease.values()][0]?.state).toBe("received");
  });

  test("the deadline stops new claims", async () => {
    let clock = 0;
    const inbox = createMemorySlackInboundEventStore({ now: () => clock });
    for (const id of ["Ev1", "Ev2", "Ev3"]) await received(inbox, id);
    const drain = await drainSlackInbox({
      inbox: inbox.store,
      handler: async () => {
        clock += 10;
      },
      logger: recorder().logger,
      concurrency: 1,
      leaseMs: 60_000,
      deadline: 15,
      now: () => clock,
    });
    expect(drain).toMatchObject({ claimed: 2, processed: 2 });
  });
});

describe("drainSlackInbox lines", () => {
  /** A received event in `channel` (none when omitted) of app `s`. */
  async function inChannel(
    inbox: ReturnType<typeof createMemorySlackInboundEventStore>,
    eventId: string,
    eventType: string,
    event: Record<string, unknown>,
  ) {
    await inbox.store.record({
      workspaceId: "w",
      agentId: "a",
      slackAppId: "s",
      teamId: "T1",
      appId: "A1",
      eventId,
      eventType,
      eventSubtype: null,
      eventTime: null,
      status: "received",
      payload: { event: { type: eventType, ...event } },
      conversationKey: null,
    });
  }

  /** A handler whose events end only when the test lets them. */
  function gated() {
    const started: string[] = [];
    const ended: string[] = [];
    const gates = new Map<string, () => void>();
    let waiters: (() => void)[] = [];
    const handler = async (event: { eventId: string }) => {
      started.push(event.eventId);
      for (const wake of waiters) wake();
      waiters = [];
      await new Promise<void>((open) => gates.set(event.eventId, open));
      ended.push(event.eventId);
    };
    const until = async (check: () => boolean) => {
      while (!check()) {
        await new Promise<void>((wake) => {
          waiters.push(wake);
          setTimeout(wake, 5);
        });
      }
    };
    const open = (eventId: string) => {
      const gate = gates.get(eventId);
      if (!gate) throw new Error(`${eventId} has not started`);
      gate();
    };
    return { handler, started, ended, until, open };
  }

  test("one channel keeps its order, a member leaving included; other channels run beside it", async () => {
    const inbox = createMemorySlackInboundEventStore();
    await inChannel(inbox, "Ev1", "app_mention", { channel: "C1", ts: "1.0" });
    await inChannel(inbox, "Ev2", "member_left_channel", {
      channel: "C1",
      user: "U1",
    });
    await inChannel(inbox, "Ev3", "app_mention", { channel: "C2", ts: "2.0" });
    await inChannel(inbox, "Ev4", "app_mention", { channel: "D9", ts: "3.0" });
    const lane = gated();
    const pass = drainSlackInbox({
      inbox: inbox.store,
      handler: lane.handler,
      logger: recorder().logger,
      concurrency: 8,
      leaseMs: 60_000,
      deadline: Number.POSITIVE_INFINITY,
    });
    await lane.until(() => lane.started.length === 3);
    expect(lane.started).toEqual(["Ev1", "Ev3", "Ev4"]);
    lane.open("Ev3");
    lane.open("Ev4");
    await lane.until(() => lane.ended.length === 2);
    // The member's leave waits for the mention before it in its channel.
    expect(lane.started).not.toContain("Ev2");
    lane.open("Ev1");
    await lane.until(() => lane.started.includes("Ev2"));
    lane.open("Ev2");
    expect(await pass).toMatchObject({ claimed: 4, processed: 4 });
    expect(lane.ended).toEqual(["Ev3", "Ev4", "Ev1", "Ev2"]);
  });

  test("a thread in backoff holds back its own later posts and a channel event behind it; other threads go on", async () => {
    let clock = 1_000_000;
    const inbox = createMemorySlackInboundEventStore({ now: () => clock });
    const post = async (eventId: string, event: Record<string, unknown>) =>
      inbox.store.record({
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
        payload: { event: { type: "app_mention", ...event } },
        conversationKey: slackConversationKey("s", event),
      });
    await post("Ev1", { channel: "C1", ts: "1.0" });
    await post("Ev2", { channel: "C1", ts: "2.0", thread_ts: "1.0" });
    await post("Ev3", { channel: "C1", ts: "3.0" });
    const ran: string[] = [];
    let failing = true;
    const pass = () =>
      drainSlackInbox({
        inbox: inbox.store,
        handler: async (event) => {
          if (event.eventId === "Ev1" && failing) throw new Error("boom");
          ran.push(event.eventId);
        },
        logger: recorder().logger,
        concurrency: 4,
        leaseMs: 60_000,
        deadline: Number.POSITIVE_INFINITY,
        now: () => clock,
      });
    expect(await pass()).toMatchObject({ retried: 1, processed: 1 });
    // Ev1 waits out its backoff: its reply waits, the other thread does not.
    expect(ran).toEqual(["Ev3"]);
    await inChannel(inbox, "Ev4", "member_left_channel", {
      channel: "C1",
      user: "U1",
    });
    await post("Ev5", { channel: "C1", ts: "5.0" });
    expect(await pass()).toMatchObject({ claimed: 0 });
    failing = false;
    clock += slackInboundBackoffMs(1);
    expect(await pass()).toMatchObject({ processed: 4 });
    expect(ran).toEqual(["Ev3", "Ev1", "Ev2", "Ev4", "Ev5"]);
  });

  test("no more run at once than the concurrency, and each claim leases only what starts", async () => {
    const inbox = createMemorySlackInboundEventStore();
    for (let i = 1; i <= 6; i += 1) {
      await inChannel(inbox, `Ev${i}`, "app_mention", {
        channel: `C${i}`,
        ts: `${i}.0`,
      });
    }
    const lane = gated();
    const pass = drainSlackInbox({
      inbox: inbox.store,
      handler: lane.handler,
      logger: recorder().logger,
      concurrency: 2,
      leaseMs: 60_000,
      deadline: Number.POSITIVE_INFINITY,
    });
    await lane.until(() => lane.started.length === 2);
    await new Promise((wake) => setTimeout(wake, 20));
    expect(lane.started).toEqual(["Ev1", "Ev2"]);
    const leased = [...inbox.lease.values()].filter(
      (row) => row.leaseExpiresAt !== null,
    );
    expect(leased.map((row) => row.eventId)).toEqual(["Ev1", "Ev2"]);
    lane.open("Ev1");
    await lane.until(() => lane.started.length === 3);
    expect(lane.started[2]).toBe("Ev3");
    for (const id of ["Ev2", "Ev3"]) lane.open(id);
    await lane.until(() => lane.started.length === 5);
    for (const id of ["Ev4", "Ev5"]) lane.open(id);
    await lane.until(() => lane.started.length === 6);
    lane.open("Ev6");
    expect(await pass).toMatchObject({ claimed: 6, processed: 6 });
  });

  test("past the deadline nothing new is claimed and what runs ends", async () => {
    let clock = 0;
    const inbox = createMemorySlackInboundEventStore({ now: () => clock });
    for (const [id, channel] of [
      ["Ev1", "C1"],
      ["Ev2", "C2"],
      ["Ev3", "C3"],
    ] as const) {
      await inChannel(inbox, id, "app_mention", { channel, ts: "1.0" });
    }
    const lane = gated();
    const pass = drainSlackInbox({
      inbox: inbox.store,
      handler: lane.handler,
      logger: recorder().logger,
      concurrency: 2,
      leaseMs: 60_000,
      deadline: 15,
      now: () => clock,
    });
    await lane.until(() => lane.started.length === 2);
    clock = 20;
    lane.open("Ev1");
    lane.open("Ev2");
    expect(await pass).toMatchObject({ claimed: 2, processed: 2 });
    expect(lane.started).toEqual(["Ev1", "Ev2"]);
    expect([...inbox.lease.values()][2]).toMatchObject({
      state: "received",
      leaseExpiresAt: null,
    });
  });

  test("an install revoked under work in flight: the event drops at its renew, and later claims drop too", async () => {
    let status: "verified" | "revoked" = "verified";
    const inbox = createMemorySlackInboundEventStore({
      installationStatus: () => status,
    });
    await inChannel(inbox, "Ev1", "app_mention", { channel: "C1", ts: "1.0" });
    await inChannel(inbox, "Ev2", "app_mention", { channel: "C1", ts: "2.0" });
    const handled: string[] = [];
    const drain = await drainSlackInbox({
      inbox: inbox.store,
      handler: async (event) => {
        handled.push(event.eventId);
        // The uninstall lands while this event is in flight.
        status = "revoked";
        // As the session handler does before an effect outside the inbox.
        const held = await inbox.store.renew(event, 60_000);
        if (held?.installationStatus === "revoked") {
          throw new SlackInboundDropped("installation_revoked");
        }
      },
      logger: recorder().logger,
      concurrency: 4,
      leaseMs: 60_000,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(handled).toEqual(["Ev1"]);
    expect(drain).toMatchObject({ claimed: 2, dropped: 2, processed: 0 });
    expect([...inbox.lease.values()].map((row) => row.dropped)).toEqual([
      "installation_revoked",
      "installation_revoked",
    ]);
  });

  test("a claim that read a channel as busy while its last work ended is asked once more", async () => {
    const inbox = createMemorySlackInboundEventStore();
    await inChannel(inbox, "Ev1", "app_mention", { channel: "C1", ts: "1.0" });
    await inChannel(inbox, "Ev2", "app_mention", { channel: "C1", ts: "2.0" });
    const claim = inbox.store.claim.bind(inbox.store);
    let claims = 0;
    inbox.store.claim = async (options) => {
      claims += 1;
      const rows = await claim(options);
      // Read while Ev1 still held C1, answered after Ev1 ended.
      if (claims === 2) await new Promise((wake) => setTimeout(wake, 20));
      return rows;
    };
    const drained = await drainSlackInbox({
      inbox: inbox.store,
      handler: noopSlackInboundHandler,
      logger: recorder().logger,
      concurrency: 2,
      leaseMs: 60_000,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(drained).toMatchObject({ claimed: 2, processed: 2 });
  });

  test("a claim that read a channel as busy while only its work ended is asked once more", async () => {
    const inbox = createMemorySlackInboundEventStore();
    await inChannel(inbox, "Ev1", "app_mention", { channel: "C1", ts: "1.0" });
    await inChannel(inbox, "Ev2", "app_mention", { channel: "C2", ts: "1.0" });
    await inChannel(inbox, "Ev3", "app_mention", { channel: "C1", ts: "2.0" });
    const lane = gated();
    const claim = inbox.store.claim.bind(inbox.store);
    let claims = 0;
    inbox.store.claim = async (options) => {
      claims += 1;
      const rows = await claim(options);
      // Read while Ev1 still held C1, answered after Ev1 ended; Ev2 runs on.
      if (claims === 2) {
        lane.open("Ev1");
        await new Promise((wake) => setTimeout(wake, 20));
      }
      return rows;
    };
    const drained = drainSlackInbox({
      inbox: inbox.store,
      handler: lane.handler,
      logger: recorder().logger,
      concurrency: 3,
      leaseMs: 60_000,
      deadline: Number.POSITIVE_INFINITY,
    });
    await new Promise((wake) => setTimeout(wake, 60));
    const startedBeforeEv2Ended = [...lane.started];
    lane.open("Ev2");
    await lane.until(() => lane.started.includes("Ev3"));
    lane.open("Ev3");
    expect(await drained).toMatchObject({ claimed: 3, processed: 3 });
    expect(startedBeforeEv2Ended).toEqual(["Ev1", "Ev2", "Ev3"]);
  });

  test("a store write that throws while the next claim is out still fails the pass", async () => {
    const inbox = createMemorySlackInboundEventStore();
    await inChannel(inbox, "Ev1", "app_mention", { channel: "C1", ts: "1.0" });
    const claim = inbox.store.claim.bind(inbox.store);
    let claims = 0;
    inbox.store.claim = async (options) => {
      claims += 1;
      // The second claim is still out when Ev1's completion throws.
      if (claims === 2) await new Promise((wake) => setTimeout(wake, 20));
      return claim(options);
    };
    inbox.store.complete = async () => {
      throw new Error("database gone");
    };
    await expect(
      drainSlackInbox({
        inbox: inbox.store,
        handler: noopSlackInboundHandler,
        logger: recorder().logger,
        concurrency: 2,
        leaseMs: 60_000,
        deadline: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("database gone");
  });

  test("a store write that throws still fails the pass, after the rest in flight end", async () => {
    const inbox = createMemorySlackInboundEventStore();
    await inChannel(inbox, "Ev1", "app_mention", { channel: "C1", ts: "1.0" });
    await inChannel(inbox, "Ev2", "app_mention", { channel: "C2", ts: "1.0" });
    const complete = inbox.store.complete.bind(inbox.store);
    inbox.store.complete = async (fence, input) => {
      if (fence.id === [...inbox.lease.values()][0]?.id) {
        throw new Error("database gone");
      }
      return complete(fence, input);
    };
    const handled: string[] = [];
    await expect(
      drainSlackInbox({
        inbox: inbox.store,
        handler: async (event) => {
          handled.push(event.eventId);
          if (event.eventId === "Ev2") {
            await new Promise((wake) => setTimeout(wake, 20));
          }
        },
        logger: recorder().logger,
        concurrency: 4,
        leaseMs: 60_000,
        deadline: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("database gone");
    expect(handled).toEqual(["Ev1", "Ev2"]);
    expect([...inbox.lease.values()][1]?.state).toBe("processed");
  });
});
