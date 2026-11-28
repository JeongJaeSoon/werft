import { describe, expect, test } from "bun:test";
import {
  deleteWorkspaceMcpServerResponseSchema,
  disconnectWorkspaceMcpServerResponseSchema,
  discoverWorkspaceMcpServerResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  startWorkspaceMcpOAuthResponseSchema,
  type WorkspaceMcpServer,
  workspaceMcpServerListSchema,
  workspaceMcpServerSchema,
} from "@werft-ai/contracts";
import {
  SessionServiceError,
  type WorkspaceMcpService,
} from "@werft-ai/platform";
import { errorOf } from "../../../testing/api-error.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerWorkspaceMcpServerRoutes } from "./workspace-mcp-servers.ts";

const createApiApp = recordRouteErrors(
  "routes/musterrolle/workspace-mcp-servers.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const SERVER_ID = "019a0000-0000-7000-8000-00000000c0a1";
const ADMIN = "019a0000-0000-7000-8000-00000000a0a1";
const owner = { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" };
const base = "/v1/workspace/mcp-servers";
const one = `${base}/${SERVER_ID}`;
const FAKE_TOKEN = "example-token-not-real";

const SERVER: WorkspaceMcpServer = {
  id: SERVER_ID,
  name: "tracker",
  url: "https://mcp.example.com/v1/mcp",
  auth_kind: "oauth",
  redirect_uri: `https://console.example.com/settings/workspace/mcp-servers/${SERVER_ID}/callback`,
  oauth: {
    issuer: "https://auth.example.com",
    scope: "read:issues",
    client_registration: "dcr",
    client_id: "werft-example-client",
    has_client_secret: false,
    dcr_supported: true,
  },
  bearer: null,
  connection: {
    state: "active",
    reauth_reason: null,
    connected_by: { user_id: ADMIN, display_name: "Admin" },
    connected_at: "2026-11-15T00:00:00.000Z",
    granted_scope: "read:issues",
    access_expires_at: "2026-11-15T01:00:00.000Z",
  },
  tools: [{ name: "search_issues", description: null }],
  tools_skipped: 0,
  tools_read_at: "2026-11-15T00:00:00.000Z",
  created_by: { user_id: ADMIN, display_name: "Admin" },
  created_at: "2026-11-15T00:00:00.000Z",
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );
const fail = (code: ConstructorParameters<typeof SessionServiceError>[0]) => {
  throw new SessionServiceError(code, "no");
};

function app(service: Partial<WorkspaceMcpService>) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerWorkspaceMcpServerRoutes(router, service as WorkspaceMcpService),
  });
}

const send = async (
  service: Partial<WorkspaceMcpService>,
  method: string,
  path: string,
  body?: string,
): Promise<Response> =>
  app(service).request(path, {
    method,
    headers: owner,
    ...(body === undefined ? {} : { body }),
  });

const huge = (field: string) =>
  JSON.stringify({ [field]: "x".repeat(REQUEST_BODY_MAX_BYTES) });

async function expectCodes(
  call: (failing: () => Promise<never>) => Promise<Response>,
  cases: readonly (readonly [
    ConstructorParameters<typeof SessionServiceError>[0],
    number,
  ])[],
) {
  for (const [code, status] of cases) {
    const response = await call(async () => fail(code));
    expect({ code, status: response.status }).toEqual({ code, status });
    expect((await errorOf(response)).code).toBe(code);
  }
  expect((await call(outage)).status).toBe(503);
}

describe("GET /v1/workspace/mcp-servers", () => {
  test("lists with no credential value in the answer", async () => {
    const response = await send(
      { list: async () => ({ items: [SERVER], limit: 20 }) },
      "GET",
      base,
    );
    expect(response.status).toBe(200);
    const listed = workspaceMcpServerListSchema.parse(await response.json());
    expect(listed.items[0]?.connection.connected_by?.user_id).toBe(ADMIN);
  });

  test("a refusal and an outage", async () => {
    await expectCodes(
      (failing) => send({ list: failing }, "GET", base),
      [["FORBIDDEN", 403]],
    );
  });
});

