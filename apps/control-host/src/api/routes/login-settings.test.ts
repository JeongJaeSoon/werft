import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  type LoginSettingsView,
  loginSettingsResponseSchema,
  updateLoginSettingsResponseSchema,
} from "@werft-ai/contracts";
import { SessionServiceError } from "@werft-ai/platform";
import type { LoginSettingsAdmin } from "../login-settings.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerLoginSettingsRoutes } from "./login-settings.ts";

const createApiApp = recordRouteErrors("routes/login-settings.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const OWNER = "019a0000-0000-7000-8000-0000000000c1";
const PATH = "/v1/login-settings";

const SETTINGS: LoginSettingsView = {
  password_login: "emergency_only",
  emergency_admin: {
    user_id: OWNER,
    email: "owner@example.com",
    display_name: "Owner",
    eligible: true,
  },
  enabled_providers: 2,
};

function request(
  admin: Partial<LoginSettingsAdmin>,
  method: "GET" | "PATCH",
  body?: unknown,
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerLoginSettingsRoutes(router, admin as LoginSettingsAdmin),
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

describe("sign-in settings routes", () => {
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
    expect(loginSettingsResponseSchema.parse(await response.json())).toEqual({
      settings: SETTINGS,
    });
    expect(callers).toEqual([WORKSPACE]);
  });

  test("PATCH hands the service the one change and answers what it ended", async () => {
    for (const change of [
      { password_login: "emergency_only" },
      { password_login: "on" },
      { emergency_admin_user_id: OWNER },
    ]) {
      const asked: unknown[] = [];
      const response = await request(
        {
          change: async (_caller, body) => {
            asked.push(body);
            return { settings: SETTINGS, sessions_revoked: 4 };
          },
        },
        "PATCH",
        change,
      );
      expect(response.status).toBe(200);
      expect(
        updateLoginSettingsResponseSchema.parse(await response.json()),
      ).toEqual({ settings: SETTINGS, sessions_revoked: 4 });
      expect(asked).toEqual([change]);
    }
  });

  for (const invalid of [
    {},
    { password_login: "off" },
    { password_login: "on", emergency_admin_user_id: OWNER },
    { emergency_admin_user_id: "not-a-uuid" },
    { emergency_admin_user_id: null },
    { password_login: "on", extra: 1 },
  ]) {
    test(`PATCH refuses ${JSON.stringify(invalid)} before the service`, async () => {
      let called = false;
      const response = await request(
        {
          change: async () => {
            called = true;
            return { settings: SETTINGS, sessions_revoked: 0 };
          },
        },
        "PATCH",
        invalid,
      );
      expect(response.status).toBe(400);
      expect(called).toBe(false);
    });
  }

  for (const [method, service] of [
    ["GET", "read"],
    ["PATCH", "change"],
  ] as const) {
    test(`${method} answers 403 when the service refuses the caller`, async () => {
      const response = await request(
        { [service]: refusing("FORBIDDEN", { reason_code: "role" }) },
        method,
        method === "PATCH" ? { password_login: "on" } : undefined,
      );
      expect(response.status).toBe(403);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.code).toBe("FORBIDDEN");
    });
  }

  for (const reason of [
    "no_provider",
    "no_emergency_admin",
    "locks_out_actor",
    "not_eligible",
  ]) {
    test(`PATCH answers 409 with reason_code ${reason} when the change is refused`, async () => {
      const response = await request(
        { change: refusing("REVISION_CONFLICT", { reason_code: reason }) },
        "PATCH",
        { password_login: "emergency_only" },
      );
      expect(response.status).toBe(409);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.code).toBe("REVISION_CONFLICT");
      // What tells the screen which refusal this is travels with it.
      expect(error.details).toMatchObject({ reason_code: reason });
    });
  }
});
