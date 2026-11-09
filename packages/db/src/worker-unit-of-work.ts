import {
  budgetEndedTerminal,
  type CheckpointBlockReason,
  type CheckpointRef,
  checkpointBlockReasonSchema,
  type EnvRefusal,
  MODEL_NOT_ALLOWED_EVENT_CODE,
  type ModelCutCause,
  type PendingRememberRule,
  type PermissionGrant,
  rememberRuleSchema,
  type SessionExtension,
  type TerminalTurnStatus,
  TURN_BUDGET_EXCEEDED_REASON,
  TURN_INPUT_WAIT_PARKED_REASON,
  TURN_WORKSPACE_QUOTA_EXCEEDED_REASON,
  terminalTurnStatusSchema,
  type WorkerEvent,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import {
  budgetExceeded,
  CHECKPOINT_ROOT_PARENT,
  type CheckpointPointer,
  type CheckpointStateInput,
  type CheckpointStateResult,
  type ClaimInput,
  type ClaimResult,
  type CommitEventsInput,
  type CommitEventsResult,
  type ConfirmExecutionGoneInput,
  type ConfirmExecutionGoneResult,
  checkpointReasonBlocks,
  checkpointReasonHoldsWork,
  type EgressAuthorization,
  type EgressPurpose,
  type ExtensionsStateInput,
  type ExtensionsStateResult,
  type FailResumeInput,
  type FailResumeResult,
  type FinalizeInput,
  type FinalizeResult,
  type HeartbeatInput,
  type HeartbeatResult,
  launchNonceFingerprint,
  type NextInputInput,
  type NextInputResult,
  nextPendingReason,
  type PeekFinalizeResult,
  type PolicyPair,
  type ProviderUsageInput,
  type ProviderUsageResult,
  payloadHash,
  type ReadyInput,
  type ReadyResult,
  type ReleaseInput,
  type ReleaseResult,
  type RepositoryPair,
  type ResolvedCredential,
  type RestoreBaseInput,
  type RestoreBaseResult,
  type RunnablePair,
  type SessionBudget,
  sameCombination,
  storedPendingReasonHoldsWork,
  TRANSCRIPT_LIMITS,
  transcriptLimitReachedEvent,
  transcriptWarnBytes,
  type WorkerBinding,
  type WorkerFence,
  type WorkerUnitOfWork,
} from "@werft-ai/platform";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  max,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { queueAchievementJudgment } from "./achievement-judgments.ts";
import {
  type RuntimeFingerprint,
  runtimeColumns,
  runtimeOfColumns,
  sessionRuntimeOnce,
} from "./checkpoint-runtime.ts";
import { finishClose } from "./close-control.ts";
import { contextCoverage, contextGap, raiseContextGap } from "./context-gap.ts";
import {
  type ControlResultEvent,
  logControlResult,
} from "./control-observability.ts";
import {
  ENDED_ATTEMPT_STATES,
  hasRestorePoint,
  INPUT_RECEIPT_OPERATIONS,
  LAUNCHABLE_ADMISSION_STATES,
  OPEN_TURN_STATUSES,
  parseTurnSequence,
  restoreBaseRevision,
  withinBudget,
} from "./control-shared.ts";
import {
  earliestUnknownTurn,
  KILL_RECEIPT_OPERATIONS,
  terminateReceiptResult,
} from "./control-unit-of-work.ts";
import { encodeEventCursor } from "./cursors.ts";
import { DB_NOW, dbNow, fromDbNow } from "./db-clock.ts";
import { CLOSE, drainBlocker, drainOf, openDrainReceipt } from "./drain.ts";
import { envStartRefusal, recordEnvRefusal } from "./env-variables.ts";
import {
  type AttemptRow,
  acquireFence,
  leaseHeld,
  type SessionRow,
} from "./fence.ts";
import {
  catalogMismatchCause,
  quarantineLaunch,
  variablesRefusedCause,
} from "./launch-quarantine.ts";
import { sessionGitHubMcpOf, sessionMcpOf } from "./mcp-egress.ts";
import { writeModelCut } from "./model-cut-notices.ts";
import {
  abandonUndeliveredParked,
  closeParkedGroup,
  settleContinuationInputs,
} from "./parked-group.ts";
import { openPauseReceipt, pauseReceiptResult } from "./pause-control.ts";
import {
  abandonUndeliveredAnswers,
  awaitingInputAt,
  closeWorkerRequests,
  parkTurnRequests,
  publicStatus,
  recordLostInputWait,
} from "./pending-requests.ts";
import { followUpFact, queuePushFollowUps } from "./push-follow-ups.ts";
import { settleTurnPushIntents } from "./push-intents.ts";
import type { Database } from "./queries.ts";
import {
  boundedReason,
  RESTORE_FAILURES_CLEARED,
  recordStartupFailure,
  restoreRetryDue,
} from "./restore-failures.ts";
import {
  completeResume,
  failResume,
  RESUME_LAUNCH_LIMIT,
  resumeLaunchesSpent,
} from "./resume-control.ts";
import {
  achievementJudgments,
  agentReleases,
  agents,
  approvalCheckpoints,
  attempts,
  checkpointOutputs,
  checkpoints,
  events,
  executions,
  installationProfiles,
  MAX_SESSION_COST_USD,
  pendingRequests,
  permissionGrants,
  providerUsage,
  queueMessages,
  receipts,
  sessions,
  settingsGeneration,
  turnContinuations,
  turns,
  unassignedSessions,
  workerCredentials,
  workerImageRefusals,
  workerLaunches,
  workers,
  workspaceProfiles,
} from "./schema.ts";
import {
  notBefore,
  recordEvent,
  recordInputWaitStage,
  recordStatus,
  streamClock,
} from "./session-events.ts";
import {
  settleTurnInterrupts,
  turnInterruptPending,
} from "./turn-interrupts.ts";

type ImageRuntime = NonNullable<WorkerBinding["launchRuntime"]>;

// Heartbeats travel over a network and can land out of order. The durable
// state is the furthest phase the attempt has been reported to reach, so a
// late "starting" cannot walk a running attempt backwards for readers.
export const ATTEMPT_PHASE_ORDER: Record<string, number> = {
  starting: 0,
  running: 1,
  draining: 2,
};

// finalize never reports `cancelled`: that terminal comes from an operator
// recovery decision, not from the worker.
const workerTerminalSchema = terminalTurnStatusSchema.exclude(["cancelled"]);

// Success, failure and user interrupt each get their own
// session state, and an unknown outcome never takes the idle path.
const SESSION_STATUS_BY_TERMINAL: Record<
  TerminalTurnStatus,
  "idle" | "failed" | "stopped"
> = {
  completed: "idle",
  failed: "failed",
  interrupted: "stopped",
  cancelled: "stopped",
  outcome_unknown: "failed",
};
const RECEIPT_STATUS_BY_TERMINAL: Record<
  TerminalTurnStatus,
  "succeeded" | "failed" | "unknown"
> = {
  completed: "succeeded",
  failed: "failed",
  interrupted: "failed",
  cancelled: "failed",
  outcome_unknown: "unknown",
};

export { acquireFence, leaseHeld };

// Every fenced write repeats these predicates so a row the lock did not
// cover (or a concurrent epoch bump) can never be written by a stale
// attempt, independently of the application-level check.
function fencedSession(fence: WorkerFence) {
  return and(
    eq(sessions.id, fence.sessionId),
    eq(sessions.leaseEpoch, fence.leaseEpoch),
    eq(sessions.executionGeneration, fence.executionGeneration),
    eq(sessions.authRevision, fence.authRevision),
  );
}

function ownedAttempt(fence: WorkerFence) {
  return and(
    eq(attempts.id, fence.attemptId),
    eq(attempts.sessionId, fence.sessionId),
    eq(attempts.leaseEpoch, fence.leaseEpoch),
    eq(attempts.executionGeneration, fence.executionGeneration),
    eq(attempts.authRevision, fence.authRevision),
    notInArray(attempts.state, ENDED_ATTEMPT_STATES),
  );
}

// `at` is the database time the lease was last judged held at. Re-reading
// the clock inside the write would let the lease end between the check and
// the write, turning an ordinary expiry into a zero-row internal error.
function fencedAttempt(fence: WorkerFence, at: Date) {
  return and(ownedAttempt(fence), gt(attempts.leaseExpiresAt, at));
}

function expectFenced(rows: unknown[], what: string) {
  if (rows.length !== 1) {
    throw new Error(`Fenced ${what} write affected ${rows.length} rows`);
  }
}

// The worker may only ever be told less than it has. `at` came through a
// Date, which drops the database's sub-millisecond part, so it may stand up
// to 1ms before the instant actually read: counted from the next whole
// millisecond instead.
function leaseRemainingMs(leaseExpiresAt: Date, at: Date): number {
  return Math.max(0, leaseExpiresAt.getTime() - (at.getTime() + 1));
}

// The system event a restore that fell back to an earlier revision leaves.
export const CHECKPOINT_RESTORE_FALLBACK = "checkpoint_restore_fallback";

// Two submissions of one source_sequence are the same event only if every
// stored field matches: a reused sequence that moved to another turn or
// another time is a different event wearing the same number. The time stored
// is the one sent raised to `floor`, the stream's clock when it was written.
function sameEvent(
  stored: {
    type: string;
    payload: unknown;
    turnId: number | null;
    occurredAt: Date | null;
  },
  event: WorkerEvent,
  turnRowId: number | null,
  floor: Date | null = null,
): boolean {
  return (
    stored.type === event.event &&
    stored.turnId === turnRowId &&
    stored.occurredAt?.getTime() ===
      notBefore(new Date(event.occurred_at), floor).getTime() &&
    payloadHash(stored.payload) === payloadHash(event.data)
  );
}

// The worker drops its local buffer up to this number, so it must be the end
// of the unbroken run that starts at sequence 1: a run found further along
// says nothing about the events before it. A row with no successor ends a
// run, and the first such row ends the first run.
// Reads how a finalize stands: already committed (a replay, or a different
// body wearing the same key), or still open and waiting for this request.
// finalizeAtomic locks the row; the read-only peek does not.
async function probeFinalize(
  tx: Database,
  fence: WorkerFence,
  input: FinalizeInput,
  lock: boolean,
): Promise<
  | { state: "open"; turn: typeof turns.$inferSelect; terminalHash: string }
  | { state: "settled"; result: FinalizeResult }
> {
  const sequence = parseTurnSequence(input.turnId);
  const query = sequence
    ? tx
        .select()
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, fence.sessionId),
            eq(turns.sequence, sequence),
          ),
        )
        .limit(1)
    : null;
  const rows = query ? await (lock ? query.for("update") : query) : [];
  const [turn] = rows;
  if (!turn || turn.attemptId !== fence.attemptId) {
    return { state: "settled", result: { outcome: "turn_not_found" } };
  }
  // The checkpoint and the event tail are part of what finalize commits, so a
  // retry that changes either is a different request wearing the same key —
  // and a replay must not let a different tail past the gate that only runs
  // on the first commit.
  const terminalHash = payloadHash({
    terminal: input.terminal,
    checkpoint: input.checkpoint,
    final_source_sequence: input.finalSourceSequence,
  });
  if (OPEN_TURN_STATUSES.includes(turn.status)) {
    return { state: "open", turn, terminalHash };
  }
  const stored = (turn.resultJson ?? {}) as {
    finalize_key?: unknown;
    finalize_hash?: unknown;
  };
  // A replay carries the same key and the same body; anything else would
  // report a terminal the stored turn does not have.
  if (
    stored.finalize_key !== input.finalizeKey ||
    stored.finalize_hash !== terminalHash
  ) {
    return { state: "settled", result: { outcome: "finalize_conflict" } };
  }
  const [checkpoint] = await tx
    .select({ revision: max(checkpoints.revision) })
    .from(checkpoints)
    .where(eq(checkpoints.turnId, turn.id));
  return {
    state: "settled",
    result: {
      outcome: "replayed",
      result: {
        turnId: input.turnId,
        status: workerTerminalSchema.parse(turn.status),
        checkpointRevision: checkpoint?.revision ?? null,
      },
    },
  };
}

async function contiguousThrough(
  tx: Database,
  fence: WorkerFence,
): Promise<number> {
  const [row] = await tx
    .select({
      first: sql<number | null>`min(${events.sourceSequence})`,
    })
    .from(events)
    .where(
      and(
        eq(events.sessionId, fence.sessionId),
        eq(events.attemptId, fence.attemptId),
      ),
    );
  if (row?.first !== 1) return 0;
  const [end] = await tx
    .select({
      through: sql<number | null>`min(${events.sourceSequence})`,
    })
    .from(events)
    .where(
      and(
        eq(events.sessionId, fence.sessionId),
        eq(events.attemptId, fence.attemptId),
        sql`NOT EXISTS (
          SELECT 1 FROM ${events} next
          WHERE next.session_id = ${fence.sessionId}
            AND next.attempt_id = ${fence.attemptId}
            AND next.source_sequence = ${events.sourceSequence} + 1
        )`,
      ),
    );
  return end?.through ?? 0;
}

/**
 * What the claim tells the worker to restore: the trusted pointer, the same
 * checkpoint the context verdict was judged against — not the newest row,
 * which a blocker or a start_fresh decision may have left untrusted.
 */
async function restoreRef(
  tx: Database,
  session: SessionRow,
): Promise<CheckpointRef | null> {
  if (!hasRestorePoint(session)) return null;
  const pointer = await readCheckpointPointer(tx, session);
  if (pointer === null) return null;
  return {
    revision: pointer.revision,
    manifest_ref: pointer.manifestRef,
    manifest_sha256: pointer.manifestSha256,
    ...(pointer.manifestVersion === null
      ? {}
      : { manifest_version: pointer.manifestVersion }),
  };
}

/**
 * The one place the checkpoint pointer advances. A turn's finalize comes
 * through here, inside its fenced transaction, so there is a single answer to
 * which revision is the session's truth: the row's current pointer plus one,
 * exactly — the server handed that number out (checkpointStateAtomic), and a
 * manifest claiming a later one was written against a pointer that no longer
 * stands.
 *
 * Committing clears a blocking pending reason only when the reason came
 * from another attempt. The runtime latches a mirror failure for its whole
 * run, so a checkpoint from the attempt that reported it was captured before
 * the failure at best and says nothing about the transcript since; a fresh
 * run that re-mirrored from the local file is what a valid checkpoint
 * proves. An advisory reason (the run was not quiescent) is cleared by any
 * commit: a checkpoint that committed is exactly what it was missing. An
 * exhausted one (a transcript past the limits) is cleared like a blocking
 * one: the attempt that reported it cannot shrink its transcript.
 *
 * The first commit since start_fresh that takes the transcript past the
 * warning threshold says so on the event stream, once.
 */
/**
 * What the committing attempt's state was built on: the fallback's revision
 * when the row records one for this very attempt, the pointer otherwise.
 * Another attempt's fallback says nothing about what this one restored. A
 * base at or below the revision a start_fresh decision retired is
 * no base at all: the engine session started empty, and a fallback past this
 * checkpoint must not restore the history the operator gave up.
 */
function parentRevisionOf(session: SessionRow, attemptId: string) {
  const base =
    (session.checkpointRestoreAttemptId === attemptId
      ? session.checkpointFallbackRevision
      : null) ?? session.checkpointRevision;
  return base !== null &&
    session.contextResetCheckpointRevision !== null &&
    base <= session.contextResetCheckpointRevision
    ? CHECKPOINT_ROOT_PARENT
    : base;
}

const OUTPUT_ROWS_PER_INSERT = 5_000;

/**
 * Whether this checkpoint's out/ list is new evidence (achievement-rules.md
 * §4): it differs from the parent revision's, path by path, or the session's
 * latest judgment could not read out/ and gave up.
 */
async function outputsAreEvidence(
  tx: Database,
  sessionId: string,
  parentRevision: number | null,
  digest: string | null,
): Promise<boolean> {
  const [parent] =
    parentRevision === null
      ? []
      : await tx
          .select({
            digest: checkpoints.outputsDigest,
            recorded: checkpoints.outputsRecorded,
          })
          .from(checkpoints)
          .where(
            and(
              eq(checkpoints.sessionId, sessionId),
              eq(checkpoints.revision, parentRevision),
            ),
          );
  // A parent that recorded no list is read as differing.
  if (parent !== undefined && !parent.recorded) return true;
  if ((parent?.digest ?? null) !== digest) return true;
  const [latest] = await tx
    .select({
      status: achievementJudgments.status,
      errorCode: achievementJudgments.errorCode,
    })
    .from(achievementJudgments)
    .where(eq(achievementJudgments.sessionId, sessionId))
    .orderBy(desc(achievementJudgments.createdAt))
    .limit(1);
  return (
    latest?.status === "failed" && latest.errorCode === "outputs_unavailable"
  );
}

