import {
  type SessionEvent,
  TOOL_DECISIONS_PER_APPEND_MAX,
  type ToolDecisionReport,
  type WorkerEvent,
  type WorkerScope,
  workerEventSchema,
} from "@werft-ai/contracts";
import { isRetryable, type WorkerGatewayClient } from "@werft-ai/runtime-core";

type Queued = { event: WorkerEvent; turnId: string | null };
type QueuedAudit = { report: ToolDecisionReport; turnId: string };

export type EventPublisherOptions = {
  gateway: Pick<WorkerGatewayClient, "appendEvents">;
  /** The fence as it stands now; the turn id moves with the turn loop. */
  scope: () => WorkerScope;
  /**
   * Told the moment a write is refused for good, so the host stops the engine
   * then instead of at the end of the turn — an owner-loss refusal especially.
   */
  onFailed?: (error: unknown) => void;
  /** Told when queued tool judgments were discarded unsent, so the loss is not silent. */
  onAuditsDropped?: (count: number) => void;
  maxBatchSize?: number;
  now?: () => Date;
  retryDelayMs?: number;
  /**
   * How long one batch keeps being retried against a gateway that answers
   * with transient errors, counted from its first failure. Past it the
   * stream fails as on a refusal: a heartbeat that still lands would
   * otherwise keep the lease while the turn waits on its events forever
   * . Unbounded when unset.
   */
  retryBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_MAX_BATCH_SIZE = 32;
const DEFAULT_RETRY_DELAY_MS = 500;
// Far more calls than one turn waits on at once.
const TOOL_USES_REMEMBERED = 1_000;
const AUDITS_QUEUED_MAX = 2_000;

/**
 * Turns projected frames into the attempt's durable event stream.
 *
 * `source_sequence` is per attempt, not per turn, and the gateway refuses an
 * event whose predecessor is not stored yet — so numbers are assigned when an
 * event is queued, batches go out strictly in order, and nothing is dropped
 * until the gateway has acknowledged it. Frames keep arriving while a batch is
 * in flight, which is where the batching comes from.
 */
export class EventPublisher {
  private readonly gateway: Pick<WorkerGatewayClient, "appendEvents">;
  private readonly scope: () => WorkerScope;
  private readonly onFailed: (error: unknown) => void;
  private readonly onAuditsDropped: (count: number) => void;
  private readonly maxBatchSize: number;
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly retryBudgetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly queue: Queued[] = [];
  private readonly audits: QueuedAudit[] = [];
  private acceptedThroughValue = 0;
  private draining: Promise<void> | undefined;
  private failure: unknown;
  private nextSequence = 1;
  /** Set while a turn boundary is being committed: nothing past it is sent. */
  private heldAfter: number | undefined;
  // The last sequence published when each recent tool call was named,
  // newest last, and the callbacks waiting for one to be named or stored.
  private readonly toolUseSequences = new Map<string, number>();
  private waiters: (() => void)[] = [];

  constructor(options: EventPublisherOptions) {
    this.gateway = options.gateway;
    this.scope = options.scope;
    this.onFailed = options.onFailed ?? (() => {});
    this.onAuditsDropped = options.onAuditsDropped ?? (() => {});
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.retryBudgetMs = options.retryBudgetMs ?? Number.POSITIVE_INFINITY;
    this.sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  }

  /** The highest contiguous sequence the gateway says it has stored. */
  get acceptedThrough(): number {
    return this.acceptedThroughValue;
  }

  /** Sequence numbers handed out so far, acknowledged or not. */
  get published(): number {
    return this.nextSequence - 1;
  }

  publish(events: SessionEvent[], turnId: string | null): void {
    if (this.failure !== undefined) return;
    const occurredAt = this.now().toISOString();
    for (const event of events) {
      // The projection's own `id` is a per-frame cursor, not this stream's;
      // the gateway assigns the public cursor when it stores the event.
      const { id: _cursor, ...payload } = event;
      this.queue.push({
        event: workerEventSchema.parse({
          ...payload,
          occurred_at: occurredAt,
          source_sequence: this.nextSequence,
        }),
        turnId,
      });
      this.nextSequence += 1;
    }
    this.wake();
    this.kick();
  }

  audit(report: ToolDecisionReport, turnId: string): void {
    if (this.failure !== undefined) return;
    this.audits.push({ report, turnId });
    if (this.audits.length > AUDITS_QUEUED_MAX) {
      this.audits.shift();
      this.onAuditsDropped(1);
    }
  }

  /**
   * Marks a tool call as carried by what has been published so far: the
   * runtime names a call after the events that carry it.
   */
  toolCalled(toolCallId: string): void {
    if (this.failure !== undefined) return;
    this.toolUseSequences.delete(toolCallId);
    this.toolUseSequences.set(toolCallId, this.published);
    // Calls nobody asked about are forgotten oldest first.
    if (this.toolUseSequences.size > TOOL_USES_REMEMBERED) {
      const [oldest] = this.toolUseSequences.keys();
      if (oldest !== undefined) this.toolUseSequences.delete(oldest);
    }
    this.wake();
  }

  /**
   * Resolves once the tool call with this id is stored, or rejects once
   * `waitMs` has passed since `since` without it, or the stream has failed. The engine can
   * ask to use a tool before `toolCalled` names the call, and whatever is
   * written about the request must follow the call in the stream. Each
   * named call answers one wait, so an id the engine uses again waits for
   * its own.
   */
  async toolUseStored(
    toolUseId: string,
    waitMs: number,
    since = performance.now(),
  ): Promise<void> {
    // A stream that already failed stores nothing more, whatever came first.
    if (this.failure !== undefined) throw this.failure;
    const deadline = since + waitMs;
    let sequence = this.toolUseSequences.get(toolUseId);
    while (sequence === undefined) {
      if (this.failure !== undefined) throw this.failure;
      if (!(await this.progress(deadline))) {
        throw new Error(
          `The tool call ${toolUseId} did not reach the event stream within ${waitMs}ms`,
        );
      }
      sequence = this.toolUseSequences.get(toolUseId);
    }
    this.toolUseSequences.delete(toolUseId);
    while (this.acceptedThroughValue < sequence) {
      if (this.failure !== undefined) throw this.failure;
      if (!(await this.progress(deadline))) {
        throw new Error(
          `The tool call ${toolUseId} was not stored within ${waitMs}ms`,
        );
      }
    }
  }

  // Waits for the next publish, acknowledgement or failure; false once the
  // deadline passes first.
  private progress(deadline: number): Promise<boolean> {
    const left = deadline - performance.now();
    if (left <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== wake);
        resolve(false);
      }, left);
      this.waiters.push(wake);
    });
  }

  private wake(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** Drops the undelivered tail: used when this attempt stops owning the session. */
  abandon(reason: string): void {
    this.failure ??= new Error(`Events were abandoned: ${reason}`);
    this.queue.length = 0;
    this.audits.length = 0;
    this.wake();
  }

  /**
   * Freezes the stream at what has been numbered so far and returns that
   * number. A finalize has to name the exact end of the durable stream, and
   * the engine keeps emitting after its result, so anything published from
   * here on waits in the queue until `release`.
   */
  hold(): number {
    this.heldAfter ??= this.published;
    return this.heldAfter;
  }

  release(): void {
    if (this.heldAfter === undefined) return;
    this.heldAfter = undefined;
    this.kick();
  }

  /**
   * Resolves once everything that may be sent is durable — everything, or up
   * to the hold — or rejects with what stopped it.
   */
  async idle(): Promise<void> {
    while (this.sendable() || this.draining !== undefined) {
      if (this.failure !== undefined) throw this.failure;
      await this.draining;
      if (this.draining === undefined && this.sendable()) this.kick();
    }
    if (this.failure !== undefined) throw this.failure;
  }

  private sendable(): boolean {
    const head = this.queue[0];
    if (head === undefined) return false;
    return (
      this.heldAfter === undefined ||
      head.event.source_sequence <= this.heldAfter
    );
  }

  private kick(): void {
    if (this.draining !== undefined || this.failure !== undefined) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
    });
  }

  private async drain(): Promise<void> {
    let failingSince: number | undefined;
    while (this.sendable()) {
      const batch = this.leadingBatch();
      const turnId = batch[0]?.turnId ?? null;
      const carried =
        turnId === null
          ? []
          : this.audits
              .filter((audit) => audit.turnId === turnId)
              .slice(0, TOOL_DECISIONS_PER_APPEND_MAX);
      try {
        const response = await this.gateway.appendEvents({
          ...this.scope(),
          turn_id: turnId,
          batch_key: this.batchKey(batch),
          events: batch.map((entry) => entry.event),
          ...(carried.length === 0
            ? {}
            : { tool_decisions: carried.map((audit) => audit.report) }),
        });
        this.acceptedThroughValue = response.accepted_through;
        this.queue.splice(0, batch.length);
        for (const audit of carried) {
          const index = this.audits.indexOf(audit);
          if (index !== -1) this.audits.splice(index, 1);
        }
        failingSince = undefined;
        this.wake();
      } catch (error) {
        failingSince ??= performance.now();
        if (
          !isRetryable(error) ||
          performance.now() - failingSince >= this.retryBudgetMs
        ) {
          this.failure = error;
          this.onFailed(error);
          this.wake();
          return;
        }
        // The same batch_key and the same sequences: a replay of what already
        // landed is a no-op, so resending is always the safe move.
        await this.sleep(this.retryDelayMs);
      }
    }
  }

  /** The longest run of queued events that share one turn, capped by batch size. */
  private leadingBatch(): Queued[] {
    const head = this.queue[0];
    if (head === undefined) return [];
    const batch: Queued[] = [];
    for (const entry of this.queue) {
      if (entry.turnId !== head.turnId) break;
      if (batch.length >= this.maxBatchSize) break;
      if (
        this.heldAfter !== undefined &&
        entry.event.source_sequence > this.heldAfter
      ) {
        break;
      }
      batch.push(entry);
    }
    return batch;
  }

  private batchKey(batch: Queued[]): string {
    const first = batch[0]?.event.source_sequence ?? 0;
    const last = batch.at(-1)?.event.source_sequence ?? 0;
    return `${this.scope().attempt_id}:${first}-${last}`;
  }
}
