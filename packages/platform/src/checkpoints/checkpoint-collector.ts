import {
  type CheckpointCodec,
  type CheckpointManifest,
  type CheckpointObjectStore,
  TRANSCRIPT_MIRROR_DIRECTORY,
  transcriptGenerationOf,
} from "@werft-ai/runtime-core";
import {
  DEFAULT_MAX_RESTORE_FALLBACKS,
  type ObjectProtection,
  sessionObjectPrefix,
} from "./checkpoint-service.ts";
import {
  engineOf,
  inBatches,
  keepSet,
  own,
  parentOf,
  sha256,
} from "./checkpoint-support.ts";
import type {
  CheckpointCollectionStore,
  CheckpointObjectCollector,
  StoredObjectVersion,
} from "./ports/checkpoint-collection.ts";
import type { CheckpointPointer } from "./ports/checkpoint-store.ts";

export type CheckpointCollectorDependencies = {
  codecs: Readonly<Record<string, CheckpointCodec>>;
  collector: CheckpointObjectCollector;
  /**
   * How many committed revisions below the pointer stay restorable. Must be
   * the CheckpointService's `maxRestoreFallbacks`: a smaller value here
   * releases revisions a fallback restore would still reach for.
   */
  maxRestoreFallbacks?: number;
  objectProtection: ObjectProtection;
  /** Reads manifests; the collector never writes through it. */
  objects: Pick<CheckpointObjectStore, "get">;
  store: CheckpointCollectionStore;
};

export type SessionCollection =
  | { kept: number; purged: number; status: "collected" }
  | { reason: string; status: "skipped" };

/**
 * Releases and deletes the checkpoint objects no restore can reach and no
 * finalize can still commit.
 *
 * Two kinds of version are collected. Under
 * `<session>/checkpoints/<revision>/<attempt>/`: manifests, workspace bundles
 * and untracked files, which each belong to the one attempt that wrote them.
 * Under `<session>/transcripts/generation-<n>/`: transcript parts, which every
 * revision that inherits them shares. Nothing else is touched.
 *
 * A version goes only when both hold:
 *
 * - *No restore needs it.* It is not named by the pointer's checkpoint, the
 *   `maxRestoreFallbacks` revisions below it along the parent chain, the
 *   fallback base the session was last restored from and as many below that
 *   (the window of the commit built on it), or a revision an open push
 *   request pinned and as many below that. Only the attempt that
 *   holds the fence restores anything that matters, and the pointer does not
 *   move until that attempt commits, so its plan is always among these.
 * - *No finalize can commit it.* For a checkpoint directory: it is at or
 *   below the pointer's revision — the pointer CAS accepts only the next
 *   one — or belongs to an attempt that lost its fence. Finalize accepts a
 *   manifest naming directory objects only in its own attempt's directory
 *   (`verifyAttemptManifest`), so whatever a finalize in flight has held
 *   sits in a directory that is neither, whatever order its hold, this
 *   collection and its CAS run in. For a transcript part: its generation is
 *   below the session's, so every attempt that could write it is fenced.
 *   Finalize accepts a part of another generation only when the checkpoint
 *   the candidate builds on names it (`strayTranscriptPart`) — the pointer,
 *   or the parent a fallback restored — and the pointer's window keeps both,
 *   so a part a finalize in flight has held is either of a generation this
 *   collection does not reach or one it keeps.
 *
 * Both conditions only ever grow more true, so reading the database before
 * listing the objects needs no lock — only the order the two reads run in
 * (`collectSession`).
 */