export async function advanceCheckpointPointer(
  tx: Database,
  input: {
    fence: WorkerFence;
    session: SessionRow;
    checkpoint: CheckpointRef;
    turnRowId: number | null;
    now: Date;
    versionsHeld: boolean;
    transcriptBytes?: number;
    runtime?: RuntimeFingerprint;
    // Absent when the verifier did not read the manifest's outputs; the row
    // then stays outputs_recorded = false and usage reports itself partial.
    outputs?: readonly { key: string; bytes: number }[];
    /** checkpointOutputsDigest of the same list. */
    outputsDigest?: string | null;
  },
): Promise<
  | { outcome: "committed"; revision: number }
  | { outcome: "not_next"; currentRevision: number | null }
> {
  const next = (input.session.checkpointRevision ?? -1) + 1;
  if (input.checkpoint.revision !== next) {
    return {
      outcome: "not_next",
      currentRevision: input.session.checkpointRevision,
    };
  }
  // The attempt committing ran on what its restore handed it.
  const parentRevision = parentRevisionOf(input.session, input.fence.attemptId);
  await tx.insert(checkpoints).values({
    sessionId: input.fence.sessionId,
    revision: input.checkpoint.revision,
    manifestRef: input.checkpoint.manifest_ref,
    manifestSha256: input.checkpoint.manifest_sha256,
    manifestVersion: input.checkpoint.manifest_version ?? null,
    versionsHeld: input.versionsHeld,
    parentRevision,
    turnId: input.turnRowId,
    committedAt: input.now,
    // The runtime fingerprint in the manifest was computed from the profile
    // this attempt claimed, which the session may have changed since.
    profileId: sql`(SELECT ${attempts.profileId} FROM ${attempts} WHERE ${attempts.id} = ${input.fence.attemptId})`,
    profileFingerprint: sql`(SELECT ${attempts.profileFingerprint} FROM ${attempts} WHERE ${attempts.id} = ${input.fence.attemptId})`,
    model: sql`(SELECT ${attempts.model} FROM ${attempts} WHERE ${attempts.id} = ${input.fence.attemptId})`,
    transcriptBytes: input.transcriptBytes ?? null,
    ...runtimeColumns(input.runtime),
    // The claim held the worker to its launch's combination, so the
    // launch's scheme is the one the manifest's digest was computed under.
    runtimeProfileScheme: sql`(SELECT ${workerLaunches.runtimeProfileScheme} FROM ${workerLaunches} WHERE ${workerLaunches.claimedAttemptId} = ${input.fence.attemptId})`,
    outputsRecorded: input.outputs !== undefined,
    outputsDigest:
      input.outputs === undefined ? null : (input.outputsDigest ?? null),
  });
  // A manifest may name up to DEFAULT_MAX_MANIFEST_OBJECTS objects; one
  // statement for all of them would pass PostgreSQL's 65,535 bind parameters.
  const outputs = input.outputs ?? [];
  for (let start = 0; start < outputs.length; start += OUTPUT_ROWS_PER_INSERT) {
    await tx.insert(checkpointOutputs).values(
      outputs
        .slice(start, start + OUTPUT_ROWS_PER_INSERT)
        .map(({ key, bytes }) => ({
          sessionId: input.fence.sessionId,
          revision: input.checkpoint.revision,
          objectKey: key,
          bytes,
        })),
    );
  }
  if (
    input.outputs !== undefined &&
    (await outputsAreEvidence(
      tx,
      input.fence.sessionId,
      parentRevision,
      input.outputsDigest ?? null,
    ))
  ) {
    await queueAchievementJudgment(tx, input.fence.sessionId);
  }
  if (input.transcriptBytes !== undefined) {
    await warnNearTranscriptLimit(tx, input, input.transcriptBytes);
  }
  const pending = storedPendingReason(input.session.checkpointPendingReason);
  const resolvesPending =
    pending !== null &&
    (!checkpointReasonHoldsWork(pending) ||
      input.session.checkpointPendingAttemptId !== input.fence.attemptId);
  expectFenced(
    await tx
      .update(sessions)
      .set({
        checkpointRevision: input.checkpoint.revision,
        checkpointCommittedAt: input.now,
        // Whatever an earlier fallback restored, this commit now stands for
        // the session's state.
        checkpointFallbackRevision: null,
        checkpointRestoreAttemptId: null,
        updatedAt: input.now,
        ...sessionRuntimeOnce(input.runtime),
        ...(resolvesPending
          ? { checkpointPendingReason: null, checkpointPendingAttemptId: null }
          : {}),
      })
      .where(fencedSession(input.fence))
      .returning({ id: sessions.id }),
    "session pointer",
  );
  return { outcome: "committed", revision: input.checkpoint.revision };
}

/**
 * Crash park (design §6.2 E2): the execution went while its turn waited on
 * a person, and the approval-wait checkpoint taken there still holds. Every
 * condition below has to hold, or the turn stays for the caller to record
 * unknown as before (approval-wait design D-12):
 *
 * - the session takes work and the turn is its only one in flight, asked
 *   by an attempt the session still names, with no interrupt waiting on it;
 * - (i) the turn has open requests, (ii) every one of them is bound to the
 *   same checkpoint and none has expired;
 * - (iii) no answer reached the worker past the one it had applied when it
 *   captured: the engine may have acted on that one, so neither the open
 *   rows nor any settled row of the turn may have such a delivery;
 * - (iv) no tool was admitted after the capture, and it is the revision
 *   the pointer would accept next.
 *
 * Then, in the caller's transaction, the checkpoint becomes the pointer, the
 * turn is interrupted to park (TURN_INPUT_WAIT_PARKED_REASON) and its
 * requests are parked, an answer given but never delivered included: it is
 * what resumes the turn. Returns whether it parked.
 */
async function parkOnApprovalCheckpoint(
  tx: Database,
  input: { session: SessionRow; executionId: string; now: Date },
): Promise<boolean> {
  const { session, now } = input;
  if (session.admissionState !== "active") return false;
  const open = await tx
    .select({
      id: turns.id,
      sequence: turns.sequence,
      attemptId: turns.attemptId,
    })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, session.id),
        inArray(turns.status, OPEN_TURN_STATUSES),
      ),
    );
  const [turn] = open;
  if (open.length !== 1 || turn === undefined || turn.attemptId === null) {
    return false;
  }
  const [attempt] = await tx
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.id, turn.attemptId),
        eq(attempts.executionId, input.executionId),
        notInArray(attempts.state, ENDED_ATTEMPT_STATES),
      ),
    )
    .limit(1);
  // Still the session's own binding: until the epoch moves, collection
  // keeps this attempt's checkpoint directory.
  if (
    attempt === undefined ||
    attempt.leaseEpoch !== session.leaseEpoch ||
    attempt.executionGeneration !== session.executionGeneration ||
    attempt.authRevision !== session.authRevision
  ) {
    return false;
  }
  if (await turnInterruptPending(tx, turn.id)) return false;
  const rows = await tx
    .select({
      checkpointRef: pendingRequests.checkpointRef,
      deliveredAt: pendingRequests.deliveredAt,
      expiresAt: pendingRequests.expiresAt,
    })
    .from(pendingRequests)
    .where(
      and(
        eq(pendingRequests.sessionId, session.id),
        eq(pendingRequests.turnId, turn.id),
        isNull(pendingRequests.settledAt),
        isNull(pendingRequests.parkedAt),
      ),
    )
    .for("update");
  const refs = new Set(rows.map((row) => row.checkpointRef));
  const [ref] = refs;
  if (
    rows.length === 0 ||
    refs.size !== 1 ||
    ref == null ||
    rows.some(
      (row) =>
        row.deliveredAt !== null || row.expiresAt.getTime() <= now.getTime(),
    )
  ) {
    return false;
  }
  const [checkpoint] = await tx
    .select()
    .from(approvalCheckpoints)
    .where(eq(approvalCheckpoints.manifestRef, ref))
    .limit(1)
    .for("update");
  if (
    checkpoint === undefined ||
    checkpoint.invalidatedAt !== null ||
    checkpoint.promotedAt !== null ||
    checkpoint.attemptId !== attempt.id ||
    checkpoint.turnId !== turn.id ||
    checkpoint.revision !== (session.checkpointRevision ?? -1) + 1
  ) {
    return false;
  }
  const [delivered] = await tx
    .select({ one: sql`1` })
    .from(pendingRequests)
    .where(
      and(
        eq(pendingRequests.sessionId, session.id),
        eq(pendingRequests.turnId, turn.id),
        isNotNull(pendingRequests.deliveredAt),
        gt(pendingRequests.answerSequence, checkpoint.answersThrough),
      ),
    )
    .limit(1);
  if (delivered !== undefined) return false;

  const fence: WorkerFence = {
    sessionId: session.id,
    attemptId: attempt.id,
    leaseEpoch: attempt.leaseEpoch,
    executionGeneration: attempt.executionGeneration,
    authRevision: attempt.authRevision,
  };
  const promotedRuntime = runtimeOfColumns(checkpoint);
  const advanced = await advanceCheckpointPointer(tx, {
    fence,
    session,
    checkpoint: {
      revision: checkpoint.revision,
      manifest_ref: checkpoint.manifestRef,
      manifest_sha256: checkpoint.manifestSha256,
      ...(checkpoint.manifestVersion === null
        ? {}
        : { manifest_version: checkpoint.manifestVersion }),
    },
    turnRowId: turn.id,
    now,
    versionsHeld: checkpoint.versionsHeld,
    ...(checkpoint.transcriptBytes === null
      ? {}
      : { transcriptBytes: checkpoint.transcriptBytes }),
    ...(promotedRuntime === null ? {} : { runtime: promotedRuntime }),
  });
  if (advanced.outcome !== "committed") return false;
  // No out/ list is kept for an approval checkpoint, so whether it changed is
  // unknown; the judge reads the pointer's own and counts nothing twice.
  await queueAchievementJudgment(tx, session.id);
  await tx
    .update(approvalCheckpoints)
    .set({ promotedAt: now })
    .where(eq(approvalCheckpoints.manifestRef, checkpoint.manifestRef));
  await tx
    .update(turns)
    .set({
      status: "interrupted",
      endedAt: now,
      terminalReason: TURN_INPUT_WAIT_PARKED_REASON,
      outcomeUnknown: false,
    })
    .where(eq(turns.id, turn.id));
  // The receipt a finalize of the same park would settle.
  await tx
    .update(receipts)
    .set({
      status: RECEIPT_STATUS_BY_TERMINAL.interrupted,
      error: {
        code: "INTERNAL_ERROR",
        message: TURN_INPUT_WAIT_PARKED_REASON,
      },
      updatedAt: now,
    })
    .where(
      and(
        inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
        eq(receipts.status, "accepted"),
        sql`${receipts.targetRef}->>'session_id' = ${session.id}`,
        sql`${receipts.targetRef}->>'turn_id' = ${String(turn.sequence)}`,
      ),
    );
  await tx
    .delete(queueMessages)
    .where(
      and(
        eq(queueMessages.sessionId, session.id),
        eq(queueMessages.turnId, turn.id),
      ),
    );
  const parked = await parkTurnRequests(tx, {
    sessionId: session.id,
    turnRowId: turn.id,
    now,
  });
  await recordInputWaitStage(tx, {
    sessionId: session.id,
    stage: "parked",
    requestIds: parked,
    turnRowId: turn.id,
    now,
  });
  await tx
    .update(sessions)
    .set({ status: "idle", lastTurnAt: now, updatedAt: now })
    .where(eq(sessions.id, session.id));
  if (session.status !== "idle") {
    await recordStatus(tx, {
      sessionId: session.id,
      phase: publicStatus(
        "idle",
        await awaitingInputAt(tx, session.id, await dbNow(tx)),
      ),
      turnRowId: turn.id,
      now,
    });
  }
  return true;
}

async function warnNearTranscriptLimit(
  tx: Database,
  input: {
    fence: WorkerFence;
    session: SessionRow;
    checkpoint: CheckpointRef;
    turnRowId: number | null;
    now: Date;
  },
  bytes: number,
): Promise<void> {
  const warn = transcriptWarnBytes();
  if (bytes < warn) return;
  // Any earlier checkpoint past the threshold, not just the pointer: a
  // fallback restore resumes a smaller one without the warning becoming news
  // again. Revisions start_fresh retired belong to the engine session it gave up.
  const retired = input.session.contextResetCheckpointRevision;
  const [warned] = await tx
    .select({ revision: checkpoints.revision })
    .from(checkpoints)
    .where(
      and(
        eq(checkpoints.sessionId, input.fence.sessionId),
        lt(checkpoints.revision, input.checkpoint.revision),
        retired === null ? undefined : gt(checkpoints.revision, retired),
        gte(checkpoints.transcriptBytes, warn),
      ),
    )
    .limit(1);
  if (warned) return;
  await recordEvent(tx, {
    sessionId: input.fence.sessionId,
    type: "system",
    payload: {
      type: "system",
      subtype: "transcript_near_limit",
      transcript_bytes: bytes,
      warn_bytes: warn,
      limit_bytes: TRANSCRIPT_LIMITS.totalBytes,
      checkpoint_revision: input.checkpoint.revision,
    },
    turnRowId: input.turnRowId,
    attemptId: input.fence.attemptId,
    now: input.now,
  });
}

function storedPendingReason(
  value: string | null,
): CheckpointBlockReason | null {
  return value === null ? null : checkpointBlockReasonSchema.parse(value);
}

/**
 * The pointer as the session row states it, read inside the caller's
 * transaction so it belongs to the same snapshot as the fence. A row that
 * points at a revision with no checkpoint row is corruption, not a state, and
 * is reported rather than read around as "no checkpoint".
 */
export async function readCheckpointPointer(
  tx: Database,
  session: Pick<
    SessionRow,
    "id" | "checkpointRevision" | "checkpointCommittedAt"
  >,
): Promise<CheckpointPointer | null> {
  if (session.checkpointRevision === null) return null;
  const [checkpoint] = await tx
    .select({
      manifestRef: checkpoints.manifestRef,
      manifestSha256: checkpoints.manifestSha256,
      manifestVersion: checkpoints.manifestVersion,
      versionsHeld: checkpoints.versionsHeld,
      parentRevision: checkpoints.parentRevision,
      committedAt: checkpoints.committedAt,
      turnSequence: turns.sequence,
    })
    .from(checkpoints)
    .leftJoin(turns, eq(turns.id, checkpoints.turnId))
    .where(
      and(
        eq(checkpoints.sessionId, session.id),
        eq(checkpoints.revision, session.checkpointRevision),
      ),
    )
    .limit(1);
  if (!checkpoint) {
    throw new Error(
      `Session ${session.id} points at checkpoint revision ${session.checkpointRevision}, which has no row`,
    );
  }
  return {
    committedAt: session.checkpointCommittedAt ?? checkpoint.committedAt,
    manifestRef: checkpoint.manifestRef,
    manifestSha256: checkpoint.manifestSha256,
    manifestVersion: checkpoint.manifestVersion,
    parentRevision: checkpoint.parentRevision,
    revision: session.checkpointRevision,
    versionsHeld: checkpoint.versionsHeld,
    turnId:
      checkpoint.turnSequence === null ? null : String(checkpoint.turnSequence),
  };
}

function sessionRepositoryOf(
  session: Pick<
    SessionRow,
    "id" | "repositoryMode" | "repositoryId" | "repoUrl" | "branch"
  >,
): { id: string | null; url: string; branch: string } | null {
  if (session.repositoryMode === "none") return null;
  // sessions_repository_mode_check rules this out.
  if (session.repoUrl === null || session.branch === null) {
    throw new Error(`Session ${session.id} has a repository but no URL`);
  }
  return {
    id: session.repositoryId,
    url: session.repoUrl,
    branch: session.branch,
  };
}

type RunnableFields = Pick<
  SessionRow,
  | "profileId"
  | "profileFingerprint"
  | "model"
  | "repositoryMode"
  | "repositoryId"
  | "repoUrl"
  | "branch"
  | "githubPolicySource"
>;

function allowsPair(pair: RunnablePair, session: RunnableFields): boolean {
  if (pair.profileId !== session.profileId) return false;
  if (pair.policy) {
    return (
      (session.githubPolicySource !== "release" || pair.workspaceScoped) &&
      (session.repositoryMode === "none" ||
        pair.repositories.some(
          (repository) =>
            repository.repositoryId === session.repositoryId &&
            repository.url === session.repoUrl &&
            repository.branch === session.branch,
        ))
    );
  }
  if (pair.repositoryId === null) return session.repositoryMode === "none";
  return (
    session.repositoryMode === "repository" &&
    pair.repositoryId === session.repositoryId &&
    pair.url === session.repoUrl &&
    pair.branch === session.branch
  );
}

/**
 * The session's model when its profile is still offered here, with models of
 * its own, but none of them is the session's; null when anything else moved
 * (a dropped pair, a row without a model). Read from the pairs' models, not
 * their fingerprints: a version 1 fingerprint names its model, so it stops
 * matching whichever way the list changed.
 */
export function removedModelOf(
  session: RunnableFields,
  runnable: readonly RunnablePair[],
): string | null {
  const { model } = session;
  if (model === null) return null;
  const named = runnable.filter(
    (pair) => allowsPair(pair, session) && pair.model !== null,
  );
  return named.length > 0 && named.every((pair) => pair.model !== model)
    ? model
    : null;
}

