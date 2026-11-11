import { confirmGone } from "./kill.ts";
import { backingOff, launchFailed, reensure } from "./launch.ts";
import {
  fieldsOf,
  messageOf,
  type PassContext,
  pinnedTo,
  refOf,
  seenIncarnation,
  storedIntentOf,
} from "./pass-context.ts";
import type {
  ExecutionObservation,
  TerminateExecutionResult,
} from "./ports/execution-backend.ts";
import type {
  ActiveExecution,
  ReplaceReason,
} from "./ports/scheduler-store.ts";

/**
 * Tears the resource down and builds it again from the stored intent. The
 * new one gets a new bootstrap credential, which is why the launch must not
 * already have bound a worker: that binding spent its credential, and a
 * replacement could never be given one.
 */
export async function replace(
  ctx: PassContext,
  execution: ActiveExecution,
  reason: ReplaceReason,
  observed: ExecutionObservation,
  // The credential the launch accepted when this was judged. The record
  // is fenced on it: `ensureExecution` on another pass issues anew without
  // counting a replacement, so the count alone would let a stale
  // judgement shut the door on that fresh credential.
  acceptedFingerprint: string | null = execution.nonceFingerprint,
): Promise<void> {
  const { backend, intentOf, lock, logger, replacementLimit, store, summary } =
    ctx;
  const ref = refOf(execution);
  const stored = storedIntentOf(execution);
  if (execution.claimed || stored === null) {
    // Nothing to rebuild from: a claimed launch spent its credential on a
    // binding, a pre-intent row never had one. Teardown and close.
    if (!(await teardown(ctx, execution, reason, observed))) return;
    summary.replaced.push(ref);
    if (
      !(await confirmGone(ctx, execution, seenIncarnation(execution, observed)))
    ) {
      return;
    }
    summary.terminatedObserved.push(ref);
    logger.warn("Replaced an execution nothing can rebuild; closed", {
      ...fieldsOf(ref),
      claimed: execution.claimed,
      reason,
      session_id: execution.sessionId,
    });
    return;
  }
  if (!execution.launchRetryDue) {
    // A rebuild is a launch like any other: one whose last attempt failed
    // waits out its backoff before the resource it has is torn down.
    backingOff(ctx, execution);
    return;
  }
  // An earlier pass recorded this replacement and its old resource is still
  // there: counted already, and the record shut the door on the credential
  // it holds, so no worker can bind to it and only the teardown and the
  // create are left to finish. A resource holding the credential the launch
  // accepts is the rebuild, and replacing that is a new replacement.
  const resumed =
    execution.pendingReplacement !== null &&
    observed.credentialFingerprint != null &&
    observed.credentialFingerprint !== execution.nonceFingerprint;
  if (!resumed && execution.replacementCount >= replacementLimit) {
    // Whatever gets built keeps being rejected, so building it once more
    // is not the answer. Nothing is touched: the resource stays, the slot
    // stays, and every pass reports it until someone looks. Closing the
    // launch instead would hand the session a fresh launch with a fresh
    // count, and move the loop one generation along.
    summary.replacementsExhausted.push(ref);
    logger.error(
      "Replacement limit reached; launch left as it is. Reset " +
        "replacement_count on its worker_launches row to let the " +
        "scheduler try again; leave replacement_reason set, or the " +
        "stopped resource reads as an ordinary exit",
      {
        ...fieldsOf(ref),
        limit: replacementLimit,
        reason,
        replacement_count: execution.replacementCount,
        session_id: execution.sessionId,
      },
    );
    return;
  }
  // Replacement is a teardown followed by a create, and only the create can
  // fail on what the provider knows. Asked here that costs a pass; asked
  // after the terminate it costs the worker. Asked before the record, a
  // refusal leaves the resource with its credential intact.
  if (backend.assertReplaceable) {
    try {
      await backend.assertReplaceable(
        intentOf(stored, execution.launchAttempts),
      );
    } catch (error) {
      lock.throwIfAborted();
      summary.failedLaunches.push(ref);
      logger.error("Replacement would not launch; resource left as is", {
        ...fieldsOf(ref),
        error: messageOf(error),
        reason,
        replacement_count: execution.replacementCount,
        session_id: execution.sessionId,
      });
      // The launch cannot be built, which is a failed attempt like a create
      // the provider refused: counted, backed off, and given up on at the
      // limit instead of refused on every pass for good.
      await launchFailed(
        ctx,
        execution,
        `replacement would not launch: ${messageOf(error)}`,
      );
      return;
    }
  }
  // Committed before anything is torn down, so a teardown that half
  // happens or a host that dies after it leaves a row the next pass
  // rebuilds from the same intent, never one it reads as an exit. The same
  // write shuts the bootstrap door, so a worker cannot bind to the
  // resource while it is on its way out.
  lock.throwIfAborted();
  const attempts = resumed
    ? execution.replacementCount
    : await store.requestReplacement(
        ref,
        reason,
        execution.replacementCount,
        acceptedFingerprint,
      );
  if (attempts === null) {
    // A worker claimed, the launch gave its slot back, or another pass
    // got here first, since the rows were read. Either way the resource
    // is not this pass's to tear down.
    logger.info("Replacement refused; launch moved on since it was read", {
      ...fieldsOf(ref),
      reason,
      session_id: execution.sessionId,
    });
    return;
  }
  if (!(await teardown(ctx, execution, reason, observed))) return;
  summary.replaced.push(ref);
  await reensure(ctx, execution, reason, attempts);
}

