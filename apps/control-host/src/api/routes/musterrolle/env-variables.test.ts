import { describe, expect, test } from "bun:test";
import {
  agentEnvVariablesSchema,
  deleteEnvVariableResponseSchema,
  envVariableListSchema,
  putEnvVariableGrantsResponseSchema,
  putEnvVariableResponseSchema,
  REQUEST_BODY_MAX_BYTES,
} from "@werft-ai/contracts";
import {
  type EnvVariableService,
  SessionServiceError,
} from "@werft-ai/platform";
import { errorOf } from "../../../test-support/api-error.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerEnvVariableRoutes } from "./env-variables.ts";

const createApiApp = recordRouteErrors(
  "routes/musterrolle/env-variables.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const AGENT = "019a0000-0000-7000-8000-00000000b0a1";
const owner = { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" };
const workspacePath = "/v1/workspace/variables";
const agentPath = `/v1/agents/${AGENT}/variables`;

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );
const fail = (code: ConstructorParameters<typeof SessionServiceError>[0]) => {
  throw new SessionServiceError(code, "no");
};

function app(service: Partial<EnvVariableService>) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerEnvVariableRoutes(router, service as EnvVariableService),
  });
}

const BODY = JSON.stringify({ kind: "plain", value: "ap-northeast-1" });

describe("GET /v1/workspace/variables", () => {
  test("lists", async () => {
    const response = await app({
      listWorkspace: async () => ({
        items: [
          {
            name: "REGION",
            kind: "plain",
            value: "ap-northeast-1",
            version: 3,
            grant_all: false,
            grant_version: 4,
            granted_agents: [AGENT],
            engine_delivery: false,
            updated_by: null,
            updated_at: "2026-11-09T00:00:00.000Z",
          },
        ],
      }),
    }).request(workspacePath, { headers: owner });
    expect(response.status).toBe(200);
    expect(
      envVariableListSchema.parse(await response.json()).items[0]?.name,
    ).toBe("REGION");
  });

  test("a refusal and an outage", async () => {
    const get = (service: Partial<EnvVariableService>) =>
      app(service).request(workspacePath, { headers: owner });
    expect(
      (await get({ listWorkspace: async () => fail("FORBIDDEN") })).status,
    ).toBe(403);
    expect((await get({ listWorkspace: outage })).status).toBe(503);
  });
});

