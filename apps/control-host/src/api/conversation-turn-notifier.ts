import { randomUUID } from "node:crypto";
import type { ConversationTurnId } from "@werft-ai/contracts";
import { CONVERSATION_TURN_QUEUE_CHANNEL } from "@werft-ai/db";
import { lookupEveryTimeStream } from "@werft-ai/db/pool";
import type { StructuredLogger } from "@werft-ai/observability";
import type { ConversationTurnWakeup } from "@werft-ai/platform";
import { Client } from "pg";

export interface PostgresConversationTurnNotifierOptions {
  reconnectDelayMs?: number;
  /** How long the proving notice may take to come back. */
  proofTimeoutMs?: number;
  connect?: () => Client;
}

/**
 * Hears the conversation turn queue's channel on one dedicated connection,
 * as PostgresSessionNotifier hears session events, and wakes the polls that
 * wait on the queue.
 *
 * Through a pooler in transaction mode LISTEN succeeds and no notice ever
 * arrives. So after each connect this sends one notice through `tell`, on
 * another connection, and counts as listening only once that notice comes
 * back here. Until then, and while the connection is down, the polls keep
 * their own short interval.
 */
export class PostgresConversationTurnNotifier
  implements ConversationTurnWakeup
{
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #connect: () => Client;
  readonly #tell: (payload: string) => Promise<void>;
  readonly #reconnectDelayMs: number;
  readonly #proofTimeoutMs: number;
  readonly #logger: StructuredLogger;
  #client: Client | null = null;
  #listening = false;
  #closed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #proofTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    connectionString: string,
    tell: (payload: string) => Promise<void>,
    logger: StructuredLogger,
    options: PostgresConversationTurnNotifierOptions = {},
  ) {
    this.#tell = tell;
    this.#logger = logger;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.#proofTimeoutMs = options.proofTimeoutMs ?? 5_000;
    this.#connect =
      options.connect ??
      (() =>
        new Client({
          connectionString,
          stream: lookupEveryTimeStream,
          application_name: "werft:api-listen-turns",
        }));
  }

  get listening(): boolean {
    return this.#listening;
  }

  // Resolves once LISTEN is in place and the proving notice is sent; a lost
  // connection reconnects in the background, as a failed first attempt does.
  async start(): Promise<void> {
    if (this.#closed || this.#client) return;
    const client = this.#connect();
    this.#client = client;
    const proof = `proof:${randomUUID()}`;
    client.on("notification", (message) => {
      if (message.channel !== CONVERSATION_TURN_QUEUE_CHANNEL) return;
      if (message.payload === proof) return this.#proved(client);
      if (!message.payload) return;
      // A turn queued or ended may free the next one; an end is also news
      // to whoever waits for that turn.
      this.#wake("next");
      this.#wake(message.payload);
    });
    client.on("error", (error) => this.#lost(client, error));
    client.on("end", () => this.#lost(client, null));
    try {
      await client.connect();
      await client.query(`LISTEN ${CONVERSATION_TURN_QUEUE_CHANNEL}`);
      // Closed or lost while it connected: nothing is left to prove.
      if (this.#client !== client) return;
      this.#proofTimer = setTimeout(
        () => this.#unproved(client, "TimedOut"),
        this.#proofTimeoutMs,
      );
      await this.#tell(proof).catch((error: unknown) =>
        this.#unproved(client, error instanceof Error ? error.name : "Error"),
      );
    } catch (error) {
      this.#lost(client, error);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#proofTimer) clearTimeout(this.#proofTimer);
    const client = this.#client;
    this.#client = null;
    this.#listening = false;
    this.#wakeAll();
    if (client) {
      client.removeAllListeners("error");
      client.removeAllListeners("end");
      client.on("error", () => {});
      await client.end().catch(() => {});
    }
  }

  wait(of: "next" | ConversationTurnId, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.#waiters.get(of) ?? new Set();
      this.#waiters.set(of, waiters);
      const done = () => {
        waiters.delete(done);
        if (waiters.size === 0) this.#waiters.delete(of);
        signal.removeEventListener("abort", done);
        resolve();
      };
      waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  #proved(client: Client): void {
    if (this.#client !== client || this.#listening) return;
    if (this.#proofTimer) clearTimeout(this.#proofTimer);
    this.#proofTimer = null;
    this.#listening = true;
    this.#logger.info("Conversation turn listener connected", {
      channel: CONVERSATION_TURN_QUEUE_CHANNEL,
    });
  }

  // Said once for a connection: the polls go on at their own interval.
  #unproved(client: Client, reason: string): void {
    if (this.#client !== client || this.#listening || !this.#proofTimer) return;
    clearTimeout(this.#proofTimer);
    this.#proofTimer = null;
    this.#logger.warn(
      "Conversation turn notices do not arrive on the listening connection; the turn queue is polled instead",
      { channel: CONVERSATION_TURN_QUEUE_CHANNEL, reason },
    );
  }

  #wake(of: string): void {
    const waiters = this.#waiters.get(of);
    if (!waiters) return;
    for (const done of [...waiters]) done();
  }

  #wakeAll(): void {
    for (const of of [...this.#waiters.keys()]) this.#wake(of);
  }

  #lost(client: Client, error: unknown): void {
    // A stale client's events (after a reconnect replaced it) mean nothing.
    if (this.#client !== client) return;
    this.#client = null;
    this.#listening = false;
    if (this.#proofTimer) clearTimeout(this.#proofTimer);
    this.#proofTimer = null;
    client.removeAllListeners();
    client.on("error", () => {});
    void client.end().catch(() => {});
    // Whoever waited on a notice goes back to polling now, not a wait later.
    this.#wakeAll();
    if (this.#closed) return;
    this.#logger.warn("Conversation turn listener disconnected; reconnecting", {
      error_name: error instanceof Error ? error.name : "ConnectionEnded",
      retry_in_ms: this.#reconnectDelayMs,
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.start();
    }, this.#reconnectDelayMs);
  }
}
