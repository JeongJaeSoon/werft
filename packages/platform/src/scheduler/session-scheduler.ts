import { fillSlots } from "./launch.ts";
import {
  DEFAULT_DRAIN_DEADLINE_MS,
  DEFAULT_LAUNCH_FAILURE_LIMIT,
  DEFAULT_REPLACEMENT_LIMIT,
  DEFAULT_STOP_DEADLINE_MS,
  type ReclaimOptions,
  type SchedulerOptions,
  type SchedulerRunSummary,
  TERMINATE_DEADLINE_MS,
} from "./options.ts";
import { reconcileNetworks, terminateOrphans } from "./orphans.ts";
import { type PassContext, refOf, storedSpecOf } from "./pass-context.ts";
import type { LaunchIntent } from "./ports/execution-backend.ts";
import { parseExecutionResources } from "./ports/execution-backend.ts";
import type { StoredLaunchIntent } from "./ports/scheduler-store.ts";
import { reconcileRows } from "./reconcile.ts";
import { collectWorkspaces } from "./workspaces.ts";

export * from "./options.ts";

/**
 * One scheduling pass. Each step is its own set of transactions so a crash
 * between them leaves only intents the next pass can pick up again:
 *
 * 1. Every live execution row is inspected; a missing resource is re-ensured
 *    from the stored intent, an exited one is recorded and reclaimed, and
 *    one with a kill intent is torn down.
 * 2. Provider resources without a matching row are logged and terminated,
 *    then isolation resources whose execution is gone are removed and the
 *    ones that lost their attachments repaired — before admission, so a
 *    launch never waits on an address pool held by a leak.
 * 3. Remaining slots are filled: reserve (commit) then ensure, never inside
 *    the transaction.
 * Terminate receipts whose kill was not confirmed within the deadline are
 * reported unknown once the rows have been reconciled.
 * 4. Workspaces of sessions nothing will come back to are reclaimed. Last,
 *    so a slow daemon listing never delays a launch.
 */
export async function runScheduler(
  options: SchedulerOptions,
): Promise<SchedulerRunSummary> {
  if (!Number.isInteger(options.slotLimit) || options.slotLimit < 0) {
    throw new Error("slotLimit must be a non-negative integer");
  }
  const replacementLimit =
    options.replacementLimit ?? DEFAULT_REPLACEMENT_LIMIT;
  if (!Number.isInteger(replacementLimit) || replacementLimit < 1) {
    throw new Error("replacementLimit must be a positive integer");
  }
  // Checked once here rather than at each create: these limits are stored
  // with every launch reserved from now on.
  parseExecutionResources(options.resources);
  const launchFailureLimit =
    options.launchFailureLimit ?? DEFAULT_LAUNCH_FAILURE_LIMIT;
  if (!Number.isInteger(launchFailureLimit) || launchFailureLimit < 1) {
    throw new Error("launchFailureLimit must be a positive integer");
  }
  for (const [name, value] of [
    ["launchRetryBaseMs", options.launchRetryBaseMs],
    ["launchRetryCapMs", options.launchRetryCapMs],
    ["stopDeadlineMs", options.stopDeadlineMs],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`${name} must be a non-negative number`);
    }
  }
  return underPassLock(
    options,
    () => options.slotLimit,
    (lock) =>
      pass(
        options,
        options.stop === undefined
          ? lock
          : AbortSignal.any([lock, options.stop]),
      ),
  );
}

/**
 * Step 4 on its own, under the same lock: reclaim the workspaces of sessions
 * nothing will come back to, and touch nothing else. It is for the caller
 * that has just been refused admission — a daemon whose quota preflight
 * failed, which on a full disk is the same daemon that needs the space back.
 * A whole pass with no free slots would not do: it still re-ensures missing
 * resources and replaces stale ones, which is the launching that the refusal
 * forbids.
 */
