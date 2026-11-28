import { describe, expect, test } from "bun:test";
import type { AuthorizationPolicy } from "../access-control/policy.ts";
import { testCatalog } from "../testing/catalog-fakes.ts";
import type {
  AppendMessageInput,
  AppendMessageResult,
} from "./ports/session-unit-of-work.ts";
import { createSessionService } from "./session-service.ts";

const OWNER = "019a0000-0000-7000-8000-0000000000f1";
const SESSION = "019a0000-0000-7000-8000-00000000e0a1";
const PUSH = "019a0000-0000-7000-8000-00000000c0b2";

function setup(outcome: AppendMessageResult["outcome"] = "accepted") {
  const appended: AppendMessageInput[] = [];
  let asked = 0;
  const authorization: AuthorizationPolicy = {
    async authorize() {
      asked++;
      throw new Error("a push follow-up judges no person");
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
                turn_id: "2",
                receipt_id: "019a0000-0000-7000-8000-00000000c0a1",
                receipt_status: "accepted",
              },
            }
          : ({ outcome } as AppendMessageResult);
      },
    },
  });
  return { service, appended, asked: () => asked };
}

const followUp = (decision: "approve" | "reject") => ({
  idempotencyKey: `slack-push:${PUSH}`,
  message: "A person approved push request.",
  pushRequestId: PUSH,
  decision,
  requestId: "req-1",
});

describe("a push decision's follow-up turn", () => {
  test("goes in as the platform's input: no person is judged or carried, whoever pressed", async () => {
    for (const decision of ["approve", "reject"] as const) {
      const { service, appended, asked } = setup();
      expect(
        await service.queuePushFollowUp(OWNER, SESSION, followUp(decision)),
      ).toMatchObject({ turn_id: "2" });
      expect(asked()).toBe(0);
      expect(appended).toHaveLength(1);
      expect(appended[0]?.principal).toEqual({
        ownerId: OWNER,
        requestId: "req-1",
      });
      expect(appended[0]?.platform).toEqual({ pushRequestId: PUSH, decision });
      expect(appended[0]?.channel).toBeUndefined();
      expect(appended[0]?.callerSubject).toBeUndefined();
    }
  });

  test("one already in the session answers nothing new and is no error", async () => {
    const { service } = setup("already_queued");
    expect(
      await service.queuePushFollowUp(OWNER, SESSION, followUp("approve")),
    ).toBeNull();
  });

  test("the session's own refusals still reach the caller", async () => {
    const { service } = setup("queue_full");
    await expect(
      service.queuePushFollowUp(OWNER, SESSION, followUp("approve")),
    ).rejects.toThrow();
  });
});
