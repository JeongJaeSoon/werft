import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_REVOKE_NOTICE,
  type CredentialBindingView,
  createCredentialBindingResponseSchema,
  listCredentialBindingsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  revokeCredentialBindingResponseSchema,
} from "@werft-ai/contracts";
import {
  type CredentialBindingService,
  SessionServiceError,
} from "@werft-ai/platform";
import { errorOf } from "../../../test-support/api-error.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerCredentialBindingRoutes } from "./credential-bindings.ts";

const createApiApp = recordRouteErrors(
  "routes/musterrolle/credential-bindings.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-00000000b0a1";
const BINDING = "019a0000-0000-7000-8000-0000000000c1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000d1";
const owner = { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" };
const path = `/v1/agents/${AGENT}/credential-bindings`;

const VIEW: CredentialBindingView = {
  id: BINDING,
  agent_id: AGENT,
  credential_ref: "slack_bot_token",
  bound_by: "019a0000-0000-7000-8000-0000000000a1",
  bound_at: "2026-10-11T00:00:00.000Z",
  revoked_at: null,
  running_sessions: 2,
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );
const refusal = () => {
  throw new SessionServiceError("FORBIDDEN", "no", undefined, {
    reason_code: "role",
  });
};
const missing = () => {
  throw new SessionServiceError("NOT_FOUND", "Resource not found");
};

function app(service: Partial<CredentialBindingService>) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerCredentialBindingRoutes(
        router,
        service as CredentialBindingService,
      ),
  });
}

describe("GET /v1/agents/{id}/credential-bindings", () => {
  test("lists with the running count and the unbind notice", async () => {
    let asked: string | undefined;
    const response = await app({
      list: async (_caller, agentId) => {
        asked = agentId;
        return { items: [VIEW], revoke_notice: CREDENTIAL_REVOKE_NOTICE };
      },
    }).request(path, { headers: owner });
    expect(response.status).toBe(200);
    expect(asked).toBe(AGENT);
    const body = listCredentialBindingsResponseSchema.parse(
      await response.json(),
    );
    expect(body.items[0]?.running_sessions).toBe(2);
    expect(body.revoke_notice).toBe(CREDENTIAL_REVOKE_NOTICE);
  });

  test("a malformed or unknown agent, a refusal and an outage", async () => {
    const list = (service: Partial<CredentialBindingService>, at = path) =>
      app(service).request(at, { headers: owner });
    expect(
      (await list({}, "/v1/agents/not-an-agent/credential-bindings")).status,
    ).toBe(404);
    expect((await list({ list: async () => missing() })).status).toBe(404);
    const refused = await list({ list: async () => refusal() });
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({
      details: { reason_code: "role" },
    });
    expect((await list({ list: outage })).status).toBe(503);
  });
});

describe("POST /v1/agents/{id}/credential-bindings", () => {
  function bind(service: Partial<CredentialBindingService>, body: unknown) {
    return app(service).request(path, {
      method: "POST",
      headers: owner,
      body: JSON.stringify(body),
    });
  }

  test("binds a name and names the receipt", async () => {
    let asked: unknown;
    const response = await bind(
      {
        bind: async (_caller, agentId, body) => {
          asked = [agentId, body];
          return { binding: VIEW, created: true, receipt_id: RECEIPT };
        },
      },
      { credential_ref: "slack_bot_token" },
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual([AGENT, { credential_ref: "slack_bot_token" }]);
    expect(
      createCredentialBindingResponseSchema.parse(await response.json()),
    ).toMatchObject({ created: true, receipt_id: RECEIPT });
  });

  test("a value where a name goes, or an oversized body, never reaches the service", async () => {
    for (const body of [
      { credential_ref: "xoxb 1234 SECRET" },
      { credential_ref: "slack", value: "secret" },
      {},
    ]) {
      expect((await bind({}, body)).status).toBe(400);
    }
    expect(
      (
        await bind(
          {},
          { credential_ref: "x", pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
        )
      ).status,
    ).toBe(413);
  });

  test("an identity's name is 409 CREDENTIAL_REF_IN_USE", async () => {
    const response = await bind(
      {
        bind: async () => {
          throw new SessionServiceError("CREDENTIAL_REF_IN_USE", "taken");
        },
      },
      { credential_ref: "slack_bot_token" },
    );
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("CREDENTIAL_REF_IN_USE");
  });

  test("a refusal, an unknown agent and an outage", async () => {
    const body = { credential_ref: "slack_bot_token" };
    expect((await bind({ bind: async () => refusal() }, body)).status).toBe(
      403,
    );
    expect((await bind({ bind: async () => missing() }, body)).status).toBe(
      404,
    );
    expect((await bind({ bind: outage }, body)).status).toBe(503);
  });
});

describe("DELETE /v1/agents/{id}/credential-bindings/{binding_id}", () => {
  function revoke(service: Partial<CredentialBindingService>, id = BINDING) {
    return app(service).request(`${path}/${id}`, {
      method: "DELETE",
      headers: owner,
    });
  }

  test("unbinds and says how many running sessions keep it", async () => {
    let asked: unknown;
    const response = await revoke({
      revoke: async (_caller, agentId, bindingId) => {
        asked = [agentId, bindingId];
        return {
          binding: { ...VIEW, revoked_at: "2026-10-11T01:00:00.000Z" },
          revoke_notice: CREDENTIAL_REVOKE_NOTICE,
          receipt_id: RECEIPT,
        };
      },
    });
    expect(response.status).toBe(200);
    expect(asked).toEqual([AGENT, BINDING]);
    expect(
      revokeCredentialBindingResponseSchema.parse(await response.json()),
    ).toMatchObject({
      binding: { running_sessions: 2 },
      revoke_notice: CREDENTIAL_REVOKE_NOTICE,
    });
  });

  test("a malformed id, a refusal, a missing binding and an outage", async () => {
    expect((await revoke({}, "not-a-binding")).status).toBe(404);
    expect((await revoke({ revoke: async () => refusal() })).status).toBe(403);
    expect((await revoke({ revoke: async () => missing() })).status).toBe(404);
    expect((await revoke({ revoke: outage })).status).toBe(503);
  });
});
