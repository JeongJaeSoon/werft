import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  type GitHubWebhookSettings,
  githubWebhookSettingsSchema,
  retryGitHubWebhookUpdatesResponseSchema,
  updateGitHubWebhookSettingsResponseSchema,
} from "@werft-ai/contracts";
import { SessionServiceError } from "@werft-ai/platform";
import type { GitHubWebhookSettingsAdmin } from "../../github-webhook-settings.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerGitHubWebhookSettingsRoutes } from "./github-webhook-settings.ts";

const createApiApp = recordRouteErrors(
  "routes/github/github-webhook-settings.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const PATH = "/v1/github-webhook-settings";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";

const SETTINGS: GitHubWebhookSettings = {
  webhook_public_url: "https://hooks.example.test/in",
  webhook_url: "https://hooks.example.test/in/v1/github/webhook",
  apps: [{ app_id: 7, name: "werft-agent", other_workspaces: 1 }],
};

function request(
  admin: Partial<GitHubWebhookSettingsAdmin>,
  method: "GET" | "PUT" | "POST",
  body?: unknown,
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerGitHubWebhookSettingsRoutes(
        router,
        admin as GitHubWebhookSettingsAdmin,
      ),
  }).request(method === "POST" ? `${PATH}/retry` : PATH, {
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

describe("GitHub webhook settings routes", () => {
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
    expect(githubWebhookSettingsSchema.parse(await response.json())).toEqual(
      SETTINGS,
    );
    expect(callers).toEqual([WORKSPACE]);
  });

  test("PUT hands the service the address, or null to clear it, and answers each App's update", async () => {
    const updates = [
      { app_id: 7, name: "werft-agent", outcome: "updated" as const },
      {
        app_id: 8,
        name: "werft-review",
        outcome: "failed" as const,
        reason_code: "url_refused" as const,
      },
    ];
    for (const body of [
      { webhook_public_url: "https://hooks.example.test/in" },
      { webhook_public_url: null },
    ]) {
      const asked: unknown[] = [];
      const response = await request(
        {
          change: async (_caller, change) => {
            asked.push(change);
            return { ...SETTINGS, receipt_id: RECEIPT, updates };
          },
        },
        "PUT",
        body,
      );
      expect(response.status).toBe(200);
      expect(
        updateGitHubWebhookSettingsResponseSchema.parse(await response.json()),
      ).toEqual({ ...SETTINGS, receipt_id: RECEIPT, updates });
      expect(asked).toEqual([body]);
    }
  });

  for (const invalid of [
    {},
    { webhook_public_url: 1 },
    { webhook_public_url: "https://hooks.example.test", extra: 1 },
    { webhook_public_url: `https://e.test/${"a".repeat(2048)}` },
  ]) {
    test(`PUT refuses ${JSON.stringify(invalid).slice(0, 60)} before the service`, async () => {
      let called = false;
      const response = await request(
        {
          change: async () => {
            called = true;
            return { ...SETTINGS, updates: [] };
          },
        },
        "PUT",
        invalid,
      );
      expect(response.status).toBe(400);
      expect(called).toBe(false);
    });
  }

  test("PUT answers 400 with reason_code webhook_url_invalid when the service refuses the address", async () => {
    const response = await request(
      {
        change: refusing("BAD_REQUEST", { reason_code: "webhook_url_invalid" }),
      },
      "PUT",
      { webhook_public_url: "http://hooks.example.test" },
    );
    expect(response.status).toBe(400);
    const { error } = apiErrorResponseSchema.parse(await response.json());
    expect(error.details).toMatchObject({ reason_code: "webhook_url_invalid" });
  });

  test("POST retry hands the service the App ids and answers its updates", async () => {
    const asked: unknown[] = [];
    const updates = [
      { app_id: 7, name: "werft-agent", outcome: "updated" as const },
      {
        app_id: 9,
        name: null,
        outcome: "failed" as const,
        reason_code: "not_found" as const,
      },
    ];
    const response = await request(
      {
        retry: async (_caller, body) => {
          asked.push(body);
          return { updates };
        },
      },
      "POST",
      { app_ids: [7, 9] },
    );
    expect(response.status).toBe(200);
    expect(
      retryGitHubWebhookUpdatesResponseSchema.parse(await response.json()),
    ).toEqual({ updates });
    expect(asked).toEqual([{ app_ids: [7, 9] }]);
  });

  for (const invalid of [
    {},
    { app_ids: [] },
    { app_ids: [0] },
    { app_ids: Array.from({ length: 101 }, (_, i) => i + 1) },
  ]) {
    test(`POST retry refuses ${JSON.stringify(invalid).slice(0, 40)} before the service`, async () => {
      let called = false;
      const response = await request(
        {
          retry: async () => {
            called = true;
            return { updates: [] };
          },
        },
        "POST",
        invalid,
      );
      expect(response.status).toBe(400);
      expect(called).toBe(false);
    });
  }

  test("POST retry answers 409 webhook_url_unset when nothing is saved", async () => {
    const response = await request(
      {
        retry: refusing("REVISION_CONFLICT", {
          reason_code: "webhook_url_unset",
        }),
      },
      "POST",
      { app_ids: [7] },
    );
    expect(response.status).toBe(409);
    const { error } = apiErrorResponseSchema.parse(await response.json());
    expect(error.details).toMatchObject({ reason_code: "webhook_url_unset" });
  });

  for (const [method, service] of [
    ["GET", "read"],
    ["PUT", "change"],
    ["POST", "retry"],
  ] as const) {
    test(`${method} answers 403 when the service refuses the caller`, async () => {
      const response = await request(
        { [service]: refusing("FORBIDDEN", { reason_code: "role" }) },
        method,
        method === "PUT"
          ? { webhook_public_url: null }
          : method === "POST"
            ? { app_ids: [7] }
            : undefined,
      );
      expect(response.status).toBe(403);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.code).toBe("FORBIDDEN");
    });
  }
});
