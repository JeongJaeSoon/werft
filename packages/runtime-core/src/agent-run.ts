import type { AgentInput } from "./agent-runtime.ts";
import type { AnswerResult, ApprovalAnswer } from "./approval.ts";
import type {
  CheckpointLeaseGrant,
  CheckpointPreparation,
} from "./checkpoint.ts";
import type { NegotiatedCapabilities } from "./descriptor.ts";
import type { RuntimeEvent } from "./events.ts";

export type CheckpointPoint = "turn_end" | "approval_wait";

/**
 * Whether the turn can be cut where it waits on a person and still leave a
 * checkpoint. `resume` is the engine session that checkpoint would resume,
 * so the host can judge the transcript before it cuts anything.
 */
export type ParkReadiness =
  | { ok: true; resume: string }
  | { ok: false; reason: "tool_executing" | "not_supported" }
  | { ok: false; reason: "checkpoint_unavailable"; detail: string };

/** Ends an `AgentRun.holdAdmission`. Idempotent. */
export interface AdmissionHold {
  release(): void;
}

/**
 * Handle for one engine execution. It may serve several turns; it is not the
 * durable Turn row the platform stores. `events()` is a single-consumer
 * stream: iterating it a second time throws, so the host fans out to
 * observers instead of subscribing twice.
 */
export interface AgentRun {
  /**
   * Resolves once the engine has loaded the session it was started on — the
   * resumed transcript read, the engine initialized — without any input
   * sent. Rejects when the transcript cannot be read. A resumed worker
   * reports itself ready only after this.
   */
  ready(): Promise<NegotiatedCapabilities>;
  /**
   * The run's events. For one tool call, its `tool.called` and the public
   * events carrying it come before its `approval.requested`.
   */
  events(): AsyncIterable<RuntimeEvent>;
  send(input: AgentInput): void;
  finishInput(): void;
  /**
   * True when the engine session already holds this input uuid: in the
   * transcript the run resumed from, or sent earlier on this run. The engine
   * deduplicates such a send and never answers it. Throws when the resumed
   * transcript cannot be read — absence is only claimed when it was checked.
   */
  holdsInput(uuid: string): Promise<boolean>;
  /** Settles an `approval.requested` at most once. */
  answer(answer: ApprovalAnswer): Promise<AnswerResult>;
  interrupt(): Promise<{ stillQueued: string[] }>;
  /**
   * Present on a run whose descriptor offers `approval_park`. A run without
   * it cannot be cut where it waits on a person; the host reads that as
   * `{ ok: false, reason: "not_supported" }`.
   */
  parkable?(): ParkReadiness;
  /**
   * Present on a run whose descriptor says `approvalCheckpoint`: the engine
   * has a point before each tool call where the host can stop it. From now
   * until released, the engine admits no new tool call before `guard` has
   * resolved for it; a rejection refuses that call. An approved call the
   * engine runs on its answer is not admitted again, so it never reaches the
   * guard. Holding a second one replaces the first. A host that took an
   * approval checkpoint from a run without it fails the turn.
   */
  holdAdmission?(guard: (toolCallId: string) => Promise<void>): AdmissionHold;
  /** Read-only: the verdict leaseCheckpoint would reach now. */
  prepareCheckpoint(point: CheckpointPoint): Promise<CheckpointPreparation>;
  /**
   * Takes the exclusive checkpoint lease when the run is quiescent, judged in
   * the same step as prepareCheckpoint. Hold it from here until the pointer
   * CAS has definitively answered, then release it.
   */
  leaseCheckpoint(point: CheckpointPoint): Promise<CheckpointLeaseGrant>;
  abort(): void;
  close(): Promise<void>;
}
