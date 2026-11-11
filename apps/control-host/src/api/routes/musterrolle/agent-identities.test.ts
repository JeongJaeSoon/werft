import { describe, expect, test } from "bun:test";
import {
  type AgentIdentity,
  linkAgentIdentityResponseSchema,
  listAgentIdentitiesResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  revokeAgentIdentityResponseSchema,
} from "@werft-ai/contracts";
import {
  type AgentIdentityService,
  SessionServiceError,
} from "@werft-ai/platform";
import { errorOf } from "../../../test-support/api-error.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerAgentIdentityRoutes } from "./agent-identities.ts";

const createApiApp = recordRouteErrors(
  "routes/musterrolle/agent-identities.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-0000000000b1";
const IDENTITY = "019a0000-0000-7000-8000-0000000000d1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";
const owner = { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" };

const VIEW: AgentIdentity = {
  id: IDENTITY,
  agent_id: AGENT,
  provider: "slack_bot",
  app_id: "A0APP",
  team_id: "T0TEAM",
  bot_user_id: "B0BOT",
  credential_ref: "slack-bot-token",
  status: "active",
  revision: 1,
  created_by: "019a0000-0000-7000-8000-0000000000a1",
  created_at: "2026-10-11T00:00:00.000Z",
  revoked_at: null,
};

const BODY = {
  provider: "slack_bot",
  app_id: "A0APP",
  team_id: "T0TEAM",
  credential_ref: "slack-bot-token",
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );

function app(service: Partial<AgentIdentityService>) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerAgentIdentityRoutes(router, {
        service: service as AgentIdentityService,
      }),
  });
}

function link(api: ReturnType<typeof app>, body: unknown, agent = AGENT) {
  return api.request(`/v1/agents/${agent}/identities`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify(body),
  });
}

describe("POST /v1/agents/{id}/identities", () => {
  test("links and answers 201 with the receipt", async () => {
    let asked: unknown;
    const response = await link(
      app({
        linkAgentIdentity: async (_caller, agentId, request) => {
          asked = { agentId, request };
          return { agent_identity: VIEW, receipt_id: RECEIPT };
        },
      }),
      BODY,
    );
    expect(response.status).toBe(201);
    expect(
      linkAgentIdentityResponseSchema.parse(await response.json()).receipt_id,
    ).toBe(RECEIPT);
    expect(asked).toEqual({ agentId: AGENT, request: BODY });
  });

  test("a malformed body, agent id or oversized body never reaches the service", async () => {
    const untouched = app({});
    for (const body of [
      { ...BODY, provider: "github_app" },
      { ...BODY, app_id: "a lowercase id" },
      { ...BODY, credential_ref: "Has Spaces" },
      { ...BODY, token: "xoxb-not-taken" },
      { provider: "slack_bot", app_id: "A0APP", team_id: "T0TEAM" },
    ]) {
      expect((await link(untouched, body)).status).toBe(400);
    }
    expect((await link(untouched, BODY, "not-an-agent")).status).toBe(404);
    expect(
      (
        await link(untouched, {
          ...BODY,
          pad: "x".repeat(REQUEST_BODY_MAX_BYTES),
        })
      ).status,
    ).toBe(413);
  });

  test("each refusal keeps its code and status", async () => {
    const cases: [SessionServiceError, number][] = [
      [
        new SessionServiceError("FORBIDDEN", "no", undefined, {
          reason_code: "role",
        }),
        403,
      ],
      [new SessionServiceError("NOT_FOUND", "Resource not found"), 404],
      [new SessionServiceError("SLACK_NOT_INSTALLED", "설치"), 409],
      [new SessionServiceError("AGENT_IDENTITY_TAKEN", "다른 에이전트"), 409],
      [new SessionServiceError("ALREADY_EXISTS", "이미"), 409],
      [new SessionServiceError("CREDENTIAL_REF_IN_USE", "다른 연결"), 409],
    ];
    for (const [error, status] of cases) {
      const response = await link(
        app({
          linkAgentIdentity: async () => {
            throw error;
          },
        }),
        BODY,
      );
      expect(response.status).toBe(status);
      expect(await errorOf(response)).toMatchObject({
        code: error.code,
        message: error.message,
      });
    }
    expect((await link(app({ linkAgentIdentity: outage }), BODY)).status).toBe(
      503,
    );
  });
});

describe("GET /v1/agents/{id}/identities", () => {
  test("lists, refuses and fails closed", async () => {
    const listed = await app({
      listAgentIdentities: async () => ({ items: [VIEW] }),
    }).request(`/v1/agents/${AGENT}/identities`, { headers: owner });
    expect(listed.status).toBe(200);
    expect(
      listAgentIdentitiesResponseSchema.parse(await listed.json()).items,
    ).toEqual([VIEW]);

    const refused = await app({
      listAgentIdentities: async () => {
        throw new SessionServiceError("FORBIDDEN", "no");
      },
    }).request(`/v1/agents/${AGENT}/identities`, { headers: owner });
    expect(refused.status).toBe(403);

    expect(
      (
        await app({}).request("/v1/agents/not-an-agent/identities", {
          headers: owner,
        })
      ).status,
    ).toBe(404);
    const down = await app({ listAgentIdentities: outage }).request(
      `/v1/agents/${AGENT}/identities`,
      { headers: owner },
    );
    expect(down.status).toBe(503);
  });
});

describe("DELETE /v1/agents/{id}/identities/{identity_id}", () => {
  function revoke(service: Partial<AgentIdentityService>, identity = IDENTITY) {
    return app(service).request(`/v1/agents/${AGENT}/identities/${identity}`, {
      method: "DELETE",
      headers: owner,
    });
  }

  test("revokes, and a second revoke has no receipt", async () => {
    let asked: unknown;
    const response = await revoke({
      revokeAgentIdentity: async (_caller, agentId, identityId) => {
        asked = [agentId, identityId];
        return {
          agent_identity: { ...VIEW, status: "revoked", revision: 2 },
          receipt_id: null,
        };
      },
    });
    expect(response.status).toBe(200);
    expect(asked).toEqual([AGENT, IDENTITY]);
    expect(
      revokeAgentIdentityResponseSchema.parse(await response.json()),
    ).toMatchObject({
      agent_identity: { status: "revoked" },
      receipt_id: null,
    });
  });

  test("a malformed id, a refusal and an outage", async () => {
    expect((await revoke({}, "not-an-identity")).status).toBe(404);
    expect(
      (
        await revoke({
          revokeAgentIdentity: async () => {
            throw new SessionServiceError("FORBIDDEN", "no");
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await revoke({
          revokeAgentIdentity: async () => {
            throw new SessionServiceError("NOT_FOUND", "Resource not found");
          },
        })
      ).status,
    ).toBe(404);
    expect((await revoke({ revokeAgentIdentity: outage })).status).toBe(503);
  });
});