/**
 * The teardown half of a replacement. True once nothing of the old
 * resource is left, which includes there having been nothing to begin
 * with; false leaves the row as it is — its slot, and any pending
 * replacement — for the next pass to retry.
 */
export async function teardown(
  ctx: PassContext,
  execution: ActiveExecution,
  reason: ReplaceReason | "failed_attempt",
  observed: ExecutionObservation,
): Promise<boolean> {
  const { backend, lock, logger, summary } = ctx;
  const ref = refOf(execution);
  if (!observed.found) return true;
  lock.throwIfAborted();
  let outcome: TerminateExecutionResult;
  try {
    // Pinned to the resource this pass inspected. The name it would
    // otherwise resolve is deterministic, so a pass that lost its lock
    // could find a replacement another pass has since built and whose
    // worker has since bound; that one is refused, the row is left as is,
    // and the next pass judges the replacement on its own merits.
    // Not waited on: a claimed worker may be draining a turn past its
    // drain deadline, and two hung unclaimed ones would outlast the pass.
    // One still stopping is asked again by the next pass, which finishes
    // the recorded replacement without counting another — if it can tell
    // the old resource by its revoked credential. One built before that
    // label cannot be told apart, so it is waited on as before.
    outcome = await backend.terminate(ref, {
      ...pinnedTo(observed),
      waitForExit: !execution.claimed && observed.credentialFingerprint == null,
    });
  } catch (error) {
    summary.reconcileFailed.push(ref);
    logger.error("Replacing an execution resource failed", {
      ...fieldsOf(ref),
      error: messageOf(error),
      reason,
      session_id: execution.sessionId,
    });
    return false;
  }
  if (outcome.outcome === "terminated" || outcome.outcome === "absent") {
    return true;
  }
  if (outcome.outcome === "stopping") {
    logger.info("Execution resource stopping for replacement", {
      ...fieldsOf(ref),
      provider_ref: outcome.providerRef,
      reason,
      session_id: execution.sessionId,
    });
    return false;
  }
  // Left untouched, so the row keeps its slot and the next pass retries.
  summary.reconcileFailed.push(ref);
  logger.error("An execution resource would not terminate for replacement", {
    ...fieldsOf(ref),
    outcome: outcome.outcome,
    reason,
    session_id: execution.sessionId,
  });
  return false;
}
