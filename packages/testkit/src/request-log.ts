import type { RecordedRequest } from "./fake-anthropic.ts";
import { type GateRequest, replyFor, specIdsIn } from "./scripted-messages.ts";

/**
 * What a long-running scripted fake remembers of its model calls: the latest
 * `limit` of them, each cut down to what its control port reports. The
 * conversation and system prompt are dropped on arrival, so the log does not
 * grow with their size.
 */
export function createRequestLog(limit: number) {
  const entries: {
    at: string;
    spec_id: string | null;
    step: number | null;
    history: string[];
    tools: string[];
    found: string[];
  }[] = [];
  return {
    reply(request: RecordedRequest, fallback?: string) {
      const seen: GateRequest[] = [];
      const reply = replyFor(request, seen, fallback);
      for (const { at, found, messages, specId, step, tools } of seen) {
        entries.push({
          at,
          spec_id: specId,
          step,
          history: specIdsIn(messages),
          tools,
          found,
        });
      }
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      return reply;
    },
    /** Oldest first; every spec's when `spec` is null. */
    entries(spec: string | null = null) {
      return spec === null
        ? [...entries]
        : entries.filter((entry) => entry.spec_id === spec);
    },
  };
}
