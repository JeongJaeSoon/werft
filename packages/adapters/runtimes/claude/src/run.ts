import type {
  Query,
  SDKMessage,
  SDKResultError,
  SDKUserMessage,
  TerminalReason,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AdmissionHold,
  AgentInput,
  CheckpointLeaseGrant,
  CheckpointPoint,
  CheckpointPreparation,
  ParkReadiness,
  RejectedCheckpoint,
  SavedCost,
} from "@werft-ai/runtime-core";

import type { AgentFrame, DriverRun, NativeSdkMessage } from "./driver.ts";
import { frameFromNativeMessage, isEngineInit } from "./mapper.ts";
import type { MirrorProgress } from "./mirror-progress.ts";
import { missingSkills } from "./plugin-skills.ts";
import type { ResumedHistory } from "./resumed-history.ts";
import type { TurnLedger } from "./turn-ledger.ts";

/**
 * How the SDK ends a turn cut short mid-response or with a tool (or its
 * permission prompt) outstanding. `interrupt()` ends a turn this way, but so
 * does any other abort, so a reason from this set proves an interrupt only to
 * a host that knows it sent one.
 */
export const ABORTED_TERMINAL_REASONS: ReadonlySet<TerminalReason> = new Set([
  "aborted_streaming",
  "aborted_tools",
]);

export function endedByAbort(message: NativeSdkMessage): boolean {
  return (
    message.type === "result" &&
    ABORTED_TERMINAL_REASONS.has(message.terminal_reason as TerminalReason)
  );
}

/**
 * How long an approval-wait checkpoint waits for the mirror to hold the
 * waiting calls and the results before them, and for a concurrent call to
 * settle. T-7 saw 26-109ms.
 */
export const APPROVAL_BARRIER_MS = 2_000;
const APPROVAL_BARRIER_POLL_MS = 25;

/** The fields of the result an interrupted turn ends with. */
export type InterruptedResult = Pick<
  SDKResultError,
  | "is_error"
  | "session_id"
  | "subtype"
  | "terminal_reason"
  | "type"
  | "user_message_uuid"
  | "user_message_uuids"
>;

export class InputStream implements AsyncIterable<SDKUserMessage> {
  private readonly queued: SDKUserMessage[] = [];
  private readonly waiting: Array<
    (value: IteratorResult<SDKUserMessage>) => void
  > = [];
  private readonly flushing: Array<() => void> = [];
  /**
   * The SDK holds a message it has not asked past yet. It writes each one to
   * the engine before asking for the next, so until then the write may still
   * be to come.
   */
  private handedOut = false;
  private finished = false;
  private abandoned = false;

  push(input: AgentInput): void {
    if (this.finished) throw new Error("Input stream is closed");
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: input.message },
      parent_tool_use_id: null,
      uuid: input.uuid as NonNullable<SDKUserMessage["uuid"]>,
    };
    const waiter = this.waiting.shift();
    if (waiter === undefined) this.queued.push(message);
    else {
      this.handedOut = true;
      waiter({ done: false, value: message });
    }
  }

  /**
   * Resolves once every message pushed so far is written to the engine. A
   * control request goes out at once, so one sent before that overtakes the
   * input it was meant to follow.
   */
  flushed(): Promise<void> {
    // Not released by finish(): what was queued before it is still written.
    if (this.abandoned || (this.queued.length === 0 && !this.handedOut)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.flushing.push(resolve));
  }

  /** The SDK reads no further, so what is still unwritten never will be. */
  abandon(): void {
    this.abandoned = true;
    for (const resolve of this.flushing.splice(0)) resolve();
  }

  finish(): void {
    this.finished = true;
    for (const waiter of this.waiting.splice(0))
      waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        this.handedOut = false;
        const value = this.queued.shift();
        if (value !== undefined) {
          this.handedOut = true;
          return { done: false, value };
        }
        for (const resolve of this.flushing.splice(0)) resolve();
        if (this.finished) return { done: true, value: undefined };
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}

const noMirror: RejectedCheckpoint = {
  status: "rejected",
  reason: "turn_in_flight",
  detail: "This run mirrors no transcript to checkpoint while it waits",
};

export class ClaudeSdkRun implements DriverRun {
  constructor(
    private readonly correlationId: string,
    private readonly input: InputStream,
    private readonly sdkQuery: Query,
    private readonly abortController: AbortController,
    private readonly history: ResumedHistory,
    /** Shared with the SDK options' tool gate, which feeds and consults it. */
    private readonly ledger: TurnLedger,
    private readonly toolDescriptions: () => ReadonlyMap<string, string> = () =>
      new Map(),
    private readonly mirror?: MirrorProgress,
    /** Set when the run was handed plugins: what the engine must report loaded. */
    private readonly expectedSkills?: readonly string[],
  ) {}

  get approvalCheckpoints(): boolean {
    return this.mirror !== undefined;
  }

  holdAdmission(guard: (toolCallId: string) => Promise<void>): AdmissionHold {
    return this.ledger.holdAdmission(guard);
  }

