import { describe, expect, test } from "bun:test";
import { type AgentUsage, REQUEST_BODY_MAX_BYTES } from "@werft-ai/contracts";
import {
  type AgentUsageService,
  SessionServiceError,
} from "@werft-ai/platform";
import { errorOf } from "../../../testing/api-error.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerAgentUsageRoutes } from "./agent-usage.ts";

const createApiApp = recordRouteErrors(
  "routes/musterrolle/agent-usage.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const TEAM = "019a0000-0000-7000-8000-00000000b0a1";
const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";
const PATH = `/v1/agents/${AGENT}/usage`;

const USAGE: AgentUsage = {
  scope: "private",
  teams: [{ id: TEAM, name: "research" }],
  revision: 2,
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );
const refusal =
  (
    code: ConstructorParameters<typeof SessionServiceError>[0],
    details?: object,
  ) =>
  async () => {
    throw new SessionServiceError(code, "no", undefined, details);
  };

function app(service: Partial<AgentUsageService>) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerAgentUsageRoutes(router, service as AgentUsageService),
  });
}

function call(
  api: ReturnType<typeof app>,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return api.request(PATH, {
    method,
    headers: {
      "X-Owner-Id": WORKSPACE,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("GET /v1/agents/{id}/usage", () => {
  test("reads the setting, and refusals map to their status", async () => {
    let asked: unknown;
    const read = await call(
      app({
        getAgentUsage: async (_caller, agentId) => {
          asked = agentId;
          return USAGE;
        },
      }),
      "GET",
    );
    expect(read.status).toBe(200);
    expect(asked).toBe(AGENT);
    expect(await read.json()).toEqual(USAGE);
    for (const [fail, status] of [
      [refusal("FORBIDDEN", { reason_code: "role" }), 403],
      [refusal("NOT_FOUND"), 404],
      [outage, 503],
    ] as const) {
      expect((await call(app({ getAgentUsage: fail }), "GET")).status).toBe(
        status,
      );
    }
  });
});

describe("PUT /v1/agents/{id}/usage", () => {
  const body = { scope: "private", teams: [{ id: TEAM }] };

  test("replaces the setting with the If-Match header as sent", async () => {
    let asked: unknown;
    const put = await call(
      app({
        putAgentUsage: async (_caller, agentId, request, ifMatch) => {
          asked = [agentId, request, ifMatch];
          return { usage: USAGE, receipt_id: RECEIPT };
        },
      }),
      "PUT",
      body,
      { "If-Match": '"1"' },
    );
    expect(put.status).toBe(200);
    expect(asked).toEqual([AGENT, body, '"1"']);
    expect(await put.json()).toEqual({ usage: USAGE, receipt_id: RECEIPT });
  });

  test("a body that breaks the scope rule or the size limit never reaches the service", async () => {
    const never = app({
      putAgentUsage: async () => {
        throw new Error("reached the service");
      },
    });
    for (const bad of [
      { scope: "private", teams: [] },
      { scope: "workspace", teams: [{ id: TEAM }] },
      { scope: "private", teams: [{ id: TEAM }, { id: TEAM }] },
      { scope: "private", teams: [{ id: "not-a-uuid" }] },
      { scope: "everyone", teams: [] },
      { scope: "private", teams: [{ id: TEAM, user_id: WORKSPACE }] },
    ]) {
      expect((await call(never, "PUT", bad, { "If-Match": "1" })).status).toBe(
        400,
      );
    }
    expect(
      (
        await call(
          never,
          "PUT",
          { ...body, pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
          { "If-Match": "1" },
        )
      ).status,
    ).toBe(413);
  });

  test("every refusal keeps its status and details", async () => {
    for (const [fail, status, code] of [
      [refusal("FORBIDDEN", { reason_code: "role" }), 403, "FORBIDDEN"],
      [
        refusal("FORBIDDEN", { reason_code: "team_not_allowed" }),
        403,
        "FORBIDDEN",
      ],
      [refusal("NOT_FOUND"), 404, "NOT_FOUND"],
      [
        refusal("VERSION_MISMATCH", { current_version: 3 }),
        412,
        "VERSION_MISMATCH",
      ],
      [refusal("PRECONDITION_REQUIRED"), 428, "PRECONDITION_REQUIRED"],
      [outage, 503, undefined],
    ] as const) {
      const response = await call(app({ putAgentUsage: fail }), "PUT", body, {
        "If-Match": "1",
      });
      expect(response.status).toBe(status);
      if (code) expect((await errorOf(response)).code).toBe(code);
    }
  });
});