describe("PUT /v1/workspace/variables/{name}", () => {
  const put = (
    service: Partial<EnvVariableService>,
    body: string,
    headers: Record<string, string> = {},
    name = "REGION",
  ) =>
    app(service).request(`${workspacePath}/${name}`, {
      method: "PUT",
      headers: { ...owner, ...headers },
      body,
    });

  test("hands the name, the body and both precondition headers to the service", async () => {
    let asked: unknown;
    const response = await put(
      {
        putWorkspace: async (_caller, name, body, headers) => {
          asked = [name, body, headers];
          return { name, version: 5, grant_version: 6 };
        },
      },
      BODY,
      { "If-None-Match": "*" },
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual([
      "REGION",
      { kind: "plain", value: "ap-northeast-1" },
      { ifMatch: undefined, ifNoneMatch: "*" },
    ]);
    expect(putEnvVariableResponseSchema.parse(await response.json())).toEqual({
      name: "REGION",
      version: 5,
      grant_version: 6,
    });
    await put(
      {
        putWorkspace: async (_c, _n, _b, headers) => {
          asked = headers;
          return { name: "REGION", version: 6, grant_version: 6 };
        },
      },
      BODY,
      { "If-Match": '"5"' },
    );
    expect(asked).toEqual({ ifMatch: '"5"', ifNoneMatch: undefined });
  });

  test("a body that is not the shape, or too large, never reaches the service", async () => {
    for (const body of [
      "{}",
      JSON.stringify({ kind: "plain" }),
      JSON.stringify({ kind: "plain", value: 1 }),
      JSON.stringify({ kind: "plain", value: "x", other: true }),
      "not json",
    ]) {
      expect((await put({}, body)).status).toBe(400);
    }
    expect(
      (
        await put(
          {},
          JSON.stringify({
            kind: "plain",
            value: "x".repeat(REQUEST_BODY_MAX_BYTES),
          }),
        )
      ).status,
    ).toBe(413);
  });

  test("the service's refusals keep their codes and statuses", async () => {
    const cases = [
      ["VARIABLE_NAME_INVALID", 400],
      ["VARIABLE_NAME_RESERVED", 400],
      ["VARIABLE_VALUE_INVALID", 400],
      ["VARIABLE_VALUE_TOO_LARGE", 400],
      ["SECRET_ENV_UNSUPPORTED", 400],
      ["FORBIDDEN", 403],
      ["VARIABLE_QUOTA_EXCEEDED", 409],
      ["VERSION_MISMATCH", 412],
      ["PRECONDITION_REQUIRED", 428],
    ] as const;
    for (const [code, status] of cases) {
      const response = await put(
        { putWorkspace: async () => fail(code) },
        BODY,
      );
      expect(response.status).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
    }
    expect((await put({ putWorkspace: outage }, BODY)).status).toBe(503);
  });
});

describe("DELETE /v1/workspace/variables/{name}", () => {
  const remove = (service: Partial<EnvVariableService>, ifMatch?: string) =>
    app(service).request(`${workspacePath}/REGION`, {
      method: "DELETE",
      headers:
        ifMatch === undefined ? owner : { ...owner, "If-Match": ifMatch },
    });

  test("deletes at the version named and says who still holds the value", async () => {
    let asked: unknown;
    const response = await remove(
      {
        deleteWorkspace: async (_caller, name, ifMatch) => {
          asked = [name, ifMatch];
          return { affected_agents: 3, open_sessions: 1 };
        },
      },
      "7",
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual(["REGION", "7"]);
    expect(
      deleteEnvVariableResponseSchema.parse(await response.json()),
    ).toEqual({ affected_agents: 3, open_sessions: 1 });
  });

  test("a malformed header, a refusal, a missing variable, a stale version, no header and an outage", async () => {
    const answer = async (code: Parameters<typeof fail>[0]) =>
      (await remove({ deleteWorkspace: async () => fail(code) }, "7")).status;
    expect(await answer("BAD_REQUEST")).toBe(400);
    expect(await answer("FORBIDDEN")).toBe(403);
    expect(await answer("NOT_FOUND")).toBe(404);
    expect(await answer("VERSION_MISMATCH")).toBe(412);
    expect(await answer("PRECONDITION_REQUIRED")).toBe(428);
    expect((await remove({ deleteWorkspace: outage }, "7")).status).toBe(503);
  });
});

describe("PUT /v1/workspace/variables/{name}/grants", () => {
  const grants = (
    service: Partial<EnvVariableService>,
    body: unknown = { grant_all: false, agents: [{ id: AGENT }] },
    ifMatch = "9",
  ) =>
    app(service).request(`${workspacePath}/REGION/grants`, {
      method: "PUT",
      headers: { ...owner, "If-Match": ifMatch },
      body: JSON.stringify(body),
    });

  test("replaces the set at the grant version named", async () => {
    let asked: unknown;
    const response = await grants({
      putGrants: async (_caller, name, body, ifMatch) => {
        asked = [name, body, ifMatch];
        return { name, grant_version: 10 };
      },
    });
    expect(response.status).toBe(200);
    expect(asked).toEqual([
      "REGION",
      { grant_all: false, agents: [{ id: AGENT }] },
      "9",
    ]);
    expect(
      putEnvVariableGrantsResponseSchema.parse(await response.json()),
    ).toEqual({ name: "REGION", grant_version: 10 });
  });

  test("a body that is not the shape, an oversized one, and the service's refusals", async () => {
    for (const body of [
      {},
      { grant_all: false },
      { grant_all: false, agents: [{ id: "x" }] },
      { grant_all: false, agents: [{ id: AGENT }, { id: AGENT }] },
    ]) {
      expect((await grants({}, body)).status).toBe(400);
    }
    expect(
      (
        await grants(
          {},
          {
            grant_all: false,
            agents: [],
            pad: "x".repeat(REQUEST_BODY_MAX_BYTES),
          },
        )
      ).status,
    ).toBe(413);
    const answer = async (code: Parameters<typeof fail>[0]) =>
      (await grants({ putGrants: async () => fail(code) })).status;
    expect(await answer("BAD_REQUEST")).toBe(400);
    expect(await answer("SECRET_GRANT_ALL_FORBIDDEN")).toBe(400);
    expect(await answer("FORBIDDEN")).toBe(403);
    expect(await answer("NOT_FOUND")).toBe(404);
    expect(await answer("VERSION_MISMATCH")).toBe(412);
    expect(await answer("PRECONDITION_REQUIRED")).toBe(428);
    expect((await grants({ putGrants: outage })).status).toBe(503);
  });
});

describe("GET /v1/agents/{id}/variables", () => {
  const get = (service: Partial<EnvVariableService>, at = agentPath) =>
    app(service).request(at, { headers: owner });

  test("reads the agent's view", async () => {
    let asked: string | undefined;
    const response = await get({
      listAgent: async (_caller, agentId) => {
        asked = agentId;
        return { effective: [], items: [], granted_workspace_values: [] };
      },
    });
    expect(response.status).toBe(200);
    expect(asked).toBe(AGENT);
    expect(agentEnvVariablesSchema.parse(await response.json())).toEqual({
      effective: [],
      items: [],
      granted_workspace_values: [],
    });
  });

  test("a malformed or unknown agent, a refusal and an outage", async () => {
    expect((await get({}, "/v1/agents/not-an-agent/variables")).status).toBe(
      404,
    );
    expect(
      (await get({ listAgent: async () => fail("NOT_FOUND") })).status,
    ).toBe(404);
    expect(
      (await get({ listAgent: async () => fail("FORBIDDEN") })).status,
    ).toBe(403);
    expect((await get({ listAgent: outage })).status).toBe(503);
  });
});

describe("PUT and DELETE /v1/agents/{id}/variables/{name}", () => {
  const put = (
    service: Partial<EnvVariableService>,
    body: string,
    headers: Record<string, string> = { "If-None-Match": "*" },
    at = `${agentPath}/REGION`,
  ) =>
    app(service).request(at, {
      method: "PUT",
      headers: { ...owner, ...headers },
      body,
    });
  const remove = (
    service: Partial<EnvVariableService>,
    at = `${agentPath}/REGION`,
  ) =>
    app(service).request(at, {
      method: "DELETE",
      headers: { ...owner, "If-Match": "3" },
    });

  test("writes and deletes on the agent named", async () => {
    let asked: unknown;
    const saved = await put(
      {
        putAgent: async (_caller, agentId, name, _body, headers) => {
          asked = [agentId, name, headers];
          return { name, version: 2, grant_version: 2 };
        },
      },
      BODY,
    );
    expect(saved.status).toBe(200);
    expect(asked).toEqual([
      AGENT,
      "REGION",
      { ifMatch: undefined, ifNoneMatch: "*" },
    ]);
    const deleted = await remove({
      deleteAgent: async (_caller, agentId, name, ifMatch) => {
        asked = [agentId, name, ifMatch];
        return { affected_agents: 1, open_sessions: 0 };
      },
    });
    expect(deleted.status).toBe(200);
    expect(asked).toEqual([AGENT, "REGION", "3"]);
  });

  test("a malformed agent or a bad body never reaches the service", async () => {
    expect(
      (await put({}, BODY, undefined, "/v1/agents/nope/variables/REGION"))
        .status,
    ).toBe(404);
    expect((await remove({}, "/v1/agents/nope/variables/REGION")).status).toBe(
      404,
    );
    expect((await put({}, "{}")).status).toBe(400);
    expect(
      (
        await put(
          {},
          JSON.stringify({
            kind: "plain",
            value: "x".repeat(REQUEST_BODY_MAX_BYTES),
          }),
        )
      ).status,
    ).toBe(413);
  });

  test("the service's refusals keep their statuses", async () => {
    const write = async (code: Parameters<typeof fail>[0]) =>
      (await put({ putAgent: async () => fail(code) }, BODY)).status;
    expect(await write("VARIABLE_NAME_RESERVED")).toBe(400);
    expect(await write("FORBIDDEN")).toBe(403);
    expect(await write("NOT_FOUND")).toBe(404);
    expect(await write("VARIABLE_QUOTA_EXCEEDED")).toBe(409);
    expect(await write("VERSION_MISMATCH")).toBe(412);
    expect(await write("PRECONDITION_REQUIRED")).toBe(428);
    expect((await put({ putAgent: outage }, BODY)).status).toBe(503);
    const erase = async (code: Parameters<typeof fail>[0]) =>
      (await remove({ deleteAgent: async () => fail(code) })).status;
    expect(await erase("BAD_REQUEST")).toBe(400);
    expect(await erase("FORBIDDEN")).toBe(403);
    expect(await erase("NOT_FOUND")).toBe(404);
    expect(await erase("VERSION_MISMATCH")).toBe(412);
    expect(await erase("PRECONDITION_REQUIRED")).toBe(428);
    expect((await remove({ deleteAgent: outage })).status).toBe(503);
  });
});