describe("POST /v1/workspace/mcp-servers/discover", () => {
  test("hands the URL to the service", async () => {
    let asked: unknown;
    const response = await send(
      {
        discover: async (_caller, url) => {
          asked = url;
          return { url, oauth: null };
        },
      },
      "POST",
      `${base}/discover`,
      JSON.stringify({ url: "https://mcp.example.com/v1/mcp" }),
    );
    expect(response.status).toBe(200);
    expect(asked).toBe("https://mcp.example.com/v1/mcp");
    expect(
      discoverWorkspaceMcpServerResponseSchema.parse(await response.json())
        .oauth,
    ).toBeNull();
  });

  test("a bad body never reaches the service; refusals keep their codes", async () => {
    for (const body of ["{}", JSON.stringify({ url: 1 }), "not json"]) {
      expect((await send({}, "POST", `${base}/discover`, body)).status).toBe(
        400,
      );
    }
    expect(
      (await send({}, "POST", `${base}/discover`, huge("url"))).status,
    ).toBe(413);
    await expectCodes(
      (failing) =>
        send(
          { discover: failing },
          "POST",
          `${base}/discover`,
          JSON.stringify({ url: "http://mcp.example.com/v1/mcp" }),
        ),
      [
        ["BAD_REQUEST", 400],
        ["FORBIDDEN", 403],
        ["BACKEND_UNAVAILABLE", 503],
      ],
    );
  });
});

describe("POST /v1/workspace/mcp-servers", () => {
  test("creates with 201, the token handed only to the service", async () => {
    let asked: unknown;
    const response = await send(
      {
        create: async (_caller, body) => {
          asked = body;
          return { ...SERVER, auth_kind: "bearer", oauth: null };
        },
      },
      "POST",
      base,
      JSON.stringify({
        name: "tracker",
        url: "https://mcp.example.com/v1/mcp",
        auth_kind: "bearer",
        token: FAKE_TOKEN,
      }),
    );
    expect(response.status).toBe(201);
    expect(asked).toMatchObject({ auth_kind: "bearer", token: FAKE_TOKEN });
    const text = await response.text();
    expect(text).not.toContain(FAKE_TOKEN);
    expect(workspaceMcpServerSchema.parse(JSON.parse(text)).id).toBe(SERVER_ID);
  });

  test("a bad body never reaches the service; refusals keep their codes", async () => {
    for (const body of [
      "{}",
      JSON.stringify({ name: "tracker", url: "https://x", auth_kind: "x" }),
      JSON.stringify({
        name: "tracker",
        url: "https://x",
        auth_kind: "bearer",
      }),
      JSON.stringify({
        name: "tracker",
        url: "https://x",
        auth_kind: "oauth",
        extra: true,
      }),
    ]) {
      expect((await send({}, "POST", base, body)).status).toBe(400);
    }
    expect((await send({}, "POST", base, huge("name"))).status).toBe(413);
    await expectCodes(
      (failing) =>
        send(
          { create: failing },
          "POST",
          base,
          JSON.stringify({
            name: "tracker",
            url: "https://mcp.example.com/v1/mcp",
            auth_kind: "oauth",
          }),
        ),
      [
        ["BAD_REQUEST", 400],
        ["FORBIDDEN", 403],
        ["ALREADY_EXISTS", 409],
        ["MCP_SERVER_QUOTA_EXCEEDED", 409],
        ["BACKEND_UNAVAILABLE", 503],
      ],
    );
  });
});

describe("DELETE /v1/workspace/mcp-servers/{id}", () => {
  test("deletes by id", async () => {
    let asked: unknown;
    const response = await send(
      {
        delete: async (_caller, id) => {
          asked = id;
          return { id };
        },
      },
      "DELETE",
      one,
    );
    expect(response.status).toBe(200);
    expect(asked).toBe(SERVER_ID);
    expect(
      deleteWorkspaceMcpServerResponseSchema.parse(await response.json()).id,
    ).toBe(SERVER_ID);
  });

  test("an id that is not one, a refusal and an outage", async () => {
    expect((await send({}, "DELETE", `${base}/not-an-id`)).status).toBe(404);
    await expectCodes(
      (failing) => send({ delete: failing }, "DELETE", one),
      [
        ["FORBIDDEN", 403],
        ["NOT_FOUND", 404],
      ],
    );
  });
});

