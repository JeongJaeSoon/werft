import {
  CONVERSATION_TOPIC_SESSION_IDLE_MS,
  CONVERSATION_TOPIC_SESSION_LIMIT,
  type ConversationTopicId,
} from "@werft-ai/contracts";
import type {
  AgentRun,
  RuntimeEvent,
  RuntimeProcessObserver,
} from "@werft-ai/runtime-core";
import { type EngineExitWatch, EngineProcesses } from "../engine-processes.ts";
import type { PermitRelay } from "./permit-relay.ts";
import type { TopicDirectories, TopicDirectory } from "./topic-directories.ts";

/**
 * The engine processes one session's run started, as the spawn hook saw them.
 * `AgentRun.close()` may resolve as soon as the engine was told to end; only
 * its observed exit says it has.
 */
export type TopicEngines = RuntimeProcessObserver &
  Pick<EngineExitWatch, "exited" | "kill" | "running">;

// How long a killed engine's exit is waited for. A stop can meet four such
// waits one after another (a leased turn's sweep, the session its topic had,
// the cut turn's drop, the last drop of all): together they stay inside the
// shortest stop grace the runtime is run with, Docker's default 10 s.
const ENGINE_EXIT_WAIT_MS = 2_000;

/**
 * One topic's live engine: the process a turn of the topic goes on in while
 * the topic has not been idle for its lifetime. It serves this topic only.
 */
export type TopicSession = {
  topicId: ConversationTopicId;
  directory: TopicDirectory;
  /** The key its engine was started with, which the relay trades for a turn's permit. */
  permitKey: string;
  /** What its engine was started with that a turn must share to go on in it. */
  startedFor: string;
  run: AgentRun;
  /** The processes `run` started. */
  engines: TopicEngines;
  /** The run's one event stream, read turn by turn. */
  events: AsyncIterator<RuntimeEvent>;
  /** Its last request and the answer to it, in bytes as a request body carries them: what the next request grows from. */
  bytes: number;
  lastUsedAt: number;
};

/**
 * The runtime's live topic sessions, in this process's memory only: a
 * restart starts with none. A session is dropped when its topic has been idle
 * for `idleMs`, when one more is opened past `limit` (the one idle longest),
 * or when its turn asks; dropping kills its engine and, once it has exited,
 * removes its directory. An engine whose exit is not seen keeps its topic
 * closed. Nothing is resumed from disk.
 */
export class TopicSessions {
  private readonly live = new Map<ConversationTopicId, TopicSession>();
  // Engines dropped whose exit was not seen yet: their topic's directory is
  // neither removed nor opened again under them.
  private readonly ending = new Map<ConversationTopicId, TopicEngines>();
  private readonly idleMs: number;
  private readonly limit: number;
  private readonly watch: () => TopicEngines;
  readonly now: () => number;

  constructor(
    readonly topics: TopicDirectories,
    readonly relay: Pick<PermitRelay, "open" | "close" | "url">,
    options: {
      idleMs?: number;
      limit?: number;
      now?: () => number;
      /** What watches a new session's engine processes. */
      engines?: () => TopicEngines;
    } = {},
  ) {
    this.idleMs = options.idleMs ?? CONVERSATION_TOPIC_SESSION_IDLE_MS;
    this.limit = options.limit ?? CONVERSATION_TOPIC_SESSION_LIMIT;
    this.now = options.now ?? Date.now;
    this.watch = options.engines ?? (() => new EngineProcesses());
  }

  get size(): number {
    return this.live.size;
  }

  /** Removes what an earlier process left: no session outlives its process. */
  async reset(): Promise<void> {
    await this.dropAll();
    await this.topics.reset();
  }

  /** The topic's session, when it is alive and its idle time is not up. */
  async get(topicId: ConversationTopicId): Promise<TopicSession | null> {
    // Another topic's engine that will not end is not this topic's failure;
    // its own, if it had one, is met again when the topic is opened.
    await this.sweep().catch(() => undefined);
    return this.live.get(topicId) ?? null;
  }

