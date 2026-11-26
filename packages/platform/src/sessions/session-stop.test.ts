import { describe, expect, test } from "bun:test";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  type AuthorizationPolicy,
  SessionServiceError,
} from "../musterrolle/index.ts";
import type {
  StopQueuedInput,
  StopQueuedResult,
} from "./ports/session-stops.ts";
import { createSessionStop } from "./session-stop.ts";

const SESSION = "11111111-1111-4111-8111-111111111111";
const BEFORE = new Date("2026-11-26T03:00:00Z");

function policy(outcome: "allow" | "deny"): AuthorizationPolicy {
  return {
    authorize: async () => ({
      outcome,
      reason_code: outcome === "allow" ? "ok" : "role",
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
      cancelQueuedBefore: async (input) => {
        calls.push("cancel");
        cancels.push(input);
        return queued;
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
    queuedBefore: BEFORE,
  });
  return { result, calls, cancels, interrupts };
}

describe("createSessionStop", () => {
  test("cancels the queued input before the request, then interrupts the running turn", async () => {
    const run = stopWith({
      outcome: "cancelled",
      cancelled: 2,
      runningTurnId: "3",
    });
    expect(await run.result).toEqual({
      outcome: "stopped",
      interrupted: true,
      cancelled: 2,
    });
    expect(run.calls).toEqual(["cancel", "interrupt"]);
    expect(run.cancels[0]?.queuedBefore).toEqual(BEFORE);
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
    });
    expect(await run.result).toEqual({
      outcome: "stopped",
      interrupted: false,
      cancelled: 1,
    });
    expect(run.calls).toEqual(["cancel"]);
  });

  test("nothing running and nothing queued", async () => {
    const run = stopWith({
      outcome: "cancelled",
      cancelled: 0,
      runningTurnId: null,
    });
    expect(await run.result).toEqual({ outcome: "nothing_running" });
  });

  test("a turn that ended since it was read is nothing to interrupt", async () => {
    const run = stopWith(
      { outcome: "cancelled", cancelled: 0, runningTurnId: "3" },
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
      { outcome: "cancelled", cancelled: 1, runningTurnId: "3" },
      { authorization: policy("deny") },
    );
    expect(await run.result).toEqual({ outcome: "not_permitted" });
    expect(run.calls).toEqual([]);
  });

  test("a closed session is left as it is", async () => {
    const run = stopWith({ outcome: "closed" });
    expect(await run.result).toEqual({ outcome: "closed" });
    expect(run.calls).toEqual(["cancel"]);
  });
});
