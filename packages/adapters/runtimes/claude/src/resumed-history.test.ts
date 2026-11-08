import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  TranscriptEntry,
  TranscriptKey,
  TranscriptMirror,
} from "@werft-ai/runtime-core";

import { ResumedHistory } from "./resumed-history.ts";

const ROOT: TranscriptKey = { projectKey: "project", sessionId: "s1" };

function mirror(
  load: (key: TranscriptKey) => Promise<TranscriptEntry[] | null>,
): TranscriptMirror {
  return {
    revisionScoped: true,
    append: async () => {},
    listSubkeys: async () => [],
    load,
  };
}

let scratch: string | undefined;

afterEach(async () => {
  if (scratch !== undefined)
    await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("resumed history", () => {
  test("a new session holds nothing", async () => {
    expect(await ResumedHistory.empty().uuids()).toEqual(new Set());
  });

  test("is exactly what the engine loaded for the root transcript", async () => {
    const entries: TranscriptEntry[] = [
      { type: "queue-operation" },
      { type: "user", uuid: "input-1" },
      { type: "attachment", uuid: "engine-1" },
    ];
    const { history, store } = ResumedHistory.watching(
      mirror(async (key) =>
        key.subpath === undefined ? entries : [{ type: "user", uuid: "sub" }],
      ),
    );
    // The revision-scoped flag is what lets a resume through at all.
    expect(store.revisionScoped).toBe(true);
    // A subagent's transcript is not the root one and settles nothing.
    await store.load({ ...ROOT, subpath: "subagents/a" });
    expect(await store.load(ROOT)).toBe(entries);
    expect(await history.uuids()).toEqual(new Set(["input-1", "engine-1"]));
    // A late abandon does not undo what was loaded.
    history.abandon();
    expect(await history.uuids()).toEqual(new Set(["input-1", "engine-1"]));
  });

  test("never reads a missing or failed load as an empty history", async () => {
    const missing = ResumedHistory.watching(mirror(async () => null));
    await missing.store.load(ROOT);
    await expect(missing.history.uuids()).rejects.toThrow("is empty");

    const failing = ResumedHistory.watching(
      mirror(async () => {
        throw new Error("store unreachable");
      }),
    );
    await expect(failing.store.load(ROOT)).rejects.toThrow("store unreachable");
    await expect(failing.history.uuids()).rejects.toThrow("store unreachable");
  });

  test("an engine that ended before loading leaves the history unknown", async () => {
    const { history } = ResumedHistory.watching(mirror(async () => []));
    history.abandon();
    await expect(history.uuids()).rejects.toThrow("before it loaded");
  });

  test("reads a local resume from the CLI's own transcript file, under the canonical cwd", async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "94s-242-")));
    const cwd = join(scratch, "space.one");
    await mkdir(cwd);
    const linked = join(scratch, "linked");
    await symlink(cwd, linked);
    const dir = join(scratch, "projects", cwd.replaceAll(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "s1.jsonl"),
      `${JSON.stringify({ type: "user", uuid: "input-1" })}\n${JSON.stringify({ type: "summary" })}\n`,
    );

    for (const spelling of [cwd, `${cwd}/`, linked]) {
      const history = ResumedHistory.fromLocalDisk(scratch, spelling, "s1");
      expect(await history.uuids()).toEqual(new Set(["input-1"]));
    }

    const absent = ResumedHistory.fromLocalDisk(scratch, cwd, "s2");
    await expect(absent.uuids()).rejects.toThrow("could not be read");
    expect(await absent.savedCost()).toBeUndefined();
  });

  test("reads the cost the transcript saved last, and none when it saved none", async () => {
    const withCost: TranscriptEntry[] = [
      { type: "user", uuid: "input-1" },
      { type: "cost-state", totalCostUSD: 3, sessionId: "s1" },
      { type: "cost-state", totalCostUSD: 4.5, sessionId: "s1" },
    ];
    const watched = ResumedHistory.watching(mirror(async () => withCost));
    await watched.store.load(ROOT);
    expect(await watched.history.savedCost()).toEqual({
      usd: 4.5,
      sessionId: "s1",
    });

    const without = ResumedHistory.watching(
      mirror(async () => [{ type: "user", uuid: "input-1" }]),
    );
    await without.store.load(ROOT);
    expect(await without.history.savedCost()).toBeUndefined();
    expect(await ResumedHistory.empty().savedCost()).toBeUndefined();
  });

  test("a mirror that wrote the transcript to disk hands over its saved cost", async () => {
    const base = mirror(async () => null);
    const { history, store } = ResumedHistory.watching({
      ...base,
      resumedEntryIds: () => new Set(["a"]),
      resumedSavedCost: () => ({ usd: 3, sessionId: "s1" }),
    });
    expect(await store.load(ROOT)).toBeNull();
    expect(await history.uuids()).toEqual(new Set(["a"]));
    expect(await history.savedCost()).toEqual({ usd: 3, sessionId: "s1" });
  });
});
