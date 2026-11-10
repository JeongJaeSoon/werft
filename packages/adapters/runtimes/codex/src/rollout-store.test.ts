import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";

import { CodexRolloutStore, ROLLOUT_PART_BYTES } from "./rollout-store.ts";
import { clientIdsIn, heldInputsFrom } from "./run.ts";

const THREAD = "019f0000-0000-7000-8000-000000000001";
const RELATIVE = `2026/11/10/rollout-2026-11-10T01-02-03-${THREAD}.jsonl`;
const PREFIX = "sessions/s1/mirror";

function line(n: number, clientId?: string): string {
  return `${JSON.stringify({
    timestamp: "2026-11-10T01:02:03Z",
    type: "response_item",
    payload: {
      n,
      ...(clientId === undefined ? {} : { item: { client_id: clientId } }),
    },
  })}\n`;
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "codex-store-"));
  const projects = join(dir, "projects");
  const rollout = join(projects, "codex", "sessions", RELATIVE);
  await mkdir(join(rollout, ".."), { recursive: true });
  return {
    dir,
    projects,
    rollout,
    done: () => rm(dir, { recursive: true, force: true }),
  };
}

describe("CodexRolloutStore", () => {
  test("captures the rollout, restores it elsewhere byte for byte, and resumes from it", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const source = await workspace();
    const target = await workspace();
    try {
      const body = line(1, "in-1") + line(2) + line(3, "in-2");
      await writeFile(source.rollout, body);

      const writer = new CodexRolloutStore({
        generation: 1,
        objects,
        prefix: PREFIX,
        engineDirectory: source.projects,
      });
      expect(await writer.transcriptSizes(THREAD)).toHaveLength(1);
      const captured = await writer.captureTranscripts(THREAD);
      if (captured === null) throw new Error("nothing captured");
      expect(captured.subagents).toEqual({});
      expect(captured.root.entryCount).toBe(3);
      expect(writer.persistedAt).not.toBeNull();

      const reader = new CodexRolloutStore({
        generation: 2,
        objects,
        prefix: PREFIX,
        engineDirectory: target.projects,
        inherit: { sessionId: THREAD, transcripts: captured },
      });
      await reader.verifyInherited();
      await reader.materialize(target.projects);

      expect(await readFile(target.rollout, "utf8")).toBe(body);
      // Whole or not at all: no staging file is left beside it.
      expect(await readdir(join(target.rollout, ".."))).toEqual([
        `rollout-2026-11-10T01-02-03-${THREAD}.jsonl`,
      ]);

      const held = await heldInputsFrom(join(target.projects, "codex"))(THREAD);
      expect([...held].sort()).toEqual(["in-1", "in-2"]);
    } finally {
      await source.done();
      await target.done();
    }
  });

  test("a second capture reuses the parts that did not change", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const source = await workspace();
    try {
      const first = `${"a".repeat(ROLLOUT_PART_BYTES - 1)}\n`;
      await writeFile(source.rollout, first + line(1));
      const store = new CodexRolloutStore({
        generation: 1,
        objects,
        prefix: PREFIX,
        engineDirectory: source.projects,
      });
      const one = await store.captureTranscripts(THREAD);
      await writeFile(source.rollout, first + line(1) + line(2));
      const two = await store.captureTranscripts(THREAD);
      expect(one?.root.parts).toHaveLength(2);
      expect(two?.root.parts[0]).toEqual(one?.root.parts[0]);
      expect(two?.root.parts[1]).not.toEqual(one?.root.parts[1]);
    } finally {
      await source.done();
    }
  });

  test("a part that is not what was pinned is refused on restore", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const source = await workspace();
    const target = await workspace();
    try {
      await writeFile(source.rollout, line(1));
      const writer = new CodexRolloutStore({
        generation: 1,
        objects,
        prefix: PREFIX,
        engineDirectory: source.projects,
      });
      const captured = await writer.captureTranscripts(THREAD);
      if (captured === null) throw new Error("nothing captured");
      const [part] = captured.root.parts;
      if (part === undefined) throw new Error("no part");
      const lying = {
        ...captured,
        root: {
          ...captured.root,
          parts: [{ ...part, sha256: "f".repeat(64) }],
        },
      };
      const reader = new CodexRolloutStore({
        generation: 2,
        objects,
        prefix: PREFIX,
        engineDirectory: target.projects,
        inherit: { sessionId: THREAD, transcripts: lying },
      });
      await expect(reader.verifyInherited()).rejects.toThrow("does not match");
      await expect(reader.materialize(target.projects)).rejects.toThrow();
      await expect(readFile(target.rollout)).rejects.toThrow();
    } finally {
      await source.done();
      await target.done();
    }
  });

  test("nothing to capture before the engine wrote a rollout", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const source = await workspace();
    try {
      const store = new CodexRolloutStore({
        generation: 1,
        objects,
        prefix: PREFIX,
        engineDirectory: source.projects,
      });
      expect(await store.captureTranscripts(THREAD)).toBeNull();
    } finally {
      await source.done();
    }
  });

  test("a store without the engine's directory cannot capture", async () => {
    const store = new CodexRolloutStore({
      generation: 1,
      objects: createMemoryCheckpointObjectStore(),
      prefix: PREFIX,
    });
    await expect(store.captureTranscripts(THREAD)).rejects.toThrow(
      "engine's directory",
    );
  });

  test("a checkpoint that does not name one rollout file is refused", () => {
    const objects = createMemoryCheckpointObjectStore();
    expect(
      () =>
        new CodexRolloutStore({
          generation: 2,
          objects,
          prefix: PREFIX,
          inherit: {
            sessionId: THREAD,
            transcripts: {
              root: {
                entryCount: 1,
                sha256: "0".repeat(64),
                parts: [
                  {
                    bytes: 1,
                    key: `${PREFIX}/generation-0000000001/other/x`,
                    sha256: "0".repeat(64),
                  },
                ],
              },
              subagents: {},
            },
          },
        }),
    ).toThrow("not one rollout file");
  });
});

describe("clientIdsIn", () => {
  test("reads the ids the engine recorded and skips a torn last line", () => {
    const text = `${line(1, "a")}${line(2)}${line(3, "b")}{"payload":{"item":{"client_id":"c`;
    expect([...clientIdsIn(text)]).toEqual(["a", "b"]);
  });
});