  /**
   * A new session of the topic, any old one dropped first, and the one idle
   * longest when the runtime holds its limit. `start` is given the topic's
   * new, empty directory, the session's permit key, and the observer its
   * engine must be started under.
   */
  async open(
    topicId: ConversationTopicId,
    start: (
      directory: TopicDirectory,
      permitKey: string,
      engines: RuntimeProcessObserver,
    ) => AgentRun,
    startedFor = "",
  ): Promise<TopicSession> {
    await this.drop(topicId);
    // An engine still ending is still an engine the runtime holds.
    while (
      this.live.size > 0 &&
      this.live.size + this.ending.size >= this.limit
    ) {
      const oldest = [...this.live.values()].reduce((a, b) =>
        b.lastUsedAt < a.lastUsedAt ? b : a,
      );
      // One that will not end does not fail this topic's turn.
      await this.drop(oldest.topicId).catch(() => undefined);
    }
    const directory = await this.topics.open(topicId);
    const permitKey = this.relay.open();
    const engines = this.watch();
    let run: AgentRun;
    try {
      run = start(directory, permitKey, engines);
    } catch (error) {
      this.relay.close(permitKey);
      // What the start left running, if anything, ends before its directory
      // goes; the start's own failure is the one the caller is told.
      this.ending.set(topicId, engines);
      engines.kill();
      await this.drop(topicId).catch(() => undefined);
      throw error;
    }
    const session: TopicSession = {
      topicId,
      directory,
      permitKey,
      startedFor,
      run,
      engines,
      events: run.events()[Symbol.asyncIterator](),
      bytes: 0,
      lastUsedAt: this.now(),
    };
    this.live.set(topicId, session);
    return session;
  }

  /**
   * Ends the topic's engine, when it has a live one, and removes the topic's
   * directory once that engine has exited. A dropped session has nothing left
   * to save, so its engine is not given time to end: it is killed, and its
   * exit waited for up to `waitMs`. One still running writes into its
   * directory, and so back into a removed one. Throws, the directory left,
   * when the exit is not seen; a later drop of the topic looks again.
   */
  async drop(
    topicId: ConversationTopicId,
    waitMs = ENGINE_EXIT_WAIT_MS,
  ): Promise<void> {
    const session = this.live.get(topicId);
    this.live.delete(topicId);
    if (session !== undefined) {
      this.relay.close(session.permitKey);
      // Held from here: whatever fails next, its directory waits for its exit.
      this.ending.set(topicId, session.engines);
      try {
        session.run.finishInput();
      } catch {}
      try {
        await session.run.close();
      } catch {}
      // Once: a later signal could reach a process given its pid since.
      session.engines.kill();
    }
    const engines = this.ending.get(topicId);
    if (engines !== undefined) {
      if (!(await engines.exited(waitMs))) {
        throw new Error("A topic's engine did not exit after it was killed");
      }
      this.ending.delete(topicId);
    }
    await this.topics.drop(topicId);
  }

  /**
   * Drops every session whose topic has been idle for its lifetime, and looks
   * again at the engines still ending.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    await this.each([
      // Without a wait: the drop that killed them gave them theirs.
      ...[...this.ending.keys()].map((topicId) => this.drop(topicId, 0)),
      ...[...this.live.values()]
        .filter((session) => now - session.lastUsedAt >= this.idleMs)
        .map((session) => this.drop(session.topicId)),
    ]);
  }

  async dropAll(): Promise<void> {
    await this.each(
      [...this.ending.keys(), ...this.live.keys()].map((topicId) =>
        this.drop(topicId),
      ),
    );
  }

  /**
   * Waits for every drop, their engines' exits together and not one after
   * another, then throws the first failure.
   */
  private async each(drops: Promise<void>[]): Promise<void> {
    for (const drop of await Promise.allSettled(drops)) {
      if (drop.status === "rejected") throw drop.reason;
    }
  }
}
