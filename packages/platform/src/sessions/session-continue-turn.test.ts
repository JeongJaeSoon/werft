import { describe, expect, test } from "bun:test";
import type { AuthorizationPolicy } from "../musterrolle/policy.ts";
import { SessionServiceError } from "../musterrolle/service-errors.ts";
import { testCatalog } from "../testing/catalog-fakes.ts";
import type {
  AppendMessageInput,
  AppendMessageResult,
} from "./ports/session-unit-of-work.ts";
import { createSessionService } from "./session-service.ts";

const OWNER = "019a0000-0000-7000-8000-0000000000f1";
const SESSION = "019a0000-0000-7000-8000-00000000e0a1";

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

function setup(outcome: AppendMessageResult["outcome"] = "accepted") {
  const appended: AppendMessageInput[] = [];
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
    controls: {} as never,
    reader: { getSession: async () => null } as never,
    limits: {
      queuedInputLimitPerSession: 10,
      storageLimitBytes: 1e9,
      sessionCostLimitUsd: 100,
      sessionTokenLimit: null,
    },
    releases: {} as never,
    inputs: {
      acceptInputAtomic: async () => {
        throw new Error("not used");
      },
      async appendInputAtomic(input) {
        appended.push(input);
        return outcome === "accepted" || outcome === "replayed"
          ? {
              outcome,
              response: {
                turn_id: "4",
                receipt_id: "019a0000-0000-7000-8000-00000000c0a1",
                receipt_status: "accepted",
              },
            }
          : ({ outcome } as AppendMessageResult);
      },
    },
  });
  return { service, appended, asked };
}

describe("going on from a turn its worker's lost lease ended", () => {
  test("is judged as a message of the caller's own and names the turn, not a text", async () => {
    const { service, appended, asked } = setup();
    const response = await service.continueTurn(caller("req-1"), SESSION, {
      turnId: 3,
    });
    expect(response.turn_id).toBe("4");
    expect(asked).toEqual(["session.submit"]);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      sessionId: SESSION,
      continueTurn: 3,
      message: "",
      channel: "slack",
    });
  });

  test("two people asking for one turn send the same request, so the store takes it once", async () => {
    const { service, appended } = setup();
    await service.continueTurn(caller("req-1"), SESSION, { turnId: 3 });
    await service.continueTurn(caller("req-2"), SESSION, { turnId: 3 });
    await service.continueTurn(caller("req-3"), SESSION, { turnId: 5 });
    const [first, second, other] = appended;
    expect(first?.idempotencyKey).toBe("continue:3");
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
    expect(second?.payloadHash).toBe(first?.payloadHash);
    // Another lost turn is another request.
    expect(other?.idempotencyKey).toBe("continue:5");
    expect(other?.payloadHash).not.toBe(first?.payloadHash);
  });

  test("a turn that did not end that way is not found", async () => {
    const { service } = setup("not_found");
    const refused = await service
      .continueTurn(caller("req-1"), SESSION, { turnId: 3 })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionServiceError);
    expect((refused as SessionServiceError).code).toBe("NOT_FOUND");
  });
});
