import { WORKER_EXIT_LEASE_LOST } from "@werft-ai/contracts";
import { confirmGone, kill, killRequested } from "./kill.ts";
import { launchFailed, reensure } from "./launch.ts";
import {
  fieldsOf,
  messageOf,
  type PassContext,
  pinnedTo,
  refOf,
  seenIncarnation,
  storedIntentOf,
  storedSpecOf,
  unknownObservation,
} from "./pass-context.ts";
import type { TerminateExecutionResult } from "./ports/execution-backend.ts";
import type { ActiveExecution } from "./ports/scheduler-store.ts";
import { replace, teardown } from "./replace.ts";

/** Step 1: reconcile rows against the provider. */
export async function reconcileRows(ctx: PassContext): Promise<void> {
  const { backend, lock, logger, store, summary } = ctx;
  const active = await store.listActiveExecutions(backend.kind);
  summary.activeBefore = active.length;
  for (const execution of active) {
    const ref = refOf(execution);
    try {
      await reconcile(ctx, execution);
    } catch (error) {
      // Not one row's failure: the whole pass stops (see `PassLock`).
      lock.throwIfAborted();
      // A resource-local failure (ownership conflict, a stuck inspect) must
      // not take the rest of the pass down with it. The row stays live, so
      // it keeps its slot until a later pass resolves it.
      summary.reconcileFailed.push(ref);
      logger.error("Reconciling execution failed; row left as is", {
        ...fieldsOf(ref),
        error: messageOf(error),
        session_id: execution.sessionId,
      });
    }
  }
}

