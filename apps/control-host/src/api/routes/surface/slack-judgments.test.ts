import { describe, expect, test } from "bun:test";
import { getSlackJudgmentsResponseSchema } from "@werft-ai/contracts";
import {
  type JudgmentReviewService,
  SessionServiceError,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerSlackJudgmentRoutes } from "./slack-judgments.ts";

const createApiApp = recordRouteErrors(
  "routes/surface/slack-judgments.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000b1";
const owner = { "X-Owner-Id": WORKSPACE };
const path = `/v1/agents/${AGENT}/slack/judgments`;

const READ = {
  window_days: 7 as const,
  since: "2026-11-18T00:00:00.000Z",
  channels: [],
  recent: [],
};

function app(getSlackJudgments: JudgmentReviewService["getSlackJudgments"]) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerSlackJudgmentRoutes(router, { getSlackJudgments }),
  });
}

describe("GET /v1/agents/{id}/slack/judgments", () => {
  test("answers the service's read for the agent in the path", async () => {
    const asked: string[] = [];
    const response = await app(async (_caller, agentId) => {
      asked.push(agentId);
      return READ;
    }).request(path, { headers: owner });
    expect(response.status).toBe(200);
    expect(
      getSlackJudgmentsResponseSchema.parse(await response.json()),
    ).toEqual(READ);
    expect(asked).toEqual([AGENT]);
  });

  test("no reason asks the service for the unfiltered read; a known reason is passed on", async () => {
    const asked: unknown[] = [];
    const server = app(async (_caller, _agentId, query) => {
      asked.push(query);
      return READ;
    });
    expect((await server.request(path, { headers: owner })).status).toBe(200);
    const filtered = await server.request(`${path}?reason=needs_agent`, {
      headers: owner,
    });
    expect(filtered.status).toBe(200);
    const answered = await server.request(
      `${path}?answer=no_reply&reason=needs_agent`,
      { headers: owner },
    );
    expect(answered.status).toBe(200);
    expect(asked).toEqual([
      {},
      { reason: "needs_agent" },
      { answer: "no_reply", reason: "needs_agent" },
    ]);
  });

  test("a reason the list has no code for is 400 and asks no service", async () => {
    let called = false;
    const server = app(async () => {
      called = true;
      return READ;
    });
    for (const query of [
      "reason=nope",
      "reason=",
      "reason=needs_agent&x=1",
      "reason=needs_agent&reason=nope",
      "reason=nope&reason=needs_agent",
      "reason=needs_agent&reason=needs_agent",
      "answer=nope",
      "answer=",
      "answer=replied&answer=nope",
      "answer=nope&answer=replied",
      "answer=replied&answer=replied",
      "answer=Replied",
    ]) {
      const response = await server.request(`${path}?${query}`, {
        headers: owner,
      });
      expect(response.status).toBe(400);
    }
    expect(called).toBe(false);
  });

  test("an agent id that is no uuid finds nothing and asks no service", async () => {
    let called = false;
    const response = await app(async () => {
      called = true;
      return READ;
    }).request("/v1/agents/not-a-uuid/slack/judgments", { headers: owner });
    expect(response.status).toBe(404);
    expect(called).toBe(false);
  });

  test("keeps the service's refusals: permission, missing agent, store down", async () => {
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
