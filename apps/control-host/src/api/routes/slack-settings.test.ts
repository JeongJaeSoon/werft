import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  type SlackSettings,
  slackSettingsSchema,
  updateSlackSettingsResponseSchema,
} from "@werft-ai/contracts";
import { SessionServiceError } from "@werft-ai/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import type { SlackSettingsAdmin } from "../slack-settings.ts";
import { registerSlackSettingsRoutes } from "./slack-settings.ts";

const createApiApp = recordRouteErrors("routes/slack-settings.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const PATH = "/v1/slack-settings";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";

const SETTINGS: SlackSettings = {
  events_public_url: "https://events.example.test/in",
  computed_events_base: "https://werft.example.test",
  events_url_template:
    "https://events.example.test/in/v1/slack/events/{agent_id}",
};

function request(
  admin: Partial<SlackSettingsAdmin>,
  method: "GET" | "PUT",
  body?: unknown,
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerSlackSettingsRoutes(router, admin as SlackSettingsAdmin),
  }).request(PATH, {
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

describe("Slack settings routes", () => {
  test("GET answers the settings the service reads for the caller", async () => {
    const callers: unknown[] = [];
    const response = await request(
      {
        read: async (caller) => {
          callers.push(caller.ownerId);
          return SETTINGS;
        },
      },
      "GET",
    );
    expect(response.status).toBe(200);
    expect(slackSettingsSchema.parse(await response.json())).toEqual(SETTINGS);
    expect(callers).toEqual([WORKSPACE]);
  });

  test("PUT hands the service the address, or null to clear it", async () => {
    for (const body of [
      { events_public_url: "https://events.example.test/in" },
      { events_public_url: null },
    ]) {
      const asked: unknown[] = [];
      const response = await request(
        {
          change: async (_caller, change) => {
            asked.push(change);
            return { ...SETTINGS, receipt_id: RECEIPT };
          },
        },
        "PUT",
        body,
      );
      expect(response.status).toBe(200);
      expect(
        updateSlackSettingsResponseSchema.parse(await response.json()),
      ).toEqual({ ...SETTINGS, receipt_id: RECEIPT });
      expect(asked).toEqual([body]);
    }
  });

  for (const invalid of [
    {},
    { events_public_url: 1 },
    { events_public_url: "https://events.example.test", extra: 1 },
    { events_public_url: `https://e.test/${"a".repeat(2048)}` },
  ]) {
    test(`PUT refuses ${JSON.stringify(invalid).slice(0, 60)} before the service`, async () => {
      let called = false;
      const response = await request(
        {
          change: async () => {
            called = true;
            return SETTINGS;
          },
        },
        "PUT",
        invalid,
      );
      expect(response.status).toBe(400);
      expect(called).toBe(false);
    });
  }

  test("PUT answers 400 with reason_code events_url_invalid when the service refuses the address", async () => {
    const response = await request(
      {
        change: refusing("BAD_REQUEST", { reason_code: "events_url_invalid" }),
      },
      "PUT",
      { events_public_url: "http://events.example.test" },
    );
    expect(response.status).toBe(400);
    const { error } = apiErrorResponseSchema.parse(await response.json());
    expect(error.details).toMatchObject({ reason_code: "events_url_invalid" });
  });

  for (const [method, service] of [
    ["GET", "read"],
    ["PUT", "change"],
  ] as const) {
    test(`${method} answers 403 when the service refuses the caller`, async () => {
      const response = await request(
        { [service]: refusing("FORBIDDEN", { reason_code: "role" }) },
        method,
        method === "PUT" ? { events_public_url: null } : undefined,
      );
      expect(response.status).toBe(403);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.code).toBe("FORBIDDEN");
    });
  }
});