export async function reclaimWorkspaces(
  options: ReclaimOptions,
): Promise<SchedulerRunSummary> {
  return underPassLock(
    options,
    () => 0,
    async (lock) => {
      const summary = emptySummary(0);
      await collectWorkspaces(options, summary, lock);
      options.logger.info("Workspace reclaim completed", {
        workspace_failed_count: summary.workspacesFailed.length,
        workspace_reclaimed_count: summary.workspacesReclaimed.length,
        workspace_scan_failed: summary.workspaceScanFailed,
        workspace_unresolved_count: summary.workspacesUnresolved.length,
      });
      return summary;
    },
  );
}

/**
 * The network half of step 2 on its own, under the same lock: for the caller
 * whose egress proxy preflight refused the pass. Two running proxies are
 * exactly when the live worker networks have to lose them, and a pass that
 * never starts would leave them attached.
 */
export async function reclaimNetworks(
  options: ReclaimOptions,
): Promise<SchedulerRunSummary> {
  return underPassLock(
    options,
    () => 0,
    async (lock) => {
      const summary = emptySummary(0);
      lock.throwIfAborted();
      await reconcileNetworks(options, summary);
      options.logger.info("Worker network reconcile completed", {
        network_failed_count: summary.networksFailed.length,
        network_reclaimed_count: summary.networksReclaimed.length,
        network_repaired_count: summary.networksRepaired.length,
        network_scan_failed: summary.networkScanFailed,
      });
      return summary;
    },
  );
}

/** Runs `work` holding the pass lock, or skips when another pass holds it. */
async function underPassLock(
  options: Pick<ReclaimOptions, "logger" | "store">,
  // Read once the lock is refused, as each entry point did inline.
  skippedSlotLimit: () => number,
  work: (lock: AbortSignal) => Promise<SchedulerRunSummary>,
): Promise<SchedulerRunSummary> {
  const lock = await options.store.acquirePassLock();
  if (lock === null) {
    options.logger.warn("Another scheduling pass holds the lock; skipping");
    return { ...emptySummary(skippedSlotLimit()), skipped: true };
  }
  let summary: SchedulerRunSummary;
  try {
    summary = await work(lock.signal);
  } finally {
    await lock.release();
  }
  // Lost after the last change it guarded, or while one was in flight:
  // either way this work ran for a while without the lock, and saying so is
  // the process's failure, whatever its summary says.
  lock.signal.throwIfAborted();
  return summary;
}

function emptySummary(slotLimit: number): SchedulerRunSummary {
  return {
    activeAfter: 0,
    activeBefore: 0,
    draining: [],
    drainsOverdue: [],
    failedLaunches: [],
    imageUnresolved: false,
    imagesRefused: [],
    heldIncompatible: [],
    launched: [],
    launchesBackingOff: [],
    launchesQuarantined: [],
    orphansTerminated: [],
    orphansUnresolved: [],
    orphansStopping: [],
    reclaimFailed: [],
    reconcileFailed: [],
    killFailed: [],
    killed: [],
    killsStopping: [],
    networkScanFailed: false,
    networksFailed: [],
    networksReclaimed: [],
    networksRepaired: [],
    reensured: [],
    replaced: [],
    replacementsExhausted: [],
    skipped: false,
    slotLimit,
    terminatedObserved: [],
    terminationsOverdue: 0,
    workspaceScanFailed: false,
    workspacesFailed: [],
    workspacesReclaimed: [],
    workspacesUnresolved: [],
  };
}

