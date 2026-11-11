import type { ImageRuntime } from "@werft-ai/runtime-core";
import { confirmGone, kill, killRequested } from "./kill.ts";
import { launchRetryDelayMs } from "./options.ts";
import {
  countsAsLaunchFailure,
  failedEnsureObservation,
  fieldsOf,
  isLaunched,
  messageOf,
  type PassContext,
  refOf,
  seenIncarnation,
  storedIntentOf,
} from "./pass-context.ts";
import type {
  EnsureExecutionResult,
  ExecutionRef,
} from "./ports/execution-backend.ts";
import type {
  ActiveExecution,
  LaunchFailureOutcome,
  ReplaceReason,
} from "./ports/scheduler-store.ts";
import {
  sameCombination,
  selectWorkerImage,
  type WorkerImageCandidate,
} from "./worker-images.ts";

type PinnedImage = { image: string; runtime: ImageRuntime | undefined };
type PinnedImages = {
  /** Current first. Every runtime is set, or there is one image without. */
  pinned: [PinnedImage, ...PinnedImage[]];
  refused: readonly PinnedImage[];
};

export async function reensure(
  ctx: PassContext,
  execution: ActiveExecution,
  reason: "missing" | ReplaceReason,
  // The count the replacement being finished was recorded at; settling is
  // fenced on it.
  replacementCount = execution.replacementCount,
): Promise<void> {
  const { backend, intentOf, lock, logger, now, store, summary } = ctx;
  const ref = refOf(execution);
  if (await killRequested(ctx, execution)) {
    // Asked to go while this pass was out at the provider: building it
    // again would hand the kill a fresh target. It is killed instead.
    await kill(ctx, execution);
    return;
  }
  const stored = storedIntentOf(execution);
  if (stored === null) {
    // Pre-intent row: nothing to relaunch from, so close it out instead of
    // letting it hold a slot forever.
    if (!(await confirmGone(ctx, execution, seenIncarnation(execution)))) {
      return;
    }
    summary.terminatedObserved.push(ref);
    logger.warn("Execution row has no launch intent; closed without relaunch", {
      ...fieldsOf(ref),
      previous_state: execution.observedState,
      session_id: execution.sessionId,
    });
    return;
  }
  if (!execution.launchRetryDue) {
    backingOff(ctx, execution);
    return;
  }
  lock.throwIfAborted();
  const attempt = await openAttempt(ctx, execution);
  if (attempt === null) return;
  lock.throwIfAborted();
  let ensured: EnsureExecutionResult;
  try {
    ensured = await backend.ensureExecution(
      intentOf(stored, attempt.launchAttempts),
    );
  } catch (error) {
    lock.throwIfAborted();
    await store.recordObservation(ref, failedEnsureObservation(error, now()));
    if (await killRequested(ctx, execution)) {
      // Asked to go while it was being built, which is also why the build
      // was refused its credential: carried out, not counted.
      await kill(ctx, execution);
      return;
    }
    summary.failedLaunches.push(ref);
    logger.error("Re-creating execution resource failed", {
      ...fieldsOf(ref),
      error: messageOf(error),
      session_id: execution.sessionId,
    });
    if (countsAsLaunchFailure(error)) {
      await launchFailed(ctx, attempt, messageOf(error));
    }
    return;
  }
  await store.recordObservation(ref, {
    found: true,
    observedAt: now(),
    providerRef: ensured.providerRef,
    state: ensured.state,
  });
  if (!isLaunched(ensured.state)) {
    summary.failedLaunches.push(ref);
    logger.error("Re-created execution resource did not stay up", {
      ...fieldsOf(ref),
      provider_ref: ensured.providerRef,
      session_id: execution.sessionId,
      state: ensured.state,
    });
    await launchFailed(
      ctx,
      attempt,
      `resource was ${ensured.state} right after launch`,
    );
    return;
  }
  // `pending` is launched but not yet proven: a start the daemon took
  // and could not show. The intent stays until a pass sees it running,
  // or a container that dies right here would read as an ordinary exit.
  if (reason !== "missing" && ensured.state !== "pending") {
    lock.throwIfAborted();
    await store.settleReplacement(ref, replacementCount);
  }
  summary.reensured.push(ref);
  logger.warn("Execution resource re-created from intent", {
    ...fieldsOf(ref),
    previous_state: execution.observedState,
    provider_ref: ensured.providerRef,
    reason,
    session_id: execution.sessionId,
  });
  if (await killRequested(ctx, execution)) {
    // Asked to go while it was being built: it is taken down in the
    // same pass rather than left running until the next one.
    await kill(ctx, execution);
  }
}

/**
 * Opens the attempt an ensure is about to make and returns the launch as
 * that attempt's outcome must be recorded against it, or null when the
 * launch moved on since it was read.
 */
export async function openAttempt<
  T extends ExecutionRef & { launchAttempts: number; sessionId: string },
