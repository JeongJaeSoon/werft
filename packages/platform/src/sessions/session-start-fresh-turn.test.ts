import { describe, expect, test } from "bun:test";
import type { AuthorizationPolicy } from "../musterrolle/policy.ts";
import { SessionServiceError } from "../musterrolle/service-errors.ts";
import { testCatalog } from "../testing/catalog-fakes.ts";
import type {
  RecoveryDecisionInput,
  RecoveryDecisionResult,
} from "./ports/session-control.ts";
import { createSessionService } from "./session-service.ts";

const OWNER = "019a0000-0000-7000-8000-0000000000f1";
const SESSION = "019a0000-0000-7000-8000-00000000e0a1";
const RECEIPT = "019a0000-0000-7000-8000-00000000c0a1";

const caller = (requestId: string) =>
  ({
    ownerId: OWNER,
    subject: {
      principal: {
        kind: "api_key",
        id: OWNER,
        owner_id: OWNER,
        workspace_id: null,
        scopes: [],
      },
      surface: { kind: "slack" },
    },
    requestId,
  }) as never;

function setup(result: RecoveryDecisionResult) {
  const decided: RecoveryDecisionInput[] = [];
  const asked: string[] = [];
  const authorization: AuthorizationPolicy = {
    async authorize(request) {
      asked.push(request.action);
      return { outcome: "allow" } as never;
    },
  };
  const service = createSessionService({
    authorization,
    catalog: testCatalog({ repositories: {} }),
    controls: {
      async decideRecoveryAtomic(input: RecoveryDecisionInput) {
        decided.push(input);
        return result;
      },
    } as never,
    reader: { getSession: async () => null } as never,
    limits: {
      queuedInputLimitPerSession: 10,
      storageLimitBytes: 1e9,
      sessionCostLimitUsd: 100,
      sessionTokenLimit: null,
    },
    releases: {} as never,
    inputs: {} as never,
  });
  return { service, decided, asked };
}

const accepted: RecoveryDecisionResult = {
  outcome: "accepted",
  response: { receipt_id: RECEIPT, receipt_status: "succeeded" },
};

describe("starting a turn of unknown outcome fresh from the Slack notice", () => {
  test("is judged as a message of the caller's own and decides start_fresh on the named turn", async () => {
    const { service, decided, asked } = setup(accepted);
    const response = await service.startFreshTurn(caller("req-1"), SESSION, {
      turnId: 1,
    });
    expect(response).toEqual({
      receipt_id: RECEIPT,
      receipt_status: "succeeded",
    });
    expect(asked).toEqual(["session.submit"]);
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      sessionId: SESSION,
      byTurn: true,
      decision: { decision: "start_fresh", target_turn_id: "1" },
    });
  });

  test("two people pressing for one turn send the same request, so the store decides it once", async () => {
    const { service, decided } = setup(accepted);
    await service.startFreshTurn(caller("req-1"), SESSION, { turnId: 1 });
    await service.startFreshTurn(caller("req-2"), SESSION, { turnId: 1 });
    await service.startFreshTurn(caller("req-3"), SESSION, { turnId: 2 });
    const [first, second, other] = decided;
    expect(first?.idempotencyKey).toBe("start_fresh:1");
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.payloadHash).toBe(first?.payloadHash);
    expect(other?.idempotencyKey).toBe("start_fresh:2");
    expect(other?.payloadHash).not.toBe(first?.payloadHash);
  });

  test("a session that moved on answers REQUEST_STALE, and a checkpointed one RECOVERY_REQUIRED", async () => {
    const stale = await setup({
      outcome: "not_in_recovery",
      admissionState: "active",
    })
      .service.startFreshTurn(caller("req-1"), SESSION, { turnId: 1 })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(SessionServiceError);
    expect((stale as SessionServiceError).code).toBe("REQUEST_STALE");
    const held = await setup({ outcome: "unknown_turn_left", turnId: "1" })
      .service.startFreshTurn(caller("req-1"), SESSION, { turnId: 1 })
      .catch((error: unknown) => error);
    expect((held as SessionServiceError).code).toBe("RECOVERY_REQUIRED");
  });
});
