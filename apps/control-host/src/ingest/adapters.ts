// Adapters that bind the listener's ports to this installation's storage,
// masking and logging.

import type { TelemetryIngestStore } from "@werft-ai/db";
import {
  type StructuredLogger,
  sanitizeText,
  turnTraceId,
} from "@werft-ai/observability";
import { hashWorkerToken } from "@werft-ai/platform";
import type {
  AttemptAuthenticator,
  Clock,
  DropCounter,
  DropReason,
  TurnTraceDirectory,
  ValueMasker,
} from "./ports.ts";

export function postgresAttemptAuthenticator(
  store: Pick<TelemetryIngestStore, "attemptOfCredential">,
  clock: Clock = { now: () => Date.now() },
): AttemptAuthenticator {
  return {
    async authenticate(token) {
      const row = await store.attemptOfCredential(hashWorkerToken(token));
      if (row === null) return null;
      return {
        sessionId: row.sessionId,
        attemptId: row.attemptId,
        executionId: row.executionId,
        executionGeneration: row.executionGeneration,
        workspaceId: row.workspaceId ?? undefined,
        fence: row.held
          ? { state: "held" }
          : { state: "lost", lostAt: new Date(clock.now() - row.lostForMs) },
      };
    },
  };
}

export function postgresTurnTraceDirectory(
  store: Pick<TelemetryIngestStore, "turnSequencesOf">,
): TurnTraceDirectory {
  return {
    async traceIdsOf(attempt) {
      const sequences = await store.turnSequencesOf(attempt.attemptId);
      return new Set(
        sequences.map((sequence) => turnTraceId(attempt.sessionId, sequence)),
      );
    },
  };
}

/** The existing value-based masker. A pattern-based one (94S-730) replaces it behind the same port. */
export const valueMasker: ValueMasker = { mask: sanitizeText };

/** Counts in memory and logs a running total at most once a minute per reason. */
export class LoggedDropCounter implements DropCounter {
  private readonly totals = new Map<DropReason, number>();
  private readonly lastLogged = new Map<DropReason, number>();

  constructor(
    private readonly logger: Pick<StructuredLogger, "warn">,
    private readonly clock: Clock = { now: () => Date.now() },
  ) {}

  dropped(reason: DropReason, count: number): void {
    const total = (this.totals.get(reason) ?? 0) + count;
    this.totals.set(reason, total);
    const now = this.clock.now();
    if (now - (this.lastLogged.get(reason) ?? 0) < 60_000) return;
    this.lastLogged.set(reason, now);
    this.logger.warn("Telemetry spans dropped", {
      event: "telemetry.ingest.dropped",
      reason,
      total,
    });
  }

  snapshot(): Readonly<Record<DropReason, number>> {
    return {
      foreign_trace: this.totals.get("foreign_trace") ?? 0,
      rate_limited: this.totals.get("rate_limited") ?? 0,
      queue_full: this.totals.get("queue_full") ?? 0,
      send_failed: this.totals.get("send_failed") ?? 0,
    };
  }
}
