import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  type LostCheckpointNotices,
  lostCheckpointNoticesSchema,
} from "@werft-ai/contracts";
import { SessionServiceError } from "@werft-ai/platform";
import type { LostCheckpointNoticesAdmin } from "../../lost-checkpoint-notices.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerLostCheckpointNoticeRoutes } from "./lost-checkpoint-notices.ts";

const createApiApp = recordRouteErrors(
  "routes/limits/lost-checkpoint-notices.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const PATH = "/v1/lost-checkpoint-notices";
const NOTICE = "019a0000-0000-7000-8000-0000000000b1";

const OPEN: LostCheckpointNotices = {
  notices: [
    { id: NOTICE, forgotten_at: "2026-11-24T09:12:44.000Z", sessions: 3 },
  ],
};

function request(
  admin: Partial<LostCheckpointNoticesAdmin>,
  method: "GET" | "POST",
  body?: unknown,
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerLostCheckpointNoticeRoutes(
        router,
        admin as LostCheckpointNoticesAdmin,
      ),
  }).request(method === "GET" ? PATH : `${PATH}/close`, {
    method,
    headers: { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("lost checkpoint notice routes", () => {
  test("GET answers the open notices the service reads for the caller", async () => {
    const callers: unknown[] = [];
    const response = await request(
      {
        read: async (caller) => {
          callers.push(caller.ownerId);
          return OPEN;
        },
      },
      "GET",
    );
    expect(response.status).toBe(200);
    expect(lostCheckpointNoticesSchema.parse(await response.json())).toEqual(
      OPEN,
    );
    expect(callers).toEqual([WORKSPACE]);
  });

  test("POST close hands the service the ids and answers what is left", async () => {
    const asked: unknown[] = [];
    const response = await request(
      {
        close: async (_caller, body) => {
          asked.push(body);
          return { notices: [] };
        },
      },
      "POST",
      { ids: [NOTICE] },
    );
    expect(response.status).toBe(200);
    expect(lostCheckpointNoticesSchema.parse(await response.json())).toEqual({
      notices: [],
    });
    expect(asked).toEqual([{ ids: [NOTICE] }]);
  });

  for (const [invalid, path] of [
    [{}, "ids"],
    [{ ids: [] }, "ids"],
    [{ ids: ["not-a-uuid"] }, "ids.0"],
    [{ ids: NOTICE }, "ids"],
    // "Close everything" is not offered: a later start would go unseen.
    [{ ids: [NOTICE], all: true }, ""],
  ] as const) {
    test(`POST close refuses ${JSON.stringify(invalid)} before the service`, async () => {
      let called = false;
      const response = await request(
        {
          close: async () => {
            called = true;
            return { notices: [] };
          },
        },
        "POST",
        invalid,
      );
      expect(response.status).toBe(400);
      expect(called).toBe(false);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(
        (error.details as { issues: { path: string }[] }).issues.map(
          (issue) => issue.path,
        ),
      ).toEqual([path]);
    });
  }

  for (const [method, service] of [
    ["GET", "read"],
    ["POST", "close"],
  ] as const) {
    test(`${method} answers 403 when the service refuses the caller`, async () => {
      const response = await request(
        {
          [service]: async () => {
            throw new SessionServiceError("FORBIDDEN", "no", undefined, {
              reason_code: "role",
            });
          },
        },
        method,
        method === "POST" ? { ids: [NOTICE] } : undefined,
      );
      expect(response.status).toBe(403);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.code).toBe("FORBIDDEN");
    });
  }
});