describe("PUT /v1/workspace/mcp-servers/{id}/token", () => {
  test("hands the token to the service and never answers it", async () => {
    let asked: unknown;
    const response = await send(
      {
        putBearerToken: async (_caller, id, body) => {
          asked = [id, body];
          return { ...SERVER, auth_kind: "bearer", bearer: { last4: "real" } };
        },
      },
      "PUT",
      `${one}/token`,
      JSON.stringify({ token: FAKE_TOKEN }),
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual([SERVER_ID, { token: FAKE_TOKEN }]);
    expect(await response.text()).not.toContain(FAKE_TOKEN);
  });

  test("a bad body never reaches the service; refusals keep their codes", async () => {
    for (const body of [
      "{}",
      JSON.stringify({ token: "short" }),
      JSON.stringify({ token: "has a space in it" }),
    ]) {
      expect((await send({}, "PUT", `${one}/token`, body)).status).toBe(400);
    }
    expect((await send({}, "PUT", `${one}/token`, huge("token"))).status).toBe(
      413,
    );
    await expectCodes(
      (failing) =>
        send(
          { putBearerToken: failing },
          "PUT",
          `${one}/token`,
          JSON.stringify({ token: FAKE_TOKEN }),
        ),
      [
        ["BAD_REQUEST", 400],
        ["FORBIDDEN", 403],
        ["NOT_FOUND", 404],
      ],
    );
  });
});

describe("PUT /v1/workspace/mcp-servers/{id}/oauth-client", () => {
  test("hands the client to the service", async () => {
    let asked: unknown;
    const response = await send(
      {
        putOAuthClient: async (_caller, id, body) => {
          asked = [id, body];
          return SERVER;
        },
      },
      "PUT",
      `${one}/oauth-client`,
      JSON.stringify({ client_id: "werft-example-client" }),
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual([SERVER_ID, { client_id: "werft-example-client" }]);
  });

  test("a bad body never reaches the service; refusals keep their codes", async () => {
    for (const body of ["{}", JSON.stringify({ client_id: "" })]) {
      expect((await send({}, "PUT", `${one}/oauth-client`, body)).status).toBe(
        400,
      );
    }
    expect(
      (await send({}, "PUT", `${one}/oauth-client`, huge("client_id"))).status,
    ).toBe(413);
    await expectCodes(
      (failing) =>
        send(
          { putOAuthClient: failing },
          "PUT",
          `${one}/oauth-client`,
          JSON.stringify({ client_id: "werft-example-client" }),
        ),
      [
        ["BAD_REQUEST", 400],
        ["FORBIDDEN", 403],
        ["NOT_FOUND", 404],
      ],
    );
  });
});

describe("POST /v1/workspace/mcp-servers/{id}/oauth/start", () => {
  test("answers where to send the browser", async () => {
    const response = await send(
      {
        startOAuth: async () => ({
          authorization_url: "https://auth.example.com/authorize?x=1",
          expires_at: "2026-11-15T00:10:00.000Z",
        }),
      },
      "POST",
      `${one}/oauth/start`,
    );
    expect(response.status).toBe(200);
    expect(
      startWorkspaceMcpOAuthResponseSchema.parse(await response.json())
        .authorization_url,
    ).toBe("https://auth.example.com/authorize?x=1");
  });

  test("refusals keep their codes", async () => {
    await expectCodes(
      (failing) => send({ startOAuth: failing }, "POST", `${one}/oauth/start`),
      [
        ["BAD_REQUEST", 400],
        ["FORBIDDEN", 403],
        ["NOT_FOUND", 404],
        ["BACKEND_UNAVAILABLE", 503],
      ],
    );
  });
});

describe("POST /v1/workspace/mcp-servers/{id}/oauth/complete", () => {
  const BODY = JSON.stringify({
    code: "example-code",
    state: "example-state",
    iss: "https://auth.example.com",
  });

  test("hands what the callback read to the service", async () => {
    let asked: unknown;
    const response = await send(
      {
        completeOAuth: async (_caller, id, body) => {
          asked = [id, body];
          return SERVER;
        },
      },
      "POST",
      `${one}/oauth/complete`,
      BODY,
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual([SERVER_ID, JSON.parse(BODY)]);
  });

  test("a bad body never reaches the service; refusals keep their codes", async () => {
    for (const body of ["{}", JSON.stringify({ code: "c" })]) {
      expect(
        (await send({}, "POST", `${one}/oauth/complete`, body)).status,
      ).toBe(400);
    }
    expect(
      (await send({}, "POST", `${one}/oauth/complete`, huge("code"))).status,
    ).toBe(413);
    await expectCodes(
      (failing) =>
        send({ completeOAuth: failing }, "POST", `${one}/oauth/complete`, BODY),
      [
        ["BAD_REQUEST", 400],
        ["FORBIDDEN", 403],
        ["NOT_FOUND", 404],
        ["BACKEND_UNAVAILABLE", 503],
      ],
    );
  });
});

describe("POST /v1/workspace/mcp-servers/{id}/disconnect", () => {
  test("answers the server and the revocation", async () => {
    const response = await send(
      { disconnect: async () => ({ server: SERVER, revoked: null }) },
      "POST",
      `${one}/disconnect`,
    );
    expect(response.status).toBe(200);
    expect(
      disconnectWorkspaceMcpServerResponseSchema.parse(await response.json())
        .revoked,
    ).toBeNull();
  });

  test("refusals keep their codes", async () => {
    await expectCodes(
      (failing) => send({ disconnect: failing }, "POST", `${one}/disconnect`),
      [
        // A server of a kind this release does not know: auth_kind_unsupported.
        ["BAD_REQUEST", 400],
        ["FORBIDDEN", 403],
        ["NOT_FOUND", 404],
      ],
    );
  });
});

describe("a server of an auth kind this release does not know", () => {
  // What a later release may store: the row still answers, as stored.
  const LATER: typeof SERVER = {
    ...SERVER,
    auth_kind: "none",
    redirect_uri: null,
    oauth: null,
    bearer: null,
    connection: { ...SERVER.connection, granted_scope: null },
  };

  test("lists, and every answer that carries a server is 2xx with it as stored", async () => {
    const listed = await send(
      { list: async () => ({ items: [SERVER, LATER], limit: 20 }) },
      "GET",
      base,
    );
    expect(listed.status).toBe(200);
    expect(
      workspaceMcpServerListSchema
        .parse(await listed.json())
        .items.map((item) => item.auth_kind),
    ).toEqual(["oauth", "none"]);

    const reply = async () => LATER;
    const calls: [
      Partial<WorkspaceMcpService>,
      string,
      string,
      string?,
      number?,
    ][] = [
      [
        { create: reply },
        "POST",
        base,
        JSON.stringify({
          name: "tracker",
          url: "https://mcp.example.com/v1/mcp",
          auth_kind: "oauth",
        }),
        201,
      ],
      [
        { putBearerToken: reply },
        "PUT",
        `${one}/token`,
        JSON.stringify({ token: "x".repeat(12) }),
      ],
      [
        { putOAuthClient: reply },
        "PUT",
        `${one}/oauth-client`,
        JSON.stringify({ client_id: "client-1" }),
      ],
      [
        { completeOAuth: reply },
        "POST",
        `${one}/oauth/complete`,
        JSON.stringify({ code: "c", state: "s" }),
      ],
      [{ refreshTools: reply }, "POST", `${one}/tools/refresh`],
    ];
    for (const [service, method, path, body, status = 200] of calls) {
      const response = await send(service, method, path, body);
      expect({ path, method, status: response.status }).toEqual({
        path,
        method,
        status,
      });
      expect(workspaceMcpServerSchema.parse(await response.json())).toEqual(
        LATER,
      );
    }
    const disconnected = await send(
      { disconnect: async () => ({ server: LATER, revoked: null }) },
      "POST",
      `${one}/disconnect`,
    );
    expect(disconnected.status).toBe(200);
    expect(
      ((await disconnected.json()) as { server: { auth_kind: string } }).server
        .auth_kind,
    ).toBe("none");
  });

  test("oauth and bearer servers answer as before; a request still names only those two", async () => {
    const bearer: typeof SERVER = {
      ...SERVER,
      auth_kind: "bearer",
      redirect_uri: null,
      oauth: null,
      bearer: { last4: "alue" },
    };
    const response = await send(
      { list: async () => ({ items: [SERVER, bearer], limit: 20 }) },
      "GET",
      base,
    );
    expect(await response.json()).toEqual({
      items: [SERVER, bearer],
      limit: 20,
    });
    const refused = await send(
      {},
      "POST",
      base,
      JSON.stringify({ name: "tracker", url: "https://x", auth_kind: "none" }),
    );
    expect(refused.status).toBe(400);
  });
});

describe("POST /v1/workspace/mcp-servers/{id}/tools/refresh", () => {
  test("answers the server with its tools", async () => {
    const response = await send(
      { refreshTools: async () => SERVER },
      "POST",
      `${one}/tools/refresh`,
    );
    expect(response.status).toBe(200);
    expect(
      workspaceMcpServerSchema.parse(await response.json()).tools[0]?.name,
    ).toBe("search_issues");
  });

  test("refusals keep their codes", async () => {
    await expectCodes(
      (failing) =>
        send({ refreshTools: failing }, "POST", `${one}/tools/refresh`),
      [
        ["BAD_REQUEST", 400],
        ["FORBIDDEN", 403],
        ["NOT_FOUND", 404],
        ["BACKEND_UNAVAILABLE", 503],
      ],
    );
  });
});
