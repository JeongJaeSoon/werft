import { describe, expect, test } from "bun:test";
import { type ApiErrorCode, apiErrorResponseSchema } from "@werft-ai/contracts";
import {
  type CloseSessionResult,
  createAuthorizationPolicy,
  createSessionService,
  type SessionControl,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerCloseRoutes } from "./sessions/close.ts";

const createApiApp = recordRouteErrors("routes/close.test.ts");

const sessionId = "019a0000-0000-7000-8000-000000000001";
const path = `/v1/sessions/${sessionId}/close`;

const notReached = async (): Promise<never> => {
  throw new Error("not reached");
};

function close(
  body: unknown,
  closeAtomic: SessionControl["closeAtomic"] = notReached,
  headers: Record<string, string> = {},
  at = path,
) {
  const service = createSessionService({
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
    authorization: createAuthorizationPolicy(),
    catalog: { profiles: {}, repositories: {} },
    inputs: { acceptInputAtomic: notReached, appendInputAtomic: notReached },
    controls: {
      terminateAtomic: notReached,
      pauseAtomic: notReached,
      closeAtomic,
      decideRecoveryAtomic: notReached,
      resumeAtomic: notReached,
      changeProfileAtomic: notReached,
      renameAtomic: notReached,
    },
    reader: {
      listSessions: notReached,
      countSessions: notReached,
      getSession: notReached,
      listTurns: notReached,
      getTurn: notReached,
      getReceipt: notReached,
      hiddenAgentRefs: notReached,
      readEvents: notReached,
    },
  });
  const app = createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerCloseRoutes(router, service),
  });
  return app.request(at, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Owner-Id": "owner-a",
      "Idempotency-Key": "key-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

const answering =
  (result: CloseSessionResult): SessionControl["closeAtomic"] =>
  async () =>
    result;

describe("POST /v1/sessions/{id}/close", () => {
  test("answers 202 with the receipt, passing revision and reason through", async () => {
    const receiptId = crypto.randomUUID();
    const response = await close(
      { expected_revision: 3, reason: "work is done" },
      async (input) => {
        expect(input).toMatchObject({
          principal: { ownerId: "owner-a" },
          sessionId,
          idempotencyKey: "key-1",
          expectedRevision: 3,
          reason: "work is done",
        });
        return {
          outcome: "accepted",
          response: { receipt_id: receiptId, receipt_status: "accepted" },
        };
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      receipt_id: receiptId,
      receipt_status: "accepted",
    });
  });

  test("the same key and body replay the first receipt; another body is IDEMPOTENCY_CONFLICT", async () => {
    const receiptId = crypto.randomUUID();
    const hashes: string[] = [];
    const store: SessionControl["closeAtomic"] = async (input) => {
      hashes.push(input.payloadHash);
      if (hashes.length === 1) {
        return {
          outcome: "accepted",
          response: { receipt_id: receiptId, receipt_status: "accepted" },
        };
      }
      return input.payloadHash === hashes[0]
        ? {
            outcome: "replayed",
            response: { receipt_id: receiptId, receipt_status: "succeeded" },
          }
        : { outcome: "conflict" };
    };
    expect((await close({ expected_revision: 3 }, store)).status).toBe(202);
    const replay = await close({ expected_revision: 3 }, store);
    expect([replay.status, await replay.json()]).toEqual([
      202,
      { receipt_id: receiptId, receipt_status: "succeeded" },
    ]);
    const other = await close({ expected_revision: 4 }, store);
    expect([other.status, await errorCode(other)]).toEqual([
      409,
      "IDEMPOTENCY_CONFLICT",
    ]);
  });

  test("requires Idempotency-Key and expected_revision, and rejects extra fields", async () => {
    expect(
      (
        await close({ expected_revision: 1 }, notReached, {
          "Idempotency-Key": "",
        })
      ).status,
    ).toBe(400);
    expect((await close({ reason: "no revision" })).status).toBe(400);
    expect((await close({ expected_revision: 1, force: true })).status).toBe(
      400,
    );
    expect(
      (await close({ expected_revision: 1, reason: "x".repeat(65 * 1024) }))
        .status,
    ).toBe(413);
    expect(
      (
        await close(
          { expected_revision: 1 },
          notReached,
          {},
          "/v1/sessions/not-a-uuid/close",
        )
      ).status,
    ).toBe(404);
  });

  test("maps each refusal to its status and code", async () => {
    const cases: Array<[CloseSessionResult, number, ApiErrorCode]> = [
      [
        { outcome: "revision_conflict", currentRevision: 4 },
        409,
        "REVISION_CONFLICT",
      ],
      [{ outcome: "conflict" }, 409, "IDEMPOTENCY_CONFLICT"],
      [
        { outcome: "rejected", admissionState: "pausing" },
        409,
        "SESSION_PAUSED",
      ],
      [
        { outcome: "rejected", admissionState: "resuming" },
        409,
        "SESSION_RESUMING",
      ],
      [
        { outcome: "rejected", admissionState: "stopping" },
        409,
        "SESSION_STOPPED",
      ],
      [
        { outcome: "rejected", admissionState: "closing" },
        409,
        "SESSION_CLOSING",
      ],
      [
        { outcome: "rejected", admissionState: "closed" },
        409,
        "SESSION_CLOSED",
      ],
      [{ outcome: "recovery_required" }, 409, "RECOVERY_REQUIRED"],
      [{ outcome: "checkpoint_unavailable" }, 409, "CHECKPOINT_UNAVAILABLE"],
      [{ outcome: "unsupported" }, 422, "UNSUPPORTED_CAPABILITY"],
      [{ outcome: "not_found" }, 404, "NOT_FOUND"],
    ];
    for (const [result, status, code] of cases) {
      const response = await close({ expected_revision: 1 }, answering(result));
      expect([response.status, await errorCode(response)]).toEqual([
        status,
        code,
      ]);
    }
  });
});
