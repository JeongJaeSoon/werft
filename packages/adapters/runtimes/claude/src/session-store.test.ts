import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestParts } from "@werft-ai/runtime-claude-codec";
import {
  type CheckpointTranscripts,
  MAX_TRANSCRIPT_PART_BYTES,
  type TranscriptEntry,
  type TranscriptInheritance,
  type TranscriptRevision,
  TranscriptTooLargeError,
} from "@werft-ai/runtime-core";
import {
  createMemoryCheckpointObjectStore,
  type MemoryCheckpointObjectStore,
} from "@werft-ai/testkit/checkpoint-objects";
import {
  ClaudeSessionStore,
  PublishRollbackFailed,
  publishRestoredSession,
} from "./session-store.ts";

const projectKey = "-workspace";
const sessionId = "session-1";
const root = { projectKey, sessionId };

const prefix = "sessions/s1/mirror";

function store(objects = createMemoryCheckpointObjectStore()) {
  return {
    objects,
    mirror: new ClaudeSessionStore({ generation: 1, objects, prefix }),
  };
}

function entry(uuid: string, text: string): TranscriptEntry {
  return { type: "user", uuid, message: { content: text } };
}

describe("Claude session store", () => {
  test("round-trips root entries through separate append batches", async () => {
    const { mirror } = store();

    await mirror.append(root, [entry("a", "first")]);
    await mirror.append(root, [entry("b", "second")]);

    expect(await mirror.load(root)).toEqual([
      entry("a", "first"),
      entry("b", "second"),
    ]);
  });

  test("answers null for a session nothing has been mirrored for", async () => {
    const { mirror } = store();

    expect(await mirror.load(root)).toBeNull();
  });

  test("keeps subagent transcripts out of the root and lists their subpaths", async () => {
    const { mirror } = store();
    const subagent = { ...root, subpath: "agents/reviewer" };

    await mirror.append(root, [entry("a", "root")]);
    await mirror.append(subagent, [entry("b", "subagent")]);

    expect(await mirror.load(root)).toEqual([entry("a", "root")]);
    expect(await mirror.load(subagent)).toEqual([entry("b", "subagent")]);
    expect(await mirror.listSubkeys(root)).toEqual(["agents/reviewer"]);
  });

  test("restores a retried batch once", async () => {
    const { mirror } = store();

    await mirror.append(root, [entry("a", "first")]);
    // A timed-out append whose original write landed anyway.
    await mirror.append(root, [entry("a", "first")]);

    expect(await mirror.load(root)).toEqual([entry("a", "first")]);
  });

  test("restores a retried batch once even when key order differs", async () => {
    const { mirror } = store();

    await mirror.append(root, [{ type: "user", uuid: "a", left: 1, right: 2 }]);
    await mirror.append(root, [{ type: "user", uuid: "a", right: 2, left: 1 }]);

    expect(await mirror.load(root)).toHaveLength(1);
  });

  test("refuses a uuid that carries two different bodies", async () => {
    const { mirror } = store();

    await mirror.append(root, [entry("a", "first")]);
    await mirror.append(root, [entry("a", "tampered")]);

    await expect(mirror.load(root)).rejects.toThrow(
      /Conflicting transcript entry/,
    );
  });

  test("keeps entries that carry no uuid", async () => {
    const { mirror } = store();

    await mirror.append(root, [{ type: "title" }, { type: "title" }]);

    expect(await mirror.load(root)).toHaveLength(2);
  });

  test("a captured revision ignores everything mirrored after it", async () => {
    const { mirror } = store();
    await mirror.append(root, [entry("a", "first")]);

    const revision = await mirror.captureRevision(root);
    await mirror.append(root, [entry("b", "later")]);

    if (revision === null) throw new Error("expected a revision");
    expect(revision.entryCount).toBe(1);
    expect(revision.parts).toHaveLength(1);
    expect(await mirror.loadRevision(revision)).toEqual([entry("a", "first")]);
    expect(await mirror.load(root)).toHaveLength(2);
  });

  test("captures null when the key holds nothing", async () => {
    const { mirror } = store();

    expect(await mirror.captureRevision(root)).toBeNull();
  });

  test("refuses a revision whose part list was edited", async () => {
    const { mirror } = store();
    await mirror.append(root, [entry("a", "first")]);
    const revision = await mirror.captureRevision(root);
    if (revision === null) throw new Error("expected a revision");

    await expect(
      mirror.loadRevision({ ...revision, parts: [] }),
    ).rejects.toThrow(/digest mismatch/);
  });

  test("refuses a revision whose part bytes changed underneath it", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);
    await mirror.append(root, [entry("a", "first")]);
    const revision = await mirror.captureRevision(root);
    if (revision === null) throw new Error("expected a revision");
    const part = revision.parts[0];
    if (part === undefined) throw new Error("expected a part");
    await objects.overwrite(
      part.key,
      new TextEncoder().encode('{"type":"x"}\n'),
    );

    await expect(mirror.loadRevision(revision)).rejects.toThrow(
      /integrity failure/,
    );
  });

  test("refuses a revision that names a part the store no longer has", async () => {
    const { mirror } = store();
    const parts = [{ bytes: 1, key: "gone", sha256: "0".repeat(64) }];

    await expect(
      mirror.loadRevision({
        entryCount: 1,
        parts,
        sha256: createHash("sha256")
          .update(JSON.stringify(parts), "utf8")
          .digest("hex"),
      }),
    ).rejects.toThrow(/Missing transcript part/);
  });

  test("counts an append the object store rejected", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);
    objects.failWrites(1);

    await expect(mirror.append(root, [entry("a", "first")])).rejects.toThrow(
      /Injected object store failure/,
    );
    expect(mirror.appendFailures).toBe(1);
  });

  test("names by version a part whose write landed but whose answer was lost", async () => {
    const objects = createMemoryCheckpointObjectStore({ versioned: true });
    const putImmutable = objects.putImmutable.bind(objects);
    let lost = 1;
    objects.putImmutable = async (key, bytes) => {
      const written = await putImmutable(key, bytes);
      if (lost-- > 0) throw new Error("connection reset");
      return written;
    };
    const { mirror } = store(objects);
    await expect(mirror.append(root, [entry("a", "first")])).rejects.toThrow(
      "connection reset",
    );
    await mirror.append(root, [entry("a", "first")]);

    const parts = (await mirror.captureRevision(root))?.parts ?? [];

    expect(parts).toHaveLength(2);
    expect(parts.every((part) => part.version !== undefined)).toBe(true);
  });

  test("is unsettled from a failed append until a later one for that transcript lands", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);
    expect(mirror.persistedAt).toBeNull();
    await mirror.append(root, [entry("a", "first")]);
    const landed = mirror.persistedAt;
    expect(landed).toBeInstanceOf(Date);

    objects.failWrites(1);
    await expect(mirror.append(root, [entry("b", "dropped")])).rejects.toThrow(
      /Injected object store failure/,
    );
    expect(mirror.unsettled).toBe(true);
    expect(mirror.persistedAt).toBe(landed);
    // Another transcript landing says nothing about the root's batch.
    await mirror.append({ ...root, subpath: "agents/a" }, [entry("s", "x")]);
    expect(mirror.unsettled).toBe(true);

    await mirror.append(root, [entry("b", "dropped")]);
    expect(mirror.unsettled).toBe(false);
  });

  test("ready() rejects before any append when the generation is taken", async () => {
    const objects = createMemoryCheckpointObjectStore();
    await store(objects).mirror.append(root, [entry("a", "other launch")]);

    await expect(store(objects).mirror.ready()).rejects.toThrow(
      /already holds transcript parts/,
    );
    await store().mirror.ready();
  });

  test("refuses a subpath that would escape the session namespace", async () => {
    const { mirror } = store();

    await expect(
      mirror.append({ ...root, subpath: "../other" }, [entry("a", "x")]),
    ).rejects.toThrow(/Unsafe transcript subpath/);
  });

  test("two stores writing the same transcript replay in commit order", async () => {
    // Two independent processes, no shared clock and no shared sequence,
    // appending to one transcript within one generation.
    for (let run = 0; run < 20; run += 1) {
      const objects = createMemoryCheckpointObjectStore();
      const options = { generation: 1, objects, prefix };
      const stale = new ClaudeSessionStore(options);
      const live = new ClaudeSessionStore(options);

      await stale.append(root, [entry("a", "from the old worker")]);
      await live.append(root, [entry("b", "from the new worker")]);

      expect(await live.load(root)).toEqual([
        entry("a", "from the old worker"),
        entry("b", "from the new worker"),
      ]);
    }
  });

  test("two stores appending identical uuid-less batches keep both", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const options = { generation: 1, objects, prefix };
    const left = new ClaudeSessionStore(options);
    const right = new ClaudeSessionStore(options);

    // Identical bytes, so the second write finds its slot already holding
    // exactly what it wanted to store. That is not the same as having stored
    // it, and nothing downstream could tell the difference afterwards.
    await Promise.all([
      left.append(root, [{ type: "title" }]),
      right.append(root, [{ type: "title" }]),
    ]);

    expect(await left.load(root)).toHaveLength(2);
  });

  test("two stores racing for the same slot do not lose a batch", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const options = { generation: 1, objects, prefix };
    const left = new ClaudeSessionStore(options);
    const right = new ClaudeSessionStore(options);

    // Both start from an empty listing, so both want slot 0. The create-only
    // write decides, and the loser takes the next slot rather than vanishing.
    await Promise.all([
      left.append(root, [entry("a", "left")]),
      right.append(root, [entry("b", "right")]),
    ]);

    const restored = await left.load(root);
    expect(restored).toHaveLength(2);
    expect(new Set(restored?.map((item) => item.uuid))).toEqual(
      new Set(["a", "b"]),
    );
  });

  test("keeps root and subagent ordering independent", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = new ClaudeSessionStore({ generation: 1, objects, prefix });
    const subagent = { ...root, subpath: "agents/reviewer" };

    await mirror.append(root, [entry("r1", "root one")]);
    await mirror.append(subagent, [entry("s1", "sub one")]);
    await mirror.append(root, [entry("r2", "root two")]);
    await mirror.append(subagent, [entry("s2", "sub two")]);

    expect(await mirror.load(root)).toEqual([
      entry("r1", "root one"),
      entry("r2", "root two"),
    ]);
    expect(await mirror.load(subagent)).toEqual([
      entry("s1", "sub one"),
      entry("s2", "sub two"),
    ]);
  });

  test("a captured revision records each part's byte length", async () => {
    const { mirror } = store();
    await mirror.append(root, [entry("a", "first")]);

    const revision = await mirror.captureRevision(root);
    const part = revision?.parts[0];
    if (part === undefined) throw new Error("expected a part");
    expect(part.bytes).toBeGreaterThan(0);
  });

  test("captures without re-reading parts it wrote itself", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);
    await mirror.append(root, [entry("a", "first")]);
    await mirror.append(root, [entry("b", "second")]);

    objects.resetReads();
    await mirror.captureRevision(root);
    await mirror.captureRevision(root);

    // Otherwise a session that checkpoints each turn re-downloads its whole
    // history every turn.
    expect(objects.reads()).toEqual([]);
  });

  test("captures from the keys it wrote rather than listing the generation", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);
    await mirror.append(root, [entry("a", "first")]);
    await mirror.append({ ...root, subpath: "agents/a" }, [entry("s", "sub")]);
    const lists = spyOn(objects, "list");

    await mirror.captureTranscripts(sessionId);
    await mirror.append(root, [entry("b", "second")]);
    const captured = await mirror.captureTranscripts(sessionId);

    expect(lists).not.toHaveBeenCalled();
    expect(captured?.root.parts).toHaveLength(2);
    expect(Object.keys(captured?.subagents ?? {})).toEqual(["agents/a"]);
  });

  test("lists the generation once after a write whose answer was lost", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const putImmutable = objects.putImmutable.bind(objects);
    let lost = 1;
    objects.putImmutable = async (key, bytes) => {
      const written = await putImmutable(key, bytes);
      if (lost-- > 0) throw new Error("connection reset");
      return written;
    };
    const { mirror } = store(objects);
    await expect(mirror.append(root, [entry("a", "first")])).rejects.toThrow(
      "connection reset",
    );
    await mirror.append(root, [entry("b", "second")]);
    const lists = spyOn(objects, "list");

    const captured = await mirror.captureTranscripts(sessionId);
    await mirror.captureTranscripts(sessionId);

    expect(captured?.root.parts).toHaveLength(2);
    expect(lists).toHaveBeenCalledTimes(1);
  });

  test("lists again after a write whose answer was lost while a listing ran", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const putImmutable = objects.putImmutable.bind(objects);
    let lose = true;
    objects.putImmutable = async (key, bytes) => {
      const written = await putImmutable(key, bytes);
      if (lose) throw new Error("connection reset");
      return written;
    };
    const { mirror } = store(objects);
    await expect(mirror.append(root, [entry("a", "first")])).rejects.toThrow(
      "connection reset",
    );
    const list = objects.list.bind(objects);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lists = spyOn(objects, "list").mockImplementationOnce(
      async (listed) => {
        await held;
        return list(listed);
      },
    );

    const first = mirror.captureTranscripts(sessionId);
    await Promise.resolve();
    await expect(
      mirror.append(root, [entry("b", "during the listing")]),
    ).rejects.toThrow("connection reset");
    release();
    await first;
    lose = false;
    const captured = await mirror.captureTranscripts(sessionId);
    await mirror.captureTranscripts(sessionId);

    expect(captured?.root.parts).toHaveLength(2);
    expect(lists).toHaveBeenCalledTimes(2);
  });

  test("lists the generation once after another writer took its slot", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const options = { generation: 1, objects, prefix };
    const left = new ClaudeSessionStore(options);
    const right = new ClaudeSessionStore(options);
    await left.append(root, [entry("a", "left")]);
    await right.append(root, [entry("b", "right")]);
    // Left still expects slot 1, which right took.
    await left.append(root, [entry("c", "left again")]);
    const lists = spyOn(objects, "list");

    const captured = await left.captureTranscripts(sessionId);
    await left.captureTranscripts(sessionId);

    expect(captured?.root.parts).toHaveLength(3);
    expect(lists).toHaveBeenCalledTimes(1);
  });

  test("a restore still confronts the bytes the store holds now", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);
    await mirror.append(root, [entry("a", "first")]);
    const revision = await mirror.captureRevision(root);
    if (revision === null) throw new Error("expected a revision");
    const part = revision.parts[0];
    if (part === undefined) throw new Error("expected a part");
    await objects.overwrite(
      part.key,
      new TextEncoder().encode('{"type":"x"}\n'),
    );

    // Same store instance, so a cached body would hide the corruption.
    await expect(mirror.loadRevision(revision)).rejects.toThrow(
      /integrity failure/,
    );
  });

  test("restores a revision whose entryCount the writer got wrong", async () => {
    const { mirror } = store();
    await mirror.append(root, [entry("a", "first")]);
    const revision = await mirror.captureRevision(root);
    if (revision === null) throw new Error("expected a revision");

    // The digests already pin the exact bytes, so a miscounted manifest must
    // not be the thing that makes a session unresumable.
    expect(await mirror.loadRevision({ ...revision, entryCount: 99 })).toEqual([
      entry("a", "first"),
    ]);
  });

  test("replays concurrent appends in the order they were called", async () => {
    // Both calls race for the very first tick under the key, where nothing is
    // stored yet to order them by.
    for (let run = 0; run < 20; run += 1) {
      const { mirror } = store();

      await Promise.all([
        mirror.append(root, [entry(`a${run}`, "first")]),
        mirror.append(root, [entry(`b${run}`, "second")]),
      ]);

      expect(await mirror.load(root)).toEqual([
        entry(`a${run}`, "first"),
        entry(`b${run}`, "second"),
      ]);
    }
  });

  test("keeps subagent appends off the root's write queue", async () => {
    const { mirror } = store();
    const subagent = { ...root, subpath: "agents/reviewer" };

    await Promise.all([
      mirror.append(root, [entry("r1", "root one")]),
      mirror.append(subagent, [entry("s1", "sub one")]),
      mirror.append(root, [entry("r2", "root two")]),
    ]);

    expect(await mirror.load(root)).toEqual([
      entry("r1", "root one"),
      entry("r2", "root two"),
    ]);
    expect(await mirror.load(subagent)).toEqual([entry("s1", "sub one")]);
  });

  test("never lets two sessions share a key prefix", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const { mirror } = store(objects);

    await mirror.append(root, [entry("a", "one")]);
    await mirror.append({ projectKey, sessionId: "session-2" }, [
      entry("b", "two"),
    ]);

    expect(await mirror.load(root)).toEqual([entry("a", "one")]);
    expect(
      objects.keys().every((key) => key.startsWith("sessions/s1/mirror/")),
    ).toBe(true);
  });
});

