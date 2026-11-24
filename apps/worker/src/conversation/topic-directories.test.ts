import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationTopicIdSchema } from "@werft-ai/contracts";
import { TopicDirectories } from "./topic-directories.ts";

let root: string;
const topic = () => conversationTopicIdSchema.parse(crypto.randomUUID());

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "topic-directories-"));
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("TopicDirectories", () => {
  test("opens an empty directory of its own for each topic, private to this user", async () => {
    const topics = new TopicDirectories(root);
    const [a, b] = [topic(), topic()];
    const opened = await topics.open(a);
    const other = await topics.open(b);

    expect(opened.root).toBe(join(root, a));
    expect(other.root).toBe(join(root, b));
    for (const path of [opened.home, opened.cwd, opened.tmp, opened.stateDir]) {
      expect(path.startsWith(`${opened.root}/`)).toBe(true);
    }
    expect(await readdir(opened.cwd)).toEqual([]);
    expect(await readdir(opened.tmp)).toEqual([]);
    expect((await stat(opened.home)).mode & 0o077).toBe(0);
  });

  test("a topic still held keeps what its last turn left; a dropped one comes back empty", async () => {
    const topics = new TopicDirectories(root);
    const id = topic();
    const first = await topics.open(id);
    await writeFile(join(first.home, "left-behind"), "x");

    expect(await readdir((await topics.open(id)).home)).toEqual([
      "left-behind",
    ]);

    await topics.drop(id);
    expect(await stat(first.root).catch(() => null)).toBeNull();
    expect(await readdir((await topics.open(id)).home)).toEqual([]);
    // Dropping a topic that is not there is not an error.
    await topics.drop(topic());
  });

  test("reset removes everything an earlier process left under the root, and keeps the root", async () => {
    const topics = new TopicDirectories(root);
    await topics.open(topic());
    await mkdir(join(root, "stray"));
    await writeFile(join(root, "stray-file"), "x");

    await topics.reset();

    expect(await readdir(root)).toEqual([]);
  });

  test("an id that is not a UUID names no directory", async () => {
    const topics = new TopicDirectories(root);
    for (const id of [
      "../outside",
      "a/b",
      "",
      ".",
      "6554880c-df89-4d2a-a466-70d644f4ce84/..",
    ]) {
      await expect(topics.open(id as never)).rejects.toThrow(/not a UUID/);
      await expect(topics.drop(id as never)).rejects.toThrow(/not a UUID/);
    }
    expect(await readdir(root)).toEqual([]);
  });
});
