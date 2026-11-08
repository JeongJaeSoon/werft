import type { TranscriptEntry, TranscriptMirror } from "@werft-ai/runtime-core";

/**
 * Which tool calls the transcript mirror has durably written on this run:
 * the tool_use ids of assistant entries and the tool_result ids of user
 * ones, counted once their append resolved. The engine hands the batch that
 * holds a waiting call to the mirror only after it asked about that call
 * (T-7: 26-109ms later), so an approval-wait checkpoint waits on this.
 */
export class MirrorProgress {
  readonly uses = new Set<string>();
  readonly results = new Set<string>();
  #waiters: Array<() => void> = [];

  watch(store: TranscriptMirror): TranscriptMirror {
    const resumedEntryIds = store.resumedEntryIds;
    const resumedSavedCost = store.resumedSavedCost;
    return {
      ...(store.revisionScoped === undefined
        ? {}
        : { revisionScoped: store.revisionScoped }),
      append: async (key, entries) => {
        await store.append(key, entries);
        this.#record(entries);
      },
      listSubkeys: (key) => store.listSubkeys(key),
      load: (key) => store.load(key),
      ...(resumedEntryIds === undefined
        ? {}
        : { resumedEntryIds: () => resumedEntryIds.call(store) }),
      ...(resumedSavedCost === undefined
        ? {}
        : { resumedSavedCost: () => resumedSavedCost.call(store) }),
    };
  }

  /** Settles at the next append that lands, or after `ms`. */
  next(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const waiters = this.#waiters;
      function done() {
        clearTimeout(timer);
        const index = waiters.indexOf(done);
        if (index !== -1) waiters.splice(index, 1);
        resolve();
      }
      waiters.push(done);
    });
  }

  #record(entries: readonly TranscriptEntry[]): void {
    for (const entry of entries) {
      const content = (entry.message as { content?: unknown } | undefined)
        ?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const part = block as {
          id?: unknown;
          tool_use_id?: unknown;
          type?: unknown;
        } | null;
        if (part?.type === "tool_use" && typeof part.id === "string") {
          this.uses.add(part.id);
        } else if (
          part?.type === "tool_result" &&
          typeof part.tool_use_id === "string"
        ) {
          this.results.add(part.tool_use_id);
        }
      }
    }
    for (const wake of this.#waiters.splice(0)) wake();
  }
}
