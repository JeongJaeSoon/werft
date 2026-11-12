import type {
  BootstrapClaimResponse,
  CheckpointRef,
  WorkerScope,
} from "@werft-ai/contracts";
import type {
  CheckpointPreparation,
  TranscriptMirror,
  WorkerCheckpointState,
} from "@werft-ai/runtime-core";

/**
 * How a run is opened: fresh, or continuing the engine session a checkpoint
 * named. `sessionStore` is where the engine mirrors its transcripts; a run
 * without one keeps them only on this container's disk, and nothing it does
 * can be checkpointed.
 */
export type RuntimeResumePlan =
  | { mode: "new"; sessionStore?: TranscriptMirror; restoredRevision?: never }
  | {
      mode: "resume";
      resume: string;
      /** Set only by a plan that resumes this container's own disk. */
      localTranscriptResume?: true;
      sessionStore?: TranscriptMirror;
      /**
       * CLAUDE.md as committed at the commit the checkpoint pinned, for a
       * restored workspace the preparer never read one from. Absent, the
       * preparer's answer stands.
       */
      committedInstructions?: () => string | null;
      /**
       * The checkpoint revision this run resumes from, set by a restore:
       * what the worker reports as restored rather than the claim's pointer.
       */
      restoredRevision?: number;
    };

/** What a capture needs from the turn it runs in. */
export type CheckpointCaptureContext = {
  /** The fenced identity the checkpoint request is made under. */
  scope: WorkerScope;
  /**
   * The run's verdict now, for a publisher that has to know whether
   * something changed while it uploaded — a `mirror_error` that arrived
   * after the lease was taken makes the capture worthless.
   */
  recheck(): Promise<CheckpointPreparation>;
  /** Goes into the manifest as it is; absent for a turn that was not parked. */
  workerState?: WorkerCheckpointState;
  /**
   * Where in the turn the capture runs, for its logs: an approval wait's
   * capture failing leaves that wait unresumable after a crash, which the
   * session's pending reason does not keep once the turn ends. Absent at the
   * turn's end.
   */
  point?: "approval_wait";
};

/**
 * The worker's side of checkpointing. Restoring an engine session and
 * building the manifest that finalize commits both live behind this port so
 * the turn loop never grows a storage dependency.
 */
export interface WorkerCheckpointPort {
  /**
   * Turns the claim into the config the runtime starts with: its restore
   * pointer, and the generation and identity the transcripts are kept under.
   * Called once, after the workspace is prepared and before the engine runs.
   * A restore stops at its next step once `signal` aborts, and never starts
   * writing the workspace after that.
   */
  restorePlan(
    claim: BootstrapClaimResponse,
    signal: AbortSignal,
  ): Promise<RuntimeResumePlan>;
  /**
   * The ref finalize should commit, or null when this turn produced none.
   * Called with every preparation, rejected ones included: those are
   * reported to the gateway, which records the refusals that outlive a turn.
   * Throws only when the attempt no longer owns the session.
   */
  capture(
    preparation: CheckpointPreparation,
    context: CheckpointCaptureContext,
  ): Promise<CheckpointRef | null>;
  /**
   * The gateway refused at finalize the manifest a capture produced, and the
   * turn goes on without it; recorded like a publish that failed. Throws only
   * when the attempt no longer owns the session.
   */
  finalizeRefused?(detail: string, scope: WorkerScope): Promise<void>;
  /**
   * Why a checkpoint of the engine session `resume` could not be taken now,
   * judged before a park cuts the turn: the transcript past its limits, say.
   * Undefined when nothing known stops one; that is no promise the capture
   * succeeds. Throws only when the attempt no longer owns the session.
   */
  parkBlocked?(resume: string): Promise<string | undefined>;
  /**
   * When the transcript mirror last took a write, for the heartbeat; absent
   * while no mirror is bound.
   */
  mirror?(): { persistedAt: Date | null } | undefined;
}

/**
 * Checkpoints nothing and restores nothing: a session that *has* a
 * checkpoint refuses to start rather than quietly opening a fresh engine
 * session on top of its workspace. For tests that run a host without an
 * object store; the composition root binds `SessionCheckpoints`.
 */
export const unwiredCheckpoints: WorkerCheckpointPort = {
  async restorePlan(claim) {
    const restore = claim.restore;
    if (restore === null) return { mode: "new" };
    throw new Error(
      `Session needs checkpoint revision ${restore.revision} restored, and this worker has no restorer bound`,
    );
  },
  async capture() {
    return null;
  },
};