describe("Claude session store across execution generations", () => {
  const subagent = { ...root, subpath: "agents/reviewer" };

  function launch(
    objects: MemoryCheckpointObjectStore,
    generation: number,
    inherit?: TranscriptInheritance,
  ) {
    return new ClaudeSessionStore({
      generation,
      objects,
      prefix,
      ...(inherit === undefined ? {} : { inherit }),
    });
  }

  /** What a committed checkpoint hands the next launch. */
  async function checkpointOf(
    mirror: ClaudeSessionStore,
  ): Promise<TranscriptInheritance> {
    const transcripts = await mirror.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");
    return { sessionId, transcripts };
  }

  test("writes only under its own generation", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects, 7);

    await mirror.append(root, [entry("a", "root")]);
    await mirror.append(subagent, [entry("b", "subagent")]);

    expect(objects.keys().length).toBe(2);
    expect(
      objects
        .keys()
        .every((key) =>
          key.startsWith("sessions/s1/mirror/generation-0000000007/"),
        ),
    ).toBe(true);
  });

  test("a resumed generation replays what the checkpoint pinned, then its own entries", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("a", "first")]);
    await first.append(root, [entry("b", "second")]);
    const inherited = await checkpointOf(first);

    const second = launch(objects, 2, inherited);
    expect(first.revisionScoped).toBe(false);
    expect(second.revisionScoped).toBe(true);
    expect(await second.load(root)).toEqual([
      entry("a", "first"),
      entry("b", "second"),
    ]);

    await second.append(root, [entry("c", "third")]);
    expect(await second.load(root)).toEqual([
      entry("a", "first"),
      entry("b", "second"),
      entry("c", "third"),
    ]);
    const captured = await second.captureRevision(root);
    if (captured === null) throw new Error("expected a revision");
    expect(captured.parts.slice(0, 2)).toEqual([
      ...inherited.transcripts.root.parts,
    ]);
    expect(captured.parts[2]?.key).toContain("/generation-0000000002/");
    expect(captured.entryCount).toBe(3);
    expect(await second.loadRevision(captured)).toEqual([
      entry("a", "first"),
      entry("b", "second"),
      entry("c", "third"),
    ]);
  });

  test("never adopts what an older generation writes past the checkpoint", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const zombie = launch(objects, 1);
    await zombie.append(root, [entry("a", "committed")]);
    const inherited = await checkpointOf(zombie);
    // Recorded after the checkpoint but before the successor started: not part
    // of the conversation being resumed.
    await zombie.append(root, [entry("x", "uncommitted")]);

    const live = launch(objects, 2, inherited);
    // The old worker lost its lease but is still running.
    await zombie.append(root, [entry("z", "after the handoff")]);
    await zombie.append({ ...root, subpath: "agents/late" }, [
      entry("s", "a subagent the old worker started late"),
    ]);
    await live.append(root, [entry("c", "the new worker")]);

    expect(await live.load(root)).toEqual([
      entry("a", "committed"),
      entry("c", "the new worker"),
    ]);
    expect(await live.listSubkeys(root)).toEqual([]);
    const captured = await live.captureRevision(root);
    if (captured === null) throw new Error("expected a revision");
    expect(await live.loadRevision(captured)).toEqual([
      entry("a", "committed"),
      entry("c", "the new worker"),
    ]);
  });

  test("carries the chain through more than one handoff", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("a", "one")]);
    const second = launch(objects, 2, await checkpointOf(first));
    await second.append(root, [entry("b", "two")]);
    const fromSecond = await checkpointOf(second);
    await second.append(root, [entry("x", "never committed")]);

    const third = launch(objects, 3, fromSecond);
    await third.append(root, [entry("c", "three")]);
    const captured = await third.captureRevision(root);
    if (captured === null) throw new Error("expected a revision");

    expect(
      captured.parts.map((part) => part.key.match(/generation-(\d+)/)?.[1]),
    ).toEqual(["0000000001", "0000000002", "0000000003"]);
    // Restoring reads the pinned list alone — no prefix listing and no
    // ancestor manifest — so a fresh launch restores it too.
    expect(await launch(objects, 4).loadRevision(captured)).toEqual([
      entry("a", "one"),
      entry("b", "two"),
      entry("c", "three"),
    ]);
  });

  test("adopts subagent transcripts and keeps listing them", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("r", "root")]);
    await first.append(subagent, [entry("s1", "review one")]);

    const second = launch(objects, 2, await checkpointOf(first));
    expect(await second.listSubkeys(root)).toEqual(["agents/reviewer"]);
    expect(await second.load(subagent)).toEqual([entry("s1", "review one")]);

    await second.append(subagent, [entry("s2", "review two")]);
    const captured = await second.captureRevision(subagent);
    if (captured === null) throw new Error("expected a revision");
    expect(await second.loadRevision(captured)).toEqual([
      entry("s1", "review one"),
      entry("s2", "review two"),
    ]);
  });

  test("adopts by engine session even when the project key moved", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("a", "first")]);

    const second = launch(objects, 2, await checkpointOf(first));

    // The project key is derived from the cwd, which the restoring host
    // chooses; the checkpoint belongs to the engine session.
    expect(await second.load({ projectKey: "-elsewhere", sessionId })).toEqual([
      entry("a", "first"),
    ]);
  });

  test("refuses every other engine session once it adopted one", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("a", "first")]);
    const second = launch(objects, 2, await checkpointOf(first));
    const other = { projectKey, sessionId: "another-session" };

    // `null` here would send the engine to the container's own disk.
    await expect(second.load(other)).rejects.toThrow(/adopted engine session/);
    await expect(second.append(other, [entry("b", "x")])).rejects.toThrow(
      /adopted engine session/,
    );
    await expect(second.listSubkeys(other)).rejects.toThrow(
      /adopted engine session/,
    );
  });

  test("refuses to adopt a part whose bytes changed", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("a", "first")]);
    const inherited = await checkpointOf(first);
    const pinned = inherited.transcripts.root.parts[0];
    if (pinned === undefined) throw new Error("expected a part");
    await objects.overwrite(
      pinned.key,
      new TextEncoder().encode('{"type":"x"}\n'),
    );

    const second = launch(objects, 2, inherited);

    await expect(second.load(root)).rejects.toThrow(
      /Inherited transcript part changed/,
    );
    await expect(second.captureRevision(root)).rejects.toThrow(
      /Inherited transcript part changed/,
    );
  });

  test("verifies every adopted part up front, holding none of them", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("a", "first")]);
    await first.append(subagent, [entry("b", "subagent")]);
    const inherited = await checkpointOf(first);
    const second = launch(objects, 2, inherited);

    objects.resetReads();
    await second.verifyInherited();
    expect(objects.reads()).toHaveLength(2);
    // Counted, so a capture does not fetch them again.
    objects.resetReads();
    await second.captureTranscripts(sessionId);
    expect(objects.reads()).toEqual([]);
    // But not held: a load reads them anew.
    expect(await second.load(subagent)).toEqual([entry("b", "subagent")]);
    expect(
      objects.reads().filter((read) => read.includes("generation-0000000001")),
    ).toHaveLength(1);

    const pinned = inherited.transcripts.subagents["agents/reviewer"]?.parts[0];
    if (pinned === undefined) throw new Error("expected a subagent part");
    await objects.overwrite(pinned.key, new TextEncoder().encode("not json\n"));
    await expect(
      launch(objects, 3, inherited).verifyInherited(),
    ).rejects.toThrow(/Inherited transcript part changed/);
    const stopped = new AbortController();
    stopped.abort(new Error("stopped"));
    await expect(
      launch(objects, 4, inherited).verifyInherited(stopped.signal),
    ).rejects.toThrow("stopped");
  });

  test("verifies an adopted part once, not on every capture", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("a", "first")]);
    const second = launch(objects, 2, await checkpointOf(first));

    objects.resetReads();
    await second.captureRevision(root);
    await second.captureRevision(root);

    expect(objects.reads()).toHaveLength(1);
  });

  test("refuses an inherited part list that fails its digest", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("a", "first")]);
    await first.append(root, [entry("b", "second")]);
    const inherited = await checkpointOf(first);

    expect(() =>
      launch(objects, 2, {
        ...inherited,
        transcripts: {
          ...inherited.transcripts,
          root: {
            ...inherited.transcripts.root,
            parts: inherited.transcripts.root.parts.slice(0, 1),
          },
        },
      }),
    ).toThrow(/does not match its digest/);
  });

  test("refuses to adopt from its own generation or a later one", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 3);
    await first.append(root, [entry("a", "first")]);
    const inherited = await checkpointOf(first);

    expect(() => launch(objects, 3, inherited)).toThrow(
      /not from a generation before 3/,
    );
    expect(() => launch(objects, 2, inherited)).toThrow(
      /not from a generation before 2/,
    );
  });

  test("refuses to adopt a part outside the session's mirror", () => {
    const parts = [
      {
        bytes: 1,
        key: "sessions/other/mirror/generation-0000000001/x/y/main/part-0000000000.jsonl",
        sha256: "0".repeat(64),
      },
    ];

    expect(() =>
      launch(createMemoryCheckpointObjectStore(), 2, {
        sessionId,
        transcripts: {
          root: { entryCount: 1, parts, sha256: digestParts(parts) },
          subagents: {},
        },
      }),
    ).toThrow(/outside sessions\/s1\/mirror\//);
  });

  test("refuses to adopt another engine session's part as this one's", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    const other = { projectKey, sessionId: "session-2" };
    await first.append(other, [entry("o", "another conversation")]);
    const foreign = await first.captureRevision(other);
    if (foreign === null) throw new Error("expected a revision");

    expect(() =>
      launch(objects, 2, {
        sessionId,
        transcripts: { root: foreign, subagents: {} },
      }),
    ).toThrow(/is not a part of session-1's root transcript/);
  });

  test("refuses a checkpoint that pins a subagent's parts as the root", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("r", "root")]);
    await first.append(subagent, [entry("s", "subagent")]);
    const { transcripts } = await checkpointOf(first);
    const reviewer = transcripts.subagents["agents/reviewer"];
    if (reviewer === undefined) throw new Error("expected the subagent");

    expect(() =>
      launch(objects, 2, {
        sessionId,
        transcripts: {
          root: reviewer,
          subagents: { "agents/reviewer": transcripts.root },
        },
      }),
    ).toThrow(/is not a part of session-1's root transcript/);
  });

  test("captures a whole engine session without being told its project key", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects, 1);
    await mirror.append(root, [entry("r", "root")]);
    await mirror.append(subagent, [entry("s", "subagent")]);
    await mirror.append({ projectKey, sessionId: "session-2" }, [
      entry("o", "another session"),
    ]);

    const transcripts = await mirror.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");

    expect(await mirror.loadRevision(transcripts.root)).toEqual([
      entry("r", "root"),
    ]);
    expect(Object.keys(transcripts.subagents)).toEqual(["agents/reviewer"]);
    expect(await mirror.captureTranscripts("session-3")).toBeNull();
  });

  test("captures what it adopted even before the engine writes anything", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await first.append(root, [entry("r", "root")]);
    await first.append(subagent, [entry("s", "subagent")]);
    const inherited = await checkpointOf(first);

    const second = launch(objects, 2, inherited);

    expect(await second.captureTranscripts(sessionId)).toEqual(
      inherited.transcripts,
    );
  });

  test("refuses to guess between two project keys for one engine session", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects, 1);
    await mirror.append(root, [entry("a", "one")]);
    await mirror.append({ projectKey: "-elsewhere", sessionId }, [
      entry("b", "two"),
    ]);

    await expect(mirror.captureTranscripts(sessionId)).rejects.toThrow(
      /more than one project key/,
    );
  });

  test("refuses a generation that already holds transcript parts", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const earlier = launch(objects, 1);
    await earlier.append(root, [entry("a", "from another launch")]);

    const reused = launch(objects, 1);

    await expect(reused.load(root)).rejects.toThrow(
      /already holds transcript parts/,
    );
    await expect(reused.append(root, [entry("b", "x")])).rejects.toThrow(
      /already holds transcript parts/,
    );
    const pinned = await earlier.captureRevision(root);
    if (pinned === null) throw new Error("expected a revision");
    await expect(reused.loadRevision(pinned)).rejects.toThrow(
      /already holds transcript parts/,
    );
    expect(await earlier.load(root)).toEqual([
      entry("a", "from another launch"),
    ]);
  });

  test("refuses a generation that is not a non-negative integer", () => {
    const objects = createMemoryCheckpointObjectStore();

    expect(() => launch(objects, -1)).toThrow(/Invalid execution generation/);
    expect(() => launch(objects, 1.5)).toThrow(/Invalid execution generation/);
  });

  test("two stores alternating appends in one generation replay in append order", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const left = launch(objects, 1);
    const right = launch(objects, 1);
    const expected: TranscriptEntry[] = [];

    for (let index = 0; index < 6; index += 1) {
      const next = entry(`e${index}`, index % 2 === 0 ? "left" : "right");
      await (index % 2 === 0 ? left : right).append(root, [next]);
      expected.push(next);
    }

    // The order is the object store's, won slot by slot, not either
    // process's clock.
    expect(await left.load(root)).toEqual(expected);
    expect(await right.load(root)).toEqual(expected);
  });

  test("a capture includes appends already queued when it was asked", async () => {
    const { mirror } = store();

    const pending = mirror.append(root, [entry("a", "in flight")]);
    const captured = await mirror.captureRevision(root);
    await pending;

    expect(captured?.entryCount).toBe(1);
  });
});

