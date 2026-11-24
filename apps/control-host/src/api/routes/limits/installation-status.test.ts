import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  installationStatusSchema,
} from "@werft-ai/contracts";
import { SessionServiceError } from "@werft-ai/platform";
import type { InstallationStatusReader } from "../../installation-status.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerInstallationStatusRoutes } from "./installation-status.ts";

const createApiApp = recordRouteErrors(
  "routes/limits/installation-status.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";

function request(read: InstallationStatusReader["read"]) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerInstallationStatusRoutes(router, { read }),
  }).request("/v1/installation-status", {
    headers: { "X-Owner-Id": WORKSPACE },
  });
}

describe("installation status route", () => {
  test("GET answers what the reader reads for the caller", async () => {
    const callers: unknown[] = [];
    const response = await request(async (caller) => {
      callers.push(caller.ownerId);
      return { profile: "production", no_disk_quota: true };
    });
    expect(response.status).toBe(200);
    expect(installationStatusSchema.parse(await response.json())).toEqual({
      profile: "production",
      no_disk_quota: true,
    });
    expect(callers).toEqual([WORKSPACE]);
  });

  test("GET answers 403 when the reader refuses the caller", async () => {
    const response = await request(async () => {
      throw new SessionServiceError("FORBIDDEN", "no", undefined, {
        reason_code: "role",
      });
    });
    expect(response.status).toBe(403);
    const { error } = apiErrorResponseSchema.parse(await response.json());
    expect(error.code).toBe("FORBIDDEN");
  });
});