async function pass(
  options: SchedulerOptions,
  lock: AbortSignal,
): Promise<SchedulerRunSummary> {
  const now = options.now ?? (() => new Date());
  const { backend, logger, store } = options;
  // `attempt` is the one `openAttempt` opened for this ensure: the credential
  // is issued only while no later attempt has been opened, so a pass that
  // lost its lock cannot rotate out the one a newer attempt just launched.
  const intentOf = (
    stored: StoredLaunchIntent,
    attempt: number,
  ): LaunchIntent => ({
    bootstrapCredentialState: () =>
      store.bootstrapCredentialState(refOf(stored)),
    executionId: stored.executionId,
    generation: stored.generation,
    // A launch reserved before the spec was stored runs on the host's
    // current settings, as every launch used to.
    image: stored.image ?? options.image,
    // Only the create path calls this, so the credential a running worker
    // holds is never rotated out from under it.
    issueBootstrapNonce: () =>
      store.issueBootstrapNonce(refOf(stored), attempt),
    launchSpec: storedSpecOf(stored),
    operationId: stored.operationId,
    resources: stored.resources ?? options.resources,
    sessionId: stored.sessionId,
  });
  const summary = emptySummary(options.slotLimit);
  const ctx: PassContext = {
    backend,
    drainDeadlineMs: options.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS,
    intentOf,
    launchFailureLimit:
      options.launchFailureLimit ?? DEFAULT_LAUNCH_FAILURE_LIMIT,
    lock,
    logger,
    now,
    options,
    replacementLimit: options.replacementLimit ?? DEFAULT_REPLACEMENT_LIMIT,
    stopDeadlineMs: options.stopDeadlineMs ?? DEFAULT_STOP_DEADLINE_MS,
    store,
    summary,
  };

  // 1. Reconcile rows against the provider.
  await reconcileRows(ctx);
  // Every kill intent had its chance this pass; what is still unconfirmed
  // past the deadline is reported to its caller as unknown, not as pending.
  summary.terminationsOverdue = await store.markOverdueTerminations({
    now: now(),
    deadlineMs: TERMINATE_DEADLINE_MS,
  });

  // 2. Resources nobody owns.
  await terminateOrphans(ctx);
  await reconcileNetworks(options, summary);

  // 3. Fill free slots.
  await fillSlots(ctx);

  // 4. Workspaces nothing will come back to.
  await collectWorkspaces(options, summary, lock);

  summary.activeAfter = (
    await store.inspectDemand({ limit: 0 })
  ).activeExecutionCount;
  logger.info("Scheduling pass completed", {
    active_after: summary.activeAfter,
    active_before: summary.activeBefore,
    draining_count: summary.draining.length,
    drain_overdue_count: summary.drainsOverdue.length,
    failed_count: summary.failedLaunches.length,
    image_unresolved: summary.imageUnresolved,
    images_refused: summary.imagesRefused,
    held_incompatible_count: summary.heldIncompatible.length,
    kill_failed_count: summary.killFailed.length,
    killed_count: summary.killed.length,
    kills_stopping_count: summary.killsStopping.length,
    launch_backoff_count: summary.launchesBackingOff.length,
    launch_quarantined_count: summary.launchesQuarantined.length,
    launched_count: summary.launched.length,
    network_failed_count: summary.networksFailed.length,
    network_reclaimed_count: summary.networksReclaimed.length,
    network_repaired_count: summary.networksRepaired.length,
    network_scan_failed: summary.networkScanFailed,
    orphan_count: summary.orphansTerminated.length,
    orphan_unresolved_count: summary.orphansUnresolved.length,
    orphan_stopping_count: summary.orphansStopping.length,
    reclaim_failed_count: summary.reclaimFailed.length,
    reconcile_failed_count: summary.reconcileFailed.length,
    reensured_count: summary.reensured.length,
    replaced_count: summary.replaced.length,
    replacement_exhausted_count: summary.replacementsExhausted.length,
    slot_limit: summary.slotLimit,
    terminated_count: summary.terminatedObserved.length,
    terminations_overdue_count: summary.terminationsOverdue,
    workspace_failed_count: summary.workspacesFailed.length,
    workspace_reclaimed_count: summary.workspacesReclaimed.length,
    workspace_scan_failed: summary.workspaceScanFailed,
    workspace_unresolved_count: summary.workspacesUnresolved.length,
  });
  return summary;
}
