import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  type GetSlackNoticeResponse,
  getSlackNoticeResponseSchema,
  REQUEST_BODY_MAX_BYTES,
} from "@werft-ai/contracts";
import { SessionServiceError } from "@werft-ai/platform";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import type { SlackNoticeService } from "../../slack-notice-service.ts";
import { registerSlackNoticeRoutes } from "./slack-notice.ts";

const createApiApp = recordRouteErrors("routes/surface/slack-notice.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000b1";
const PATH = `/v1/agents/${AGENT}/slack/notice`;

const VIEW: GetSlackNoticeResponse = getSlackNoticeResponseSchema.parse({
  notice: null,
  state: "no_notice",
  rollout: "off",
  can_approve: true,
  approvals: [],
});

type Notices = Pick<SlackNoticeService, "read" | "setRollout" | "retired">;

function request(
  notices: Partial<Notices>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerSlackNoticeRoutes(router, notices as Notices),
  }).request(path, {
    method,
    headers: { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const refusing =
  (code: string, details: Record<string, unknown> = {}) =>
  async () => {
    throw new SessionServiceError(code as never, "no", undefined, details);
  };

describe("Slack notice routes", () => {
  test("GET answers the notice the service reads for the agent", async () => {
    const asked: string[] = [];
    const response = await request(
      {
        read: async (_caller, agentId) => {
          asked.push(agentId);
          return VIEW;
        },
      },
      "GET",
      PATH,
    );
    expect(response.status).toBe(200);
    expect(getSlackNoticeResponseSchema.parse(await response.json())).toEqual(
      VIEW,
    );
    expect(asked).toEqual([AGENT]);
  });

  for (const [suffix, body] of [
    ["/approve", { notice_version: 1, locale: "ja" }],
    ["/approve", { anything: true }],
    ["/approve", undefined],
    ["/revoke", undefined],
  ] as const) {
    test(`POST ${suffix} ${JSON.stringify(body)} answers 410 ENDPOINT_RETIRED, whatever its body`, async () => {
      const response = await request(
        {
          retired: () => {
            throw new SessionServiceError(
              "ENDPOINT_RETIRED",
              "gone",
              undefined,
              { reason_code: "slack_notice_retired" },
            );
          },
        },
        "POST",
        `${PATH}${suffix}`,
        body,
      );
      expect(response.status).toBe(410);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.code).toBe("ENDPOINT_RETIRED");
      expect(error.details).toEqual({ reason_code: "slack_notice_retired" });
    });
  }

  for (const suffix of ["/approve", "/revoke"]) {
    test(`POST ${suffix} with a body over the limit answers 413 before the route`, async () => {
      let asked = false;
      const response = await request(
        {
          retired: () => {
            asked = true;
            throw new Error("not reached");
          },
        },
        "POST",
        `${PATH}${suffix}`,
        { pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
      );
      expect(response.status).toBe(413);
      expect(asked).toBe(false);
    });
  }

  test("POST rollout hands the service the value asked for", async () => {
    const asked: unknown[] = [];
    const response = await request(
      {
        setRollout: async (_caller, agentId, body) => {
          asked.push([agentId, body]);
          return { ...VIEW, rollout: body.rollout };
        },
      },
      "POST",
      `${PATH}/rollout`,
      { rollout: "shadow" },
    );
    expect(response.status).toBe(200);
    expect(
      getSlackNoticeResponseSchema.parse(await response.json()).rollout,
    ).toBe("shadow");
    expect(asked).toEqual([[AGENT, { rollout: "shadow" }]]);
  });

  test("POST rollout refuses a body over the limit", async () => {
    const response = await request(
      { setRollout: async () => VIEW },
      "POST",
      `${PATH}/rollout`,
      { rollout: "off", pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
    );
    expect(response.status).toBe(413);
  });

  for (const invalid of [{}, { rollout: "maybe" }, { rollout: "off", x: 1 }]) {
    test(`POST rollout refuses ${JSON.stringify(invalid)} before the service`, async () => {
      let called = false;
      const response = await request(
        {
          setRollout: async () => {
            called = true;
            return VIEW;
          },
        },
        "POST",
        `${PATH}/rollout`,
        invalid,
      );
      expect(response.status).toBe(400);
      expect(called).toBe(false);
    });
  }

  for (const [code, details, status] of [
    ["BAD_REQUEST", { reason_code: "rollout_on_unavailable" }, 400],
  ] as const) {
    test(`POST rollout answers ${status} ${code} ${JSON.stringify(details)}`, async () => {
      const response = await request(
        { setRollout: refusing(code, details) },
        "POST",
        `${PATH}/rollout`,
        { rollout: "shadow" },
      );
      expect(response.status).toBe(status);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.code).toBe(code);
      expect(error.details ?? {}).toMatchObject(details);
    });
  }

  for (const [method, service, suffix] of [
    ["GET", "read", ""],
    ["POST", "setRollout", "/rollout"],
  ] as const) {
    const body = service === "setRollout" ? { rollout: "off" } : undefined;
    test(`${method} ${suffix || "/"} answers 403 when the service refuses the caller`, async () => {
      const response = await request(
        {
          [service]: refusing("FORBIDDEN", {
            reason_code: "workspace_admin_required",
          }),
        },
        method,
        `${PATH}${suffix}`,
        body,
      );
      expect(response.status).toBe(403);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.details).toMatchObject({
        reason_code: "workspace_admin_required",
      });
    });

    test(`${method} ${suffix || "/"} answers 404 for an agent the caller cannot see or a malformed id`, async () => {
      expect(
        (
          await request(
            { [service]: refusing("NOT_FOUND") },
            method,
            `${PATH}${suffix}`,
            body,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await request(
            { [service]: async () => VIEW },
            method,
            `/v1/agents/not-an-agent/slack/notice${suffix}`,
            body,
          )
        ).status,
      ).toBe(404);
    });
  }
});