describe("Claude session store merging parts", () => {
  const subagent = { ...root, subpath: "agents/reviewer" };

  function launch(
    objects: MemoryCheckpointObjectStore,
    generation: number,
    inherit?: TranscriptInheritance,
  ) {
    return new ClaudeSessionStore({
      generation,
      objects,
      prefix,
      ...(inherit === undefined ? {} : { inherit }),
    });
  }

  /** One append per entry, with a retried batch and a uuid-less frame mixed in. */
  async function appendMany(
    mirror: ClaudeSessionStore,
    count: number,
    label = "",
  ) {
    for (let index = 0; index < count; index += 1) {
      const batch = [entry(`${label}${index}`, `entry ${index}`)];
      await mirror.append(root, batch);
      if (index % 100 === 0) {
        await mirror.append(root, batch);
        await mirror.append(root, [{ type: "title", title: `t${index}` }]);
      }
    }
  }

  test("a capture pinning too many parts merges them, and restores the same entries", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects, 1);
    await appendMany(mirror, 600);
    const expected = await mirror.load(root);

    const transcripts = await mirror.captureTranscripts(sessionId);

    const parts = transcripts?.root.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.key).toMatch(
      /^sessions\/s1\/mirror\/generation-0000000001\/-workspace\/session-1\/main\/merged-[0-9a-f]{64}\.jsonl$/,
    );
    expect(transcripts?.root.entryCount).toBe(expected?.length as number);
    expect(
      await launch(objects, 2).loadRevision(
        transcripts?.root as TranscriptRevision,
      ),
    ).toEqual(expected as TranscriptEntry[]);
    // The engine's own view is untouched by the merge.
    expect(await mirror.load(root)).toEqual(expected);
  });

  test("keeps merging what comes after, carrying the merged parts forward", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects, 1);
    await appendMany(mirror, 600);
    const first = await mirror.captureTranscripts(sessionId);
    await mirror.append(root, [entry("after", "one more")]);

    const second = await mirror.captureRevision(root);
    expect(second?.parts.slice(0, 1)).toEqual([...(first?.root.parts ?? [])]);
    expect(second?.parts).toHaveLength(2);

    await appendMany(mirror, 600, "later-");
    const third = await mirror.captureTranscripts(sessionId);
    // Both runs fit in one merged part, so the earlier one is rewritten
    // rather than kept beside a second.
    expect(third?.root.parts).toHaveLength(1);
    expect(
      await launch(objects, 2).loadRevision(third?.root as TranscriptRevision),
    ).toEqual((await mirror.load(root)) as TranscriptEntry[]);
  });

  test("merges every transcript once the session as a whole pins too many parts", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects, 1);
    const lanes = Array.from({ length: 9 }, (_, index) => ({
      ...root,
      subpath: `agents/a${index}`,
    }));
    await appendMany(mirror, 10);
    for (const lane of lanes) {
      for (let index = 0; index < 460; index += 1) {
        await mirror.append(lane, [entry(`${lane.subpath}-${index}`, "x")]);
      }
    }

    const transcripts = await mirror.captureTranscripts(sessionId);

    expect(transcripts?.root.parts).toHaveLength(1);
    for (const lane of lanes) {
      const revision = transcripts?.subagents[lane.subpath];
      expect(revision?.parts).toHaveLength(1);
      expect(
        await launch(objects, 2).loadRevision(revision as TranscriptRevision),
      ).toEqual((await mirror.load(lane)) as TranscriptEntry[]);
    }
  });

  test("a resumed generation adopts merged parts and merges what it inherited under its own", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects, 1);
    await appendMany(first, 600);
    await first.append(subagent, [entry("s", "subagent")]);
    const pinned = await first.captureTranscripts(sessionId);
    if (pinned === null) throw new Error("expected transcripts");

    const second = launch(objects, 2, { sessionId, transcripts: pinned });
    await second.verifyInherited();
    expect(await second.load(root)).toEqual(
      (await first.load(root)) as TranscriptEntry[],
    );
    await appendMany(second, 600, "second-");
    const captured = await second.captureTranscripts(sessionId);

    expect(captured?.root.parts).toHaveLength(1);
    expect(captured?.root.parts[0]?.key).toContain("/generation-0000000002/");
    expect(captured?.subagents["agents/reviewer"]).toEqual(
      pinned.subagents["agents/reviewer"] as TranscriptRevision,
    );
    expect(
      await launch(objects, 3).loadRevision(
        captured?.root as TranscriptRevision,
      ),
    ).toEqual((await second.load(root)) as TranscriptEntry[]);
    // Generation 1 holds only the merged part it wrote itself.
    expect(
      objects
        .keys()
        .filter(
          (key) =>
            key.includes("/generation-0000000001/") && key.includes("merged-"),
        ),
    ).toHaveLength(1);
  });

  test("a merged part is held to its digest like any other", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects, 1);
    await appendMany(mirror, 600);
    const transcripts = await mirror.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");
    const merged = transcripts.root.parts[0];
    if (merged === undefined) throw new Error("expected a merged part");

    await objects.overwrite(merged.key, new TextEncoder().encode("{}\n"));

    await expect(
      launch(objects, 2).loadRevision(transcripts.root),
    ).rejects.toThrow(/integrity failure/);
    await expect(
      launch(objects, 3, { sessionId, transcripts }).verifyInherited(),
    ).rejects.toThrow(/Inherited transcript part changed/);
  });

  test("a merge that fails to write leaves the store pinning what it did", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects, 1);
    await appendMany(mirror, 600);
    const before = await mirror.captureRevision(root);

    objects.failWrites(1);
    await expect(mirror.captureTranscripts(sessionId)).rejects.toThrow();

    expect(await mirror.captureRevision(root)).toEqual(
      before as TranscriptRevision,
    );
    const retried = await mirror.captureTranscripts(sessionId);
    expect(retried?.root.parts).toHaveLength(1);
  });

  test("a merged part is not an appended one", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects, 1);
    await mirror.append(root, [entry("a", "first")]);
    const main = `${prefix}/generation-0000000001/-workspace/session-1/main/`;
    await objects.putImmutable(
      `${main}merged-${"0".repeat(64)}.jsonl`,
      new TextEncoder().encode("{}\n"),
    );

    // Neither the engine's view nor the next slot counts it: it is a
    // capture's, not an append's.
    await mirror.append(root, [entry("b", "second")]);

    expect(
      objects
        .keys()
        .filter((key) => key.startsWith(main))
        .sort(),
    ).toEqual([
      `${main}merged-${"0".repeat(64)}.jsonl`,
      `${main}part-0000000000.jsonl`,
      `${main}part-0000000001.jsonl`,
    ]);
    expect(await mirror.load(root)).toEqual([
      entry("a", "first"),
      entry("b", "second"),
    ]);
  });
});

