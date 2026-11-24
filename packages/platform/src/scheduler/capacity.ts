import { CAPACITY_WAIT_LIMIT_MS } from "./options.ts";
import { fieldsOf, type PassContext, refOf } from "./pass-context.ts";
import type { ExecutionObservation } from "./ports/execution-backend.ts";
import type { ActiveExecution } from "./ports/scheduler-store.ts";

/**
 * The provider's reason an unclaimed launch's resource has no room, or
 * undefined when it is not waiting for room.
 */
export function capacityShortageOf(
  execution: ActiveExecution,
  observed: ExecutionObservation,
): { message: string } | undefined {
  if (execution.claimed || !observed.found || observed.state !== "pending") {
    return undefined;
  }
  return observed.unschedulable;
}

/**
 * The resource waits for room: the wait is recorded and logged, room is
 * asked for, and past `CAPACITY_WAIT_LIMIT_MS` the launch is given up on.
 * Never replaced meanwhile: a rebuilt resource waits for the same room.
 */
export async function waitForCapacity(
  ctx: PassContext,
  execution: ActiveExecution,
  message: string,
): Promise<void> {
  const { lock, logger, store, summary } = ctx;
  const ref = refOf(execution);
  lock.throwIfAborted();
  const wait = await store.recordCapacityWait(ref, message);
  // A worker bound, or the launch moved on, since the rows were read.
  if (wait === null) return;
  const fields = {
    ...fieldsOf(ref),
    unschedulable_reason: message,
    session_id: execution.sessionId,
    waiting_since: wait.since.toISOString(),
    waited_ms: wait.waitedMs,
  };
  if (wait.began) {
    logger.warn("Execution waiting for capacity; no node has room", fields);
  } else if (wait.previousMessage !== message) {
    logger.warn("Execution still waiting for capacity", fields);
  }
  if (wait.waitedMs >= CAPACITY_WAIT_LIMIT_MS) {
    lock.throwIfAborted();
    if (await store.giveUpForCapacity(ref, CAPACITY_WAIT_LIMIT_MS)) {
      summary.launchesNoCapacity.push(ref);
      logger.error(
        "Execution found no capacity in time; queued input failed with NO_CAPACITY",
        { ...fields, limit_ms: CAPACITY_WAIT_LIMIT_MS },
      );
    }
    return;
  }
  summary.waitingForCapacity.push(ref);
  await makeRoom(ctx, execution);
}

/** The wait ended: the resource has room now, or is no longer pending. */
export async function capacityFound(
  ctx: PassContext,
  execution: ActiveExecution,
  observed: ExecutionObservation,
): Promise<void> {
  const ref = refOf(execution);
  ctx.lock.throwIfAborted();
  const waitedMs = await ctx.store.clearCapacityWait(ref);
  if (waitedMs === null) return;
  ctx.logger.info("Execution waited for capacity and found it", {
    ...fieldsOf(ref),
    found: observed.found,
    session_id: execution.sessionId,
    state: observed.state,
    waited_ms: waitedMs,
  });
}

/**
 * Where room is made for a launch that waits for it, called on every pass
 * while it waits. Nothing makes room yet; taking down the worker that has
 * been idle longest goes here.
 */
async function makeRoom(
  _ctx: PassContext,
  _execution: ActiveExecution,
): Promise<void> {}
