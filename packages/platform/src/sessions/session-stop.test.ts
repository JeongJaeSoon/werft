import { describe, expect, test } from "bun:test";
import type { AuthorizationReason } from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  type AuthorizationPolicy,
  AuthorizationUndecidedError,
  SessionServiceError,
} from "../access-control/index.ts";
import type {
  StopQueuedInput,
  StopQueuedResult,
} from "./ports/session-stops.ts";
import { createSessionStop } from "./session-stop.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";

function policy(
  outcome: "allow" | "deny",
  reason: AuthorizationReason = outcome === "allow" ? "ok" : "role",
): AuthorizationPolicy {
  return {
    authorize: async () => ({
      outcome,
      reason_code: reason,
      effective_scopes: [],
    }),
  } as unknown as AuthorizationPolicy;
}

// Called the way any input path calls it: no Slack event, no thread.
function stopWith(
  queued: StopQueuedResult,
  options: {
    authorization?: AuthorizationPolicy;
    interrupt?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const cancels: StopQueuedInput[] = [];
  const interrupts: unknown[] = [];
  const stop = createSessionStop({
    authorization: options.authorization ?? policy("allow"),
    stops: {
      cancelQueued: async (input) => {
        calls.push("cancel");
        cancels.push(input);
        return queued;
      },
      stoppedIn: async () => {
        throw new Error("not asked here");
      },
    },
    interrupts: {
      interrupt: async (_actor, sessionId, input) => {
        calls.push("interrupt");
        interrupts.push({ sessionId, ...input });
        await options.interrupt?.();
        return { receipt_id: "r", receipt_status: "accepted" };
      },
    },
  });
  const result = stop.stop(testCaller("owner-a"), SESSION, {
    idempotencyKey: "stop-1",
  });
  return { result, calls, cancels, interrupts };
}

describe("createSessionStop", () => {
  test("cancels the queued input before the request, then interrupts the running turn", async () => {
    const run = stopWith({
      outcome: "cancelled",
      cancelled: 2,
      runningTurnId: "3",
      closed: false,
    });
    expect(await run.result).toEqual({
      outcome: "stopped",
      interrupted: true,
      cancelled: 2,
      closed: false,
    });
    expect(run.calls).toEqual(["cancel", "interrupt"]);
    expect(run.cancels.map((cancel) => cancel.sessionId)).toEqual([SESSION]);
    expect(run.interrupts).toEqual([
      {
        sessionId: SESSION,
        idempotencyKey: "stop-1",
        body: { target_turn_id: "3" },
      },
    ]);
  });

  test("queued input alone is stopped too", async () => {
    const run = stopWith({
      outcome: "cancelled",
      cancelled: 1,
      runningTurnId: null,
      closed: false,
    });
    expect(await run.result).toEqual({
      outcome: "stopped",
      interrupted: false,
      cancelled: 1,
      closed: false,
    });
    expect(run.calls).toEqual(["cancel"]);
  });

  test("a task the stop closed before its first turn says so", async () => {
    const run = stopWith({
      outcome: "cancelled",
      cancelled: 1,
      runningTurnId: null,
      closed: true,
    });
    expect(await run.result).toEqual({
      outcome: "stopped",
      interrupted: false,
      cancelled: 1,
      closed: true,
    });
    expect(run.calls).toEqual(["cancel"]);
  });

  test("nothing running and nothing queued", async () => {
    const run = stopWith({
      outcome: "cancelled",
      cancelled: 0,
      runningTurnId: null,
      closed: false,
    });
    expect(await run.result).toEqual({ outcome: "nothing_running" });
  });

  test("a turn put back in the queue since it was read is nothing to interrupt", async () => {
    const run = stopWith(
      { outcome: "cancelled", cancelled: 0, runningTurnId: "3", closed: false },
      {
        interrupt: async () => {
          throw new SessionServiceError("TURN_NOT_STARTED", "queued");
        },
      },
    );
    expect(await run.result).toEqual({ outcome: "nothing_running" });
  });

  test("a caller who may not control the session stops nothing", async () => {
    const run = stopWith(
      { outcome: "cancelled", cancelled: 1, runningTurnId: "3", closed: false },
      { authorization: policy("deny") },
    );
    expect(await run.result).toEqual({ outcome: "not_permitted" });
    expect(run.calls).toEqual([]);
  });

  test("a caller who may not even see the session stops nothing, and is not asked again", async () => {
    const run = stopWith(
      { outcome: "cancelled", cancelled: 1, runningTurnId: "3", closed: false },
      { authorization: policy("deny", "not_found") },
    );
    expect(await run.result).toEqual({ outcome: "not_permitted" });
    expect(run.calls).toEqual([]);
  });

  test("an authorization that could not be decided is passed on, to be retried", async () => {
    const run = stopWith(
      { outcome: "cancelled", cancelled: 1, runningTurnId: "3", closed: false },
      {
        authorization: {
          authorize: async () => {
            throw new AuthorizationUndecidedError(new Error("store down"));
          },
        } as unknown as AuthorizationPolicy,
      },
    );
    await expect(run.result).rejects.toBeInstanceOf(
      AuthorizationUndecidedError,
    );
    expect(run.calls).toEqual([]);
  });

  test("a closed session is left as it is", async () => {
    const run = stopWith({ outcome: "closed" });
    expect(await run.result).toEqual({ outcome: "closed" });
    expect(run.calls).toEqual(["cancel"]);
  });
});

describe("stoppedBefore", () => {
  function storeWith(stopped: boolean) {
    const asked: { sessionIds: readonly string[]; idempotencyKey: string }[] =
      [];
    const stop = createSessionStop({
      // Nothing is authorized: the answer only ends a post read again.
      authorization: policy("deny"),
      stops: {
        cancelQueued: async () => {
          throw new Error("no stop is made");
        },
        stoppedIn: async (input) => {
          asked.push(input);
          return stopped;
        },
      },
      interrupts: {
        interrupt: async () => {
          throw new Error("no turn is interrupted");
        },
      },
    });
    return { stop, asked };
  }

  test("asks the store about the closed sessions under the stop's key", async () => {
    const { stop, asked } = storeWith(true);
    expect(
      await stop.stoppedBefore([SESSION], { idempotencyKey: "stop-1" }),
    ).toBe(true);
    expect(asked).toEqual([
      { sessionIds: [SESSION], idempotencyKey: "stop-1" },
    ]);
    expect(
      await storeWith(false).stop.stoppedBefore([SESSION], {
        idempotencyKey: "stop-2",
      }),
    ).toBe(false);
  });

  test("a thread with no closed session made no stop, and the store is not asked", async () => {
    const { stop, asked } = storeWith(true);
    expect(await stop.stoppedBefore([], { idempotencyKey: "stop-1" })).toBe(
      false,
    );
    expect(asked).toEqual([]);
  });
});