>(ctx: PassContext, execution: T): Promise<T | null> {
  const attempts = await ctx.store.beginLaunchAttempt(
    refOf(execution),
    execution.launchAttempts,
  );
  if (attempts === null) {
    ctx.logger.info(
      "Launch attempt not opened; launch moved on since it was read",
      {
        ...fieldsOf(execution),
        session_id: execution.sessionId,
      },
    );
    return null;
  }
  return { ...execution, launchAttempts: attempts };
}

export function backingOff(ctx: PassContext, execution: ActiveExecution): void {
  ctx.summary.launchesBackingOff.push(refOf(execution));
  ctx.logger.warn("Launch is waiting out the backoff after a failed attempt", {
    ...fieldsOf(execution),
    launch_failure_count: execution.launchFailureCount,
    retry_at: execution.launchRetryAt?.toISOString() ?? null,
    session_id: execution.sessionId,
  });
}

/**
 * Counts one failed attempt at the launch. The launch then waits out a
 * backoff with its slot held, or — at the limit — is given up on: the
 * store fails its queued input and writes its kill, and the kill is
 * carried out right here so the slot comes back in this same pass.
 */
export async function launchFailed(
  ctx: PassContext,
  execution: ExecutionRef & {
    launchAttempts: number;
    launchFailureCount: number;
    sessionId: string;
  },
  error: string,
  expectedNonceFingerprint?: string | null,
): Promise<LaunchFailureOutcome> {
  const { launchFailureLimit, lock, logger, options, store, summary } = ctx;
  const ref = refOf(execution);
  const count = execution.launchFailureCount + 1;
  const quarantine = count >= launchFailureLimit;
  const retryDelayMs = quarantine
    ? 0
    : launchRetryDelayMs(
        count,
        options.launchRetryBaseMs,
        options.launchRetryCapMs,
      );
  lock.throwIfAborted();
  const outcome = await store.recordLaunchFailure(ref, {
    error,
    expectedAttempts: execution.launchAttempts,
    expectedCount: execution.launchFailureCount,
    ...(expectedNonceFingerprint === undefined
      ? {}
      : { expectedNonceFingerprint }),
    quarantine,
    retryDelayMs,
  });
  const fields = {
    ...fieldsOf(ref),
    error,
    launch_failure_count: count,
    limit: launchFailureLimit,
    session_id: execution.sessionId,
  };
  if (outcome === "stale") {
    logger.info(
      "Launch failure not recorded; launch moved on since it was read",
      fields,
    );
    return outcome;
  }
  if (outcome === "backing_off") {
    logger.warn("Launch attempt failed; retrying after a backoff", {
      ...fields,
      retry_in_ms: retryDelayMs,
    });
    return outcome;
  }
  summary.launchesQuarantined.push(ref);
  logger.error(
    "Launch failed as many times as the limit allows; given up, its " +
      "queued input failed with LAUNCH_FAILED. New input launches it again",
    fields,
  );
  await kill(ctx, execution);
  return outcome;
}