// A row from before has no fingerprint; it runs on whatever the
// pair's profile is now, and the claim that binds it pins that.
export function runnablePairOf(
  session: RunnableFields,
  runnable: readonly RunnablePair[],
): RunnablePair | undefined {
  return runnable.find(
    (pair) =>
      allowsPair(pair, session) &&
      (session.profileFingerprint === null ||
        (session.profileFingerprint === pair.profileFingerprint &&
          (pair.model === null || pair.model === session.model))),
  );
}

function replayableBinding(
  session: SessionRow,
  attempt: AttemptRow,
  launch: Pick<
    typeof workerLaunches.$inferSelect,
    "executionId" | "generation"
  >,
): boolean {
  return (
    LAUNCHABLE_ADMISSION_STATES.includes(session.admissionState) &&
    // An operator's revocation must not see a token rotated in
    // after it, whatever state it left the session in.
    session.executionRevokedAt === null &&
    session.podId === launch.executionId &&
    session.executionId === launch.executionId &&
    session.executionGeneration === launch.generation &&
    attempt.executionId === launch.executionId &&
    session.leaseEpoch === attempt.leaseEpoch &&
    session.executionGeneration === attempt.executionGeneration &&
    session.authRevision === attempt.authRevision
  );
}

// A row of mode repository with no repository id predates the catalog and
// matches nothing: the SQL tuple holds a NULL. The same predicate as
// runnablePairOf.
export function runnableCondition(all: readonly RunnablePair[]): SQL {
  const withRepository = all.filter(
    (pair): pair is RepositoryPair => typeof pair.repositoryId === "string",
  );
  const without = all.filter((pair) => pair.repositoryId === null);
  const policy = all.filter((pair): pair is PolicyPair => pair.policy === true);
  const conditions: SQL[] = [];
  if (withRepository.length > 0) {
    const pairs = sql.join(
      withRepository.map(
        (pair) =>
          sql`(${pair.profileId}, ${pair.repositoryId}, ${pair.url}, ${pair.branch})`,
      ),
      sql`, `,
    );
    const pinned = pinnedCondition(
      withRepository,
      (pair) =>
        sql`${pair.profileId}, ${pair.repositoryId}, ${pair.url}, ${pair.branch}, ${pair.profileFingerprint}`,
      sql`${sessions.profileId}, ${sessions.repositoryId}, ${sessions.repoUrl}, ${sessions.branch}, ${sessions.profileFingerprint}`,
    );
    conditions.push(
      sql`(${sessions.repositoryMode} = 'repository' AND (${pinned} OR (${sessions.profileFingerprint} IS NULL AND (${sessions.profileId}, ${sessions.repositoryId}, ${sessions.repoUrl}, ${sessions.branch}) IN (${pairs}))))`,
    );
  }
  if (without.length > 0) {
    const profiles = sql.join(
      without.map((pair) => sql`${pair.profileId}`),
      sql`, `,
    );
    const pinned = pinnedCondition(
      without,
      (pair) => sql`${pair.profileId}, ${pair.profileFingerprint}`,
      sql`${sessions.profileId}, ${sessions.profileFingerprint}`,
    );
    conditions.push(
      sql`(${sessions.repositoryMode} = 'none' AND (${pinned} OR (${sessions.profileFingerprint} IS NULL AND ${sessions.profileId} IN (${profiles}))))`,
    );
  }
  const [firstPolicy] = policy;
  if (firstPolicy !== undefined) {
    const idList = (pairs: readonly PolicyPair[]) =>
      sql.join(
        pairs.map((pair) => sql`${pair.profileId}`),
        sql`, `,
      );
    const scoped = policy.filter((pair) => pair.workspaceScoped);
    const judged =
      scoped.length === 0
        ? sql`${sessions.githubPolicySource} <> 'release'`
        : sql`(${sessions.githubPolicySource} <> 'release' OR ${sessions.profileId} IN (${idList(scoped)}))`;
    // Every pair holds the same list, so the tuples stay one per repository.
    const repositories = firstPolicy.repositories.map(
      (repository) =>
        sql`(${repository.repositoryId}, ${repository.url}, ${repository.branch})`,
    );
    const onRepository =
      repositories.length === 0
        ? sql`false`
        : sql`(${sessions.repositoryId}, ${sessions.repoUrl}, ${sessions.branch}) IN (${sql.join(repositories, sql`, `)})`;
    const pinned = pinnedCondition(
      policy,
      (pair) => sql`${pair.profileId}, ${pair.profileFingerprint}`,
      sql`${sessions.profileId}, ${sessions.profileFingerprint}`,
    );
    conditions.push(
      sql`(${judged} AND (${sessions.repositoryMode} = 'none' OR ${onRepository}) AND (${pinned} OR (${sessions.profileFingerprint} IS NULL AND ${sessions.profileId} IN (${idList(policy)}))))`,
    );
  }
  if (conditions.length === 0) return sql`false`;
  return sql`(${sql.join(conditions, sql` OR `)})`;
}

function pinnedCondition<Pair extends RunnablePair>(
  all: readonly Pair[],
  values: (pair: Pair) => SQL,
  columns: SQL,
): SQL {
  const byFingerprint = all.filter((pair) => pair.model === null);
  const byModel = all.filter((pair) => pair.model !== null);
  const conditions: SQL[] = [];
  if (byFingerprint.length > 0) {
    const tuples = sql.join(
      byFingerprint.map((pair) => sql`(${values(pair)})`),
      sql`, `,
    );
    conditions.push(sql`(${columns}) IN (${tuples})`);
  }
  if (byModel.length > 0) {
    const tuples = sql.join(
      byModel.map((pair) => sql`(${values(pair)}, ${pair.model})`),
      sql`, `,
    );
    conditions.push(sql`(${columns}, ${sessions.model}) IN (${tuples})`);
  }
  return conditions.length === 0
    ? sql`false`
    : sql`(${sql.join(conditions, sql` OR `)})`;
}

function budgetOf(input: {
  costLimitUsd: number;
  tokenLimit: number | null;
}): SessionBudget {
  return { costUsd: input.costLimitUsd, tokens: input.tokenLimit };
}

/**
 * The proxy refuses a spent session's calls, and the engine reports that as
 * whatever the refusal looked like to it: a 403 it calls an authentication
 * failure, or a connection error when the regrant cut the exchange. The
 * session's own spend is what says the budget ended the turn, so the reason
 * and the receipt follow it.
 */
function budgetEnded(
  terminal: FinalizeInput["terminal"],
  session: SessionRow,
  budget: SessionBudget,
): FinalizeInput["terminal"] {
  return budgetExceeded(session, budget)
    ? budgetEndedTerminal(terminal)
    : terminal;
}

/**
 * A launch reserved for one session whose pair the catalog has since dropped
 * would wait out the worker's claim timeout, exit unclaimed, and be rebuilt
 * until the scheduler's failure limit gave it up — holding a slot
 * the whole time for an answer that is already known here. When the pinned
 * session is otherwise claimable and only the pair stands in the way, the
 * launch is given up on now, in the claim's transaction and under its launch
 * row lock. Anything else — the session bound, paused, spent, or
 * the launch already asked to go — is left to the ordinary "nothing to claim".
 *
 * With several API replicas, the one that answers could fail a session
 * another would run. So only a host that has read the database's settings
 * generation gives up; any other answers "nothing to claim" and writes
 * nothing, leaving the existing failure count as the net. A blocked ceiling
 * is the exception: its row says the same to every replica.
 */
/**
 * A session with a pod keeps its model until its turn ends, and the proxy's
 * cut stays what it was. A version 1 pin names its model in the hash, so the
 * row's pin moves with it (its model column may be null). A locked row is
 * left to its holder unless `wait`. Returns how many moved.
 */
