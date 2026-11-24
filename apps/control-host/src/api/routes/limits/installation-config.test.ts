import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  type InstallationConfig,
  installationConfigSchema,
  updateInstallationConfigResponseSchema,
} from "@werft-ai/contracts";
import { SessionServiceError } from "@werft-ai/platform";
import type { InstallationConfigAdmin } from "../../installation-config.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerInstallationConfigRoutes } from "./installation-config.ts";

const createApiApp = recordRouteErrors(
  "routes/limits/installation-config.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const PATH = "/v1/installation-config";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";

const unsaved = <T>(value: T) => ({
  value,
  default: value,
  saved: false,
  blocked: false,
});

const CONFIG: InstallationConfig = {
  pending_request_ttl_sec: {
    value: 3600,
    default: 1800,
    saved: true,
    blocked: false,
  },
  queued_input_limit_per_session: unsaved(20),
  storage_limit_bytes: unsaved(1_073_741_824),
  session_cost_limit_usd: {
    value: 25,
    default: 25,
    saved: false,
    blocked: true,
  },
  session_token_limit: unsaved(0),
  workspace_enforce: unsaved("warn" as const),
  max_turn_seconds: unsaved(3600),
  provider_max_retries: unsaved(2),
  session_archive_after_days: unsaved(180),
  session_archive_dry_run: unsaved(true),
  workspace_stopped_ttl_sec: unsaved(86_400),
  workspace_paused_ttl_sec: unsaved(86_400),
  judgment_buffer_limit_per_channel: unsaved(100),
  session_archive: { available: false, reason: "unversioned" },
};

function request(
  admin: Partial<InstallationConfigAdmin>,
  method: "GET" | "PATCH",
  body?: unknown,
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerInstallationConfigRoutes(
        router,
        admin as InstallationConfigAdmin,
      ),
  }).request(PATH, {
    method,
    headers: { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("installation config routes", () => {
  test("GET answers every key the service reads for the caller", async () => {
    const callers: unknown[] = [];
    const response = await request(
      {
        read: async (caller) => {
          callers.push(caller.ownerId);
          return CONFIG;
        },
      },
      "GET",
    );
    expect(response.status).toBe(200);
    expect(installationConfigSchema.parse(await response.json())).toEqual(
      CONFIG,
    );
    expect(callers).toEqual([WORKSPACE]);
  });

  test("PATCH hands the service only the keys sent, an empty body included", async () => {
    for (const body of [
      { pending_request_ttl_sec: 3600 },
      { session_cost_limit_usd: 0.5, session_token_limit: 0 },
      { workspace_enforce: "fail" },
      { session_archive_after_days: 0, session_archive_dry_run: false },
      {},
    ]) {
      const asked: unknown[] = [];
      const response = await request(
        {
          change: async (_caller, change) => {
            asked.push(change);
            return { ...CONFIG, receipt_id: RECEIPT };
          },
        },
        "PATCH",
        body,
      );
      expect(response.status).toBe(200);
      expect(
        updateInstallationConfigResponseSchema.parse(await response.json()),
      ).toEqual({ ...CONFIG, receipt_id: RECEIPT });
      expect(asked).toEqual([body]);
    }
  });

  for (const [invalid, path] of [
    [{ pending_request_ttl_sec: 0 }, "pending_request_ttl_sec"],
    [{ pending_request_ttl_sec: 604_801 }, "pending_request_ttl_sec"],
    [{ pending_request_ttl_sec: 1.5 }, "pending_request_ttl_sec"],
    [{ pending_request_ttl_sec: "3600" }, "pending_request_ttl_sec"],
    [{ pending_request_ttl_sec: null }, "pending_request_ttl_sec"],
    [{ queued_input_limit_per_session: 0 }, "queued_input_limit_per_session"],
    [{ storage_limit_bytes: 0 }, "storage_limit_bytes"],
    [{ session_cost_limit_usd: 0 }, "session_cost_limit_usd"],
    [{ session_token_limit: -1 }, "session_token_limit"],
    [{ workspace_enforce: "force" }, "workspace_enforce"],
    [{ session_archive_after_days: 29 }, "session_archive_after_days"],
    [{ session_archive_after_days: 3651 }, "session_archive_after_days"],
    [{ session_archive_dry_run: "false" }, "session_archive_dry_run"],
    // The status is the deployment's, not a setting.
    [{ session_archive: { available: true, reason: null } }, ""],
    // An unknown key is the body's fault, not a key's.
    [{ pending_request_ttl_sec: 60, extra: 1 }, ""],
  ] as const) {
    test(`PATCH refuses ${JSON.stringify(invalid)} before the service`, async () => {
      let called = false;
      const response = await request(
        {
          change: async () => {
            called = true;
            return CONFIG;
          },
        },
        "PATCH",
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
    ["PATCH", "change"],
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
        method === "PATCH" ? {} : undefined,
      );
      expect(response.status).toBe(403);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.code).toBe("FORBIDDEN");
    });
  }
});
