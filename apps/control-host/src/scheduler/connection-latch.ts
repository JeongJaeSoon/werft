import { isConnectionFailure } from "@werft-ai/db/pool";
import type { SchedulerStore } from "@werft-ai/platform";

/**
 * The connection is gone, not the statement: 08xxx connection exceptions,
 * 57P0x shutdowns, socket errors and pg's code-less connection failures. Not
 * the API's `isStorageUnavailable`: that one also takes 57014, and a
 * statement_timeout here can be one row waiting on a lock, which the pass
 * treats as that row's failure and moves on from.
 */
export function isConnectionLoss(error: unknown): boolean {
  for (let depth = 0, current = error; depth < 5; depth += 1) {
    if (isConnectionFailure(current)) return true;
    const code = (current as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("57P")) return true;
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}

export type ConnectionLatch = {
  store: SchedulerStore;
  /** The failure that tripped the latch, if one did. */
  lost(): unknown;
};

/**
 * Once one store call has lost the connection, every later one fails at once
 * with that same error. The pass reconciles each live execution on its own
 * and carries on past a failure there, so against a frozen database each one
 * would otherwise wait out its own connect timeout and the pass would grow
 * with the number of live rows. The release of the lock `acquirePassLock`
 * returns is left alone: it has to run on the locked connection whatever
 * happened.
 */
export function latchOnConnectionLoss(
  store: SchedulerStore,
  onLost: (error: unknown) => void,
): ConnectionLatch {
  let lost: { error: unknown } | undefined;
  // Object.fromEntries keeps no per-method types, so the result is cast back.
  const latched = Object.fromEntries(
    Object.entries(store).map(([name, method]) => [
      name,
      async (...args: unknown[]) => {
        if (lost !== undefined) throw lost.error;
        try {
          return await (method as (...a: unknown[]) => Promise<unknown>).apply(
            store,
            args,
          );
        } catch (error) {
          if (lost === undefined && isConnectionLoss(error)) {
            lost = { error };
            onLost(error);
          }
          throw error;
        }
      },
    ]),
  ) as unknown as SchedulerStore;
  return { store: latched, lost: () => lost?.error };
}