async function reconcile(
  ctx: PassContext,
  execution: ActiveExecution,
): Promise<void> {
  const { backend, lock, logger, now, store, summary } = ctx;
  const ref = refOf(execution);
  if (execution.backend !== backend.kind) {
    // The store is scoped; a row leaking through anyway must never be
    // recreated on this provider.
    logger.error("Execution row belongs to another backend; skipping", {
      ...fieldsOf(ref),
      row_backend: execution.backend,
      session_id: execution.sessionId,
    });
    return;
  }
  if (await killRequested(ctx, execution)) {
    await kill(ctx, execution);
    return;
  }
  const observed = await backend.inspect(ref);
  if (observed.logTail !== undefined) {
    // Every path below may remove the resource, and its output with it;
    // this line is where the tail survives. Logged again by each pass
    // that still finds the resource.
    logger.warn("Execution resource failed; log tail kept", {
      ...fieldsOf(ref),
      exit_code: observed.exitCode ?? null,
      log_tail: observed.logTail,
      provider_ref: observed.providerRef,
      session_id: execution.sessionId,
      termination_reason: observed.terminationReason ?? null,
    });
  }
  const up = observed.found && observed.state !== "terminated";
  if (up && (await killRequested(ctx, execution))) {
    // A terminate that committed while the pass was out at the provider
    // must not wait for the next pass: the receipt's deadline is running
    // and the resource is still doing work.
    await kill(ctx, execution);
    return;
  }
  if (
    observed.found &&
    !execution.claimed &&
    execution.launchFailureCount > 0 &&
    storedIntentOf(execution) !== null &&
    observed.credentialFingerprint != null &&
    observed.credentialFingerprint !== execution.nonceFingerprint
  ) {
    // Left behind by an attempt that failed: recording the failure revoked
    // the credential it was built with, so it can never bind. It is
    // cleared away, not replaced — a replacement would spend the
    // replacement budget on what is one launch failing, and read a stale
    // or expired resource as the reason — and the launch is built again
    // once its backoff allows. Judged before any replacement reason for
    // that same cause.
    if (!(await teardown(ctx, execution, "failed_attempt", observed))) return;
    lock.throwIfAborted();
    await store.recordObservation(ref, unknownObservation(now()));
    await reensure(ctx, execution, execution.pendingReplacement ?? "missing");
    return;
  }
  if (up && observed.stale) {
    // The resource runs under an isolation contract this host no longer
    // promises, and an upgrade cannot reach inside a running resource. It
    // is torn down here and re-created from the stored intent.
    logger.warn("Execution resource predates the isolation contract", {
      ...fieldsOf(ref),
      provider_ref: observed.providerRef,
      session_id: execution.sessionId,
      state: observed.state,
    });
    if (execution.claimed && !(await drained(ctx, execution))) return;
    await replace(ctx, execution, "stale_isolation", observed);
    return;
  }
  if (
    up &&
    !execution.claimed &&
    execution.nonceExpiresAt !== null &&
    execution.nonceExpired
  ) {
    // The bootstrap door shut before anyone came through it. The resource
    // cannot be handed a second credential while it runs — the one it holds
    // is fixed in its environment — so leaving it up would keep a slot and
    // a session that nothing can ever bind. It is replaced instead.
    //
    // `claimed` is a snapshot taken before the provider was inspected, so a
    // worker may have bound itself since. Revoking decides and shuts the
    // door in one write: it loses to a claim that got there first, and once
    // it wins no claim can follow, so the teardown never orphans a binding.
    lock.throwIfAborted();
    if (await store.revokeBootstrapNonce(ref)) {
      logger.warn("Launch nonce expired before the resource claimed", {
        ...fieldsOf(ref),
        nonce_expires_at: execution.nonceExpiresAt.toISOString(),
        provider_ref: observed.providerRef,
        session_id: execution.sessionId,
        state: observed.state,
      });
      // The revoke just emptied the registry; that is the state the
      // record is fenced on, not the snapshot read before it.
      await replace(ctx, execution, "nonce_expired", observed, null);
      return;
    }
    // A worker came through the door while this pass was inspecting. It
    // owns the session now, so the resource is left alone and handled below
    // like any other live one.
    logger.info("Expired launch had already been claimed; left running", {
      ...fieldsOf(ref),
      provider_ref: observed.providerRef,
      session_id: execution.sessionId,
    });
  }
  if (
    up &&
    !execution.claimed &&
    observed.credentialFingerprint != null &&
    observed.credentialFingerprint !== execution.nonceFingerprint
  ) {
    // The resource holds a credential the registry rotated past — a
    // create that landed after a later pass had already issued anew, and
    // whose pass never got to judge it. `ensureExecution` catches
    // this when it is the one adopting; this catches what it did not get
    // to. A launch that accepts no credential at all (a replacement
    // recorded by a pass that died before its teardown, a revoke whose
    // replace never ran) lands here too: what is up under it is the old
    // resource, not the replacement — the pending branch below must not
    // settle it. `replace` records the request with a write fenced on this
    // very fingerprint, so a credential issued anew since the snapshot is
    // never the one it shuts the door on. A resource without the label is
    // not judged here at all.
    logger.warn(
      "Execution resource holds a credential the launch no longer accepts",
      {
        ...fieldsOf(ref),
        provider_ref: observed.providerRef,
        session_id: execution.sessionId,
        state: observed.state,
      },
    );
    await replace(ctx, execution, "credential_mismatch", observed);
    return;
  }
  const spec = storedSpecOf(execution);
  if (
    up &&
    !execution.claimed &&
    spec !== null &&
    observed.launchSpec != null &&
    observed.launchSpec !== spec
  ) {
    // Built from something other than what the launch was reserved with.
    // Nothing the scheduler creates does that — a create reads its spec
    // from the row — so this is a resource another hand put there, or a
    // pending replacement whose rebuild is not what is up. Either way it
    // is not this launch, and once replaced it will be. A claimed one has
    // a worker bound and is left to finish; a resource without the label
    // cannot be judged.
    logger.warn("Execution resource runs another launch spec", {
      ...fieldsOf(ref),
      provider_ref: observed.providerRef,
      session_id: execution.sessionId,
      state: observed.state,
    });
    await replace(ctx, execution, "spec_mismatch", observed);
    return;
  }
  const builtWith =
    observed.credentialFingerprint ?? execution.nonceFingerprint;
  if (
    observed.found &&
    observed.state === "terminated" &&
    !execution.claimed &&
    storedIntentOf(execution) !== null &&
    builtWith !== null &&
    builtWith === execution.nonceFingerprint
  ) {
    // No worker ever bound to it, so nothing ran: this is a launch that
    // failed, not a session that finished. Reading it as an exit would
    // hand the session a new launch with a fresh count, and a worker that
    // crashes on boot would cycle through generations forever. Only a
    // resource built with the credential the launch accepts now is judged
    // here — a replacement that died, too, which would otherwise spend the
    // replacement budget below. The old resource a replacement is tearing
    // down had its credential revoked when the replacement was recorded.
    // The failure is fenced on that credential and revokes it, so the same
    // dead resource is never counted twice.
    const outcome = await launchFailed(
      ctx,
      execution,
      `resource exited before a worker claimed it (exit code ${observed.exitCode ?? "unknown"}${observed.terminationReason === undefined ? "" : `, ${observed.terminationReason}`})`,
      builtWith,
    );
    if (outcome === "quarantined") return;
    if (outcome === "backing_off") {
      // A pending replacement stays recorded: the next pass finds the
      // resource gone and rebuilds once the backoff allows.
      if (await teardown(ctx, execution, "failed_attempt", observed)) {
        lock.throwIfAborted();
        await store.recordObservation(ref, unknownObservation(now()));
      }
      return;
    }
    // Refused: since the rows were read a worker bound, the launch was
    // asked to go, or another pass opened an attempt of its own. Asked to
    // go — say a claim refused it for recovery — it is carried out now,
    // never rebuilt. Otherwise the newer attempt may have adopted this very
    // resource on the same credential, so an ordinary exit here would
    // release that attempt's slot and start the session over with a fresh
    // count. The next pass reads the launch as it is now and judges the
    // exit from there.
    if (await killRequested(ctx, execution)) {
      await kill(ctx, execution);
      return;
    }
    logger.info("Unclaimed exit left for the next pass; launch moved on", {
      ...fieldsOf(ref),
      session_id: execution.sessionId,
    });
    return;
  }
  if (
    !observed.found &&
    !execution.claimed &&
    execution.observedState === "unknown" &&
    execution.nonceFingerprint !== null &&
    storedIntentOf(execution) !== null
  ) {
    // An ensure the provider never answered kept its credential for this
    // look. Nothing landed, so the launch did fail after all
    // and it is counted now — a create that never takes cannot hold its
    // slot forever. Fenced on that credential, which the record revokes:
    // a create landing later is torn down as a failed attempt.
    await launchFailed(
      ctx,
      execution,
      "the provider never answered the launch and no resource was created",
      execution.nonceFingerprint,
    );
    return;
  }
  const running = up && observed.state !== "pending";
  // A replacement an earlier pass committed to and did not get to finish:
  // its teardown half happened, or the host died between the two halves.
  // A claimed launch is never rebuilt, so its flag says nothing.
  const pending = execution.claimed ? null : execution.pendingReplacement;
  if (pending !== null) {
    // Whatever is up here is neither stale nor past its credential, or it
    // would have been taken above: it is the replacement itself, built by
    // a pass that died before it could say so.
    if (observed.state === "pending" || !observed.found) {
      // Created and never started: ensure adopts and starts it. Or gone:
      // the teardown half is done and only the create is left. Either way
      // it is not a rebuild, so it is not counted — asking again would
      // spend the replacement budget on a create that failed, which is a
      // launch failure and is counted as one.
      await reensure(ctx, execution, pending);
      return;
    }
    if (observed.state === "running" || observed.state === "suspended") {
      // Only a state that proves the replacement viable settles it. A
      // resource on its way out (`terminating`) or in a state the provider
      // cannot name would be settled straight into the ordinary exit path,
      // which is the loss this record exists to prevent.
      lock.throwIfAborted();
      await store.settleReplacement(ref, execution.replacementCount);
      await store.recordObservation(ref, observed);
      logger.info("Pending replacement found already running; settled", {
        ...fieldsOf(ref),
        provider_ref: observed.providerRef,
        reason: pending,
        replacement_count: execution.replacementCount,
        session_id: execution.sessionId,
      });
      return;
    }
    // Stopped, going, or unknown: whatever is there is the old resource,
    // and the intent still has to be rebuilt.
    // Reading an exited one as an ordinary exit here is exactly what would
    // lose the replacement and hand the session a new launch.
    await replace(ctx, execution, pending, observed);
    return;
  }
  if (running) {
    await store.recordObservation(ref, observed);
    return;
  }
  if (observed.found && observed.state === "terminated") {
    // Mark, reclaim, then record. `terminating` keeps the row live so a
    // failed or interrupted removal is retried, and tells the next pass
    // that an absent resource means "reclaimed", not "relaunch me".
    lock.throwIfAborted();
    await store.recordObservation(ref, {
      ...observed,
      state: "terminating",
    });
    lock.throwIfAborted();
    let outcome: TerminateExecutionResult;
    try {
      // Pinned to the exited resource that was inspected, like `teardown`:
      // under the same name there may by now be a replacement another
      // pass built, and reclaiming that would also release its binding.
      outcome = await backend.terminate(ref, pinnedTo(observed));
    } catch (error) {
      logger.error("Reclaiming exited execution resource failed", {
        ...fieldsOf(ref),
        error: messageOf(error),
        session_id: execution.sessionId,
      });
      summary.reclaimFailed.push(ref);
      return;
    }
    if (outcome.outcome !== "terminated" && outcome.outcome !== "absent") {
      // The resource was left untouched, so the slot stays occupied; the
      // row remains `terminating` and the next pass tries again — and for
      // a replacement, judges it on its own merits.
      logger.error("Reclaiming exited execution resource left it in place", {
        ...fieldsOf(ref),
        ...(outcome.outcome === "generation_mismatch"
          ? { found_generation: outcome.foundGeneration }
          : outcome.outcome === "provider_mismatch"
            ? { found_provider_ref: outcome.foundProviderRef }
            : {}),
        outcome: outcome.outcome,
        session_id: execution.sessionId,
      });
      summary.reclaimFailed.push(ref);
      return;
    }
    // The one place the slot and the session come back, so an exit the
    // scheduler sees is accounted exactly like one the gateway sees. The
    // terminate is pinned to the exited resource, but a replacement built
    // under the same name after its check reads as the same success; the
    // incarnation it was created with is what tells them apart.
    if (
      !(await confirmGone(
        ctx,
        execution,
        seenIncarnation(execution, observed),
        observed.exitCode === WORKER_EXIT_LEASE_LOST
          ? "worker_lease_lost"
          : undefined,
      ))
    ) {
      return;
    }
    summary.terminatedObserved.push(ref);
    logger.info("Execution exited; resource reclaimed", {
      ...fieldsOf(ref),
      exit_code: observed.exitCode ?? null,
      session_id: execution.sessionId,
      termination_reason: observed.terminationReason ?? null,
    });
    return;
  }
  if (!observed.found && execution.observedState === "terminating") {
    // The previous pass removed the resource but crashed before recording.
    // Or another pass is between removing it and creating its replacement:
    // the row this pass read is the only incarnation it can speak for.
    if (!(await confirmGone(ctx, execution, seenIncarnation(execution)))) {
      return;
    }
    summary.terminatedObserved.push(ref);
    return;
  }
  if (!observed.found && execution.claimed) {
    // A worker traded this launch's nonce for a binding and its resource
    // is gone. Re-creating it would put a second container on a session an
    // attempt still owns, so the binding is ended instead.
    if (!(await confirmGone(ctx, execution, seenIncarnation(execution)))) {
      return;
    }
    summary.terminatedObserved.push(ref);
    logger.warn("Claimed execution resource vanished; binding released", {
      ...fieldsOf(ref),
      previous_state: execution.observedState,
      session_id: execution.sessionId,
    });
    return;
  }
  // Row says live but the provider has nothing, or has a resource that was
  // created and never started. The stored intent covers both: ensure is
  // idempotent and starts a pending resource it already owns.
  await reensure(ctx, execution, "missing");
}