describe("Claude session store merging parts, the edges", () => {
  function launch(objects: MemoryCheckpointObjectStore, generation = 1) {
    return new ClaudeSessionStore({ generation, objects, prefix });
  }

  async function appendParts(mirror: ClaudeSessionStore, count: number) {
    for (let index = 0; index < count; index += 1) {
      await mirror.append(root, [entry(`u${index}`, `entry ${index}`)]);
    }
  }

  test("names a merged part by the version the store answered", async () => {
    const objects = createMemoryCheckpointObjectStore({ versioned: true });
    const mirror = launch(objects);
    await appendParts(mirror, 600);

    const [merged] = (await mirror.captureTranscripts(sessionId))?.root
      .parts ?? [undefined];

    if (merged === undefined) throw new Error("expected a merged part");
    expect(merged.version).toBeDefined();
    expect((await objects.head(merged.key))?.version).toBe(
      merged.version as string,
    );
  });

  test("still refuses one uuid with two bodies once they share a merged part", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects);
    await mirror.append(root, [entry("same", "first body")]);
    await appendParts(mirror, 600);
    await mirror.append(root, [entry("same", "second body")]);

    await expect(mirror.captureTranscripts(sessionId)).rejects.toThrow(
      /Conflicting transcript entry uuid: same/,
    );
  });

  test("refuses a transcript past the size limit before merging anything", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const mirror = launch(objects);
    await appendParts(mirror, 600);
    await mirror.append(root, [
      {
        type: "user",
        uuid: "big",
        message: "x".repeat(MAX_TRANSCRIPT_PART_BYTES),
      },
    ]);

    await expect(mirror.captureTranscripts(sessionId)).rejects.toMatchObject({
      name: "TranscriptTooLargeError",
      reason: "transcript_part_too_large",
    });
    expect(objects.keys().filter((key) => key.includes("/merged-"))).toEqual(
      [],
    );
  });

  test("sizes what a capture would pin without merging, and judges it by the limits it was given", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const limits = { partBytes: 1 << 20, totalBytes: 1 << 20 };
    const mirror = new ClaudeSessionStore({
      generation: 1,
      objects,
      prefix,
      transcriptLimits: limits,
    });
    await appendParts(mirror, 600);
    await mirror.append({ ...root, subpath: "subagents/agent-1" }, [
      entry("s1", "sub"),
    ]);

    const sizes = await mirror.transcriptSizes(sessionId);
    if (sizes === null) throw new Error("expected a root transcript");
    expect(sizes).toHaveLength(601);
    expect(objects.keys().filter((key) => key.includes("/merged-"))).toEqual(
      [],
    );
    const total = sizes.reduce((sum, part) => sum + part.bytes, 0);
    expect(await mirror.transcriptSizes("session-none")).toBeNull();

    limits.totalBytes = total - 1;
    const refused = mirror.captureTranscripts(sessionId);
    await expect(refused).rejects.toBeInstanceOf(TranscriptTooLargeError);
    await expect(refused).rejects.toMatchObject({
      reason: "transcript_too_large",
    });
    limits.totalBytes = total;
    expect(await mirror.captureTranscripts(sessionId)).not.toBeNull();
  });
});

