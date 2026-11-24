import {
  CONVERSATION_TOPIC_SESSION_IDLE_MS,
  CONVERSATION_TOPIC_SESSION_LIMIT,
  type ConversationTopicId,
} from "@werft-ai/contracts";
import type { AgentRun, RuntimeEvent } from "@werft-ai/runtime-core";
import type { TopicDirectories, TopicDirectory } from "./topic-directories.ts";

/**
 * One topic's live engine: the process a turn of the topic goes on in while
 * the topic has not been idle for its lifetime. It serves this topic only.
 */
export type TopicSession = {
  topicId: ConversationTopicId;
  directory: TopicDirectory;
  run: AgentRun;
  /** The run's one event stream, read turn by turn. */
  events: AsyncIterator<RuntimeEvent>;
  /** What the session has been sent and has said, in UTF-8 bytes. */
  bytes: number;
  lastUsedAt: number;
};

/**
 * The runtime's live topic sessions, in this process's memory only: a
 * restart starts with none. A session is dropped when its topic has been idle
 * for `idleMs`, when one more is opened past `limit` (the one idle longest),
 * or when its turn asks; dropping ends its engine and removes its directory.
 * Nothing is resumed from disk.
 */
export class TopicSessions {
  private readonly live = new Map<ConversationTopicId, TopicSession>();
  private readonly idleMs: number;
  private readonly limit: number;
  readonly now: () => number;

  constructor(
    readonly topics: TopicDirectories,
    options: { idleMs?: number; limit?: number; now?: () => number } = {},
  ) {
    this.idleMs = options.idleMs ?? CONVERSATION_TOPIC_SESSION_IDLE_MS;
    this.limit = options.limit ?? CONVERSATION_TOPIC_SESSION_LIMIT;
    this.now = options.now ?? Date.now;
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
    await this.sweep();
    return this.live.get(topicId) ?? null;
  }

  /**
   * A new session of the topic, any old one dropped first, and the one idle
   * longest when the runtime holds its limit. `start` is given the topic's
   * new, empty directory.
   */
  async open(
    topicId: ConversationTopicId,
    start: (directory: TopicDirectory) => AgentRun,
  ): Promise<TopicSession> {
    await this.drop(topicId);
    while (this.live.size >= this.limit) {
      const oldest = [...this.live.values()].reduce((a, b) =>
        b.lastUsedAt < a.lastUsedAt ? b : a,
      );
      await this.drop(oldest.topicId);
    }
    const directory = await this.topics.open(topicId);
    let run: AgentRun;
    try {
      run = start(directory);
    } catch (error) {
      await this.topics.drop(topicId);
      throw error;
    }
    const session: TopicSession = {
      topicId,
      directory,
      run,
      events: run.events()[Symbol.asyncIterator](),
      bytes: 0,
      lastUsedAt: this.now(),
    };
    this.live.set(topicId, session);
    return session;
  }

  /** Ends the topic's engine and removes its directory; nothing when it has none. */
  async drop(topicId: ConversationTopicId): Promise<void> {
    const session = this.live.get(topicId);
    this.live.delete(topicId);
    if (session !== undefined) {
      try {
        session.run.finishInput();
      } catch {}
      await session.run.close().catch(() => undefined);
    }
    await this.topics.drop(topicId);
  }

  /** Drops every session whose topic has been idle for its lifetime. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const session of [...this.live.values()]) {
      if (now - session.lastUsedAt >= this.idleMs) {
        await this.drop(session.topicId);
      }
    }
  }

  async dropAll(): Promise<void> {
    for (const topicId of [...this.live.keys()]) await this.drop(topicId);
  }
}