/**
 * A claimed resource cannot be rebuilt, only torn down and its session
 * handed to a new launch, so tearing it down mid-turn would leave that
 * turn unknown for an operator. Its worker is asked to take no
 * new turn instead, and it goes once the one it runs has ended. True when
 * the teardown may go ahead now: nothing is left open, or the deadline
 * passed first.
 */
async function drained(
  ctx: PassContext,
  execution: ActiveExecution,
): Promise<boolean> {
  const { drainDeadlineMs, lock, logger, store, summary } = ctx;
  const ref = refOf(execution);
  lock.throwIfAborted();
  const drain = await store.requestDrain(ref, drainDeadlineMs);
  // The binding moved on since the rows were read; the next pass sees
  // what the launch is now.
  if (drain === null) return false;
  if (!drain.busy) return true;
  if (!drain.overdue) {
    summary.draining.push(ref);
    logger.info("Claimed execution draining before its replacement", {
      ...fieldsOf(ref),
      deadline_ms: drainDeadlineMs,
      session_id: execution.sessionId,
    });
    return false;
  }
  summary.drainsOverdue.push(ref);
  logger.warn(
    "Drain deadline passed with the worker still busy; replacing anyway",
    {
      ...fieldsOf(ref),
      deadline_ms: drainDeadlineMs,
      session_id: execution.sessionId,
    },
  );
  return true;
}
