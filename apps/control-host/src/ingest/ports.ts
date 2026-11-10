// Ports the telemetry ingest listener owns. Adapters (Postgres, the OTLP SDK,
// the logger) implement them elsewhere, so this module has no storage or SDK
// import and can move into its own process later.

import type { IngestSpan } from "@werft-ai/observability";

/** Who a session credential belongs to, and whether the attempt still holds the session. */
export interface IngestAttempt {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly executionGeneration: number;
  /** Null for a session created before workspaces: it goes to the install tenant. */
  readonly workspaceId: string | undefined;
  /** `lost` carries the moment the attempt stopped owning the session. */
  readonly fence:
    | { readonly state: "held" }
    | { readonly state: "lost"; readonly lostAt: Date };
}

export interface AttemptAuthenticator {
  /** Null for a token that is unknown, or lost its attempt long enough ago that no grace can apply. */
  authenticate(token: string): Promise<IngestAttempt | null>;
}

export interface TurnTraceDirectory {
  /** `turnTraceId` of every turn the attempt was handed. */
  traceIdsOf(attempt: IngestAttempt): Promise<ReadonlySet<string>>;
}

/** A second masking pass over a content value, by the value itself. */
export interface ValueMasker {
  mask(value: string): string;
}

export interface SpanSink {
  send(spans: readonly IngestSpan[]): Promise<void>;
}

export type DropReason =
  | "foreign_trace"
  | "rate_limited"
  | "queue_full"
  | "send_failed";

export interface DropCounter {
  dropped(reason: DropReason, count: number): void;
}

export interface Clock {
  now(): number;
}