  send(input: AgentInput): void {
    this.ledger.queued(input.uuid);
    try {
      this.input.push(input);
    } catch (error) {
      this.ledger.release(input.uuid);
      throw error;
    }
  }

  finishInput(): void {
    this.input.finish();
  }

  async ready(): Promise<void> {
    await this.history.uuids();
    const initialized = await this.sdkQuery.initializationResult();
    if (this.expectedSkills === undefined) return;
    // The session must not run without the bundles it was started with.
    if (initialized.plugins_applied !== true) {
      throw new Error(
        "The engine did not load the session's extension bundles",
      );
    }
    if (!Array.isArray(initialized.commands)) {
      throw new Error(
        "The engine's initialization reply did not list its commands, so the extension skills cannot be confirmed",
      );
    }
    const missing = missingSkills(this.expectedSkills, initialized.commands);
    if (missing.length > 0) {
      throw new Error(
        `The engine did not report these extension skills: ${missing.join(", ")}`,
      );
    }
  }

  savedCost(): Promise<SavedCost | undefined> {
    return this.history.savedCost();
  }

  async holdsInput(uuid: string): Promise<boolean> {
    if (this.ledger.wasSent(uuid)) return true;
    return (await this.history.uuids()).has(uuid);
  }

  async interrupt(): Promise<{ stillQueued: string[] }> {
    // Sent ahead of its input, the interrupt finds nothing running, is
    // acknowledged, and the input then runs to completion.
    await this.input.flushed();
    const receipt = await this.sdkQuery.interrupt();
    return { stillQueued: receipt?.still_queued ?? [] };
  }

  abort(): void {
    this.abortController.abort();
    this.input.abandon();
  }

  close(): void {
    this.input.finish();
    this.input.abandon();
    this.sdkQuery.close();
  }

  async leaseCheckpoint(
    point: CheckpointPoint = "turn_end",
  ): Promise<CheckpointLeaseGrant> {
    if (point === "turn_end") return this.ledger.leaseCheckpoint();
    const mirror = this.mirror;
    if (mirror === undefined) {
      return { lease: null, preparation: noMirror };
    }
    const deadline = performance.now() + APPROVAL_BARRIER_MS;
    for (;;) {
      // A macrotask first: an answer handed over just before has run its
      // callback's settlement into the ledger by then.
      await Bun.sleep(0);
      const verdict = this.ledger.prepareCheckpoint("approval_wait");
      if (
        verdict.status === "rejected" &&
        verdict.reason !== "tool_in_flight"
      ) {
        return { lease: null, preparation: verdict };
      }
      const missing =
        verdict.status === "ready" ? this.unmirrored(mirror) : undefined;
      // The verdict, the barrier and the lease in one synchronous step.
      if (missing !== undefined && missing.length === 0) {
        return this.ledger.leaseCheckpoint("approval_wait");
      }
      const left = deadline - performance.now();
      if (left <= 0) {
        return {
          lease: null,
          preparation:
            verdict.status === "rejected"
              ? verdict
              : {
                  status: "rejected",
                  reason: "turn_in_flight",
                  detail: `The transcript mirror does not hold ${(missing ?? []).join(", ")} after ${APPROVAL_BARRIER_MS}ms`,
                },
        };
      }
      await mirror.next(Math.min(left, APPROVAL_BARRIER_POLL_MS));
    }
  }

  async prepareCheckpoint(
    point: CheckpointPoint = "turn_end",
  ): Promise<CheckpointPreparation> {
    if (point === "turn_end") return this.ledger.prepareCheckpoint();
    const mirror = this.mirror;
    if (mirror === undefined) return noMirror;
    const verdict = this.ledger.prepareCheckpoint("approval_wait");
    if (verdict.status === "rejected") return verdict;
    const missing = this.unmirrored(mirror);
    return missing.length === 0
      ? verdict
      : {
          status: "rejected",
          reason: "turn_in_flight",
          detail: `The transcript mirror does not hold ${missing.join(", ")} yet`,
        };
  }

  /** The waiting calls and settled results the mirror has not written. */
  private unmirrored(mirror: MirrorProgress): string[] {
    return [
      ...this.ledger.awaitingIds().filter((id) => !mirror.uses.has(id)),
      ...this.ledger.unmirroredResults(mirror.results),
    ];
  }

  parkable(): ParkReadiness {
    return this.ledger.parkable();
  }

  events(): AsyncIterable<AgentFrame> {
    return this;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentFrame> {
    this.ledger.claimConsumer();
    try {
      let cursor = 0;
      for await (const message of this.sdkQuery) {
        const native = message as SDKMessage as unknown as NativeSdkMessage;
        this.ledger.observe(native);
        yield frameFromNativeMessage(
          native,
          this.correlationId,
          `sdk:${cursor}`,
          isEngineInit(native) ? this.toolDescriptions() : undefined,
        );
        cursor += 1;
      }
    } finally {
      this.ledger.streamEnded();
      this.history.abandon();
      this.input.abandon();
    }
  }
}