/** Step 3: fill free slots. */
export async function fillSlots(ctx: PassContext): Promise<void> {
  const { backend, intentOf, lock, logger, now, options, store, summary } = ctx;
  const demand = await store.inspectDemand({ limit: options.slotLimit });
  // Pinned once per pass, and only when there is a session to admit. What a
  // tag names can move between passes; that is the point — each new launch
  // gets whatever it names when the launch is reserved, and keeps it.
  let images: PinnedImages | null | undefined;
  const pinnedImages = async (): Promise<PinnedImages | null> => {
    const configured: PinnedImage[] = [
      { image: options.image, runtime: options.imageRuntime },
    ];
    if (
      options.imageRuntime !== undefined &&
      options.previousImage !== undefined
    ) {
      configured.push(options.previousImage);
    }
    const pinned: PinnedImage[] = [];
    for (const { image, runtime } of configured) {
      try {
        pinned.push({ image: await backend.resolveImage(image), runtime });
      } catch (error) {
        summary.imageUnresolved = true;
        logger.error("Worker image could not be pinned; nothing admitted", {
          error: messageOf(error),
          image,
        });
        return null;
      }
    }
    const refusals =
      options.imageRuntime === undefined
        ? []
        : await store.workerImageRefusals();
    const refused: PinnedImage[] = [];
    for (const { image, runtime } of pinned) {
      if (
        runtime !== undefined &&
        refusals.some(
          (refusal) =>
            refusal.image === image &&
            sameCombination(refusal.assumed, runtime),
        )
      ) {
        refused.push({ image, runtime });
        summary.imagesRefused.push(image);
        logger.error(
          "Worker image refused: a worker on it claimed under another runtime than configured; no session is launched on it until the configured runtime is corrected",
          { image, assumed: runtime },
        );
      }
    }
    return { pinned: pinned as [PinnedImage, ...PinnedImage[]], refused };
  };
  // The image this session launches on; null when it waits this pass.
  const imageFor = async (
    sessionId: string,
    available: PinnedImages,
  ): Promise<PinnedImage | null> => {
    const [current] = available.pinned;
    if (current.runtime === undefined) return current;
    const { pointer, checkpointRevision } =
      await store.pointerRuntimeOf(sessionId);
    const selection = selectWorkerImage(
      pointer,
      available.pinned.map(({ image, runtime }) => ({
        image,
        runtime: runtime as ImageRuntime,
      })) as [WorkerImageCandidate<string>, ...WorkerImageCandidate<string>[]],
    );
    if (selection.kind === "selected") {
      // By the pair: one digest configured twice under two runtimes is
      // refused only under the one a worker contradicted.
      return available.refused.some(
        ({ image, runtime }) =>
          image === selection.image &&
          runtime !== undefined &&
          sameCombination(runtime, selection.runtime),
      )
        ? null
        : { image: selection.image, runtime: selection.runtime };
    }
    lock.throwIfAborted();
    const held = await store.holdIncompatibleBeforeLaunch({
      sessionId,
      checkpointRevision,
      detail: selection.detail,
      now: now(),
    });
    if (held === "held") {
      summary.heldIncompatible.push(sessionId);
      logger.warn(
        "No configured worker image matches the session's checkpoint; stopped before launch as incompatible_checkpoint",
        { detail: selection.detail, session_id: sessionId },
      );
    }
    return null;
  };
  // Rows are the ledger, but a still-running orphan occupies the host too.
  let free = Math.max(
    0,
    options.slotLimit -
      demand.activeExecutionCount -
      summary.orphansUnresolved.length -
      summary.orphansStopping.length,
  );
  // A session passed over (its image refused, held before launch, raced)
  // leaves its slot to the next in line, so a full page reads on past it.
  const eligible = async function* () {
    const seen: string[] = [];
    let page = demand.eligibleSessionIds;
    let limit = options.slotLimit;
    for (;;) {
      for (const sessionId of page) {
        seen.push(sessionId);
        yield sessionId;
      }
      if (free <= 0 || page.length < limit) return;
      limit = free;
      lock.throwIfAborted();
      page = (await store.inspectDemand({ limit, excluding: seen }))
        .eligibleSessionIds;
    }
  };
  for await (const sessionId of eligible()) {
    if (free <= 0) break;
    if (images === undefined) images = await pinnedImages();
    if (images === null) break;
    lock.throwIfAborted();
    const chosen = await imageFor(sessionId, images);
    if (chosen === null) continue;
    lock.throwIfAborted();
    const stored = await store.reserveLaunch({
      backend: backend.kind,
      image: chosen.image,
      ...(chosen.runtime === undefined ? {} : { imageRuntime: chosen.runtime }),
      now: now(),
      resources: options.resources,
      sessionId,
      slotLimit: options.slotLimit,
    });
    if (stored === null) continue;
    free -= 1;
    const ref = refOf(stored);
    lock.throwIfAborted();
    const launch = await openAttempt(ctx, {
      ...stored,
      launchAttempts: 0,
      launchFailureCount: 0,
    });
    if (launch === null) continue;
    lock.throwIfAborted();
    let ensured: EnsureExecutionResult;
    try {
      ensured = await backend.ensureExecution(
        intentOf(stored, launch.launchAttempts),
      );
    } catch (error) {
      lock.throwIfAborted();
      await store.recordObservation(ref, failedEnsureObservation(error, now()));
      if ((await store.desiredStateOf(ref)) === "terminated") {
        await kill(ctx, { ...ref, sessionId });
        continue;
      }
      // The intent stays committed; step 1 of a later pass retries it once
      // the backoff this failure starts allows.
      summary.failedLaunches.push(ref);
      logger.error("Launching execution failed; intent kept for retry", {
        ...fieldsOf(ref),
        error: messageOf(error),
        session_id: sessionId,
      });
      if (countsAsLaunchFailure(error)) {
        await launchFailed(ctx, launch, messageOf(error));
      }
      continue;
    }
    await store.recordObservation(ref, {
      found: true,
      observedAt: now(),
      providerRef: ensured.providerRef,
      state: ensured.state,
    });
    if (!isLaunched(ensured.state)) {
      // Created, but already dead (bad image, crashing entrypoint). Not a
      // success, so the process exits non-zero, and a failed attempt: the
      // next pass clears the dead resource and retries after the backoff.
      summary.failedLaunches.push(ref);
      logger.error("Execution resource exited right after launch", {
        ...fieldsOf(ref),
        provider_ref: ensured.providerRef,
        session_id: sessionId,
        state: ensured.state,
      });
      await launchFailed(
        ctx,
        launch,
        `resource was ${ensured.state} right after launch`,
      );
      continue;
    }
    summary.launched.push(ref);
    logger.info("Execution launched", {
      ...fieldsOf(ref),
      created: ensured.created,
      provider_ref: ensured.providerRef,
      session_id: sessionId,
    });
    if ((await store.desiredStateOf(ref)) === "terminated") {
      // A terminate that committed between the reservation and the
      // resource coming up: this row was not in the pass's snapshot, so
      // nothing else would kill it before the receipt's deadline.
      await kill(ctx, { ...ref, sessionId });
    }
  }
}
