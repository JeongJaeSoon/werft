import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { TranscriptEntry, TranscriptMirror } from "@werft-ai/runtime-core";

/**
 * The entry uuids of the transcript a resumed run continues. A send whose uuid
 * is already in it is deduplicated by the engine and never answered, so the
 * host has to know before it sends, not after.
 *
 * Every entry's uuid counts, not only user messages': an input the engine
 * folded into a queued command or wrote on a branch is still one it will not
 * run again, and the uuids the host generates never collide with the ones the
 * engine does.
 */
export class ResumedHistory {
  readonly #settle = Promise.withResolvers<ReadonlySet<string>>();
  readonly #cost = Promise.withResolvers<number | undefined>();

  private constructor() {
    // Nobody may ask before the run ends, and an unobserved rejection is noise.
    this.#settle.promise.catch(() => {});
  }

  /** A new engine session holds nothing yet. */
  static empty(): ResumedHistory {
    const history = new ResumedHistory();
    history.#settle.resolve(new Set());
    history.#cost.resolve(undefined);
    return history;
  }

  /**
   * Reads the transcript a local resume hands the engine: the CLI's own file
   * under `<config dir>/projects/<sanitized cwd>/`. Deliberately minimal — the
   * CLI shortens directory names past 200 characters with a hash this does
   * not reproduce, so such a path reads as missing and the run fails closed.
   * Only local tools resume this way; a checkpoint resume goes through
   * `watching`.
   */
  static fromLocalDisk(
    claudeConfigDir: string,
    cwd: string,
    sessionId: string,
  ): ResumedHistory {
    const history = new ResumedHistory();
    void (async () => {
      try {
        // The CLI names the directory after the canonical cwd, not the
        // string it was handed: a trailing slash or a symlink would
        // otherwise point at a file that does not exist.
        const canonical = (await realpath(resolve(cwd))).normalize("NFC");
        const path = join(
          claudeConfigDir,
          "projects",
          canonical.replaceAll(/[^a-zA-Z0-9]/g, "-"),
          `${sessionId}.jsonl`,
        );
        const text = await readFile(path, "utf8");
        const entries = text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as TranscriptEntry);
        history.#settle.resolve(uuidsOf(entries));
        history.#cost.resolve(savedCostOf(entries));
      } catch (error) {
        history.#cost.resolve(undefined);
        history.#settle.reject(
          new Error(
            `The resumed transcript for session ${sessionId} could not be read: ${describe(error)}`,
          ),
        );
      }
    })();
    return history;
  }

  /**
   * Wraps the mirror a checkpoint resume hands the engine, so the history is
   * exactly what the engine loaded — the SDK reads the root transcript once,
   * in this process, before it spawns the CLI. No second read, and no second
   * guess at the key it used. A mirror that already wrote the transcript to
   * the engine's disk answers that read with null and names the uuids it
   * wrote instead.
   */
  static watching(store: TranscriptMirror): {
    history: ResumedHistory;
    store: TranscriptMirror;
  } {
    const history = new ResumedHistory();
    const watched: TranscriptMirror = {
      ...(store.revisionScoped === undefined
        ? {}
        : { revisionScoped: store.revisionScoped }),
      append: (key, entries) => store.append(key, entries),
      listSubkeys: (key) => store.listSubkeys(key),
      load: async (key) => {
        if (key.subpath !== undefined) return store.load(key);
        try {
          const entries = await store.load(key);
          const written =
            entries === null ? store.resumedEntryIds?.() : undefined;
          if (written !== undefined) {
            history.#settle.resolve(written);
            history.#cost.resolve(undefined);
          } else if (entries === null) {
            history.#cost.resolve(undefined);
            history.#settle.reject(
              new Error(
                `The resumed transcript for session ${key.sessionId} is empty`,
              ),
            );
          } else {
            history.#settle.resolve(uuidsOf(entries));
            history.#cost.resolve(savedCostOf(entries));
          }
          return entries;
        } catch (error) {
          history.#cost.resolve(undefined);
          history.#settle.reject(
            new Error(
              `The resumed transcript for session ${key.sessionId} could not be loaded: ${describe(error)}`,
            ),
          );
          throw error;
        }
      },
    };
    return { history, store: watched };
  }

  uuids(): Promise<ReadonlySet<string>> {
    return this.#settle.promise;
  }

  /**
   * The running cost the resumed transcript saved, which the engine reports
   * again in its first result. Undefined when the transcript holds none or
   * was not read (a mirror that wrote it to disk before the engine asked).
   */
  priorCostUsd(): Promise<number | undefined> {
    return this.#cost.promise;
  }

  /** The engine is gone; a load it never made will not come. No-op once settled. */
  abandon(): void {
    this.#cost.resolve(undefined);
    this.#settle.reject(
      new Error("The engine ended before it loaded the resumed transcript"),
    );
  }
}

function uuidsOf(entries: readonly TranscriptEntry[]): ReadonlySet<string> {
  return new Set(
    entries.flatMap((entry) =>
      typeof entry.uuid === "string" ? [entry.uuid] : [],
    ),
  );
}

/** The engine saves its running cost as `cost-state` entries; the last one wins. */
function savedCostOf(entries: readonly TranscriptEntry[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "cost-state") continue;
    const total = entry.totalCostUSD;
    return typeof total === "number" && Number.isFinite(total) && total >= 0
      ? total
      : undefined;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
