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

const TEXT = {
  body: ["Werft does not train any model on what it reads in Slack."],
  policy_link: { label: "Data", href: "https://docs.example.test/data" },
};
const VIEW: GetSlackNoticeResponse = getSlackNoticeResponseSchema.parse({
  notice: {
    version: 1,
    requires_reapproval: true,
    text: { ko: TEXT, ja: TEXT },
  },
  state: "approved",
  rollout: "off",
  can_approve: true,
  approvals: [
    {
      id: "019a0000-0000-7000-8000-0000000000a1",
      slack_team_id: "T0NOTICE",
      notice_version: 1,
      counts: true,
      approved_by: {
        user_id: "019a0000-0000-7000-8000-0000000000c1",
        display_name: "Admin",
        email: "admin@example.test",
      },
      approved_at: "2026-11-24T00:00:00.000Z",
    },
  ],
});

type Notices = Pick<
  SlackNoticeService,
  "read" | "approve" | "revoke" | "setRollout"
>;

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

  test("POST approve hands the service the version and language shown", async () => {
    const asked: unknown[] = [];
    const response = await request(
      {
        approve: async (_caller, agentId, body) => {
          asked.push([agentId, body]);
          return VIEW;
        },
      },
      "POST",
      `${PATH}/approve`,
      { notice_version: 1, locale: "ja" },
    );
    expect(response.status).toBe(200);
    expect(getSlackNoticeResponseSchema.parse(await response.json())).toEqual(
      VIEW,
    );
    expect(asked).toEqual([[AGENT, { notice_version: 1, locale: "ja" }]]);
  });

  test("POST revoke answers the notice after the revoke", async () => {
    const response = await request(
      {
        revoke: async () => ({ ...VIEW, state: "not_approved", approvals: [] }),
      },
      "POST",
      `${PATH}/revoke`,
    );
    expect(response.status).toBe(200);
    expect(
      getSlackNoticeResponseSchema.parse(await response.json()).state,
    ).toBe("not_approved");
  });

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
    ["REVISION_CONFLICT", { reason_code: "notice_not_approved" }, 409],
    ["REVISION_CONFLICT", { reason_code: "no_notice" }, 409],
    ["SLACK_NOT_INSTALLED", {}, 409],
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

  for (const invalid of [
    {},
    { notice_version: 1 },
    { notice_version: 1, locale: "en" },
    { notice_version: 0, locale: "ko" },
    { notice_version: 1, locale: "ko", extra: true },
  ]) {
    test(`POST approve refuses ${JSON.stringify(invalid)} before the service`, async () => {
      let called = false;
      const response = await request(
        {
          approve: async () => {
            called = true;
            return VIEW;
          },
        },
        "POST",
        `${PATH}/approve`,
        invalid,
      );
      expect(response.status).toBe(400);
      expect(called).toBe(false);
    });
  }

  test("POST approve refuses a body over the limit", async () => {
    const response = await request(
      { approve: async () => VIEW },
      "POST",
      `${PATH}/approve`,
      {
        notice_version: 1,
        locale: "ko",
        pad: "x".repeat(REQUEST_BODY_MAX_BYTES),
      },
    );
    expect(response.status).toBe(413);
  });

  for (const [code, details, status] of [
    ["REVISION_CONFLICT", { reason_code: "no_notice" }, 409],
    ["REVISION_CONFLICT", { reason_code: "notice_version_stale" }, 409],
    ["SLACK_NOT_INSTALLED", {}, 409],
  ] as const) {
    test(`POST approve answers ${status} ${code} ${JSON.stringify(details)}`, async () => {
      const response = await request(
        { approve: refusing(code, details) },
        "POST",
        `${PATH}/approve`,
        { notice_version: 1, locale: "ko" },
      );
      expect(response.status).toBe(status);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.code).toBe(code);
      expect(error.details ?? {}).toMatchObject(details);
    });
  }

  for (const [method, service, suffix] of [
    ["GET", "read", ""],
    ["POST", "approve", "/approve"],
    ["POST", "revoke", "/revoke"],
    ["POST", "setRollout", "/rollout"],
  ] as const) {
    const body =
      service === "approve"
        ? { notice_version: 1, locale: "ko" }
        : service === "setRollout"
          ? { rollout: "off" }
          : undefined;
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
