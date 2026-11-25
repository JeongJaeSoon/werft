import { describe, expect, test } from "bun:test";
import { getSlackInstructionsHeadResponseSchema } from "@werft-ai/contracts";
import {
  type InstructionsHeadService,
  SessionServiceError,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerSlackInstructionsHeadRoutes } from "./slack-instructions-head.ts";

const createApiApp = recordRouteErrors(
  "routes/surface/slack-instructions-head.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000b1";
const owner = { "X-Owner-Id": WORKSPACE };
const path = `/v1/agents/${AGENT}/slack/instructions-head`;
const READ = { state: "read" as const, commit: "b".repeat(40), newer: true };

function app(
  getSlackInstructionsHead: InstructionsHeadService["getSlackInstructionsHead"],
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerSlackInstructionsHeadRoutes(router, { getSlackInstructionsHead }),
  });
}

describe("GET /v1/agents/{id}/slack/instructions-head", () => {
  test("answers the service's read for the agent in the path", async () => {
    const asked: string[] = [];
    const response = await app(async (_caller, agentId) => {
      asked.push(agentId);
      return READ;
    }).request(path, { headers: owner });
    expect(response.status).toBe(200);
    expect(
      getSlackInstructionsHeadResponseSchema.parse(await response.json()),
    ).toEqual(READ);
    expect(asked).toEqual([AGENT]);
  });

  test("an agent id that is no uuid finds nothing and asks no service", async () => {
    let called = false;
    const response = await app(async () => {
      called = true;
      return READ;
    }).request("/v1/agents/not-a-uuid/slack/instructions-head", {
      headers: owner,
    });
    expect(response.status).toBe(404);
    expect(called).toBe(false);
  });

  test("keeps the service's refusals: permission, missing agent, GitHub down", async () => {
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["BACKEND_UNAVAILABLE", 503],
    ] as const) {
      const response = await app(async () => {
        throw new SessionServiceError(code, "refused");
      }).request(path, { headers: owner });
      expect(response.status).toBe(status);
    }
  });
});
