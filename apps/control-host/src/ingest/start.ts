// Opens the ingest listener on its own port inside the api process. Every
// piece below the Bun.serve call is injected, so a separate process can build
// the same thing from the same ports.

import type { ContentMode, TracingSettings } from "@werft-ai/observability";
import { ForwardQueue } from "./forward-queue.ts";
import { createIngestHandler } from "./listener.ts";
import type {
  AttemptAuthenticator,
  DropCounter,
  SpanSink,
  TurnTraceDirectory,
  ValueMasker,
} from "./ports.ts";

// Requests read or checked at once. Each holds at most one request body, so
// this bounds the listener's memory at maxConcurrent * maxRequestBytes.
const MAX_CONCURRENT = 8;
const QUEUE_CLOSE_MS = 3_000;

export interface IngestListener {
  readonly port: number;
  stop(closeActiveConnections?: boolean): Promise<void>;
  readonly pendingRequests: number;
  /** Stops the listener, then gives queued spans a bounded time to leave. */
  close(): Promise<void>;
}

export interface StartIngestDeps {
  readonly settings: Pick<TracingSettings, "ingest" | "content">;
  readonly authenticator: AttemptAuthenticator;
  readonly turns: TurnTraceDirectory;
  readonly sink: SpanSink;
  readonly masker: ValueMasker;
  readonly drops: DropCounter;
  /** 0 asks the OS for a free port. */
  readonly port?: number;
  readonly contentMode?: () => ContentMode;
}

export function startIngestListener(deps: StartIngestDeps): IngestListener {
  const { ingest, content } = deps.settings;
  const queue = new ForwardQueue(deps.sink, deps.drops);
  const handler = createIngestHandler({
    authenticator: deps.authenticator,
    turns: deps.turns,
    queue,
    masker: deps.masker,
    drops: deps.drops,
    contentMode: deps.contentMode ?? (() => content.mode),
    limits: {
      maxRequestBytes: ingest.maxRequestBytes,
      maxBytesPerMinute: ingest.maxBytesPerMinute,
      maxBytesPerTrace: ingest.maxBytesPerTrace,
      fencedGraceSec: ingest.fencedGraceSec,
      maxConcurrent: MAX_CONCURRENT,
    },
  });
  const server = Bun.serve({
    port: deps.port ?? ingest.port,
    // Bun cuts a larger body before the handler runs; this is the only
    // place the ingest limit is set, apart from the public API's own.
    maxRequestBodySize: ingest.maxRequestBytes,
    fetch: handler,
  });
  return {
    get port() {
      return server.port ?? 0;
    },
    stop: (closeActiveConnections) => server.stop(closeActiveConnections),
    get pendingRequests() {
      return server.pendingRequests;
    },
    async close() {
      await server.stop();
      await queue.close(QUEUE_CLOSE_MS);
    },
  };
}
