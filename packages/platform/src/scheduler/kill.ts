import type { ExecutionIncarnation } from "../ports/worker-unit-of-work.ts";
import {
  fieldsOf,
  messageOf,
  type PassContext,
  refOf,
} from "./pass-context.ts";
import type {
  ExecutionRef,
  TerminateExecutionResult,
} from "./ports/execution-backend.ts";
import type { ActiveExecution } from "./ports/scheduler-store.ts";

// The snapshot is checked first, then the row: a terminate that committed
// after listActiveExecutions still gets its kill this pass.
export async function killRequested(
  ctx: PassContext,
  execution: ActiveExecution,
): Promise<boolean> {
  if (execution.desiredState === "terminated") return true;
  return (await ctx.store.desiredStateOf(refOf(execution))) === "terminated";
}

/**
 * Hands the launch's slot and session back for a resource seen gone. False
 * when the launch has moved on to an incarnation this pass never saw —
 * another pass rebuilt it, and a worker may already be bound to the
 * rebuild — or has a replacement pending since the rows were read; nothing
 * changed and the row is left to a pass that sees what it runs now.
 */
export async function confirmGone(
  ctx: PassContext,
  execution: ExecutionRef & { sessionId: string },
  incarnation: ExecutionIncarnation | null,
  endReason?: string,
): Promise<boolean> {
  const { lock, logger, now, store } = ctx;
  const ref = refOf(execution);
  lock.throwIfAborted();
  const outcome = await store.confirmExecutionGone(
    ref.executionId,
    now(),
    incarnation,
    endReason,
  );
  if (outcome === "confirmed") return true;
  logger.warn(
    outcome === "superseded"
      ? "Launch moved on to another resource; exit not confirmed"
      : "Launch has a replacement pending; exit not confirmed",
    {
      ...fieldsOf(ref),
      seen_claimed: incarnation?.claimed ?? null,
      seen_fingerprint: incarnation?.nonceFingerprint ?? null,
      session_id: execution.sessionId,
    },
  );
  return false;
}

/**
 * Carries out a kill intent. The resource is removed whatever it was
 * doing; the store then decides what its session's turns become. A
 * provider that will not remove it leaves the row as is, so the next pass
 * tries again and the receipt's deadline keeps running.
 */
export async function kill(
  ctx: PassContext,
  execution: ExecutionRef & { sessionId: string } & Partial<
      Pick<ActiveExecution, "observedAt" | "observedState" | "providerRef">
    >,
): Promise<void> {
  const { backend, lock, logger, now, stopDeadlineMs, store, summary } = ctx;
  const ref = refOf(execution);
  lock.throwIfAborted();
  let outcome: TerminateExecutionResult;
  try {
    outcome = await backend.terminate(ref, { waitForExit: false });
  } catch (error) {
    summary.killFailed.push(ref);
    logger.error("Killing execution failed; intent kept for retry", {
      ...fieldsOf(ref),
      error: messageOf(error),
      session_id: execution.sessionId,
    });
    return;
  }
  if (outcome.outcome === "generation_mismatch") {
    summary.killFailed.push(ref);
    logger.error("Killing execution hit a generation mismatch", {
      ...fieldsOf(ref),
      found_generation: outcome.foundGeneration,
      session_id: execution.sessionId,
    });
    return;
  }
  if (outcome.outcome === "stopping") {
    // A client timeout reads as `stopping` whether or not the daemon took
    // the stop, so the deadline runs from the first one that went out to
    // this very resource.
    const since =
      execution.observedState === "terminating" &&
      execution.providerRef === outcome.providerRef
        ? (execution.observedAt ?? null)
        : null;
    if (since === null) {
      lock.throwIfAborted();
      await store.recordObservation(ref, {
        found: true,
        observedAt: now(),
        providerRef: outcome.providerRef,
        state: "terminating",
      });
    } else if (now().getTime() - since.getTime() > stopDeadlineMs) {
      summary.killFailed.push(ref);
      logger.error("Kill still stopping past the stop deadline", {
        ...fieldsOf(ref),
        deadline_ms: stopDeadlineMs,
        first_stop_at: since.toISOString(),
        provider_ref: outcome.providerRef,
        session_id: execution.sessionId,
      });
      return;
    }
    summary.killsStopping.push(ref);
    logger.info("Execution asked to stop; confirmed gone by a later pass", {
      ...fieldsOf(ref),
      provider_ref: outcome.providerRef,
      session_id: execution.sessionId,
    });
    return;
  }
  // A kill is asked of the launch, not of one resource: whatever it runs
  // now is what was asked to go.
  if (!(await confirmGone(ctx, execution, null))) {
    summary.killFailed.push(ref);
    return;
  }
  summary.killed.push(ref);
  summary.terminatedObserved.push(ref);
  logger.info("Execution killed on request; resource removed", {
    ...fieldsOf(ref),
    previously_present: outcome.outcome === "terminated",
    session_id: execution.sessionId,
  });
}
