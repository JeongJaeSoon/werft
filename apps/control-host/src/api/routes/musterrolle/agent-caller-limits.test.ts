import { describe, expect, test } from "bun:test";
import {
  type AgentCallerLimits,
  REQUEST_BODY_MAX_BYTES,
} from "@werft-ai/contracts";
import {
  type AgentCallerLimitsService,
  SessionServiceError,
} from "@werft-ai/platform";
import { errorOf } from "../../../testing/api-error.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerAgentCallerLimitsRoutes } from "./agent-caller-limits.ts";

const createApiApp = recordRouteErrors(
  "routes/musterrolle/agent-caller-limits.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const TEAM = "019a0000-0000-7000-8000-00000000b0a1";
const AGENT = "019a0000-0000-7000-8000-00000000a0a1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";
const PATH = `/v1/agents/${AGENT}/caller-limits`;

const rule = (over: object = {}) => ({
  target: { kind: "team", id: TEAM },
  tools_deny: ["shell"],
  repositories: ["platform"],
  mcp_servers: null,
  credentials_deny: [],
  ...over,
});
const LIMITS: AgentCallerLimits = {
  rules: [rule()] as AgentCallerLimits["rules"],
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

function app(service: Partial<AgentCallerLimitsService>) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerAgentCallerLimitsRoutes(
        router,
        service as AgentCallerLimitsService,
      ),
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

describe("GET /v1/agents/{id}/caller-limits", () => {
  test("reads the rules, and refusals map to their status", async () => {
    let asked: unknown;
    const read = await call(
      app({
        getAgentCallerLimits: async (_caller, agentId) => {
          asked = agentId;
          return LIMITS;
        },
      }),
      "GET",
    );
    expect(read.status).toBe(200);
    expect(asked).toBe(AGENT);
    expect(await read.json()).toEqual(LIMITS);
    for (const [fail, status] of [
      [refusal("FORBIDDEN", { reason_code: "role" }), 403],
      [refusal("NOT_FOUND"), 404],
      [outage, 503],
    ] as const) {
      expect(
        (await call(app({ getAgentCallerLimits: fail }), "GET")).status,
      ).toBe(status);
    }
  });
});

describe("PUT /v1/agents/{id}/caller-limits", () => {
  const body = { rules: [rule()] };

  test("replaces the rules with the If-Match header as sent", async () => {
    let asked: unknown;
    const put = await call(
      app({
        putAgentCallerLimits: async (_caller, agentId, request, ifMatch) => {
          asked = [agentId, request, ifMatch];
          return { limits: LIMITS, receipt_id: RECEIPT };
        },
      }),
      "PUT",
      body,
      { "If-Match": '"1"' },
    );
    expect(put.status).toBe(200);
    expect(asked).toEqual([AGENT, body, '"1"']);
    expect(await put.json()).toEqual({ limits: LIMITS, receipt_id: RECEIPT });
  });

  test("a person as target, a repeated target or name, and a malformed body never reach the service", async () => {
    const never = app({
      putAgentCallerLimits: async () => {
        throw new Error("reached the service");
      },
    });
    const user = { kind: "user", id: TEAM };
    for (const bad of [
      { rules: [rule({ target: user })] },
      { rules: [rule({ target: { kind: "team" } })] },
      { rules: [rule({ target: { kind: "team", id: "not-a-uuid" } })] },
      { rules: [rule({ target: { kind: "workspace", id: TEAM } })] },
      { rules: [rule({ target: { kind: "channel", id: "" } })] },
      { rules: [rule(), rule()] },
      {
        rules: [
          rule({ target: { kind: "workspace" } }),
          rule({ target: { kind: "workspace" } }),
        ],
      },
      { rules: [rule({ tools_deny: ["a", "a"] })] },
      { rules: [rule({ repositories: ["Not A Repo"] })] },
      { rules: [rule({ repositories: undefined })] },
      { rules: [rule({ tools_deny: null })] },
      { rules: [rule({ extra: true })] },
      {
        rules: Array.from({ length: 101 }, (_, i) =>
          rule({ target: { kind: "channel", id: `C${i}` } }),
        ),
      },
      {
        rules: [
          rule({ mcp_servers: Array.from({ length: 201 }, (_, i) => `s${i}`) }),
        ],
      },
      {},
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

  test("channel ids that differ only by case are two targets; team ids are not", async () => {
    const reached: unknown[] = [];
    const api = app({
      putAgentCallerLimits: async (_caller, _agent, request) => {
        reached.push(request);
        return { limits: { rules: [], revision: 3 }, receipt_id: null };
      },
    });
    const channels = {
      rules: [
        rule({ target: { kind: "channel", id: "C1" } }),
        rule({ target: { kind: "channel", id: "c1" } }),
      ],
    };
    expect((await call(api, "PUT", channels, { "If-Match": "2" })).status).toBe(
      200,
    );
    const teams = {
      rules: [
        rule({ target: { kind: "team", id: TEAM } }),
        rule({ target: { kind: "team", id: TEAM.toUpperCase() } }),
      ],
    };
    expect((await call(api, "PUT", teams, { "If-Match": "2" })).status).toBe(
      400,
    );
    expect(reached).toHaveLength(1);
  });

  test("an empty set is a valid replacement", async () => {
    const put = await call(
      app({
        putAgentCallerLimits: async () => ({
          limits: { rules: [], revision: 3 },
          receipt_id: null,
        }),
      }),
      "PUT",
      { rules: [] },
      { "If-Match": "2" },
    );
    expect(put.status).toBe(200);
  });

  test("every refusal keeps its status and details", async () => {
    for (const [fail, status, code, details] of [
      [refusal("FORBIDDEN", { reason_code: "role" }), 403, "FORBIDDEN", null],
      [
        refusal("FORBIDDEN", { reason_code: "team_not_allowed" }),
        403,
        "FORBIDDEN",
        { reason_code: "team_not_allowed" },
      ],
      [refusal("NOT_FOUND"), 404, "NOT_FOUND", null],
      [
        refusal("BAD_REQUEST", {
          reason_code: "repository_not_in_catalog",
          repository_ids: ["gone"],
        }),
        400,
        "BAD_REQUEST",
        { reason_code: "repository_not_in_catalog", repository_ids: ["gone"] },
      ],
      [
        refusal("VERSION_MISMATCH", { current_version: 3 }),
        412,
        "VERSION_MISMATCH",
        { current_version: 3 },
      ],
      [refusal("PRECONDITION_REQUIRED"), 428, "PRECONDITION_REQUIRED", null],
      [outage, 503, undefined, null],
    ] as const) {
      const response = await call(
        app({ putAgentCallerLimits: fail }),
        "PUT",
        body,
        { "If-Match": "1" },
      );
      expect(response.status).toBe(status);
      if (code) {
        const error = await errorOf(response);
        expect(error.code).toBe(code);
        if (details) expect(error.details).toEqual(details);
      }
    }
  });
});