export async function moveSessionsToSuccessors(
  tx: Database,
  launch: { partition: string; sessionId: string | null },
  input: Pick<ClaimInput, "modelMoves" | "now">,
  wait = false,
): Promise<number> {
  let moved = 0;
  for (const move of input.modelMoves ?? []) {
    const rows = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(
        unassignedSessions,
        eq(unassignedSessions.sessionId, sessions.id),
      )
      .where(
        and(
          eq(unassignedSessions.partition, launch.partition),
          eq(sessions.partition, launch.partition),
          eq(sessions.profileId, move.profileId),
          eq(sessions.profileFingerprint, move.fromFingerprint),
          move.fromFingerprint === move.toFingerprint
            ? eq(sessions.model, move.from)
            : or(eq(sessions.model, move.from), isNull(sessions.model)),
          isNull(sessions.podId),
          inArray(sessions.admissionState, LAUNCHABLE_ADMISSION_STATES),
          isNull(sessions.executionRevokedAt),
          isNull(sessions.takeoverRequiredAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${agentReleases} AS r
            JOIN ${agents} AS a ON a.id = r.agent_id
            WHERE r.id = ${sessions.agentReleaseId}
              AND a.auto_model_migration = false
          )`,
          ...(launch.sessionId === null
            ? []
            : [eq(sessions.id, launch.sessionId)]),
        ),
      )
      .orderBy(asc(sessions.id))
      .for(
        "update",
        wait ? { of: sessions } : { of: sessions, skipLocked: true },
      );
    for (const { id } of rows) {
      // A share lock on the agent row orders this move against the switch's
      // update: a switch committed after the filter above is seen here.
      const { rows: held } = (await tx.execute(sql`
        SELECT a.auto_model_migration AS "on"
        FROM ${sessions} AS s
        JOIN ${agentReleases} AS r ON r.id = s.agent_release_id
        JOIN ${agents} AS a ON a.id = r.agent_id
        WHERE s.id = ${id}
        FOR SHARE OF a`)) as unknown as { rows: { on: boolean }[] };
      if (held.some((row) => row.on === false)) continue;
      moved += 1;
      await tx
        .update(sessions)
        .set({
          model: move.to,
          profileFingerprint: move.toFingerprint,
          updatedAt: input.now,
        })
        .where(eq(sessions.id, id));
      await recordEvent(tx, {
        sessionId: id,
        type: "system",
        payload: {
          type: "system",
          subtype: "model_migrated",
          from: move.from,
          to: move.to,
        },
        turnRowId: null,
        now: await dbNow(tx),
      });
    }
  }
  return moved;
}

async function giveUpOnCatalogMismatch(
  tx: Database,
  launch: typeof workerLaunches.$inferSelect,
  sessionId: string,
  input: Pick<
    ClaimInput,
    | "runnable"
    | "settingsGeneration"
    | "unsettledRepositoryIds"
    | "settledProfileIds"
    | "costLimitUsd"
    | "tokenLimit"
  >,
  now: Date,
): Promise<"catalog_mismatch" | "context_gap" | null> {
  const { runnable } = input;
  const [session] = await tx
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
    .for("update");
  if (
    !session ||
    session.podId !== null ||
    session.partition !== launch.partition ||
    !LAUNCHABLE_ADMISSION_STATES.includes(session.admissionState) ||
    // Reserved for this launch and no later one.
    session.executionId !== launch.executionId ||
    budgetExceeded(session, budgetOf(input)) ||
    runnablePairOf(session, runnable) !== undefined ||
    (session.profileId !== null &&
      !input.settledProfileIds.has(session.profileId)) ||
    (session.repositoryId !== null &&
      input.unsettledRepositoryIds.has(session.repositoryId))
  ) {
    return null;
  }
  // The ceiling before the generation: a ceiling write locks its row and
  // then, through its trigger, the generation, so the other order deadlocks.
  const blocked =
    input.settingsGeneration === null
      ? undefined
      : await profileBlocked(tx, session.profileId);
  // Held until the claim commits: a settings write waits for this give-up
  // rather than committing a row the claim judged without. Never waited for: a write in
  // flight may go on to lock the ceiling held above, so the give-up yields
  // and the claim is asked again.
  const [settings] =
    input.settingsGeneration === null
      ? []
      : await tx
          .select({ generation: settingsGeneration.generation })
          .from(settingsGeneration)
          .limit(1)
          .for("share", { skipLocked: true });
  if (input.settingsGeneration !== null && settings === undefined) {
    return null;
  }
  const behind =
    settings === undefined ||
    (input.settingsGeneration ?? 0) < settings.generation;
  if (behind && !(blocked ?? (await profileBlocked(tx, session.profileId)))) {
    return null;
  }
  // Skipped when locked, as the candidate query does: another claim holding
  // it is binding the session and waits on the row lock taken above, so
  // waiting for it here would deadlock, and failing the session under it
  // would be wrong.
  const [signal] = await tx
    .select({ sessionId: unassignedSessions.sessionId })
    .from(unassignedSessions)
    .where(
      and(
        eq(unassignedSessions.sessionId, session.id),
        eq(unassignedSessions.partition, launch.partition),
      ),
    )
    .limit(1)
    .for("update", { skipLocked: true });
  if (!signal) return null;
  const ref = {
    executionId: launch.executionId,
    generation: launch.generation,
  };
  const [execution] = await tx
    .select({ desiredState: executions.desiredState })
    .from(executions)
    .where(
      and(
        eq(executions.id, ref.executionId),
        eq(executions.generation, ref.generation),
        eq(executions.sessionId, session.id),
      ),
    )
    .limit(1);
  if (execution?.desiredState !== "running") return null;
  // A context gap is the operator's call before the catalog's: it
  // holds the queued input for start_fresh, where a catalog give-up would
  // fail it and leave the gap to be found only at the next claim.
  const coverage = await contextCoverage(tx, session);
  if (contextGap(session, coverage)) {
    await raiseContextGap(tx, { session, coverage, detectedAt: "claim", now });
    await tx
      .update(executions)
      .set({ desiredState: "terminated" })
      .where(eq(executions.id, launch.executionId));
    return "context_gap";
  }
  const removed = removedModelOf(session, runnable);
  // Names ids only: the stored URL may embed a credential.
  const detail =
    removed !== null
      ? `model ${removed} was taken off the allowed list of profile ${session.profileId}`
      : runnable.some((pair) => allowsPair(pair, session))
        ? `profile ${session.profileId} has other settings in this host's catalog than the session was created with`
        : `profile ${session.profileId ?? "(none)"} and repository ${session.repositoryId ?? "(none)"} at the session's URL and branch are not an allowed pair in this host's catalog`;
  await countLaunchGiveUp(tx, launch.executionId, detail);
  // The stream and the DMs say which model left, as they do for an attempt
  // cut while running; the session's own lock is held.
  if (removed !== null) {
    await writeModelCut(tx, {
      sessionId: session.id,
      attemptId: null,
      model: removed,
      cause: "model_removed",
    });
  }
  await quarantineLaunch(tx, ref, session.id, catalogMismatchCause(detail));
  return "catalog_mismatch";
}

/**
 * Fails a session whose variable snapshot the claim refuses, in the claim's
 * transaction: one receipt that names the cause, the launch counted as given
 * up, the session failed and its execution asked to go.
 */
async function refuseSessionVariables(
  tx: Database,
  launch: { executionId: string; generation: number },
  session: { id: string; ownerId: string },
  reason: EnvRefusal,
): Promise<void> {
  const cause = variablesRefusedCause(reason);
  await recordEnvRefusal(tx, {
    ownerId: session.ownerId,
    actor: null,
    requestId: null,
    reason,
    target: { sessionId: session.id },
  });
  await countLaunchGiveUp(tx, launch.executionId, cause.detail);
  await quarantineLaunch(
    tx,
    { executionId: launch.executionId, generation: launch.generation },
    session.id,
    cause,
  );
}

/**
 * As `recordLaunchFailure` gives a launch up: counted, the credential
 * revoked, nothing left to rebuild.
 */
async function countLaunchGiveUp(
  tx: Database,
  executionId: string,
  detail: string,
): Promise<void> {
  await tx
    .update(workerLaunches)
    .set({
      launchFailureCount: sql`${workerLaunches.launchFailureCount} + 1`,
      launchAttempts: sql`${workerLaunches.launchAttempts} + 1`,
      lastLaunchError: detail,
      launchRetryAt: null,
      nonceHash: null,
      replacementReason: null,
    })
    .where(eq(workerLaunches.executionId, executionId));
}

/**
 * Whether `profileId`, or the ceiling a workspace version of that id is on,
 * is blocked. Held until the claim commits, so an unblock waits for the
 * give-up judged under the block.
 */
async function profileBlocked(
  tx: Database,
  profileId: string | null,
): Promise<boolean> {
  if (profileId === null) return false;
  const [version] = await tx
    .select({ baseProfileId: workspaceProfiles.baseProfileId })
    .from(workspaceProfiles)
    .where(eq(workspaceProfiles.id, profileId))
    .limit(1);
  const [ceiling] = await tx
    .select({ blockedAt: installationProfiles.blockedAt })
    .from(installationProfiles)
    .where(eq(installationProfiles.id, version?.baseProfileId ?? profileId))
    .limit(1)
    .for("share");
  return ceiling !== undefined && ceiling.blockedAt !== null;
}

async function drainRequested(
  tx: Database,
  attempt: Pick<AttemptRow, "executionId" | "executionGeneration">,
): Promise<boolean> {
  const [launch] = await tx
    .select({ drainRequestedAt: workerLaunches.drainRequestedAt })
    .from(workerLaunches)
    .where(
      and(
        eq(workerLaunches.executionId, attempt.executionId),
        eq(workerLaunches.generation, attempt.executionGeneration),
      ),
    )
    .limit(1);
  return launch?.drainRequestedAt != null;
}

function launchRuntimeOf(
  launch: typeof workerLaunches.$inferSelect,
): ImageRuntime | undefined {
  if (
    launch.runtimeEngine === null ||
    launch.runtimeSdkVersion === null ||
    launch.runtimeCliVersion === null ||
    launch.runtimeProfileScheme === null
  ) {
    return undefined;
  }
  return {
    engine: launch.runtimeEngine,
    sdkVersion: launch.runtimeSdkVersion,
    cliVersion: launch.runtimeCliVersion,
    profileDigestScheme: launch.runtimeProfileScheme,
  };
}

function withLaunchRuntime(
  binding: WorkerBinding,
  launch: typeof workerLaunches.$inferSelect,
): WorkerBinding {
  const launchRuntime = launchRuntimeOf(launch);
  return launchRuntime === undefined ? binding : { ...binding, launchRuntime };
}

/**
 * Records the refusal and gives the launch's slot back the way a kill does:
 * the bootstrap door shut and the execution asked to go. Its failure count
 * is left alone, and so is the session, which stays waiting for a launch.
 */
async function refuseWorkerImage(
  tx: Database,
  launch: typeof workerLaunches.$inferSelect,
  assumed: ImageRuntime,
  claimed: ImageRuntime,
): Promise<void> {
  const image = launch.image ?? "(unpinned)";
  await tx
    .insert(workerImageRefusals)
    .values({
      image,
      assumedEngine: assumed.engine,
      assumedSdkVersion: assumed.sdkVersion,
      assumedCliVersion: assumed.cliVersion,
      assumedProfileScheme: assumed.profileDigestScheme,
      claimed,
      executionId: launch.executionId,
    })
    .onConflictDoNothing();
  await tx
    .update(workerLaunches)
    .set({
      nonceHash: null,
      launchRetryAt: null,
      replacementReason: null,
      lastLaunchError: `worker image ${image} runs ${JSON.stringify(claimed)}, not the configured ${JSON.stringify(assumed)}`,
    })
    .where(eq(workerLaunches.executionId, launch.executionId));
  await tx
    .update(executions)
    .set({ desiredState: "terminated" })
    .where(
      and(
        eq(executions.id, launch.executionId),
        eq(executions.generation, launch.generation),
      ),
    );
}

// `at` is a database instant read after the worker sent its request, which
// is what lets the worker count the remainder from its own send time.
async function bindingOf(
  tx: Database,
  session: SessionRow,
  attempt: AttemptRow,
  at: Date,
  restore?: CheckpointRef | null,
): Promise<WorkerBinding> {
  return {
    sessionId: session.id,
    attemptId: attempt.id,
    leaseEpoch: attempt.leaseEpoch,
    executionGeneration: attempt.executionGeneration,
    authRevision: attempt.authRevision,
    leaseExpiresAt: attempt.leaseExpiresAt,
    leaseRemainingMs: leaseRemainingMs(attempt.leaseExpiresAt, at),
    profileId: session.profileId,
    profileFingerprint: session.profileFingerprint,
    model: session.model,
    unmetered: session.unmetered,
    ownerScope: session.ownerId,
    repository: sessionRepositoryOf(session),
    ...(await withRestoreProfiles(
      tx,
      session.id,
      restore === undefined ? await restoreRef(tx, session) : restore,
    )),
    costUsd: session.costUsd,
    providerTokens: session.providerTokens,
    mcp: await sessionMcpOf(tx, session),
    githubMcp: await sessionGitHubMcpOf(tx, session),
    ...(await releaseRunOf(tx, session)),
    platformPrompt: session.platformPrompt,
    ...(pinnedExtensionsOf(session).length === 0
      ? {}
      : { extensions: pinnedExtensionsOf(session) }),
    grants: await unspentGrants(tx, session.id, attempt.id),
  };
}

// A row from before extensions holds null; one created with none holds `[]`.
function pinnedExtensionsOf(
  session: Pick<SessionRow, "extensions">,
): SessionExtension[] {
  return (session.extensions as SessionExtension[] | null) ?? [];
}

// A snapshot this image cannot read allows no tool rather than guessing.
async function releaseRunOf(
  tx: Database,
  session: SessionRow,
): Promise<Pick<WorkerBinding, "releaseTools">> {
  if (session.agentReleaseId === null) return { releaseTools: null };
  const [release] = await tx
    .select({ snapshot: agentReleases.runtimeConfigSnapshot })
    .from(agentReleases)
    .where(eq(agentReleases.id, session.agentReleaseId))
    .limit(1);
  const tools = (release?.snapshot as { tools?: unknown } | undefined)?.tools;
  return {
    releaseTools:
      Array.isArray(tools) && tools.every((tool) => typeof tool === "string")
        ? tools
        : [],
  };
}

// Only for a turn not yet finished: a grant outlives nothing past the turn
// it was left for. Each is marked as handed to the claiming attempt, which
// is how nextInput knows an attempt claimed before a grant existed.
async function unspentGrants(
  tx: Database,
  sessionId: string,
  attemptId: string,
): Promise<PermissionGrant[]> {
  const rows = await tx
    .select({
      requestId: permissionGrants.requestId,
      sequence: turns.sequence,
      tool: pendingRequests.tool,
      payload: pendingRequests.payload,
      answer: pendingRequests.answer,
      inputHash: pendingRequests.inputHash,
    })
    .from(permissionGrants)
    .innerJoin(turns, eq(turns.id, permissionGrants.turnId))
    .innerJoin(
      pendingRequests,
      eq(pendingRequests.requestId, permissionGrants.requestId),
    )
    .where(
      and(
        eq(permissionGrants.sessionId, sessionId),
        isNull(permissionGrants.consumedAt),
        isNull(pendingRequests.settledAt),
        inArray(turns.status, ["queued", ...OPEN_TURN_STATUSES]),
      ),
    )
    .orderBy(asc(permissionGrants.requestId));
  if (rows.length > 0) {
    await tx
      .update(permissionGrants)
      .set({ attemptId })
      .where(
        inArray(
          permissionGrants.requestId,
          rows.map((row) => row.requestId),
        ),
      );
  }
  return rows.map((row) => {
    const offer = rememberedOffer(row.payload, row.answer);
    return {
      request_id: row.requestId,
      turn_id: String(row.sequence),
      tool: (row.payload as { tool?: string }).tool ?? row.tool ?? "",
      input_hash: row.inputHash,
      ...(offer === undefined ? {} : { remember_offer: offer }),
    };
  });
}

// The rules a person agreed to keep for the session: the offer the row was
// registered with, only when the stored answer asked to remember it.
function rememberedOffer(
  payload: unknown,
  answer: unknown,
): PendingRememberRule[] | undefined {
  if ((answer as { remember?: unknown } | null)?.remember !== "session") {
    return undefined;
  }
  const offer = rememberRuleSchema
    .array()
    .min(1)
    .safeParse((payload as { remember_offer?: unknown }).remember_offer);
  return offer.success ? offer.data : undefined;
}

async function grantMissedBy(
  tx: Database,
  turnRowId: number,
  attemptId: string,
): Promise<boolean> {
  // Only a grant a claim would carry: one whose request a cancel settled
  // goes to no worker, and waiting for it would hold the queue for good.
  const [missed] = await tx
    .select({ requestId: permissionGrants.requestId })
    .from(permissionGrants)
    .innerJoin(
      pendingRequests,
      eq(pendingRequests.requestId, permissionGrants.requestId),
    )
    .where(
      and(
        eq(permissionGrants.turnId, turnRowId),
        isNull(permissionGrants.consumedAt),
        isNull(pendingRequests.settledAt),
        sql`${permissionGrants.attemptId} IS DISTINCT FROM ${attemptId}`,
      ),
    )
    .limit(1);
  return missed !== undefined;
}

// The profiles the checkpoints a restore may land on were committed under:
// the pointer's and any earlier one a fallback walks back to, newest first,
// so a cap on how many the claim carries drops the oldest. A row from before
// the column names none; it ran the session's own.
async function withRestoreProfiles(
  tx: Database,
  sessionId: string,
  restore: CheckpointRef | null,
): Promise<Pick<WorkerBinding, "restore" | "restoreProfiles">> {
  if (restore === null) return { restore, restoreProfiles: [] };
  const rows = await tx
    .select({
      profileId: checkpoints.profileId,
      profileFingerprint: checkpoints.profileFingerprint,
      model: checkpoints.model,
    })
    .from(checkpoints)
    .where(
      and(
        eq(checkpoints.sessionId, sessionId),
        lte(checkpoints.revision, restore.revision),
        isNotNull(checkpoints.profileId),
        isNotNull(checkpoints.profileFingerprint),
      ),
    )
    .groupBy(
      checkpoints.profileId,
      checkpoints.profileFingerprint,
      checkpoints.model,
    )
    .orderBy(desc(max(checkpoints.revision)));
  return {
    restore,
    restoreProfiles: rows.flatMap((row) =>
      row.profileId === null || row.profileFingerprint === null
        ? []
        : [
            {
              profileId: row.profileId,
              profileFingerprint: row.profileFingerprint,
              model: row.model,
            },
          ],
    ),
  };
}

async function issueCredentials(
  tx: Database,
  input: Pick<ClaimInput, "credentialHash" | "credentialTtlMs" | "egress">,
  attemptId: string,
  session: Pick<
    SessionRow,
    | "id"
    | "profileId"
    | "profileFingerprint"
    | "model"
    | "repositoryMode"
    | "repositoryId"
    | "agentReleaseId"
    | "githubPolicySource"
    | "mcpStart"
  >,
) {
  const expiresAt = fromDbNow(input.credentialTtlMs);
  const bindings = input.egress.bindingsOf({
    ...session,
    mcp: await sessionMcpOf(tx, session),
    githubMcp: await sessionGitHubMcpOf(tx, session),
  });
  await tx.insert(workerCredentials).values([
    {
      tokenHash: input.credentialHash,
      attemptId,
      purpose: "gateway",
      expiresAt,
    },
    {
      tokenHash: input.egress.providerHash,
      attemptId,
      purpose: "provider",
      binding: bindings.provider,
      expiresAt,
    },
    ...(bindings.repository === null
      ? []
      : [
          {
            tokenHash: input.egress.repositoryHash,
            attemptId,
            purpose: "repository" as const,
            binding: bindings.repository,
            expiresAt,
          },
        ]),
    {
      tokenHash: input.egress.objectStoreHash,
      attemptId,
      purpose: "object_store",
      binding: bindings.object_store,
      expiresAt,
    },
    ...(bindings.mcp === undefined || input.egress.mcpHash === undefined
      ? []
      : [
          {
            tokenHash: input.egress.mcpHash,
            attemptId,
            purpose: "mcp",
            binding: bindings.mcp,
            expiresAt,
          },
        ]),
    ...(bindings.packages === undefined ||
    input.egress.packagesHash === undefined
      ? []
      : [
          {
            tokenHash: input.egress.packagesHash,
            attemptId,
            purpose: "packages",
            binding: bindings.packages,
            expiresAt,
          },
        ]),
  ]);
}

async function firstProviderBinding(
  tx: Database,
  attemptId: string,
): Promise<string | null> {
  const [issued] = await tx
    .select({ binding: workerCredentials.binding })
    .from(workerCredentials)
    .where(
      and(
        eq(workerCredentials.attemptId, attemptId),
        eq(workerCredentials.purpose, "provider"),
      ),
    )
    .orderBy(asc(workerCredentials.createdAt))
    .limit(1);
  return issued?.binding ?? null;
}

async function revokeCredentials(tx: Database, attemptId: string, now: Date) {
  await tx
    .update(workerCredentials)
    .set({ revokedAt: now })
    .where(
      and(
        eq(workerCredentials.attemptId, attemptId),
        isNull(workerCredentials.revokedAt),
      ),
    );
}

export function createPostgresWorkerUnitOfWork(
  db: Database,
  options: { logger?: StructuredLogger } = {},
): WorkerUnitOfWork {
  return {
    claimAtomic(input: ClaimInput): Promise<ClaimResult> {
      return db.transaction(async (tx) => {
        const [launch] = await tx
          .select()
          .from(workerLaunches)
          .where(eq(workerLaunches.nonceHash, input.nonceHash))
          .limit(1)
          .for("update");
        // The lease and the token start on the database clock once this row
        // is locked, so a claim that waited out its own TTL on the lock does
        // not answer "claimed" with a binding that is already dead. Audit
        // stamps keep the caller's clock: they record the request, not the
        // ownership window.
        const leaseExpiresAt = fromDbNow(input.leaseTtlMs);
        const credentialTtlMs = input.credentialTtlMs;
        // The nonce deadline was written on the database clock, so it is
        // judged there too, once the row lock is held: a claim that waited
        // out the nonce window on the lock is refused, whatever this
        // replica's clock says.
        const at = await dbNow(tx);
        if (
          !launch ||
          launch.executionId !== input.executionId ||
          launch.generation !== input.executionGeneration ||
          // The backend already observed this execution end and took its slot
          // back, so a straggler must not claim a session with its nonce.
          launch.slotReleasedAt !== null ||
          // A reservation that never had a container created for it holds no
          // credential at all; the lookup above cannot match one, and this
          // says so rather than reading a null expiry.
          launch.nonceExpiresAt === null ||
          // Applies to the replay path too: after the nonce lifetime the
          // bootstrap door is shut, and re-entering it would revoke the
          // session token of the worker that is still running.
          launch.nonceExpiresAt.getTime() <= at.getTime()
        ) {
          return { outcome: "invalid_credential" };
        }
        // Before anything is bound, so the session is left as it was: a
        // worker that is not what its launch assumed proves the image's
        // configured runtime wrong, not the session.
        const assumed = launchRuntimeOf(launch);
        if (
          assumed !== undefined &&
          input.imageRuntime !== undefined &&
          !sameCombination(assumed, input.imageRuntime)
        ) {
          await refuseWorkerImage(tx, launch, assumed, input.imageRuntime);
          return { outcome: "image_mismatch", assumed };
        }

        // A retry of a claim whose response was lost gets the same binding
        // and a fresh session token; it never selects a second session.
        // Earlier tokens for the attempt are revoked so that, if the nonce
        // leaked to a second worker, only the latest claimant can write.
        if (launch.claimedAttemptId !== null) {
          const [bound] = await tx
            .select({ session: sessions, attempt: attempts })
            .from(attempts)
            .innerJoin(sessions, eq(sessions.id, attempts.sessionId))
            .where(eq(attempts.id, launch.claimedAttemptId))
            .limit(1)
            .for("update");
          // "allocated" is what the claim itself wrote: any later state
          // means the worker already used its token, so this is not a lost
          // response but a second holder trying to rotate it away.
          if (!bound || bound.attempt.state !== "allocated") {
            return { outcome: "invalid_credential" };
          }
          // Terminate, close, a pause with nothing to drain and the lease
          // sweep fence this attempt by moving the session on, but leave it
          // `allocated` until the execution is seen gone. A replay
          // is therefore judged as a new claim and the fence would judge it:
          // still the session's binding, on its epoch, and claimable
          // . Refused before anything is written, so the tokens and
          // lease stay as the exit observation expects to find them.
          if (!replayableBinding(bound.session, bound.attempt, launch)) {
            return { outcome: "invalid_credential" };
          }
          // The retry is judged like a new claim: a replica whose reserved
          // names grew since the first answer was lost must not hand the same
          // binding back.
          const replayRefusal = envStartRefusal(
            bound.session.envStart,
            await dbNow(tx),
          );
          if (replayRefusal !== null) {
            // The first answer may have reached a worker: its token, fence
            // and epoch die with the refusal, like a release. pod/execution
            // stay until the backend confirms the execution gone.
            await tx
              .update(attempts)
              .set({
                state: "exited",
                endedAt: input.now,
                endReason: "variables_refused",
              })
              .where(eq(attempts.id, bound.attempt.id));
            await revokeCredentials(tx, bound.attempt.id, input.now);
            await tx
              .update(sessions)
              .set({
                leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
                authRevision: sql`${sessions.authRevision} + 1`,
                updatedAt: input.now,
              })
              .where(eq(sessions.id, bound.session.id));
            await refuseSessionVariables(
              tx,
              launch,
              bound.session,
              replayRefusal,
            );
            return { outcome: "variables_refused" };
          }
          // A retry can land on a replica whose catalog lost this profile.
          // Rotating the token first would revoke the old one, bump the
          // revision and then fail on the way out, leaving a binding nobody
          // holds a token for and a retry that mutates again.
          const pair = runnablePairOf(bound.session, input.runnable);
          if (
            pair === undefined ||
            // A row from before bound by a claim that did not pin it
            // the provider token that claim issued names the settings it ran
            // under, and a replay may not trade them for this catalog's.
            (bound.session.profileFingerprint === null &&
              (await firstProviderBinding(tx, bound.attempt.id)) !==
                pair.profileFingerprint)
          ) {
            return { outcome: "profile_unavailable" };
          }
          await revokeCredentials(tx, bound.attempt.id, input.now);
          await issueCredentials(
            tx,
            { ...input, credentialTtlMs },
            bound.attempt.id,
            bound.session,
          );
          // Revoking the old token does not stop a request that authenticated
          // before it: the auth revision moves so anything already in flight
          // fails its fence, and only the new holder can write.
          const [session] = await tx
            .update(sessions)
            .set({
              authRevision: sql`${sessions.authRevision} + 1`,
              profileFingerprint: pair.profileFingerprint,
              model:
                bound.session.profileFingerprint === null
                  ? pair.model
                  : bound.session.model,
              updatedAt: input.now,
            })
            .where(eq(sessions.id, bound.session.id))
            .returning();
          if (!session) return { outcome: "invalid_credential" };
          const [attempt] = await tx
            .update(attempts)
            // The attempt has not started, so the replay gets a whole lease:
            // handing back the expired one would answer "claimed" and then
            // refuse every call the worker makes with it.
            // It has run nothing yet either, so it takes the profile the
            // session names now, as the tokens just issued do.
            .set({
              authRevision: session.authRevision,
              leaseExpiresAt,
              profileId: session.profileId,
              profileFingerprint: session.profileFingerprint,
              model: session.model,
            })
            .where(eq(attempts.id, bound.attempt.id))
            .returning();
          if (!attempt) return { outcome: "invalid_credential" };
          return {
            outcome: "replayed",
            binding: withLaunchRuntime(
              await bindingOf(tx, session, attempt, at),
              launch,
            ),
          };
        }
        await moveSessionsToSuccessors(tx, launch, input);
        // Server-side selection: the worker never names a session. It is
        // either the one the launch reserved or the partition's head; SKIP
        // LOCKED lets concurrent claims in one partition pick different heads
        // instead of serialising on the oldest signal.
        const selectCandidate = async () => {
          const [found] = await tx
            .select({ sessionId: unassignedSessions.sessionId })
            .from(unassignedSessions)
            .innerJoin(sessions, eq(sessions.id, unassignedSessions.sessionId))
            .where(
              and(
                eq(unassignedSessions.partition, launch.partition),
                // The signal carries a copy; the session's own partition is
                // the one that says which pool may run it.
                eq(sessions.partition, launch.partition),
                isNull(sessions.podId),
                inArray(sessions.admissionState, LAUNCHABLE_ADMISSION_STATES),
                isNull(sessions.executionRevokedAt),
                isNull(sessions.takeoverRequiredAt),
                runnableCondition(input.runnable),
                withinBudget(budgetOf(input)),
                restoreRetryDue(),
                ...(launch.sessionId === null
                  ? []
                  : [eq(sessions.id, launch.sessionId)]),
              ),
            )
            .orderBy(asc(unassignedSessions.signaledAt), asc(sessions.id))
            .limit(1)
            .for("update", { of: unassignedSessions, skipLocked: true });
          return found;
        };
        let candidate = await selectCandidate();
        // The move above skips a row another transaction holds (an input
        // being appended), and the candidate query then finds the dropped
        // model unrunnable. The reserved session is waited for once, so a
        // session that has a successor is not given up on for a lock.
        if (
          !candidate &&
          launch.sessionId !== null &&
          (await moveSessionsToSuccessors(tx, launch, input, true)) > 0
        ) {
          candidate = await selectCandidate();
        }
        if (!candidate) {
          const givenUp =
            launch.sessionId === null
              ? null
              : await giveUpOnCatalogMismatch(
                  tx,
                  launch,
                  launch.sessionId,
                  input,
                  input.now,
                );
          return { outcome: givenUp ?? "no_session" };
        }

        // The candidate query locked only the signal; the context verdict
        // below must be read under the session's own lock, or a checkpoint
        // committing alongside could make it stale before it is acted on.
        const [locked] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.id, candidate.sessionId))
          .limit(1)
          .for("update");
        // A terminate can commit between the candidate read and this lock,
        // and so can an exit that starts a restore backoff.
        const pair = locked && runnablePairOf(locked, input.runnable);
        if (
          !locked ||
          !pair ||
          locked.podId !== null ||
          !LAUNCHABLE_ADMISSION_STATES.includes(locked.admissionState) ||
          locked.executionRevokedAt !== null ||
          locked.takeoverRequiredAt !== null ||
          (locked.restoreRetryAt !== null &&
            locked.restoreRetryAt > (await dbNow(tx)))
        ) {
          return { outcome: "no_session" };
        }
        // A worker bound now would start an engine session without turns it
        // has no checkpoint for, and the user would never be told.
        // The session goes to an operator instead, and the launch is asked to
        // go so the scheduler reclaims it rather than rebuilding it.
        const coverage = await contextCoverage(tx, locked);
        if (contextGap(locked, coverage)) {
          await raiseContextGap(tx, {
            session: locked,
            coverage,
            detectedAt: "claim",
            now: input.now,
          });
          await tx
            .update(executions)
            .set({ desiredState: "terminated" })
            .where(eq(executions.id, launch.executionId));
          return { outcome: "context_gap" };
        }

        // The snapshot the session took at accept is judged again under the
        // names the platform reserves now. A refusal fails the session here, in
        // this transaction, as a catalog give-up does; the next input signals it
        // again and meets the same refusal until the variables are fixed.
        const envRefusal = envStartRefusal(locked.envStart, await dbNow(tx));
        if (envRefusal !== null) {
          await refuseSessionVariables(tx, launch, locked, envRefusal);
          return { outcome: "variables_refused" };
        }

        // Read once: the binding hands the worker exactly the restore the
        // session holds this attempt to reporting ready from.
        const restore = await restoreRef(tx, locked);
        // Every claim is on trial until its worker is ready for input
        // one with nothing to restore can still fail preparing
        // the workspace, over and over.
        const [session] = await tx
          .update(sessions)
          .set({
            leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
            executionGeneration: launch.generation,
            executionId: launch.executionId,
            podId: launch.executionId,
            // Pins a row from before; any other holds this already.
            profileFingerprint: pair.profileFingerprint,
            model:
              locked.profileFingerprint === null ? pair.model : locked.model,
            restoreAttemptId: input.attemptId,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(sessions.id, candidate.sessionId),
              isNull(sessions.podId),
              // The candidate query saw it launchable, but a terminate can
              // commit between that read and this row lock; the write is the
              // check.
              inArray(sessions.admissionState, LAUNCHABLE_ADMISSION_STATES),
            ),
          )
          .returning();
        if (!session) return { outcome: "no_session" };

        const [attempt] = await tx
          .insert(attempts)
          .values({
            id: input.attemptId,
            sessionId: session.id,
            executionId: launch.executionId,
            leaseEpoch: session.leaseEpoch,
            executionGeneration: session.executionGeneration,
            authRevision: session.authRevision,
            state: "allocated",
            leaseExpiresAt,
            startedAt: input.now,
            profileId: session.profileId,
            profileFingerprint: session.profileFingerprint,
            model: session.model,
          })
          .returning();
        if (!attempt) throw new Error("Failed to insert attempt");
        await tx
          .insert(executions)
          .values({
            id: launch.executionId,
            sessionId: session.id,
            backend: launch.backend,
            generation: launch.generation,
            desiredState: "running",
            observedState: "running",
            observedAt: input.now,
          })
          .onConflictDoUpdate({
            target: executions.id,
            set: {
              sessionId: session.id,
              observedState: "running",
              observedAt: input.now,
            },
          });
        await issueCredentials(tx, input, attempt.id, session);
        await tx
          .update(workerLaunches)
          .set({ claimedAttemptId: attempt.id })
          .where(eq(workerLaunches.executionId, launch.executionId));
        await tx
          .delete(unassignedSessions)
          .where(eq(unassignedSessions.sessionId, session.id));
        return {
          outcome: "claimed",
          binding: withLaunchRuntime(
            await bindingOf(tx, session, attempt, at, restore),
            launch,
          ),
        };
      });
    },

    async resolveCredential(
      tokenHash: Uint8Array,
    ): Promise<ResolvedCredential> {
      const [session] = await db
        .select({
          attemptId: attempts.id,
          sessionId: attempts.sessionId,
          leaseEpoch: attempts.leaseEpoch,
          executionGeneration: attempts.executionGeneration,
          authRevision: attempts.authRevision,
          profileId: sessions.profileId,
        })
        .from(workerCredentials)
        .innerJoin(attempts, eq(attempts.id, workerCredentials.attemptId))
        .innerJoin(sessions, eq(sessions.id, attempts.sessionId))
        .where(
          and(
            eq(workerCredentials.tokenHash, tokenHash),
            // An egress token authorizes the proxy's routes and nothing
            // here, whatever else about it is valid.
            eq(workerCredentials.purpose, "gateway"),
            isNull(workerCredentials.revokedAt),
            gt(workerCredentials.expiresAt, DB_NOW),
            notInArray(attempts.state, ENDED_ATTEMPT_STATES),
          ),
        )
        .limit(1);
      if (session) return { kind: "session", ...session };
      const [launch] = await db
        .select({ executionId: workerLaunches.executionId })
        .from(workerLaunches)
        .where(eq(workerLaunches.nonceHash, tokenHash))
        .limit(1);
      return launch ? { kind: "bootstrap" } : null;
    },

    authorizeEgressAtomic(input: {
      tokenHash: Uint8Array;
      purpose: EgressPurpose;
    }): Promise<EgressAuthorization> {
      return db.transaction(async (tx) => {
        const [token] = await tx
          .select({
            binding: workerCredentials.binding,
            sessionId: attempts.sessionId,
            attemptId: attempts.id,
            leaseEpoch: attempts.leaseEpoch,
            executionGeneration: attempts.executionGeneration,
            authRevision: attempts.authRevision,
          })
          .from(workerCredentials)
          .innerJoin(attempts, eq(attempts.id, workerCredentials.attemptId))
          .where(
            and(
              eq(workerCredentials.tokenHash, input.tokenHash),
              eq(workerCredentials.purpose, input.purpose),
              isNull(workerCredentials.revokedAt),
              gt(workerCredentials.expiresAt, DB_NOW),
            ),
          )
          .limit(1);
        if (!token || token.binding === null) {
          return { outcome: "invalid_token" };
        }
        // The attempt's own numbers as the fence: what has to hold is that
        // the session still names this attempt and its lease has not run
        // out, not merely that the token is unexpired. A token outlives a
        // lost lease until the reconciler gets to it; the proxy must not.
        const { binding, ...fence } = token;
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        return {
          outcome: "ok",
          sessionId: fence.sessionId,
          attemptId: fence.attemptId,
          binding,
          // The profile the attempt claimed: a change on the session since
          // reaches the next attempt, not the turn this one is running.
          profileId: fenced.attempt.profileId ?? fenced.session.profileId,
          model:
            fenced.attempt.profileId === null
              ? fenced.session.model
              : fenced.attempt.model,
          repository: sessionRepositoryOf(fenced.session),
          githubPolicySource: fenced.session.githubPolicySource,
          costUsd: fenced.session.costUsd,
          providerTokens: fenced.session.providerTokens,
        };
      });
    },

    recordModelCutAtomic(input: {
      sessionId: string;
      attemptId: string;
      model: string;
      cause: ModelCutCause;
    }): Promise<{ recorded: boolean }> {
      return db.transaction(async (tx) => {
        // The session first, as every stream write does: a later event id
        // must not commit before an earlier one a reader already passed.
        await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, input.sessionId))
          .for("update");
        // Then the attempt row, which serializes the exchanges the proxy
        // refuses at once, so the check below and the insert see each other.
        const [attempt] = await tx
          .select({ id: attempts.id })
          .from(attempts)
          .where(
            and(
              eq(attempts.id, input.attemptId),
              eq(attempts.sessionId, input.sessionId),
            ),
          )
          .limit(1)
          .for("update");
        if (!attempt) return { recorded: false };
        const [seen] = await tx
          .select({ id: events.id })
          .from(events)
          .where(
            and(
              eq(events.sessionId, input.sessionId),
              eq(events.attemptId, input.attemptId),
              eq(events.type, "error"),
              sql`${events.payload}->>'code' = ${MODEL_NOT_ALLOWED_EVENT_CODE}`,
            ),
          )
          .limit(1);
        if (seen) return { recorded: false };
        await writeModelCut(tx, input);
        return { recorded: true };
      });
    },

    recordProviderUsageAtomic(
      input: ProviderUsageInput,
    ): Promise<ProviderUsageResult> {
      return db.transaction(async (tx) => {
        // Session and attempt locked in the order every fenced write takes
        // them. No fence beyond the pair: an attempt that has lost its
        // session since the call still made it.
        const [pair] = await tx
          .select({ unmetered: sessions.unmetered })
          .from(sessions)
          .innerJoin(attempts, eq(attempts.sessionId, sessions.id))
          .where(
            and(
              eq(sessions.id, input.sessionId),
              eq(attempts.id, input.attemptId),
            ),
          )
          .limit(1)
          .for("update");
        if (!pair) return { outcome: "unknown_attempt" };
        const priced = input.priceFor(pair);
        // What makes two reports the same call. The price is left out: it
        // may have moved between them.
        const call = {
          exchangeId: input.exchangeId,
          sessionId: input.sessionId,
          attemptId: input.attemptId,
          model: input.usage.model,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
          cacheCreation1hInputTokens: input.usage.cacheCreation1hInputTokens,
          cacheReadInputTokens: input.usage.cacheReadInputTokens,
          speed: input.usage.speed,
          inferenceGeo: input.usage.inferenceGeo,
          webSearchRequests: input.usage.webSearchRequests,
          webFetchRequests: input.usage.webFetchRequests,
          codeExecutionRequests: input.usage.codeExecutionRequests,
          estimated: input.usage.estimated,
        };
        // Rounded up to the column's micro-dollar, or a stream of tiny calls
        // would each round away to nothing; clamped to the column, so a
        // runaway figure saturates the budget instead of failing the report.
        const [inserted] = await tx
          .insert(providerUsage)
          .values({
            ...call,
            costUsd: sql`LEAST(ceil(${priced.costUsd}::numeric * 1000000) / 1000000, ${MAX_SESSION_COST_USD})`,
            pricedBy: priced.pricedBy,
          })
          .onConflictDoNothing({ target: providerUsage.exchangeId })
          .returning({
            costUsd: providerUsage.costUsd,
            pricedBy: providerUsage.pricedBy,
          });
        if (inserted === undefined) {
          const [stored] = await tx
            .select({
              exchangeId: providerUsage.exchangeId,
              sessionId: providerUsage.sessionId,
              attemptId: providerUsage.attemptId,
              model: providerUsage.model,
              inputTokens: providerUsage.inputTokens,
              outputTokens: providerUsage.outputTokens,
              cacheCreationInputTokens: providerUsage.cacheCreationInputTokens,
              cacheCreation1hInputTokens:
                providerUsage.cacheCreation1hInputTokens,
              cacheReadInputTokens: providerUsage.cacheReadInputTokens,
              speed: providerUsage.speed,
              inferenceGeo: providerUsage.inferenceGeo,
              webSearchRequests: providerUsage.webSearchRequests,
              webFetchRequests: providerUsage.webFetchRequests,
              codeExecutionRequests: providerUsage.codeExecutionRequests,
              estimated: providerUsage.estimated,
              costUsd: providerUsage.costUsd,
              pricedBy: providerUsage.pricedBy,
            })
            .from(providerUsage)
            .where(eq(providerUsage.exchangeId, input.exchangeId));
          if (stored === undefined) return { outcome: "conflict" };
          const { costUsd, pricedBy, ...was } = stored;
          return payloadHash(was) === payloadHash(call)
            ? { outcome: "replayed", costUsd, pricedBy }
            : { outcome: "conflict" };
        }
        await tx
          .update(sessions)
          .set({
            costUsd: sql`LEAST(${sessions.costUsd} + ${inserted.costUsd}::numeric, ${MAX_SESSION_COST_USD})`,
          })
          .where(eq(sessions.id, input.sessionId));
        return {
          outcome: "recorded",
          costUsd: inserted.costUsd,
          pricedBy: inserted.pricedBy,
        };
      });
    },

    nextInputAtomic(input: NextInputInput): Promise<NextInputResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const leaseExpiresAt = fenced.attempt.leaseExpiresAt;
        // A draining attempt is on its way out. Handing it a queued turn
        // would both walk its state back to running and leave that turn
        // unfinished once the execution goes, which costs the session a
        // recovery decision it never needed.
        const draining = fenced.attempt.state === "draining";
        // The session's profile was changed after this attempt claimed it:
        // it finishes what it holds on its own profile and goes, and the
        // next claim runs the new one.
        // An attempt with no model ran a version 1 fingerprint, which names
        // its model; the session's may have been backfilled since.
        const profileMoved =
          fenced.attempt.profileFingerprint !== null &&
          (fenced.attempt.profileId !== fenced.session.profileId ||
            fenced.attempt.profileFingerprint !==
              fenced.session.profileFingerprint ||
            (fenced.attempt.model !== null &&
              fenced.attempt.model !== fenced.session.model));

        const [head] = await tx
          .select({ message: queueMessages, turn: turns })
          .from(queueMessages)
          .innerJoin(turns, eq(turns.id, queueMessages.turnId))
          .where(
            and(
              eq(queueMessages.sessionId, fence.sessionId),
              eq(queueMessages.kind, "message"),
            ),
          )
          .orderBy(asc(queueMessages.id))
          .limit(1)
          .for("update");
        // Whoever held that row may have held it past this lease. Handing the
        // turn over now would start work on a session this attempt no longer
        // owns, which is the one thing the fence exists to prevent.
        const at = await dbNow(tx);
        if (!leaseHeld(fenced.attempt, at)) return { outcome: "lease_expired" };
        // A worker asks for input only once it has started up, restore or
        // not, and every worker version does: its later exit is not
        // a failed startup, and the ones before it no longer count. Only an
        // answered poll says so; one refused here may be the last it sends.
        if (fenced.session.restoreAttemptId === fence.attemptId) {
          await tx
            .update(sessions)
            .set(RESTORE_FAILURES_CLEARED)
            .where(eq(sessions.id, fence.sessionId));
        }
        // Read under the session lock the fence holds, and finalize adds to
        // it under the same lock, so a turn cannot start on a stale total.
        const overBudget = budgetExceeded(fenced.session, budgetOf(input));
        const none = {
          outcome: "ok" as const,
          input: null,
          leaseExpiresAt,
          ...(draining || profileMoved ? { draining: true as const } : {}),
          ...(overBudget ? { blocked: "BUDGET_EXCEEDED" as const } : {}),
        };
        if (!head) return none;
        const { message, turn } = head;

        // The head was delivered to an earlier attempt and never finalized:
        // its outcome is unknown, and only the reconciler may
        // decide; a fresh delivery here would re-run its side effects.
        const redelivery =
          turn.attemptId === fence.attemptId &&
          OPEN_TURN_STATUSES.includes(turn.status);
        if (turn.status !== "queued" && !redelivery) return none;
        if ((draining || profileMoved) && !redelivery) return none;
        // The turn carries a grant this attempt's claim never had: the
        // engine would ask again for what was already allowed. It goes, and
        // the next claim takes the grant.
        if (
          !redelivery &&
          (await grantMissedBy(tx, turn.id, fence.attemptId))
        ) {
          return { ...none, draining: true as const };
        }
        // Pausing (or any state but active) admits nothing new; the turn
        // this attempt already holds is still its to finish.
        if (fenced.session.admissionState !== "active" && !redelivery) {
          return none;
        }
        // A turn this attempt already holds is finished whatever it costs;
        // only a new one is refused.
        if (overBudget && !redelivery) return none;
        if (fenced.session.takeoverRequiredAt !== null && !redelivery) {
          return none;
        }
        // Nor a turn queued before the session stopped taking new ones (a
        // transcript past the limits, or a mirror failure that outranked
        // it): it would run on a session no checkpoint can carry.
        if (
          checkpointReasonHoldsWork(
            storedPendingReason(fenced.session.checkpointPendingReason),
          ) &&
          !redelivery
        ) {
          return none;
        }
        // The scheduler is draining the launch to replace it: the
        // turn this attempt runs is its last. Read under the session lock,
        // which `requestDrain` takes before it looks for an open turn.
        if (!redelivery && (await drainRequested(tx, fenced.attempt))) {
          return none;
        }

        const deliveryStartedAt = turn.deliveryStartedAt ?? now;
        if (!redelivery) {
          await tx
            .update(queueMessages)
            .set({
              claimedBy: fence.attemptId,
              claimToken: crypto.randomUUID(),
              visibleAt: now,
            })
            .where(eq(queueMessages.id, message.id));
          await tx
            .update(turns)
            .set({
              status: "running",
              attemptId: fence.attemptId,
              startedAt: now,
              deliveryStartedAt,
            })
            .where(and(eq(turns.id, turn.id), eq(turns.status, "queued")));
          const [continued] = await tx
            .select({ parkedTurnId: turnContinuations.parkedTurnId })
            .from(turnContinuations)
            .where(eq(turnContinuations.turnId, turn.id));
          if (continued) {
            await settleContinuationInputs(tx, {
              parkedTurnRowId: continued.parkedTurnId,
              at: now,
            });
          }
          expectFenced(
            await tx
              .update(sessions)
              .set({ status: "running", updatedAt: now })
              .where(fencedSession(fence))
              .returning({ id: sessions.id }),
            "session",
          );
          // The turn boundary is on the stream too. A turn just
          // handed over has asked nothing yet, so it reads as running.
          await recordStatus(tx, {
            sessionId: fence.sessionId,
            phase: "running",
            turnRowId: turn.id,
            now,
          });
          expectFenced(
            await tx
              .update(attempts)
              .set({ state: "running" })
              .where(fencedAttempt(fence, at))
              .returning({ id: attempts.id }),
            "attempt",
          );
        }
        return {
          outcome: "ok",
          leaseExpiresAt,
          input: {
            turnId: String(turn.sequence),
            inputId: String(message.id),
            // Turns queued before the follow-up wording became facts still
            // hold the old text; only a message equal to it is rewritten.
            message: followUpFact(turn.message),
            deliveryStartedAt,
            actorId: turn.actorId,
          },
        };
      });
    },

    heartbeatAtomic(input: HeartbeatInput): Promise<HeartbeatResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        // A beat stuck behind another transaction's session row would spend
        // the worker's whole lease budget waiting; failing fast lets it send
        // the next beat while a renewal can still land.
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const reported = ATTEMPT_PHASE_ORDER[input.attemptState] ?? -1;
        const current = ATTEMPT_PHASE_ORDER[fenced.attempt.state] ?? -1;
        // Overlapping heartbeats can commit out of order, and the loser must
        // not shorten a lease the winner already extended, so every clock
        // here only moves forward.
        const updated = await tx
          .update(attempts)
          .set({
            leaseExpiresAt: sql`GREATEST(${attempts.leaseExpiresAt}, ${fromDbNow(input.leaseTtlMs)})`,
            lastHeartbeatAt: sql`GREATEST(${attempts.lastHeartbeatAt}, ${now})`,
            state:
              reported > current ? input.attemptState : fenced.attempt.state,
          })
          .where(fencedAttempt(fence, fenced.at))
          .returning({ leaseExpiresAt: attempts.leaseExpiresAt });
        expectFenced(updated, "attempt");
        const [beat] = updated;
        if (!beat) throw new Error("Fenced attempt write returned no row");
        const persistedAt = input.transcript?.persistedAt ?? null;
        const mirrorError = input.transcript?.mirrorError ?? null;
        // A mirror that has written nothing yet reports nulls on every beat
        // until its first batch lands; there is nothing to record, and an
        // empty SET is an error in drizzle.
        if (persistedAt !== null || mirrorError !== null) {
          // A late heartbeat cannot walk the mirror mark backwards, and an
          // error only sets the reason: clearing is a checkpoint's to do.
          expectFenced(
            await tx
              .update(sessions)
              .set({
                ...(persistedAt === null
                  ? {}
                  : {
                      lastTranscriptPersistedAt: sql`GREATEST(${sessions.lastTranscriptPersistedAt}, ${persistedAt})`,
                    }),
                ...(mirrorError === null
                  ? {}
                  : {
                      checkpointPendingReason: "mirror_error",
                      checkpointPendingAttemptId: fence.attemptId,
                    }),
              })
              .where(fencedSession(fence))
              .returning({ id: sessions.id }),
            "session transcript",
          );
        }
        await tx
          .update(executions)
          .set({
            observedAt: sql`GREATEST(${executions.observedAt}, ${now})`,
            observedState: "running",
          })
          .where(eq(executions.id, fenced.attempt.executionId));
        await tx
          .update(workerCredentials)
          .set({
            expiresAt: sql`GREATEST(${workerCredentials.expiresAt}, ${fromDbNow(input.credentialTtlMs)})`,
          })
          .where(
            and(
              eq(workerCredentials.attemptId, fence.attemptId),
              isNull(workerCredentials.revokedAt),
            ),
          );
        // The legacy orphan reconciler keys on workers by pod_id and judges
        // the deadline written here, never a TTL of its own.
        await tx
          .insert(workers)
          .values({
            podId: fenced.attempt.executionId,
            lastSeen: now,
            leaseExpiresAt: beat.leaseExpiresAt,
          })
          .onConflictDoUpdate({
            target: workers.podId,
            set: {
              lastSeen: sql`GREATEST(${workers.lastSeen}, ${now})`,
              leaseExpiresAt: sql`GREATEST(${workers.leaseExpiresAt}, ${beat.leaseExpiresAt})`,
            },
          });
        return {
          outcome: "ok",
          leaseExpiresAt: beat.leaseExpiresAt,
          leaseRemainingMs: leaseRemainingMs(beat.leaseExpiresAt, fenced.at),
          authRevision: fenced.session.authRevision,
        };
      });
    },

    commitEventsAtomic(input: CommitEventsInput): Promise<CommitEventsResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;

        // One batch must not carry two different events under one sequence:
        // which of them survived would then depend on insert order.
        const batch = new Map<number, WorkerEvent>();
        for (const event of input.events) {
          const twin = batch.get(event.source_sequence);
          if (
            twin &&
            (twin.event !== event.event ||
              twin.occurred_at !== event.occurred_at ||
              payloadHash(twin.data) !== payloadHash(event.data))
          ) {
            return { outcome: "event_conflict" };
          }
          batch.set(event.source_sequence, event);
        }

        let turnRowId: number | null = null;
        let turnStatus: string | null = null;
        if (input.turnId !== null) {
          const sequence = parseTurnSequence(input.turnId);
          // Only the turn this attempt is running: the fence alone would let
          // a live worker write history onto a queued or foreign turn.
          const [turn] = sequence
            ? await tx
                .select({ id: turns.id, status: turns.status })
                .from(turns)
                .where(
                  and(
                    eq(turns.sessionId, fence.sessionId),
                    eq(turns.sequence, sequence),
                    eq(turns.attemptId, fence.attemptId),
                  ),
                )
                .limit(1)
            : [];
          if (!turn) return { outcome: "turn_not_found" };
          turnRowId = turn.id;
          turnStatus = turn.status;
        }

        // Everything is checked before anything is written: a batch that is
        // rejected must leave the stream exactly as it was, which an
        // insert-then-inspect order cannot promise.
        const existing = await tx
          .select({
            id: events.id,
            type: events.type,
            payload: events.payload,
            turnId: events.turnId,
            occurredAt: events.occurredAt,
            sourceSequence: events.sourceSequence,
          })
          .from(events)
          .where(
            and(
              eq(events.sessionId, fence.sessionId),
              eq(events.attemptId, fence.attemptId),
              inArray(events.sourceSequence, [...batch.keys()]),
            ),
          );
        const stored = new Map(
          existing.map((row) => [row.sourceSequence, row]),
        );
        const fresh: WorkerEvent[] = [];
        for (const [sequence, event] of batch) {
          const row = stored.get(sequence);
          if (!row) {
            fresh.push(event);
            continue;
          }
          // A replay of what is already stored is a no-op; anything else
          // would leave the worker holding a cursor for data the stream
          // does not contain.
          if (
            !sameEvent(row, event, turnRowId) &&
            !sameEvent(
              row,
              event,
              turnRowId,
              await streamClock(tx, fence.sessionId, row.id),
            )
          ) {
            return { outcome: "event_conflict" };
          }
        }
        // A finalized turn's history is closed: only exact replays of what it
        // already holds are still answered.
        if (
          fresh.length > 0 &&
          turnStatus !== null &&
          !OPEN_TURN_STATUSES.includes(turnStatus)
        ) {
          return { outcome: "turn_finalized" };
        }
        // Events are published in insertion order, so one may only be written
        // once its predecessor is durable: a hole here would be permanent in
        // the order every subscriber reads.
        fresh.sort((a, b) => a.source_sequence - b.source_sequence);
        const durable = await contiguousThrough(tx, fence);
        for (const [index, event] of fresh.entries()) {
          if (event.source_sequence !== durable + 1 + index) {
            return { outcome: "sequence_gap", acceptedThrough: durable };
          }
        }
        if (fresh.length > 0 && !leaseHeld(fenced.attempt, await dbNow(tx))) {
          return { outcome: "lease_expired" };
        }
        if (fresh.length > 0) {
          let floor = await streamClock(tx, fence.sessionId);
          await tx.insert(events).values(
            fresh.map((event) => {
              floor = notBefore(new Date(event.occurred_at), floor);
              return {
                sessionId: fence.sessionId,
                type: event.event,
                payload: event.data,
                neutral: input.neutral?.(event) ?? null,
                turnId: turnRowId,
                attemptId: fence.attemptId,
                sourceSequence: event.source_sequence,
                occurredAt: floor,
              };
            }),
          );
        }
        const [latest] = await tx
          .select({ id: max(events.id) })
          .from(events)
          .where(
            and(
              eq(events.sessionId, fence.sessionId),
              eq(events.attemptId, fence.attemptId),
            ),
          );
        await tx.execute(
          sql`SELECT pg_notify('session_events', ${fence.sessionId})`,
        );
        return {
          outcome: "ok",
          acceptedThrough: await contiguousThrough(tx, fence),
          cursor: encodeEventCursor(latest?.id ?? 0),
        };
      });
    },

    // Deliberately unfenced: this only reads back what the attempt itself
    // already committed. A retry that arrives after the lease lapsed still
    // has to learn whether its finalize landed — answering LEASE_EXPIRED
    // there turns a settled turn into an unknown outcome. Nothing is written
    // here, and an open turn still goes through the fenced commit below.
    peekFinalizeAtomic(input: FinalizeInput): Promise<PeekFinalizeResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const probe = await probeFinalize(tx, fence, input, false);
        if (probe.state !== "open") return probe.result;
        // Only a settled turn is readable without the fence. An open one
        // belongs to whoever holds the lease, and saying "open" to anyone
        // else would have the gateway verify a checkpoint on their behalf.
        const fenced = await acquireFence(tx, fence);
        // Waiting for that lock is exactly when a competing finalize commits,
        // so the turn is read again before this one is called open.
        const settled = await probeFinalize(tx, fence, input, false);
        if (settled.state !== "open") return settled.result;
        return fenced.outcome === "ok" ? { outcome: "open" } : fenced;
      });
    },

    finalizeAtomic(input: FinalizeInput): Promise<FinalizeResult> {
      const { fence, now } = input;
      const controlResults: ControlResultEvent[] = [];
      const transaction = db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;

        const probe = await probeFinalize(tx, fence, input, true);
        if (probe.state !== "open") return probe.result;
        const { turn, terminalHash } = probe;
        // api.md: `interrupted` is only ever recorded together with the
        // checkpoint that makes it consistent; without one the worker has to
        // say outcome_unknown. A replay above is still answered as stored.
        if (input.terminal.status === "interrupted" && !input.checkpoint) {
          return {
            outcome: "checkpoint_rejected",
            reason: "an interrupted turn must commit a checkpoint with it",
          };
        }
        if (!leaseHeld(fenced.attempt, await dbNow(tx))) {
          return { outcome: "lease_expired" };
        }
        // Appends take the same session lock, so this read cannot race one:
        // either the tail landed before this transaction or it arrives after
        // a refusal and the worker finalizes again.
        const durable = await contiguousThrough(tx, fence);
        if (durable !== input.finalSourceSequence) {
          return { outcome: "events_incomplete", acceptedThrough: durable };
        }

        // A session the platform cannot checkpoint must not report a turn
        // as durably finished: the SDK's success is not enough on its own.
        // The other terminals record what happened and are never held back.
        const pendingReason = storedPendingReason(
          fenced.session.checkpointPendingReason,
        );
        if (
          input.terminal.status === "completed" &&
          !input.checkpoint &&
          checkpointReasonBlocks(pendingReason)
        ) {
          return { outcome: "checkpoint_required", reason: pendingReason };
        }

        let checkpointRevision: number | null = null;
        if (input.checkpoint) {
          const advanced = await advanceCheckpointPointer(tx, {
            fence,
            session: fenced.session,
            checkpoint: input.checkpoint,
            turnRowId: turn.id,
            now,
            versionsHeld: input.checkpointVersionsHeld === true,
            ...(input.checkpointTranscriptBytes === undefined
              ? {}
              : { transcriptBytes: input.checkpointTranscriptBytes }),
            ...(input.checkpointOutputs === undefined
              ? {}
              : { outputs: input.checkpointOutputs }),
            ...(input.checkpointOutputsDigest === undefined
              ? {}
              : { outputsDigest: input.checkpointOutputsDigest }),
            ...(input.checkpointRuntime === undefined
              ? {}
              : { runtime: input.checkpointRuntime }),
          });
          if (advanced.outcome === "not_next") {
            // An interrupt has no second capture to wait for: its checkpoint
            // cannot commit, so the worker records the turn unknown instead.
            if (input.terminal.status === "interrupted") {
              return {
                outcome: "checkpoint_rejected",
                reason: `revision ${input.checkpoint.revision} is not next after ${advanced.currentRevision ?? "none"}`,
              };
            }
            return {
              outcome: "checkpoint_conflict",
              currentRevision: advanced.currentRevision,
            };
          }
          checkpointRevision = advanced.revision;
        }

        const ended = budgetEnded(
          input.terminal,
          fenced.session,
          budgetOf(input),
        );
        const unknownOutcome = input.terminal.status === "outcome_unknown";
        const [terminal] = await tx
          .update(turns)
          .set({
            status: input.terminal.status,
            endedAt: now,
            terminalReason: ended.reason,
            outcomeUnknown: unknownOutcome,
            resultJson: {
              finalize_key: input.finalizeKey,
              finalize_hash: terminalHash,
              result: ended.result,
              usage: input.terminal.usage,
              // Only when reported, so a turn that said nothing reads as
              // before and not as a cost of zero.
              ...(input.terminal.cost_usd == null
                ? {}
                : { cost_usd: input.terminal.cost_usd }),
            },
          })
          .where(
            and(
              eq(turns.id, turn.id),
              eq(turns.attemptId, fence.attemptId),
              inArray(turns.status, OPEN_TURN_STATUSES),
            ),
          )
          .returning({ id: turns.id, sequence: turns.sequence });
        expectFenced([terminal].filter(Boolean), "turn");
        if (terminal) {
          controlResults.push(
            ...(await settleTurnInterrupts(tx, {
              sessionId: fence.sessionId,
              turnRowId: terminal.id,
              turnSequence: terminal.sequence,
              terminal: input.terminal.status,
              terminalReason: ended.reason,
              at: now,
            })),
          );
        }

        const receiptStatus = RECEIPT_STATUS_BY_TERMINAL[input.terminal.status];
        const succeeded = receiptStatus === "succeeded";
        // `result` stays the acceptance response (receiptSchema.result); the
        // turn's own result is read through target_ref.turn_id.
        await tx
          .update(receipts)
          .set({
            status: receiptStatus,
            error: succeeded
              ? null
              : {
                  code: unknownOutcome
                    ? "RECOVERY_REQUIRED"
                    : input.terminal.status === "failed" &&
                        ended.reason === TURN_BUDGET_EXCEEDED_REASON
                      ? "BUDGET_EXCEEDED"
                      : input.terminal.status === "failed" &&
                          ended.reason === TURN_WORKSPACE_QUOTA_EXCEEDED_REASON
                        ? "WORKSPACE_QUOTA_EXCEEDED"
                        : "INTERNAL_ERROR",
                  message: ended.reason ?? ended.status,
                },
            updatedAt: now,
          })
          .where(
            and(
              inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
              eq(receipts.status, "accepted"),
              sql`${receipts.targetRef}->>'session_id' = ${fence.sessionId}`,
              sql`${receipts.targetRef}->>'turn_id' = ${input.turnId}`,
            ),
          );
        // An unknown outcome keeps its queue head: the input stays blocked
        // until an operator recovery decision, never redelivered.
        if (!unknownOutcome) {
          await tx
            .delete(queueMessages)
            .where(
              and(
                eq(queueMessages.sessionId, fence.sessionId),
                eq(queueMessages.turnId, turn.id),
              ),
            );
        }
        // A turn interrupted to park leaves its requests answerable and the
        // session idle on them; the answer resumes it from this checkpoint.
        const parked =
          terminal !== undefined &&
          input.terminal.status === "interrupted" &&
          input.terminal.reason === TURN_INPUT_WAIT_PARKED_REASON
            ? await parkTurnRequests(tx, {
                sessionId: fence.sessionId,
                turnRowId: terminal.id,
                now,
              })
            : [];
        await recordInputWaitStage(tx, {
          sessionId: fence.sessionId,
          stage: "parked",
          requestIds: parked,
          turnRowId: turn.id,
          now,
        });
        const settled =
          parked.length > 0
            ? "idle"
            : SESSION_STATUS_BY_TERMINAL[input.terminal.status];
        expectFenced(
          await tx
            .update(sessions)
            .set({
              status: settled,
              lastTurnAt: now,
              updatedAt: now,
              ...(unknownOutcome
                ? { admissionState: "recovery_required" as const }
                : {}),
            })
            .where(fencedSession(fence))
            .returning({ id: sessions.id }),
          "session",
        );
        // Intents the turn left deferred are pinned to the checkpoint this
        // finalize just advanced to, or cancelled when the turn left none.
        // A parked turn keeps them: the answer starts a turn that takes
        // them over (continueParkedTurn).
        if (terminal !== undefined && parked.length === 0) {
          await settleTurnPushIntents(tx, {
            turnRowId: terminal.id,
            completedRevision:
              input.terminal.status === "completed" ? checkpointRevision : null,
          });
        }
        // A parked turn resumes later and may still open the pull request;
        // an unknown outcome puts the session in recovery, which keeps holds.
        if (terminal !== undefined && parked.length === 0 && !unknownOutcome) {
          await queuePushFollowUps(tx, { session: fenced.session });
        }
        // The Nth turn's end is when an every_n_turns judgment is due.
        await queueAchievementJudgment(tx, fence.sessionId, {
          trigger: "turns",
          turn: turn.sequence,
        });
        // After every event of the turn, which the check above found
        // durable: the stream ends the turn where the session now reads
        // . Only an open turn holds a question, so the stored
        // status is the public one.
        const recovering =
          unknownOutcome &&
          fenced.session.admissionState !== "recovery_required";
        if (settled !== fenced.session.status || recovering) {
          await recordStatus(tx, {
            sessionId: fence.sessionId,
            phase:
              parked.length > 0
                ? publicStatus(
                    settled,
                    await awaitingInputAt(tx, fence.sessionId, await dbNow(tx)),
                  )
                : settled,
            ...(recovering
              ? { extra: { admission_state: "recovery_required" } }
              : {}),
            turnRowId: turn.id,
            now,
          });
        }
        const drain = drainOf(fenced.session.admissionState);
        if (unknownOutcome && drain !== undefined) {
          // recovery_required takes the session out of its drain, so the
          // pause or close it was draining for can no longer complete.
          await tx
            .update(receipts)
            .set({
              status: "failed",
              error: {
                code: "RECOVERY_REQUIRED",
                message: `turn ${input.turnId} ended with an unknown outcome while the ${drain.operation} was draining`,
              },
              updatedAt: now,
            })
            .where(openDrainReceipt(fence.sessionId));
        }
        return {
          outcome: "finalized",
          result: {
            turnId: input.turnId,
            status: input.terminal.status,
            checkpointRevision,
          },
        };
      }) as Promise<FinalizeResult>;
      return transaction.then((result) => {
        for (const controlResult of controlResults) {
          logControlResult(options.logger, controlResult);
        }
        return result;
      });
    },

    checkpointStateAtomic(
      input: CheckpointStateInput,
    ): Promise<CheckpointStateResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        let pendingReason = storedPendingReason(
          fenced.session.checkpointPendingReason,
        );
        // A blocking reason outranks an advisory one and stays, attempt
        // included: the attempt decides who may clear it.
        if (
          input.pendingReason !== undefined &&
          nextPendingReason(pendingReason, input.pendingReason) ===
            input.pendingReason
        ) {
          // Announced when it is first recorded, not on every turn that
          // reports it again.
          if (
            pendingReason !== input.pendingReason &&
            (input.pendingReason === "transcript_too_large" ||
              input.pendingReason === "transcript_part_too_large")
          ) {
            await recordEvent(tx, {
              sessionId: fence.sessionId,
              type: "system",
              payload: transcriptLimitReachedEvent(input.pendingReason),
              turnRowId: null,
              attemptId: fence.attemptId,
              now: input.now,
            });
          }
          expectFenced(
            await tx
              .update(sessions)
              .set({
                checkpointPendingReason: input.pendingReason,
                checkpointPendingAttemptId: fence.attemptId,
                updatedAt: input.now,
              })
              .where(fencedSession(fence))
              .returning({ id: sessions.id }),
            "session pending reason",
          );
          pendingReason = input.pendingReason;
        }
        return {
          outcome: "ok",
          pointer: await readCheckpointPointer(tx, fenced.session),
          restorable: hasRestorePoint({
            ...fenced.session,
            checkpointPendingReason: pendingReason,
          }),
          pendingReason,
        };
      });
    },

    extensionsStateAtomic(
      input: ExtensionsStateInput,
    ): Promise<ExtensionsStateResult> {
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, input.fence);
        if (fenced.outcome !== "ok") return fenced;
        return {
          outcome: "ok",
          ownerScope: fenced.session.ownerId,
          extensions: pinnedExtensionsOf(fenced.session),
        };
      });
    },

    /**
     * The fallback is a fact about the session, not about one response: it
     * goes on the row, where pause and recovery read what the session's
     * state is actually based on, and on the event stream, where the owner
     * learns their session resumed from an older generation. Both happen
     * before the worker is given the plan, under the same fence and against
     * the same pointer the plan was judged on.
     *
     * Every served plan pins its attempt to the base it names, the pointer
     * included, so asking again for the same base is a retry and being
     * handed a different one is refused: the object store can change
     * between two requests, and a worker holding two plans for one pointer
     * may restore either while the row describes only one.
     */
    recordRestoreBaseAtomic(
      input: RestoreBaseInput,
    ): Promise<RestoreBaseResult> {
      const { fence } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const { session } = fenced;
        if (session.checkpointRevision !== input.pointerRevision) {
          return {
            outcome: "pointer_moved",
            currentRevision: session.checkpointRevision,
          };
        }
        const base = input.fallback?.revision ?? input.pointerRevision;
        // A pointer advance clears the attempt column, so a match here
        // means this attempt was served a plan on this very pointer.
        if (session.checkpointRestoreAttemptId === fence.attemptId) {
          const recorded =
            session.checkpointFallbackRevision ?? input.pointerRevision;
          return recorded === base
            ? { outcome: "ok" }
            : { outcome: "base_changed", recordedRevision: recorded };
        }
        expectFenced(
          await tx
            .update(sessions)
            .set({
              checkpointFallbackRevision: input.fallback?.revision ?? null,
              checkpointRestoreAttemptId: fence.attemptId,
              updatedAt: input.now,
            })
            .where(fencedSession(fence))
            .returning({ id: sessions.id }),
          "session restore base",
        );
        if (input.fallback === null) return { outcome: "ok" };
        // The attempt goes in the payload, not the event's attempt column:
        // that column numbers the worker's own sourced stream, and this row
        // is the server's.
        await recordEvent(tx, {
          sessionId: fence.sessionId,
          type: "system",
          payload: {
            type: "system",
            subtype: CHECKPOINT_RESTORE_FALLBACK,
            attempt_id: fence.attemptId,
            pointer_revision: input.pointerRevision,
            restored_revision: base,
            skipped: input.fallback.skipped.map((skip) => ({
              revision: skip.revision,
              reason: skip.reason,
            })),
          },
          turnRowId: null,
          now: input.now,
        });
        return { outcome: "ok" };
      });
    },

    releaseAtomic(input: ReleaseInput): Promise<ReleaseResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        // An expired lease on the current epoch may still release: the
        // worker is giving the binding up, which only advances the fence.
        // A superseded epoch cannot; that binding is not its to release.
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome === "stale_epoch") return { released: false };
        const pause = input.pauseControlId;
        if (pause !== undefined) {
          // Committing a pause is a decision taken under the lease, not the
          // giving up of one; an attempt refused here keeps both.
          if (fenced.outcome !== "ok") {
            return { released: false, refused: "lease_expired" };
          }
          // A close drains through the same control, so the receipt it
          // names may be either.
          const [open] =
            drainOf(fenced.session.admissionState) !== undefined
              ? await tx
                  .select({ id: receipts.id })
                  .from(receipts)
                  .where(openDrainReceipt(fence.sessionId))
                  .limit(1)
              : [];
          if (open?.id !== pause) {
            return { released: false, refused: "pause_stale" };
          }
          const blocker = await drainBlocker(tx, fenced.session);
          if (blocker !== null) {
            return {
              released: false,
              refused: "pause_blocked",
              reason: blocker,
            };
          }
          if (!leaseHeld(fenced.attempt, await dbNow(tx))) {
            return { released: false, refused: "lease_expired" };
          }
        }
        const [attempt] = await tx
          .update(attempts)
          .set({
            state: "exited",
            endedAt: now,
            endReason: boundedReason(input.reason),
          })
          .where(ownedAttempt(fence))
          .returning({ id: attempts.id, executionId: attempts.executionId });
        if (!attempt) return { released: false };
        await revokeCredentials(tx, fence.attemptId, now);
        // The epoch moves on so nothing from this attempt lands later, but
        // pod_id/execution_id stay: the session is not claimable until the
        // backend confirms the execution is gone (confirmExecutionGone).
        expectFenced(
          await tx
            .update(sessions)
            .set({
              leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
              // A drain was asked of it, so a startup it cut short is not
              // counted; the failures before it still are.
              ...(input.drained
                ? {
                    restoreAttemptId: sql`NULLIF(${sessions.restoreAttemptId}, ${fence.attemptId})`,
                  }
                : {}),
              updatedAt: now,
            })
            .where(fencedSession(fence))
            .returning({ id: sessions.id }),
          "session",
        );
        await tx.delete(workers).where(eq(workers.podId, attempt.executionId));
        if (pause !== undefined) {
          // The pause's stop intent, after the epoch discard above: the
          // scheduler removes the execution, and confirmExecutionGone settles
          // the session paused once it is seen gone.
          await tx
            .update(executions)
            .set({ desiredState: "terminated" })
            .where(eq(executions.id, attempt.executionId));
        }
        return { released: true };
      });
    },

    readyAtomic(input: ReadyInput): Promise<ReadyResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const { session } = fenced;
        // The attempt restored the base its claim and plan handed it, so the
        // restores that failed before it no longer count.
        if (
          session.restoreAttemptId === fence.attemptId &&
          input.restoredRevision !== null &&
          input.restoredRevision === restoreBaseRevision(session)
        ) {
          await tx
            .update(sessions)
            .set(RESTORE_FAILURES_CLEARED)
            .where(eq(sessions.id, session.id));
        }
        // Only a resume from `paused` waits on this report; a fresh or a
        // stopped-resume claim is already active.
        if (session.admissionState !== "resuming") {
          return { outcome: "ok", activated: false };
        }
        // A draining attempt takes no input, so it cannot carry the
        // session on; its exit settles the resume instead.
        if (fenced.attempt.state === "draining") {
          return { outcome: "ok", activated: false };
        }
        if (!leaseHeld(fenced.attempt, await dbNow(tx))) {
          return { outcome: "lease_expired" };
        }
        if (
          !hasRestorePoint(session) ||
          session.checkpointRevision !== input.restoredRevision
        ) {
          await failResume(tx, {
            sessionId: session.id,
            error: {
              code: "CHECKPOINT_UNAVAILABLE",
              message: `the worker restored checkpoint revision ${input.restoredRevision ?? "none"}, but the session was resumed onto ${session.checkpointRevision ?? "none"}${session.checkpointPendingReason === null ? "" : ` (${session.checkpointPendingReason})`}`,
            },
            now,
          });
          return { outcome: "restore_mismatch" };
        }
        await completeResume(tx, session, now);
        return { outcome: "ok", activated: true };
      });
    },

    failResumeAtomic(input: FailResumeInput): Promise<FailResumeResult> {
      const { fence, now } = input;
      return db.transaction(async (tx) => {
        const fenced = await acquireFence(tx, fence);
        if (fenced.outcome !== "ok") return fenced;
        const { session } = fenced;
        // The verdict was reached outside this transaction; it holds only
        // while the session is still resuming onto the pointer it judged.
        if (
          session.admissionState !== "resuming" ||
          session.checkpointRevision !== input.pointerRevision
        ) {
          return { outcome: "ok", failed: false };
        }
        await failResume(tx, {
          sessionId: session.id,
          error: input.error,
          now,
        });
        return { outcome: "ok", failed: true };
      });
    },

    async confirmExecutionGoneAtomic(
      input: ConfirmExecutionGoneInput,
    ): Promise<ConfirmExecutionGoneResult> {
      const { executionId, incarnation, now } = input;
      const controlResults: ControlResultEvent[] = [];
      const transaction = db.transaction(async (tx) => {
        const [launch] = await tx
          .select({
            claimedAttemptId: workerLaunches.claimedAttemptId,
            nonceHash: workerLaunches.nonceHash,
            replacementReason: workerLaunches.replacementReason,
          })
          .from(workerLaunches)
          .where(eq(workerLaunches.executionId, executionId))
          .limit(1)
          .for("update");
        if (
          incarnation !== undefined &&
          (!launch ||
            (launch.nonceHash
              ? launchNonceFingerprint(launch.nonceHash)
              : null) !== incarnation.nonceFingerprint ||
            (incarnation.claimed !== undefined &&
              (launch.claimedAttemptId !== null) !== incarnation.claimed))
        ) {
          // Judged under the row lock a create's credential issue and a
          // claim both take, so the caller's resource either is still the
          // launch's incarnation here or has been succeeded by one it never
          // saw — whose binding is not the caller's to end.
          return {
            sessionReleased: false,
            slotReleased: false,
            superseded: true,
          };
        }
        if (
          launch &&
          launch.replacementReason !== null &&
          launch.claimedAttemptId === null
        ) {
          // The scheduler has committed to rebuilding this launch from its
          // intent and may be between the teardown and the create right
          // now. Its resource being gone is that plan in progress, not an
          // exit: releasing here would hand the session a new launch under
          // a new generation, which is exactly what the record exists to
          // prevent. A claimed launch is never rebuilt, so it stays
          // confirmable whatever the column says; so does one asked to go,
          // which is killed rather than rebuilt — a replacement recorded
          // after the terminate would otherwise hold its slot forever.
          const [execution] = await tx
            .select({ desiredState: executions.desiredState })
            .from(executions)
            .where(eq(executions.id, executionId))
            .limit(1);
          if (execution?.desiredState !== "terminated") {
            return {
              deferred: true,
              sessionReleased: false,
              slotReleased: false,
            };
          }
        }
        // One slot returns per launch, however many times the exit is seen.
        const slot = await tx
          .update(workerLaunches)
          .set({ slotReleasedAt: now })
          .where(
            and(
              eq(workerLaunches.executionId, executionId),
              isNull(workerLaunches.slotReleasedAt),
            ),
          )
          .returning({ executionId: workerLaunches.executionId });
        // Every path takes its locks in the same order — launch, session,
        // attempt, execution — so a heartbeat and an exit observation that
        // overlap queue up instead of deadlocking each other.
        const [found] = await tx
          .select()
          .from(sessions)
          .where(eq(sessions.executionId, executionId))
          .limit(1)
          .for("update");
        // Before anything below ends the attempt and moves the epoch it
        // judges by; re-read after, since it may have moved the pointer.
        const crashParked =
          found !== undefined &&
          (await parkOnApprovalCheckpoint(tx, {
            session: found,
            executionId,
            now,
          }));
        const [session] = crashParked
          ? await tx
              .select()
              .from(sessions)
              .where(eq(sessions.id, found.id))
              .limit(1)
          : [found];
        const [observed] = await tx
          .update(executions)
          .set({
            observedState: "terminated",
            desiredState: "terminated",
            observedAt: sql`GREATEST(${executions.observedAt}, ${now})`,
          })
          .where(eq(executions.id, executionId))
          .returning({ observedAt: executions.observedAt });
        await tx.delete(workers).where(eq(workers.podId, executionId));

        if (!session) {
          return { sessionReleased: false, slotReleased: slot.length === 1 };
        }
        const open = await tx
          .update(attempts)
          .set({
            state: "lost",
            endedAt: now,
            endReason: input.endReason ?? "execution_gone",
          })
          .where(
            and(
              eq(attempts.executionId, executionId),
              notInArray(attempts.state, ENDED_ATTEMPT_STATES),
            ),
          )
          .returning({ id: attempts.id });
        for (const attempt of open) {
          await revokeCredentials(tx, attempt.id, now);
        }

        // A turn that was handed to the execution and never finalized has no
        // knowable result now that the execution is gone. Saying nothing
        // would leave it looking like work in progress, so it is recorded as
        // unknown here and its input stays on the queue until an operator
        // decides. The judgement lives in the same transaction
        // that removes the binding.
        const unresolved = await tx
          .update(turns)
          .set({
            status: "outcome_unknown",
            outcomeUnknown: true,
            endedAt: now,
            terminalReason: "execution_gone",
          })
          .where(
            and(
              eq(turns.sessionId, session.id),
              inArray(turns.status, OPEN_TURN_STATUSES),
            ),
          )
          .returning({ id: turns.id, sequence: turns.sequence });
        for (const turn of unresolved) {
          controlResults.push(
            ...(await settleTurnInterrupts(tx, {
              sessionId: session.id,
              turnRowId: turn.id,
              turnSequence: turn.sequence,
              terminal: "outcome_unknown",
              terminalReason: "execution_gone",
              at: now,
            })),
          );
        }
        // Requests the gone worker raised can never be answered by it; left
        // open they would keep the session reporting pending input forever.
        // A parked one was never the worker's to answer: it stays open.
        const closedRequests = await closeWorkerRequests(tx, session.id, now);
        await abandonUndeliveredAnswers(tx, session.id, now);
        await abandonUndeliveredParked(tx, session.id, now);
        await recordLostInputWait(tx, {
          sessionId: session.id,
          closed: closedRequests,
          now,
        });
        for (const turn of unresolved) {
          // `result` stays the acceptance response (receiptSchema.result).
          await tx
            .update(receipts)
            .set({
              status: "unknown",
              error: {
                code: "RECOVERY_REQUIRED",
                message: "execution ended before the turn was finalized",
              },
              updatedAt: now,
            })
            .where(
              and(
                inArray(receipts.operation, INPUT_RECEIPT_OPERATIONS),
                eq(receipts.status, "accepted"),
                sql`${receipts.targetRef}->>'session_id' = ${session.id}`,
                sql`${receipts.targetRef}->>'turn_id' = ${String(turn.sequence)}`,
              ),
            );
        }

        // A session that asked for this kill (terminate) lands in
        // `stopped`, unless a turn was left unresolved, in which case the
        // recovery decision takes precedence just as for any other exit. A
        // session an operator already closed stays closed: the
        // unknown turn is recorded above, but nothing reopens the session.
        const stopping = session.admissionState === "stopping";
        const closed = session.admissionState === "closed";
        // A pause completes only here, on the observed absence, and only onto
        // a checkpoint that covers every turn that ran. One that cannot has
        // lost the only attempt that could still have committed it
        // the pause fails and the session is active again, as after any lost
        // worker, so a new one restores the last trusted checkpoint for the
        // queued input — unless that checkpoint leaves a turn behind, which
        // the context check below hands to an operator. A blocking pending reason (a dropped mirror batch, or
        // one this build does not know) cannot be carried on from, so that
        // one goes to an operator instead, as a cancel would.
        // A close drains and settles the same way, into closed.
        const drain = drainOf(session.admissionState);
        const pauseBlockedBy =
          drain !== undefined && unresolved.length === 0
            ? await drainBlocker(tx, session)
            : undefined;
        const drained = pauseBlockedBy === null;
        const paused = drained && drain?.settlesInto === "paused";
        const closedNow = drained && drain?.settlesInto === "closed";
        const pauseFailed =
          pauseBlockedBy !== undefined && pauseBlockedBy !== null;
        const pauseFailedInto = storedPendingReasonHoldsWork(
          session.checkpointPendingReason,
        )
          ? "recovery_required"
          : "active";
        // A worker that claimed a resuming session and ended before it
        // reported ready did not prove the checkpoint restores, nor that it
        // cannot: the session stays resuming and is signalled again until
        // RESUME_LAUNCH_LIMIT claimed launches have died that way, then an
        // operator decides. A launch that never claimed spends nothing.
        const resumeFailed =
          session.admissionState === "resuming" &&
          launch?.claimedAttemptId !== null &&
          launch?.claimedAttemptId !== undefined &&
          (await resumeLaunchesSpent(tx, session.id)) >= RESUME_LAUNCH_LIMIT;
        // A session left taking work would hand its next input to a worker
        // that cannot restore the turns it ran. Judged here, where
        // the loss becomes certain, so it shows before anyone sends another
        // message; the claim gate stays the one that cannot be bypassed. A
        // failed pause lands here too: the pointer it could not advance is
        // exactly the one that leaves the last turn uncovered.
        const activeNow =
          session.admissionState === "active" ||
          (pauseFailed && pauseFailedInto === "active");
        const coverage =
          !closed && unresolved.length === 0 && activeNow
            ? await contextCoverage(tx, session)
            : null;
        const contextLost = coverage !== null && contextGap(session, coverage);
        // The worker claimed and ended before it was ready for input: its
        // restore never reported ready, or it never asked for input
        // . Without counting it the session goes straight back in
        // line and the next worker fails the same way, one generation after
        // another. A resume counts its own launches; a pause, terminate,
        // close or revocation has taken the session out of `active`.
        const failedStartup =
          session.admissionState === "active" &&
          unresolved.length === 0 &&
          !contextLost &&
          launch?.claimedAttemptId != null &&
          session.restoreAttemptId === launch.claimedAttemptId
            ? launch.claimedAttemptId
            : null;
        await tx
          .update(sessions)
          .set({
            podId: null,
            executionId: null,
            leaseEpoch: sql`${sessions.leaseEpoch} + 1`,
            restoreAttemptId: null,
            updatedAt: now,
            ...(closed
              ? {}
              : unresolved.length > 0
                ? {
                    status: "failed" as const,
                    admissionState: "recovery_required" as const,
                  }
                : stopping
                  ? {
                      status: "stopped" as const,
                      admissionState: "stopped" as const,
                    }
                  : paused
                    ? { admissionState: "paused" as const }
                    : closedNow
                      ? {
                          status: "stopped" as const,
                          admissionState: "closed" as const,
                        }
                      : pauseFailed
                        ? pauseFailedInto === "active"
                          ? { admissionState: "active" as const }
                          : {
                              status: "failed" as const,
                              admissionState: "recovery_required" as const,
                            }
                        : {}),
          })
          .where(eq(sessions.id, session.id));
        // The run ended with nothing left unknown: idle between turns,
        // paused or closed. A pause or close of a session with no run has
        // nothing running to stop, and its last run already queued this.
        if (
          unresolved.length === 0 &&
          !stopping &&
          (paused ||
            closedNow ||
            closed ||
            (session.admissionState === "active" && session.status === "idle"))
        ) {
          await queueAchievementJudgment(tx, session.id, { trigger: "idle" });
        }
        const startupOutcome =
          failedStartup === null
            ? null
            : await recordStartupFailure(tx, {
                session,
                attemptId: failedStartup,
                now,
              });
        if (resumeFailed && unresolved.length === 0) {
          await failResume(tx, {
            sessionId: session.id,
            error: {
              code: "RECOVERY_REQUIRED",
              message: `${RESUME_LAUNCH_LIMIT} executions restoring the checkpoint ended before any reported ready`,
            },
            now,
          });
        }
        // Stamped no earlier than the observation it rests on.
        const observedAt =
          observed?.observedAt && observed.observedAt > now
            ? observed.observedAt
            : now;
        if (paused) {
          await tx
            .update(receipts)
            .set({
              status: "succeeded",
              error: null,
              result: await pauseReceiptResult(tx, session),
              updatedAt: observedAt,
            })
            .where(openPauseReceipt(session.id));
        } else if (pauseFailed) {
          await tx
            .update(receipts)
            .set({
              status: "failed",
              error: {
                code:
                  pauseFailedInto === "active"
                    ? "CHECKPOINT_UNAVAILABLE"
                    : "RECOVERY_REQUIRED",
                message: `the execution ended before the ${drain?.operation} could commit (${pauseBlockedBy})`,
              },
              updatedAt: observedAt,
            })
            .where(openDrainReceipt(session.id));
        }
        // Every admission this exit settles is a status change the event
        // stream has to carry, or a client following it stays at stopping,
        // pausing or wherever the unknown turn left it. Written in
        // the transaction that settles the kill and pause receipts, so the
        // stream never reports stopped under an open terminate.
        const settledInto = closed
          ? null
          : unresolved.length > 0
            ? "recovery_required"
            : stopping
              ? "stopped"
              : drained
                ? (drain?.settlesInto ?? null)
                : pauseFailed
                  ? pauseFailedInto
                  : null;
        if (settledInto !== null) {
          await recordStatus(tx, {
            sessionId: session.id,
            phase:
              settledInto === "recovery_required"
                ? "failed"
                : settledInto === "stopped" || settledInto === "closed"
                  ? "stopped"
                  : // A park settles paused with its requests still open.
                    publicStatus(
                      session.status,
                      await awaitingInputAt(tx, session.id, await dbNow(tx)),
                    ),
            extra: {
              admission_state: settledInto,
              ...(pauseFailed
                ? {
                    [drain?.operation === "close"
                      ? "close_failed"
                      : "pause_failed"]: pauseBlockedBy,
                  }
                : {}),
            },
            turnRowId: null,
            now: observedAt,
          });
        }
        // Answers that came while the park was still draining could not
        // carry it on then; with the asker gone, the session can.
        if (!closed && !closedNow && unresolved.length === 0) {
          const [settled] = await tx
            .select()
            .from(sessions)
            .where(eq(sessions.id, session.id))
            .limit(1);
          if (settled) {
            await closeParkedGroup(tx, settled, {
              by: "execution_gone",
              at: observedAt,
            });
          }
        }
        if (closedNow) {
          const [open] = await tx
            .select({ id: receipts.id, acceptedAt: receipts.createdAt })
            .from(receipts)
            .where(openDrainReceipt(session.id))
            .limit(1);
          if (open) {
            await tx
              .update(receipts)
              .set({
                status: "succeeded",
                error: null,
                result: await finishClose(tx, session, {
                  receiptId: open.id,
                  now: observedAt,
                }),
                updatedAt: observedAt,
              })
              .where(eq(receipts.id, open.id));
            controlResults.push({
              acceptedAt: open.acceptedAt,
              controlId: open.id,
              effectiveAt: observedAt,
              operation: "close",
              outcome: "succeeded",
              reasonCode: "drained",
              sessionId: session.id,
            });
          }
        }
        // A close with nothing to drain closed the session at once and
        // waited only on this absence.
        if (closed) {
          const settledCloses = await tx
            .update(receipts)
            .set({ status: "succeeded", updatedAt: observedAt })
            .where(
              and(
                eq(receipts.operation, CLOSE),
                eq(receipts.status, "accepted"),
                sql`${receipts.targetRef}->>'session_id' = ${session.id}`,
              ),
            )
            .returning({ id: receipts.id, acceptedAt: receipts.createdAt });
          for (const settled of settledCloses) {
            controlResults.push({
              acceptedAt: settled.acceptedAt,
              controlId: settled.id,
              effectiveAt: observedAt,
              operation: "close",
              outcome: "succeeded",
              reasonCode: "execution_gone",
              sessionId: session.id,
            });
          }
        }
        // After the pause's own outcome, so the stream ends on where the
        // session actually is.
        if (contextLost) {
          await raiseContextGap(tx, {
            session,
            coverage,
            detectedAt: "execution_gone",
            now: observedAt,
          });
        }
        if (drain !== undefined && unresolved.length > 0) {
          await tx
            .update(receipts)
            .set({
              status: "failed",
              error: {
                code: "RECOVERY_REQUIRED",
                message: `execution ended before the turn the ${drain.operation} was draining was finalized`,
              },
              updatedAt: observedAt,
            })
            .where(openDrainReceipt(session.id));
        }
        // The terminate receipt, and an execution revocation's
        // succeeds only here, on the observed absence;
        // one that already went `unknown` past its deadline is upgraded. The
        // turn it names is the earliest still unknown, whether it became so
        // just now or in an earlier exit the session is still recovering from.
        const settledKills = await tx
          .update(receipts)
          .set({
            status: "succeeded",
            error: null,
            result: terminateReceiptResult({
              checkpointRevision: session.checkpointRevision,
              unconfirmedTurnId: await earliestUnknownTurn(tx, session.id),
            }),
            updatedAt: now,
          })
          .where(
            and(
              inArray(receipts.operation, KILL_RECEIPT_OPERATIONS),
              inArray(receipts.status, ["accepted", "unknown"]),
              sql`${receipts.targetRef}->>'session_id' = ${session.id}`,
            ),
          )
          .returning({
            acceptedAt: receipts.createdAt,
            controlId: receipts.id,
            operation: receipts.operation,
          });
        for (const settled of settledKills) {
          if (settled.operation !== "terminate") continue;
          controlResults.push({
            acceptedAt: settled.acceptedAt,
            controlId: settled.controlId,
            effectiveAt: now,
            operation: "terminate",
            outcome: "succeeded",
            reasonCode: "execution_gone",
            sessionId: session.id,
          });
        }

        // Re-signal only when nothing is left unresolved: an unknown turn
        // must not be re-run by the next claim.
        const [queuedRow] = await tx
          .select({ queued: count() })
          .from(turns)
          .where(
            and(eq(turns.sessionId, session.id), eq(turns.status, "queued")),
          );
        const queued = queuedRow?.queued ?? 0;
        if (
          unresolved.length === 0 &&
          ((queued > 0 &&
            activeNow &&
            !contextLost &&
            startupOutcome !== "recovery_required") ||
            (session.admissionState === "resuming" && !resumeFailed))
        ) {
          await tx
            .insert(unassignedSessions)
            .values({
              sessionId: session.id,
              signaledAt: now,
              partition: session.partition,
            })
            .onConflictDoNothing({ target: unassignedSessions.sessionId });
        }
        return { sessionReleased: true, slotReleased: slot.length === 1 };
      }) as Promise<ConfirmExecutionGoneResult>;
      return transaction.then((result) => {
        for (const controlResult of controlResults) {
          logControlResult(options.logger, controlResult);
        }
        return result;
      });
    },
  };
}
