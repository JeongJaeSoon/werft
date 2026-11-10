import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  getReceiptResponseSchema,
  type Receipt,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createSessionService,
  type SessionReader,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerReceiptRoutes } from "./receipts.ts";

const createApiApp = recordRouteErrors("routes/receipts.test.ts");

const receipt: Receipt = {
  id: "4d6d1a3e-1f1c-4c3a-9f3e-2b1c1d1e1f10",
  operation: "create_session",
  target_ref: {
    session_id: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d",
    turn_id: "1",
    request_id: null,
  },
  status: "accepted",
  result: { session_id: "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d" },
  error: null,
  created_at: "2026-09-22T00:00:00.000Z",
  updated_at: "2026-09-22T00:00:00.000Z",
};

function app(getReceipt: SessionReader["getReceipt"]) {
  const service = createSessionService({
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
    authorization: createAuthorizationPolicy(),
    catalog: { connections: {}, repositories: {} },
    inputs: {
      acceptInputAtomic: async () => {
        throw new Error("not reached");
      },
      appendInputAtomic: async () => {
        throw new Error("not reached");
      },
    },
    controls: {
      terminateAtomic: async () => {
        throw new Error("not reached");
      },
      pauseAtomic: async () => {
        throw new Error("not reached");
      },
      closeAtomic: async () => {
        throw new Error("not reached");
      },
      decideRecoveryAtomic: async () => {
        throw new Error("not reached");
      },
      resumeAtomic: async () => {
        throw new Error("not reached");
      },
      renameAtomic: async () => {
        throw new Error("not reached");
      },
    },
    reader: {
      listSessions: async () => ({ items: [], next_cursor: null }),
      countSessions: async () => {
        throw new Error("not reached");
      },
      getSession: async () => null,
      listTurns: async () => null,
      getTurn: async () => null,
      getReceipt,
      readEvents: async () => null,
    },
  });
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerReceiptRoutes(router, service),
  });
}

function get(
  api: ReturnType<typeof app>,
  id: string,
  owner: string | null = "owner-a",
) {
  return api.request(`/v1/receipts/${id}`, {
    headers: owner ? { "X-Owner-Id": owner } : {},
  });
}

describe("GET /v1/receipts/{id}", () => {
  test("returns the owner's receipt in contract shape", async () => {
    const seen: string[][] = [];
    const response = await get(
      app(async (ownerId, receiptId) => {
        seen.push([ownerId, receiptId]);
        return receipt;
      }),
      receipt.id,
    );
    expect(response.status).toBe(200);
    expect(getReceiptResponseSchema.parse(await response.json())).toEqual(
      receipt,
    );
    expect(seen).toEqual([["owner-a", receipt.id]]);
  });

  test("answers 404 for another owner's or a missing receipt", async () => {
    const response = await get(
      app(async () => null),
      receipt.id,
    );
    expect(response.status).toBe(404);
    const body = apiErrorResponseSchema.parse(await response.json());
    expect(body.error).toMatchObject({ code: "NOT_FOUND", details: null });
  });

  test("treats a malformed id as not found without hitting storage", async () => {
    let calls = 0;
    const response = await get(
      app(async () => {
        calls += 1;
        return receipt;
      }),
      "not-a-uuid",
    );
    expect(response.status).toBe(404);
    expect(calls).toBe(0);
  });

  test("requires authentication", async () => {
    const response = await get(
      app(async () => receipt),
      receipt.id,
      null,
    );
    expect(response.status).toBe(401);
  });

  test("maps a storage outage to a retryable 503", async () => {
    const response = await get(
      app(async () => {
        throw Object.assign(new Error("connection refused"), {
          code: "ECONNREFUSED",
        });
      }),
      receipt.id,
    );
    expect(response.status).toBe(503);
    expect(
      apiErrorResponseSchema.parse(await response.json()).error,
    ).toMatchObject({ code: "BACKEND_UNAVAILABLE", retryable: true });
  });
});
