import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  SavedCost,
  TranscriptEntry,
  TranscriptMirror,
} from "@werft-ai/runtime-core";

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
  readonly #cost = Promise.withResolvers<SavedCost | undefined>();

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
        history.#cost.resolve(savedCostOf(entries, sessionId));
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
      ...(store.resumedSavedCost === undefined
        ? {}
        : { resumedSavedCost: () => store.resumedSavedCost?.() }),
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
            history.#cost.resolve(store.resumedSavedCost?.());
          } else if (entries === null) {
            history.#cost.resolve(undefined);
            history.#settle.reject(
              new Error(
                `The resumed transcript for session ${key.sessionId} is empty`,
              ),
            );
          } else {
            history.#settle.resolve(uuidsOf(entries));
            history.#cost.resolve(savedCostOf(entries, key.sessionId));
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
   * again in its first result. Undefined when the transcript holds none.
   */
  savedCost(): Promise<SavedCost | undefined> {
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

/**
 * The engine saves its running cost as `cost-state` entries. It resumes from
 * the last valid one of the session, so that is the one taken here.
 */
function savedCostOf(
  entries: readonly TranscriptEntry[],
  sessionId: string,
): SavedCost | undefined {
  let saved: SavedCost | undefined;
  for (const entry of entries) {
    saved = savedCostOfEntry(entry, sessionId) ?? saved;
  }
  return saved;
}

const COST_STATE_NUMBERS = [
  "totalAPIDuration",
  "totalAPIDurationWithoutRetries",
  "totalToolDuration",
  "totalLinesAdded",
  "totalLinesRemoved",
  "totalDuration",
  "startTime",
] as const;

const MODEL_USAGE_REQUIRED = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "webSearchRequests",
  "costUSD",
] as const;

const MODEL_USAGE_OPTIONAL = [
  "thinkingTokens",
  "cacheCreationEphemeral5mInputTokens",
  "cacheCreationEphemeral1hInputTokens",
] as const;

/** The four token counts the engine also bounds as a sum over all models. */
const MODEL_USAGE_SUMMED = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;

const MAX_COUNT = 1e15;
const MAX_COST_USD = 1e9;

function within(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= max
  );
}

/** A model name the engine accepts: not empty, no control or format characters. */
function isModelName(name: string): boolean {
  return name !== "" && !/[\p{Cc}\p{Cf}]/u.test(name);
}

/**
 * Whether `modelUsage` is what the engine accepts. Anything it would drop is
 * dropped here, since a baseline taken from an entry the engine ignored is
 * larger than the total it starts from and charges the run short.
 */
function isModelUsage(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const sums = MODEL_USAGE_SUMMED.map(() => 0);
  for (const [name, usage] of Object.entries(value)) {
    if (!isModelName(name)) return false;
    if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
      return false;
    }
    const fields = usage as Record<string, unknown>;
    if (!MODEL_USAGE_REQUIRED.every((key) => within(fields[key], MAX_COUNT))) {
      return false;
    }
    for (const key of MODEL_USAGE_OPTIONAL) {
      if (fields[key] !== undefined && !within(fields[key], MAX_COUNT)) {
        return false;
      }
    }
    MODEL_USAGE_SUMMED.forEach((key, i) => {
      sums[i] = (sums[i] ?? 0) + (fields[key] as number);
    });
  }
  return sums.every((sum) => sum <= MAX_COUNT);
}

/**
 * The cost one `cost-state` entry of `sessionId` saved. Undefined for any
 * other entry, for another session's, and for one the engine (0.3.319) would
 * drop for not matching its schema. Charging in full is the safe side when
 * unsure, so this errs toward rejecting.
 */
export function savedCostOfEntry(
  entry: TranscriptEntry,
  sessionId: string,
): SavedCost | undefined {
  if (entry.type !== "cost-state" || entry.sessionId !== sessionId) {
    return undefined;
  }
  const usd = entry.totalCostUSD;
  if (
    !within(usd, MAX_COST_USD) ||
    !COST_STATE_NUMBERS.every((key) => within(entry[key], MAX_COUNT)) ||
    !isModelUsage(entry.modelUsage) ||
    (entry.hasUnknownModelCost !== undefined &&
      typeof entry.hasUnknownModelCost !== "boolean")
  ) {
    return undefined;
  }
  return { usd, sessionId };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
