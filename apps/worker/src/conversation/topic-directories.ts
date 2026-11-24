import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationTopicId } from "@werft-ai/contracts";

/** Where one topic's engine runs: nothing in it is shared with another topic. */
export type TopicDirectory = {
  root: string;
  /** The engine's HOME. */
  home: string;
  /** The engine's own state, its session transcripts included. */
  stateDir: string;
  /** The engine's working directory: empty, and no repository is checked out into it. */
  cwd: string;
  tmp: string;
};

// A topic id names a directory, so it is held to its shape here as well as
// where the protocol parses it.
const TOPIC_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/**
 * One temporary directory per topic under `root`, made empty when the topic
 * is first opened and removed when it is dropped. The root is the runtime's
 * own tmpfs: nothing under it outlives the container.
 */
export class TopicDirectories {
  constructor(private readonly root: string) {}

  private pathOf(topicId: ConversationTopicId): string {
    if (!TOPIC_ID.test(topicId)) {
      throw new Error("A topic id that is not a UUID names no directory");
    }
    return join(this.root, topicId.toLowerCase());
  }

  /** Removes what an earlier process left: no topic outlives the process that held it. */
  async reset(): Promise<void> {
    for (const name of await readdir(this.root)) {
      await rm(join(this.root, name), { force: true, recursive: true });
    }
  }

  async open(topicId: ConversationTopicId): Promise<TopicDirectory> {
    const root = this.pathOf(topicId);
    const directory = {
      root,
      home: join(root, "home"),
      stateDir: join(root, "home", ".claude"),
      cwd: join(root, "work"),
      tmp: join(root, "tmp"),
    };
    for (const path of [directory.home, directory.cwd, directory.tmp]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    return directory;
  }

  async drop(topicId: ConversationTopicId): Promise<void> {
    await rm(this.pathOf(topicId), { force: true, recursive: true });
  }
}
