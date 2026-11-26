import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { conversationTurnIdSchema } from "@werft-ai/contracts";
import { CONVERSATION_TURN_QUEUE_CHANNEL } from "@werft-ai/db";
import { createLogger, MemoryLogSink } from "@werft-ai/observability";
import type { Client } from "pg";
import { PostgresConversationTurnNotifier } from "./conversation-turn-notifier.ts";

// Enough of pg.Client for LISTEN: connect, one query, events, end.
class FakeClient extends EventEmitter {
  queries: string[] = [];
  ended = false;
  constructor(
    private readonly failConnect = false,
    private readonly connected: Promise<void> = Promise.resolve(),
  ) {
    super();
  }
  async connect() {
    await this.connected;
    if (this.failConnect) throw new Error("ECONNREFUSED");
  }
  async query(text: string) {
    this.queries.push(text);
    return { rows: [] };
  }
  async end() {
    this.ended = true;
  }
  notify(payload: string, channel = CONVERSATION_TURN_QUEUE_CHANNEL) {
    this.emit("notification", { channel, payload, processId: 1 });
  }
}

/**
 * A notifier over the given clients, one a connect. `carries` is whether a
 * notice told on another connection reaches the listening one: false is a
 * pooler in transaction mode.
 */
function notifier(clients: FakeClient[], carries = true) {
  let index = 0;
  const sink = new MemoryLogSink();
  const told: string[] = [];
  const instance = new PostgresConversationTurnNotifier(
    "postgresql://unused",
    async (payload) => {
      told.push(payload);
      if (carries) clients[index - 1]?.notify(payload);
    },
    createLogger({ sinks: [sink], level: "debug" }),
    {
      reconnectDelayMs: 10,
      proofTimeoutMs: 20,
      connect: () => {
        const client = clients[index] ?? clients[clients.length - 1];
        index += 1;
        if (!client) throw new Error("no client");
        return client as unknown as Client;
      },
    },
  );
  return { instance, sink, told };
}

async function settled(promise: Promise<void>, withinMs = 200) {
  const result = await Promise.race([
    promise.then(() => "settled" as const),
    Bun.sleep(withinMs).then(() => "pending" as const),
  ]);
  return result === "settled";
}

const turnId = () => conversationTurnIdSchema.parse(crypto.randomUUID());
const never = () => new AbortController().signal;

describe("PostgresConversationTurnNotifier", () => {
  test("counts as listening only once a notice told on another connection comes back", async () => {
    const client = new FakeClient();
    const { instance, told } = notifier([client]);
    expect(instance.listening).toBe(false);
    await instance.start();
    expect(client.queries).toEqual([
      `LISTEN ${CONVERSATION_TURN_QUEUE_CHANNEL}`,
    ]);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/^proof:[0-9a-f-]{36}$/);
    expect(instance.listening).toBe(true);
    await instance.close();
    expect(client.ended).toBe(true);
  });

  test("a notice that never comes back, as through a pooler in transaction mode, leaves it not listening and says so once", async () => {
    const client = new FakeClient();
    const { instance, sink } = notifier([client], false);
    await instance.start();
    await Bun.sleep(60);
    expect(instance.listening).toBe(false);
    // Another listener's proof is not this one's.
    client.notify("proof:00000000-0000-4000-8000-000000000000");
    expect(instance.listening).toBe(false);
    expect(
      sink.records.filter((record) =>
        record.message.includes("the turn queue is polled instead"),
      ),
    ).toHaveLength(1);
    await instance.close();
  });

  test("a turn queued wakes whoever waits for the next turn; a turn's end wakes them and whoever waits for that turn", async () => {
    const client = new FakeClient();
    const { instance } = notifier([client]);
    await instance.start();
    const mine = turnId();

    const next = instance.wait("next", never());
    const end = instance.wait(mine, never());
    client.notify("queued", "other_channel");
    expect(await settled(next, 30)).toBe(false);
    client.notify("queued");
    expect(await settled(next)).toBe(true);
    expect(await settled(end, 30)).toBe(false);

    const nextAgain = instance.wait("next", never());
    client.notify(turnId());
    expect(await settled(nextAgain)).toBe(true);
    expect(await settled(end, 30)).toBe(false);
    client.notify(mine);
    expect(await settled(end)).toBe(true);
    await instance.close();
  });

  test("an aborted wait leaves no waiter behind", async () => {
    const client = new FakeClient();
    const { instance } = notifier([client]);
    await instance.start();
    const controller = new AbortController();
    const waiting = instance.wait("next", controller.signal);
    controller.abort();
    expect(await settled(waiting)).toBe(true);
    expect(await settled(instance.wait("next", controller.signal))).toBe(true);
    // A later notice has nothing to resolve; nothing throws.
    client.notify("queued");
    await instance.close();
  });

  test("a lost connection stops listening, sends its waiters back to polling, and proves itself again once reconnected", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const { instance, sink, told } = notifier([first, second]);
    await instance.start();
    const waiting = instance.wait("next", never());

    first.emit("error", new Error("server closed the connection"));
    expect(instance.listening).toBe(false);
    expect(await settled(waiting)).toBe(true);
    for (let i = 0; i < 50 && !instance.listening; i += 1) await Bun.sleep(5);
    expect(instance.listening).toBe(true);
    expect(second.queries).toEqual([
      `LISTEN ${CONVERSATION_TURN_QUEUE_CHANNEL}`,
    ]);
    expect(new Set(told).size).toBe(2);
    expect(first.ended).toBe(true);
    expect(
      sink.records.some((record) =>
        record.message.includes("disconnected; reconnecting"),
      ),
    ).toBe(true);
    await instance.close();
  });

  test("closed while it connects, it proves nothing and warns of nothing", async () => {
    let connect = () => {};
    const client = new FakeClient(
      false,
      new Promise<void>((resolve) => {
        connect = resolve;
      }),
    );
    const { instance, sink, told } = notifier([client], false);
    const starting = instance.start();
    await instance.close();
    connect();
    await starting;
    await Bun.sleep(60);
    expect(told).toEqual([]);
    expect(instance.listening).toBe(false);
    expect(sink.records.map((record) => record.message)).toEqual([]);
  });

  test("retries a failed first connection in the background, and close stops the retries", async () => {
    const failing = new FakeClient(true);
    const healthy = new FakeClient();
    const { instance } = notifier([failing, healthy]);
    await instance.start();
    expect(instance.listening).toBe(false);
    for (let i = 0; i < 50 && !instance.listening; i += 1) await Bun.sleep(5);
    expect(instance.listening).toBe(true);
    await instance.close();

    const stopped = notifier([new FakeClient(true)]);
    await stopped.instance.start();
    await stopped.instance.close();
    await Bun.sleep(30);
    expect(stopped.instance.listening).toBe(false);
  });
});
