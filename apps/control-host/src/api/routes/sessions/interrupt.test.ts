import { describe, expect, test } from "bun:test";
import { apiErrorResponseSchema } from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createInterruptService,
  type InterruptTurnInput,
  type InterruptTurnResult,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerInterruptRoutes } from "./interrupt.ts";

const createApiApp = recordRouteErrors("routes/sessions/interrupt.test.ts");

const SESSION = "11111111-1111-4111-8111-111111111111";
const RECEIPT = "019a0000-0000-7000-8000-000000000001";

function interrupt(
  result: InterruptTurnResult,
  body: unknown = { target_turn_id: "3" },
  headers: Record<string, string> = { "Idempotency-Key": "key-1" },
) {
  const seen: InterruptTurnInput[] = [];
  const service = createInterruptService({
    authorization: createAuthorizationPolicy(),
    store: {
      interruptAtomic: async (input) => {
        seen.push(input);
        return result;
      },
    },
  });
  const response = createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerInterruptRoutes(router, service),
  }).request(`/v1/sessions/${SESSION}/interrupt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Owner-Id": "owner-a",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { response, seen };
}

async function errorOf(response: Response | Promise<Response>) {
  const settled = await response;
  return {
    status: settled.status,
    code: apiErrorResponseSchema.parse(await settled.json()).error.code,
  };
}

const accepted: InterruptTurnResult = {
  outcome: "accepted",
  response: { receipt_id: RECEIPT, receipt_status: "accepted" },
};

describe("interrupt route", () => {
  test("accepts with 202 and hands the store the target and key", async () => {
    const { response, seen } = interrupt(accepted);
    const settled = await response;
    expect(settled.status).toBe(202);
    expect(await settled.json()).toEqual({
      receipt_id: RECEIPT,
      receipt_status: "accepted",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      principal: { ownerId: "owner-a" },
      sessionId: SESSION,
      idempotencyKey: "key-1",
      targetTurnId: "3",
    });
  });

  test("a replay answers the stored response with 202", async () => {
    const { response } = interrupt({
      outcome: "replayed",
      response: { receipt_id: RECEIPT, receipt_status: "succeeded" },
    });
    const settled = await response;
    expect(settled.status).toBe(202);
    expect(await settled.json()).toEqual({
      receipt_id: RECEIPT,
      receipt_status: "succeeded",
    });
  });

  test("a queued turn is 409 TURN_NOT_STARTED", async () => {
    expect(
      await errorOf(interrupt({ outcome: "not_started" }).response),
    ).toEqual({ status: 409, code: "TURN_NOT_STARTED" });
  });

  test("a reused key with another target is 409 IDEMPOTENCY_CONFLICT", async () => {
    expect(await errorOf(interrupt({ outcome: "conflict" }).response)).toEqual({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  test("an unknown session or turn is 404", async () => {
    expect(await errorOf(interrupt({ outcome: "not_found" }).response)).toEqual(
      {
        status: 404,
        code: "NOT_FOUND",
      },
    );
  });

  test("a session on the legacy pod lifecycle is 422", async () => {
    expect(
      await errorOf(interrupt({ outcome: "unsupported" }).response),
    ).toEqual({ status: 422, code: "UNSUPPORTED_CAPABILITY" });
  });

  test("the store is not reached without an Idempotency-Key or a valid target", async () => {
    const missingKey = interrupt(accepted, { target_turn_id: "3" }, {});
    expect(await errorOf(missingKey.response)).toMatchObject({ status: 400 });
    expect(missingKey.seen).toHaveLength(0);

    for (const body of [
      { target_turn_id: "" },
      {},
      // An interrupt names one turn and nothing else.
      { target_turn_id: "3", reason: "stop" },
    ]) {
      const invalid = interrupt(accepted, body);
      expect((await invalid.response).status).toBe(400);
      expect(invalid.seen).toHaveLength(0);
    }
    const oversized = interrupt(accepted, {
      target_turn_id: "x".repeat(65 * 1024),
    });
    expect(await errorOf(oversized.response)).toEqual({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
    expect(oversized.seen).toHaveLength(0);
  });
});