export function createCheckpointCollector(
  deps: CheckpointCollectorDependencies,
) {
  const { codecs, collector, objects, store } = deps;
  const window = deps.maxRestoreFallbacks ?? DEFAULT_MAX_RESTORE_FALLBACKS;

  async function row(
    sessionId: string,
    revision: number,
  ): Promise<CheckpointPointer | undefined> {
    const [found] = await store.listCheckpoints(sessionId, {
      belowRevision: revision + 1,
      limit: 1,
    });
    return found?.revision === revision ? found : undefined;
  }

  /** The committed checkpoints a restore of this session may still read. */
  async function restorable(
    sessionId: string,
    pointer: CheckpointPointer | null,
    fallbackRevision: number | null,
    pinnedRevisions: readonly number[],
  ): Promise<CheckpointPointer[] | string> {
    const rows = new Map<number, CheckpointPointer>();
    const walk = async (start: CheckpointPointer) => {
      let next = start;
      for (let depth = 0; ; depth += 1) {
        rows.set(next.revision, next);
        const parent = depth < window ? parentOf(next) : null;
        if (parent === null) return undefined;
        const found = await row(sessionId, parent);
        if (found === undefined) {
          return `no checkpoint row for revision ${parent}, which revision ${next.revision} was built on`;
        }
        next = found;
      }
    };
    const broken = pointer === null ? undefined : await walk(pointer);
    if (broken !== undefined) return broken;
    // The session runs on the fallback base, and its next commit is built on
    // it: that commit's own window then reaches below the base, so the base's
    // chain stays as the pointer's does.
    if (fallbackRevision !== null) {
      const base = await row(sessionId, fallbackRevision);
      if (base === undefined) {
        return `no checkpoint row for fallback revision ${fallbackRevision}`;
      }
      const brokenBase = await walk(base);
      if (brokenBase !== undefined) return brokenBase;
    }
    for (const revision of pinnedRevisions) {
      const pinned = await row(sessionId, revision);
      if (pinned === undefined) {
        return `no checkpoint row for revision ${revision}, which a push request pinned`;
      }
      const brokenPin = await walk(pinned);
      if (brokenPin !== undefined) return brokenPin;
    }
    return [...rows.values()];
  }

  /**
   * The manifest as its row committed it, or a reason it cannot be trusted
   * to say what to keep. Read by the version the row recorded, the way a
   * restore reads it.
   */
  async function manifestOf(
    checkpoint: CheckpointPointer,
  ): Promise<CheckpointManifest | string> {
    const bytes = await objects.get(
      checkpoint.manifestRef,
      checkpoint.manifestVersion ?? undefined,
    );
    const label = `revision ${checkpoint.revision} manifest ${checkpoint.manifestRef}`;
    if (bytes === undefined) return `${label} is missing`;
    if (sha256(bytes) !== checkpoint.manifestSha256) {
      return `${label} does not match its digest`;
    }
    const engine = engineOf(bytes);
    const codec = engine === undefined ? undefined : own(codecs, engine);
    if (codec === undefined) return `${label} has no codec`;
    try {
      return codec.decode(bytes);
    } catch (error) {
      return `${label} does not decode: ${(error as Error).message}`;
    }
  }

  async function collectSession(
    sessionId: string,
    options: { dryRun: boolean },
  ): Promise<SessionCollection> {
    if (deps.objectProtection !== "locked") {
      return {
        status: "skipped",
        reason:
          "objectProtection is unversioned: nothing is held, and a checkpoint names keys rather than versions",
      };
    }
    // Fences first, pointer second. An attempt fenced by now committed
    // whatever it ever will before this read, so the pointer read after it
    // covers that commit. The other order loses it: the pointer is read,
    // the attempt commits the next revision and is released, and its fresh
    // pointer's directory then reads as a fenced attempt's garbage.
    // A fallback base recorded after this read needs nothing more: a locked
    // restore falls back one hop at most (`judgeEarlier` refuses damage), so
    // that base is the pointer's parent, and a commit built on it can reach
    // no further back than the pointer's own window already keeps.
    const fences = await store.readCollectionFences(sessionId);
    if (fences === null) {
      return { status: "skipped", reason: "session does not exist" };
    }
    const pointer = await store.readPointer(sessionId);
    // Pins after the pointer: a request made after this read pins the
    // pointer it sees, which is this one or newer and so kept anyway.
    const pinned = await store.readPushPinnedRevisions(sessionId);
    const rows = await restorable(
      sessionId,
      pointer,
      fences.fallbackRevision,
      pinned,
    );
    if (typeof rows === "string") return { status: "skipped", reason: rows };
    const keep = keepSet();
    for (const checkpoint of rows) {
      const manifest = await manifestOf(checkpoint);
      if (typeof manifest === "string") {
        return { status: "skipped", reason: manifest };
      }
      keep.addManifest(checkpoint, manifest);
    }
    const pointerRevision = pointer?.revision ?? -1;
    const sessionPrefix = sessionObjectPrefix(sessionId);
    const directories = `${sessionPrefix}checkpoints/`;
    const doomed: StoredObjectVersion[] = [];
    let kept = 0;
    for (const entry of await collector.listVersions(directories)) {
      const directory = attemptDirectory(entry.key, directories);
      const collectible =
        directory !== undefined &&
        (directory.revision <= pointerRevision ||
          fences.fencedAttemptIds.has(directory.attemptId));
      if (collectible && !keep.has(entry)) doomed.push(entry);
      else kept += 1;
    }
    // A dead generation's tail past its last checkpoint, and parts only a
    // revision this collection gave up named. The generation is read with
    // the fences, before the pointer, for the same reason they are.
    const mirror = `${sessionPrefix}${TRANSCRIPT_MIRROR_DIRECTORY}/`;
    for (const entry of await collector.listVersions(mirror)) {
      const generation = transcriptGenerationOf(entry.key, sessionPrefix);
      const collectible =
        generation !== undefined && generation < fences.executionGeneration;
      if (collectible && !keep.has(entry)) doomed.push(entry);
      else kept += 1;
    }
    if (!options.dryRun) {
      const collected =
        pointer === null
          ? null
          : {
              keep: rows.map((checkpoint) => checkpoint.revision),
              throughRevision: pointer.revision,
            };
      if (collected !== null) {
        await store.markCollected(sessionId, collected);
      }
      await inBatches(doomed, 32, (entry) => collector.purge(entry));
      if (collected !== null) {
        await store.markPurged(sessionId, collected);
      }
    }
    return { status: "collected", kept, purged: doomed.length };
  }

  return {
    collectSession,

    /**
     * Every session not settled, `batchSize` at a time. A session that fails
     * is reported and the rest still run: one unreadable bucket prefix must
     * not keep every other session's garbage forever. A session collected
     * here may be settled, which later passes then skip.
     */
    async collect(options: {
      batchSize: number;
      dryRun: boolean;
      onSession?: (
        sessionId: string,
        result: SessionCollection | { error: unknown; status: "failed" },
      ) => void;
    }): Promise<{
      failed: number;
      purged: number;
      sessions: number;
      settled: number;
    }> {
      const totals = { failed: 0, purged: 0, sessions: 0, settled: 0 };
      let after: string | null = null;
      for (;;) {
        const ids = await store.listSessionIds({
          after,
          limit: options.batchSize,
        });
        for (const sessionId of ids) {
          totals.sessions += 1;
          try {
            const result = await collectSession(sessionId, options);
            if (result.status === "collected") {
              totals.purged += result.purged;
              if (
                !options.dryRun &&
                (await store.settleCollection(sessionId))
              ) {
                totals.settled += 1;
              }
            }
            options.onSession?.(sessionId, result);
          } catch (error) {
            totals.failed += 1;
            options.onSession?.(sessionId, { status: "failed", error });
          }
        }
        if (ids.length < options.batchSize) return totals;
        after = ids.at(-1) ?? null;
      }
    },
  };
}

/**
 * `<prefix><revision>/<attempt>/…` as `manifestRefFor` mints it. Anything
 * else under the prefix was not written by a checkpoint publish and is not
 * this collector's to judge.
 */
function attemptDirectory(
  key: string,
  prefix: string,
): { attemptId: string; revision: number } | undefined {
  const match = /^(\d{10})\/([^/]+)\/./.exec(key.slice(prefix.length));
  if (match === null || !key.startsWith(prefix)) return undefined;
  return { revision: Number(match[1]), attemptId: match[2] as string };
}
