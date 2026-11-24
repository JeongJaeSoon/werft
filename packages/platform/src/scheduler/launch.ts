import type { ImageRuntime } from "@werft-ai/runtime-core";
import { confirmGone, kill, killRequested } from "./kill.ts";
import { launchRetryDelayMs, type SchedulerOptions } from "./options.ts";
import {
  countsAsLaunchFailure,
  failedEnsureObservation,
  fieldsOf,
  heldForLimits,
  isLaunched,
  messageOf,
  type PassContext,
  refOf,
  seenIncarnation,
  storedIntentOf,
} from "./pass-context.ts";
import type {
  EnsureExecutionResult,
  ExecutionObservation,
  ExecutionRef,
} from "./ports/execution-backend.ts";
import type {
  ActiveExecution,
  LaunchFailureOutcome,
  ReplaceReason,
  StoredLaunchIntent,
} from "./ports/scheduler-store.ts";
import {
  imageIdentity,
  imagesOfEngine,
  sameCombination,
  selectWorkerImage,
  type WorkerImageCandidate,
} from "./worker-images.ts";

type PinnedImage = { image: string; runtime: ImageRuntime | undefined };
type PinnedImages = {
  /**
   * Current first. Every runtime is set, or there is one image without.
   * Empty only when every configured image is retracted.
   */
  pinned: PinnedImage[];
  refused: readonly PinnedImage[];
  /** Configured but retracted: judged with, never launched on. */
  retracted: readonly { image: string; runtime: ImageRuntime }[];
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
  const cause = await giveBackCause(ctx, execution, stored);
  if (cause !== null) {
    // Given back instead, the session chooses afresh: a fixed build, or a
    // hold. A replacement it had pending is settled first, or the exit
    // would wait on the rebuild.
    if (reason !== "missing" || execution.pendingReplacement !== null) {
      lock.throwIfAborted();
      await store.settleReplacement(ref, replacementCount);
    }
    if (!(await confirmGone(ctx, execution, seenIncarnation(execution)))) {
      return;
    }
    reportGivenBack(ctx, ref, cause, "given back", {
      image: stored.image,
      reason,
      session_id: execution.sessionId,
    });
    return;
  }
  if (heldForLimits(ctx, stored)) {
    reportHeldForLimits(ctx, execution, reason);
    return;
  }
  if (!execution.launchRetryDue) {
    backingOff(ctx, execution);
    return;
  }
  if (
    !execution.claimed &&
    (await refusedForCodexSandbox(ctx, execution, stored.image))
  ) {
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
 * Why an unclaimed launch is given back instead of built again, or null to
 * build it. No worker bound it, so nothing runs on it yet: `retracted`, its
 * rebuild would restore its session on a retracted image; `engine_dropped`,
 * no configured image runs its session's engine; `limits_changed`, it was
 * reserved with worker limits the scheduler no longer runs, and a rebuild
 * would start its worker with them again.
 */
export async function giveBackCause(
  ctx: PassContext,
  execution: ActiveExecution,
  stored: StoredLaunchIntent,
): Promise<GiveBackCause | null> {
  if (execution.claimed) return null;
  // An intent from before images were stored takes the current setting.
  const image = stored.image ?? ctx.options.image;
  if ((await retractedImagesOf(ctx)).rebuildsRetracted(image)) {
    return "retracted";
  }
  if (await engineDropped(ctx, execution.sessionId)) return "engine_dropped";
  return limitsChanged(ctx, execution) ? "limits_changed" : null;
}

export type GiveBackCause = "retracted" | "engine_dropped" | "limits_changed";

/**
 * The launch runs worker limits other than the ones a launch reserved now
 * takes: its pinned ones, else those its resource was started with. One with
 * neither is built with the current ones, so it never differs; nor does
 * anything while this pass could not read them.
 */
export function limitsChanged(
  ctx: PassContext,
  execution: ActiveExecution,
  observed?: ExecutionObservation,
): boolean {
  const own = execution.resources?.workerLimits ?? observed?.workerLimits;
  const current = ctx.workerLimits;
  return (
    own != null &&
    current !== null &&
    (own.maxTurnSeconds !== current.maxTurnSeconds ||
      own.providerMaxRetries !== current.providerMaxRetries)
  );
}

/** A build that waits for a pass that can read the worker limits. */
export function reportHeldForLimits(
  ctx: PassContext,
  execution: ActiveExecution,
  reason: "missing" | ReplaceReason,
): void {
  ctx.logger.warn(
    "Launch held: the worker limits it would start with cannot be read",
    {
      ...fieldsOf(refOf(execution)),
      reason,
      session_id: execution.sessionId,
    },
  );
}

/** Counts and logs a launch given back unbuilt, under its cause. */
export function reportGivenBack(
  ctx: PassContext,
  ref: ExecutionRef,
  cause: GiveBackCause,
  done: "given back" | "torn down",
  fields: Record<string, unknown>,
): void {
  if (cause === "retracted") {
    ctx.summary.launchesRetracted.push(ref);
    ctx.logger.warn(
      `Launch's worker image is retracted; ${done} unbuilt so its session chooses an image again`,
      { ...fieldsOf(ref), ...fields },
    );
  } else if (cause === "engine_dropped") {
    ctx.summary.launchesEngineDropped.push(ref);
    ctx.logger.warn(
      `No configured worker image runs the launch's session engine; ${done} unbuilt so its session waits for one`,
      { ...fieldsOf(ref), ...fields },
    );
  } else {
    ctx.summary.launchesLimitsChanged.push(ref);
    ctx.logger.warn(
      `Launch was reserved with other worker limits; ${done} unbuilt so its session launches with the current ones`,
      { ...fieldsOf(ref), ...fields },
    );
  }
}

/**
 * No unretracted configured image runs the session's engine: an upgrade
 * dropped it after this launch was reserved. Its worker would find the
 * session in no claim catalog and exit, counted as a failed launch each
 * time until the launch is quarantined; given back, the session waits for
 * an image of its engine without a slot.
 */
function engineDropped(ctx: PassContext, sessionId: string): Promise<boolean> {
  let judged = droppedJudges.get(ctx);
  if (judged === undefined) {
    judged = new Map();
    droppedJudges.set(ctx, judged);
  }
  let dropped = judged.get(sessionId);
  if (dropped === undefined) {
    dropped = judgeEngineDropped(ctx, sessionId);
    judged.set(sessionId, dropped);
  }
  return dropped;
}

// Asked by reconcile, replace and reensure for one launch in one pass.
const droppedJudges = new WeakMap<PassContext, Map<string, Promise<boolean>>>();

async function judgeEngineDropped(
  ctx: PassContext,
  sessionId: string,
): Promise<boolean> {
  const { options, store } = ctx;
  if (
    options.engineOfKind === undefined ||
    options.imageRuntime === undefined
  ) {
    return false;
  }
  const { runtimeKind } = await store.pointerRuntimeOf(sessionId);
  const engine =
    runtimeKind === null ? null : (options.engineOfKind(runtimeKind) ?? null);
  const retracted = options.retractedImages ?? [];
  return !imagesOfEngine(
    [
      { image: options.image, runtime: options.imageRuntime },
      ...(options.olderImages ?? []),
    ],
    engine,
  ).some(
    ({ image, runtime }) =>
      !retracted.some(
        (entry) =>
          entry.image === image && sameCombination(entry.runtime, runtime),
      ),
  );
}

/**
 * A launch whose resource runs a retracted image. Unclaimed, it is judged as
 * a rebuild would be: given back on doubt, which costs its session no more
 * than choosing an image again. Claimed, a worker is serving its session, so
 * only an image known retracted counts: draining it ends that worker.
 */
export async function runsRetracted(
  ctx: PassContext,
  execution: ActiveExecution,
): Promise<boolean> {
  if (!ctx.options.retractedImages?.length) return false;
  if (execution.claimed) {
    // A row from before images were stored says nothing of what its worker
    // runs, and the current setting is no evidence of it either.
    const image = execution.image;
    if (image === null) return false;
    return (await retractedImagesOf(ctx)).pinned.some(
      (retracted) => imageIdentity(retracted) === imageIdentity(image),
    );
  }
  return (await retractedImagesOf(ctx)).rebuildsRetracted(
    execution.image ?? ctx.options.image,
  );
}

type RetractedImages = {
  /** The retracted images as configured and as this backend pins them. */
  pinned: readonly string[];
  /** Whether rebuilding a stored image could run a retracted one. */
  rebuildsRetracted: (image: string) => boolean;
};

const retractedJudges = new WeakMap<PassContext, Promise<RetractedImages>>();

/**
 * The retracted images as this backend pins them (for Docker, the image id
 * a stored intent holds), resolved once per pass and only when asked. A
 * retracted image it cannot resolve may still be the one an intent holds by
 * id, under a tag it keeps; then only an image resolved from an unretracted
 * entry is built again. Giving an unclaimed launch back costs its session no
 * more than choosing an image again. `pinned` keeps to what is known
 * retracted: it is what a record and a DM say.
 */
function retractedImagesOf(ctx: PassContext): Promise<RetractedImages> {
  let judge = retractedJudges.get(ctx);
  if (judge === undefined) {
    judge = (async () => {
      const configured = (ctx.options.retractedImages ?? []).map(
        ({ image }) => image,
      );
      const resolveAll = async (images: readonly string[]) => {
        const resolved = new Set(images);
        let complete = true;
        for (const image of images) {
          try {
            resolved.add(await ctx.backend.resolveImage(image));
          } catch {
            complete = false;
          }
        }
        return { complete, resolved };
      };
      const retracted = await resolveAll(configured);
      const pinned = [...retracted.resolved];
      if (everyImageRetracted(ctx.options)) {
        return { pinned, rebuildsRetracted: () => true };
      }
      if (retracted.complete) {
        return {
          pinned,
          rebuildsRetracted: (image) => retracted.resolved.has(image),
        };
      }
      const { resolved: launchable } = await resolveAll([
        ctx.options.image,
        ...(ctx.options.olderImages ?? []).map(({ image }) => image),
      ]);
      return {
        pinned,
        rebuildsRetracted: (image) =>
          retracted.resolved.has(image) || !launchable.has(image),
      };
    })();
    retractedJudges.set(ctx, judge);
  }
  return judge;
}

/**
 * Listed digests are unique, so `image` is retracted only when every listed
 * image is; then nothing is launched or built again.
 */
function everyImageRetracted(
  options: Pick<SchedulerOptions, "image" | "retractedImages">,
): boolean {
  return (options.retractedImages ?? []).some(
    ({ image }) => image === options.image,
  );
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

/**
 * Refuses a launch whose image needs a Codex sandbox the installation does
 * not have, before anything is created: the queued input fails with
 * `CODEX_SANDBOX_NOT_INSTALLED` and the session waits for its next input.
 * True when it was refused (or moved on meanwhile), so the caller stops.
 */
export async function refusedForCodexSandbox(
  ctx: PassContext,
  execution: ExecutionRef & { sessionId: string | null },
  image: string | null,
): Promise<boolean> {
  const missing =
    image === null ? undefined : ctx.backend.missingCodexSandbox?.(image);
  if (missing === undefined) return false;
  const ref = refOf(execution);
  ctx.lock.throwIfAborted();
  if (await ctx.store.giveUpForCodexSandbox(ref, missing)) {
    ctx.summary.launchesNoCodexSandbox.push(ref);
    ctx.logger.error(
      "Execution refused: no Codex sandbox on this installation; queued input failed with CODEX_SANDBOX_NOT_INSTALLED",
      { ...fieldsOf(ref), reason: missing, session_id: execution.sessionId },
    );
  }
  return true;
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
    // A retracted image is judged with, never pinned: one gone from the
    // registry must not stop admission on the others.
    const retracted = options.retractedImages ?? [];
    const configured: PinnedImage[] = [
      { image: options.image, runtime: options.imageRuntime },
      ...(options.imageRuntime === undefined
        ? []
        : (options.olderImages ?? [])),
    ].filter(
      ({ image, runtime }) =>
        runtime === undefined ||
        !retracted.some(
          (entry) =>
            entry.image === image && sameCombination(entry.runtime, runtime),
        ),
    );
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
    return { pinned, refused, retracted };
  };
  // The image this session launches on; null when it waits this pass.
  const imageFor = async (
    sessionId: string,
    available: PinnedImages,
  ): Promise<PinnedImage | null> => {
    const [current] = available.pinned;
    if (current?.runtime === undefined && available.retracted.length === 0) {
      return current ?? null;
    }
    const { pointer, checkpointRevision, runtimeKind } =
      await store.pointerRuntimeOf(sessionId);
    const engine =
      options.engineOfKind === undefined
        ? undefined
        : runtimeKind === null
          ? null
          : (options.engineOfKind(runtimeKind) ?? null);
    // Never empty: options.image is either pinned or retracted.
    const selection = selectWorkerImage(
      pointer,
      [
        ...available.pinned.map(({ image, runtime }) => ({
          image,
          runtime: runtime as ImageRuntime,
        })),
        ...available.retracted.map(({ image, runtime }) => ({
          image,
          runtime,
          retracted: true,
        })),
      ] as [WorkerImageCandidate<string>, ...WorkerImageCandidate<string>[]],
      engine,
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
    // Not held: it waits for an image of its engine, uses no slot, and the
    // API says why (its runtime is not shipped) on each read.
    if (selection.reason === "engine_unavailable") {
      summary.waitingForEngine.push(sessionId);
      return null;
    }
    // A session with no checkpoint is not held: it waits, and the API says
    // why (every image retracted) on each read.
    if (pointer.kind === "none") return null;
    lock.throwIfAborted();
    const held = await store.holdIncompatibleBeforeLaunch({
      sessionId,
      checkpointRevision,
      reason: selection.reason,
      detail: selection.detail,
      now: now(),
    });
    if (held === "held") {
      (selection.reason === "runtime_retired"
        ? summary.heldRetired
        : summary.heldIncompatible
      ).push(sessionId);
      logger.warn(
        selection.reason === "runtime_retired"
          ? "Only a retracted worker image runs the session's checkpoint; stopped before launch as runtime_retired"
          : "No configured worker image matches the session's checkpoint; stopped before launch as incompatible_checkpoint",
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
    const retractedImages =
      images.retracted.length === 0
        ? undefined
        : (await retractedImagesOf(ctx)).pinned;
    lock.throwIfAborted();
    const stored = await store.reserveLaunch({
      backend: backend.kind,
      image: chosen.image,
      ...(chosen.runtime === undefined ? {} : { imageRuntime: chosen.runtime }),
      ...(retractedImages === undefined ? {} : { retractedImages }),
      now: now(),
      // Pinned to this pass's limits; the pass reserves nothing without them.
      resources:
        ctx.workerLimits === null
          ? options.resources
          : { ...options.resources, workerLimits: ctx.workerLimits },
      sessionId,
      slotLimit: options.slotLimit,
    });
    if (stored === null) continue;
    free -= 1;
    const ref = refOf(stored);
    if (
      await refusedForCodexSandbox(ctx, { ...ref, sessionId }, chosen.image)
    ) {
      continue;
    }
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
