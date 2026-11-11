import type { ReclaimOptions, SchedulerRunSummary } from "./options.ts";
import {
  fieldsOf,
  keyOf,
  messageOf,
  type PassContext,
  refOf,
} from "./pass-context.ts";
import type {
  NetworkReconcileResult,
  TerminateExecutionResult,
} from "./ports/execution-backend.ts";

/** The first half of step 2: provider resources without a matching row. */
export async function terminateOrphans(ctx: PassContext): Promise<void> {
  const { backend, lock, logger, store, summary } = ctx;
  const managed = await backend.listManaged();
  const known = new Set(
    (await store.filterKnown(managed.map(refOf), backend.kind)).map(keyOf),
  );
  for (const resource of managed) {
    if (known.has(keyOf(resource))) continue;
    logger.warn("Execution resource has no launch intent; terminating", {
      ...fieldsOf(resource),
      provider_ref: resource.providerRef,
      session_id: resource.sessionId,
    });
    lock.throwIfAborted();
    let outcome: TerminateExecutionResult;
    try {
      // Nothing is rebuilt from an orphan, so nothing is lost by not
      // waiting on one that is busy; a later pass lists it again.
      outcome = await backend.terminate(refOf(resource), {
        providerRef: resource.providerRef,
        waitForExit: false,
      });
    } catch (error) {
      // One stuck resource must not stop the rest of the pass; it still
      // occupies the host, so it is counted against capacity below.
      logger.error("Terminating orphan resource failed", {
        ...fieldsOf(resource),
        error: messageOf(error),
        provider_ref: resource.providerRef,
      });
      summary.orphansUnresolved.push(refOf(resource));
      continue;
    }
    if (outcome.outcome === "stopping") {
      summary.orphansStopping.push(refOf(resource));
      logger.info("Orphan resource asked to stop; still winding down", {
        ...fieldsOf(refOf(resource)),
        provider_ref: outcome.providerRef,
      });
      continue;
    }
    if (outcome.outcome !== "terminated") {
      logger.warn("Orphan resource was not terminated", {
        ...fieldsOf(refOf(resource)),
        outcome: outcome.outcome,
      });
      if (outcome.outcome !== "absent") {
        summary.orphansUnresolved.push(refOf(resource));
      }
      continue;
    }
    summary.orphansTerminated.push(refOf(resource));
  }
}

/**
 * The second half of step 2. A backend that creates no isolation resources
 * of its own leaves the method out and this does nothing.
 */
export async function reconcileNetworks(
  options: ReclaimOptions,
  summary: SchedulerRunSummary,
): Promise<void> {
  const { backend, logger } = options;
  if (!backend.reconcileNetworks) return;
  let result: NetworkReconcileResult;
  try {
    result = await backend.reconcileNetworks();
  } catch (error) {
    summary.networkScanFailed = true;
    logger.error("Listing worker networks failed; none reconciled", {
      error: messageOf(error),
    });
    return;
  }
  summary.networksReclaimed.push(...result.removed);
  summary.networksRepaired.push(...result.repaired);
  for (const id of result.removed) {
    logger.info("Worker network of a vanished execution removed", {
      network_id: id,
    });
  }
  for (const id of result.repaired) {
    logger.warn("Worker network had lost its egress proxy; reattached", {
      network_id: id,
    });
  }
  for (const { error, id } of result.failed) {
    summary.networksFailed.push(id);
    logger.error("Worker network could not be reconciled", {
      error,
      network_id: id,
    });
  }
}