describe("Claude session store counting entries across captures", () => {
  function launch(
    objects: MemoryCheckpointObjectStore,
    generation = 1,
    inherit?: TranscriptInheritance,
  ) {
    return new ClaudeSessionStore({
      generation,
      objects,
      prefix,
      ...(inherit === undefined ? {} : { inherit }),
    });
  }

  /** Retried batches and uuid-less frames mixed in, as the SDK writes them. */
  async function appendMany(
    mirror: ClaudeSessionStore,
    from: number,
    to: number,
  ) {
    for (let index = from; index < to; index += 1) {
      const batch = [entry(`u${index}`, `entry ${index}`)];
      await mirror.append(root, batch);
      if (index % 37 === 0) {
        await mirror.append(root, batch);
        await mirror.append(root, [{ type: "title", title: `t${index}` }]);
      }
    }
  }

  async function parsesDuring(work: () => Promise<unknown>): Promise<number> {
    const parse = spyOn(JSON, "parse");
    try {
      await work();
      return parse.mock.calls.length;
    } finally {
      parse.mockRestore();
    }
  }

  /**
   * `JSON.parse` calls made by the capture after one more single-entry part,
   * on top of `history` parts already captured. What one entry costs is the
   * serializer's business; that it does not grow with the history is this
   * store's.
   */
  async function parsesAfter(history: number): Promise<number> {
    const mirror = launch(createMemoryCheckpointObjectStore());
    await appendMany(mirror, 0, history);
    await mirror.captureTranscripts(sessionId);
    await mirror.append(root, [entry("next", "one more")]);
    return parsesDuring(() => mirror.captureTranscripts(sessionId));
  }

  test("parses only the parts appended since the last capture", async () => {
    const one = await parsesAfter(1);

    expect(one).toBeGreaterThan(0);
    expect(await parsesAfter(200)).toBe(one);
  });

  test("carries the count over a merge, so the capture after it parses only what is new", async () => {
    const mirror = launch(createMemoryCheckpointObjectStore());
    await appendMany(mirror, 0, 600);
    const merged = await mirror.captureTranscripts(sessionId);
    expect(merged?.root.parts[0]?.key).toContain("/merged-");
    await mirror.append(root, [entry("next", "one more")]);

    expect(await parsesDuring(() => mirror.captureTranscripts(sessionId))).toBe(
      await parsesAfter(1),
    );
  });

  test("counts what a count over the whole transcript would, capture after capture", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = launch(objects);
    for (let to = 50; to <= 1300; to += 50) {
      await appendMany(first, to - 50, to);
      const captured = await first.captureTranscripts(sessionId);
      const revision = await first.captureRevision(root);
      const all = (await first.load(root)) as TranscriptEntry[];
      expect(captured?.root.entryCount).toBe(all.length);
      expect(revision?.entryCount).toBe(all.length);
      expect(captured?.root.sha256).toBe(
        digestParts(captured?.root.parts ?? []),
      );
    }

    const pinned = await first.captureTranscripts(sessionId);
    if (pinned === null) throw new Error("expected transcripts");
    const second = launch(objects, 2, { sessionId, transcripts: pinned });
    await second.verifyInherited();
    await appendMany(second, 1300, 1400);
    const resumed = await second.captureTranscripts(sessionId);

    expect(resumed?.root.entryCount).toBe(
      ((await second.load(root)) as TranscriptEntry[]).length,
    );
    expect(
      await launch(objects, 3).loadRevision(
        resumed?.root as TranscriptRevision,
      ),
    ).toHaveLength(resumed?.root.entryCount as number);
  });

  test("refuses one uuid with two bodies across captures, on every capture after", async () => {
    const mirror = launch(createMemoryCheckpointObjectStore());
    await mirror.append(root, [entry("same", "first body")]);
    await appendMany(mirror, 0, 20);
    await mirror.captureTranscripts(sessionId);
    await mirror.append(root, [entry("same", "second body")]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(mirror.captureTranscripts(sessionId)).rejects.toThrow(
        /Conflicting transcript entry uuid: same/,
      );
    }
  });
});

describe("Claude session store writing a resumed transcript to disk", () => {
  const subagent = { ...root, subpath: "subagents/agent-1" };
  const metadata = { type: "agent_metadata", agentType: "reviewer" };

  async function adopted(objects: MemoryCheckpointObjectStore) {
    const first = new ClaudeSessionStore({ generation: 1, objects, prefix });
    await first.append(root, [entry("a", "first")]);
    // A retried batch, stored twice, and a uuid-less frame.
    await first.append(root, [entry("b", "second")]);
    await first.append(root, [entry("b", "second")]);
    await first.append(root, [{ type: "title", title: "t" }]);
    await first.append(subagent, [entry("s", "subagent"), metadata]);
    const transcripts = await first.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");
    return new ClaudeSessionStore({
      generation: 2,
      inherit: { sessionId, transcripts },
      objects,
      prefix,
    });
  }

  async function lines(path: string): Promise<unknown[]> {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  test("reports the cost the transcript saved last, with its session", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = new ClaudeSessionStore({ generation: 1, objects, prefix });
    await first.append(root, [
      entry("a", "first"),
      { type: "cost-state", totalCostUSD: 3, sessionId },
    ]);
    await first.append(root, [
      { type: "cost-state", totalCostUSD: 4.5, sessionId },
    ]);
    const transcripts = await first.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");
    const second = new ClaudeSessionStore({
      generation: 2,
      inherit: { sessionId, transcripts },
      objects,
      prefix,
    });
    const projects = await mkdtemp(join(tmpdir(), "materialize-"));
    try {
      expect(second.resumedSavedCost()).toBeUndefined();
      await second.materialize(projects);
      expect(second.resumedSavedCost()).toEqual({ usd: 4.5, sessionId });
    } finally {
      await rm(projects, { force: true, recursive: true });
    }
  });

  test("lays the session out as the SDK does, each entry as load returned it", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const loaded = await adopted(objects);
    const expectedRoot = await loaded.load(root);
    const expectedSubagent = await loaded.load(subagent);
    const projects = await mkdtemp(join(tmpdir(), "materialize-"));
    try {
      const second = new ClaudeSessionStore({
        generation: 3,
        inherit: {
          sessionId,
          transcripts: (await loaded.captureTranscripts(
            sessionId,
          )) as CheckpointTranscripts,
        },
        objects,
        prefix,
      });
      await second.materialize(projects);

      const session = join(projects, projectKey);
      expect(await lines(join(session, `${sessionId}.jsonl`))).toEqual(
        expectedRoot as TranscriptEntry[],
      );
      expect(
        await lines(join(session, sessionId, `${subagent.subpath}.jsonl`)),
      ).toEqual(
        (expectedSubagent as TranscriptEntry[]).filter(
          (item) => item.type !== "agent_metadata",
        ),
      );
      expect(
        JSON.parse(
          await readFile(
            join(session, sessionId, `${subagent.subpath}.meta.json`),
            "utf8",
          ),
        ),
      ).toEqual({ agentType: "reviewer" });
      // Published whole: no staging directory is left beside it.
      expect(await readdir(projects)).toEqual([projectKey]);
      expect(
        (await stat(join(session, `${sessionId}.jsonl`))).mode & 0o777,
      ).toBe(0o600);

      // The engine reads the disk; the store hands it nothing, and the
      // history is what it would have handed over.
      expect(await second.load(root)).toBeNull();
      expect([...(second.resumedEntryIds() ?? [])].sort()).toEqual(["a", "b"]);
      await expect(
        second.load({ ...root, projectKey: "-elsewhere" }),
      ).rejects.toThrow(/restored under project key/);
    } finally {
      await rm(projects, { force: true, recursive: true });
    }
  });

  test("holds every part to its digest, and publishes nothing when one fails", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const second = await adopted(objects);
    const transcripts = await second.captureTranscripts(sessionId);
    const pinned = transcripts?.subagents[subagent.subpath]?.parts[0];
    if (pinned === undefined) throw new Error("expected a subagent part");
    const { key: damaged } = pinned;
    await objects.overwrite(
      damaged,
      new TextEncoder().encode('{"type":"x"}\n'),
    );
    const projects = await mkdtemp(join(tmpdir(), "materialize-"));
    try {
      await expect(second.materialize(projects)).rejects.toThrow(
        /Inherited transcript part changed/,
      );
      expect(await readdir(projects)).toEqual([]);
      expect(second.resumedEntryIds()).toBeUndefined();
    } finally {
      await rm(projects, { force: true, recursive: true });
    }
  });

  test("a capture after it fetches none of what it wrote", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const second = await adopted(objects);
    const projects = await mkdtemp(join(tmpdir(), "materialize-"));
    try {
      await second.verifyInherited();
      await second.materialize(projects);
      objects.resetReads();
      await second.append(root, [entry("c", "third")]);
      const captured = await second.captureTranscripts(sessionId);
      expect(objects.reads()).toEqual([]);
      expect(captured?.root.entryCount).toBe(4);
    } finally {
      await rm(projects, { force: true, recursive: true });
    }
  });

  test("writes parts of several MiB back to back, each once", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const first = new ClaudeSessionStore({ generation: 1, objects, prefix });
    const big = (uuid: string) => entry(uuid, "x".repeat(3 * 1024 * 1024));
    await first.append(root, [big("a"), big("b")]);
    await first.append(root, [big("c")]);
    const transcripts = await first.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");
    const second = new ClaudeSessionStore({
      generation: 2,
      inherit: { sessionId, transcripts },
      objects,
      prefix,
    });
    const projects = await mkdtemp(join(tmpdir(), "materialize-"));
    try {
      await second.materialize(projects);
      const file = join(projects, projectKey, `${sessionId}.jsonl`);
      expect((await stat(file)).size).toBe(
        transcripts.root.parts.reduce((total, part) => total + part.bytes, 0),
      );
    } finally {
      await rm(projects, { force: true, recursive: true });
    }
  });

  test("replaces a transcript already under the project key", async () => {
    const objects = createMemoryCheckpointObjectStore();
    const loaded = await adopted(objects);
    const expectedRoot = await loaded.load(root);
    const projects = await mkdtemp(join(tmpdir(), "materialize-"));
    try {
      const stale = join(projects, projectKey, sessionId);
      await mkdir(stale, { recursive: true });
      await writeFile(join(stale, "stale.jsonl"), "{}\n");
      await writeFile(join(projects, projectKey, `${sessionId}.jsonl`), "{}\n");
      await writeFile(join(projects, projectKey, "other.jsonl"), "{}\n");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const second = new ClaudeSessionStore({
          generation: 3 + attempt,
          inherit: {
            sessionId,
            transcripts: (await loaded.captureTranscripts(
              sessionId,
            )) as CheckpointTranscripts,
          },
          objects,
          prefix,
        });
        await second.materialize(projects);
      }
      const session = join(projects, projectKey);
      expect(await lines(join(session, `${sessionId}.jsonl`))).toEqual(
        expectedRoot as TranscriptEntry[],
      );
      expect(
        (await readdir(join(session, sessionId, "subagents"))).sort(),
      ).toEqual(["agent-1.jsonl", "agent-1.meta.json"]);
      expect(await readdir(join(session, sessionId))).toEqual(["subagents"]);
      expect(await readFile(join(session, "other.jsonl"), "utf8")).toBe("{}\n");
      expect(await readdir(projects)).toEqual([projectKey]);
    } finally {
      await rm(projects, { force: true, recursive: true });
    }
  });

  async function occupied() {
    const directory = await mkdtemp(join(tmpdir(), "publish-"));
    const target = join(directory, "target");
    const session = join(directory, "session");
    const aside = join(directory, "aside");
    for (const [root, body] of [
      [target, "old"],
      [session, "new"],
    ] as const) {
      await mkdir(join(root, sessionId, "subagents"), { recursive: true });
      await writeFile(join(root, `${sessionId}.jsonl`), `${body}\n`);
      await writeFile(join(root, sessionId, "subagents", `${body}.jsonl`), "");
    }
    await writeFile(join(target, "other.jsonl"), "other\n");
    return { aside, directory, session, target };
  }

  async function holdsOld(root: string) {
    expect(await readFile(join(root, `${sessionId}.jsonl`), "utf8")).toBe(
      "old\n",
    );
    expect(await readdir(join(root, sessionId, "subagents"))).toEqual([
      "old.jsonl",
    ]);
  }

  test("puts back what a failed publish replaced", async () => {
    const { aside, directory, session, target } = await occupied();
    try {
      await expect(
        publishRestoredSession(session, target, sessionId, aside, (from, to) =>
          from.startsWith(session) && to.endsWith(".jsonl")
            ? Promise.reject(new Error("disk full"))
            : rename(from, to),
        ),
      ).rejects.toThrow("disk full");
      await holdsOld(target);
      expect(await readFile(join(target, "other.jsonl"), "utf8")).toBe(
        "other\n",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("keeps what it replaced aside when putting it back fails too", async () => {
    const { aside, directory, session, target } = await occupied();
    try {
      const failed = await publishRestoredSession(
        session,
        target,
        sessionId,
        aside,
        (from, to) =>
          (from.startsWith(session) && to.endsWith(".jsonl")) ||
          from.startsWith(aside)
            ? Promise.reject(new Error("disk full"))
            : rename(from, to),
      ).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(PublishRollbackFailed);
      expect((failed as PublishRollbackFailed).kept).toBe(aside);
      await holdsOld(aside);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("only a store that adopted a checkpoint materializes", async () => {
    const { mirror } = store();
    await expect(mirror.materialize(tmpdir())).rejects.toThrow(
      /adopted a checkpoint/,
    );
  });
});
