import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  listSettingsConnectionsResponseSchema,
  settingsChangeResponseSchema,
  settingsConnectionImpactResponseSchema,
} from "@werft-ai/contracts";
import {
  SessionServiceError,
  type SettingsConsoleService,
} from "@werft-ai/platform";
import { credentialHostsFromEnv } from "../installation-settings.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerSettingsConsoleRoutes } from "./installation-settings.ts";

const createApiApp = recordRouteErrors("routes/settings-console.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const BASE = "/v1/installation/settings";
const CHANGED = {
  id: "console",
  receipt_id: "019a0000-0000-7000-8000-0000000000f3",
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );
const refusing = (code: string) => async () => {
  throw new SessionServiceError(code as never, "no", undefined, {
    reason_code: "role",
  });
};

function request(
  settings: Partial<SettingsConsoleService>,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerSettingsConsoleRoutes(router, settings as SettingsConsoleService),
  }).request(path, {
    method,
    headers: { "X-Owner-Id": WORKSPACE, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

type Method = keyof SettingsConsoleService;

describe("removed URL repository routes", () => {
  for (const [method, suffix] of [
    ["GET", "/repositories"],
    ["POST", "/repositories"],
    ["PATCH", "/repositories/legacy"],
    ["POST", "/repositories/legacy/credential"],
    ["POST", "/repositories/legacy/disable"],
  ] as const) {
    test(`${method} ${suffix} is not registered`, async () => {
      const response = await request({}, method, `${BASE}${suffix}`, {});
      expect(response.status).toBe(404);
    });
  }
});

/** Every write route: its service method, a valid body, and a refused one. */
const WRITES: ReadonlyArray<{
  method: "POST" | "PATCH";
  path: string;
  service: Method;
  body?: unknown;
  invalid?: unknown;
  status: 200 | 201;
  /** The service gets the kind or id the path names. */
  args: unknown[];
}> = [
  {
    method: "POST",
    path: `${BASE}/connections`,
    service: "createConnection",
    body: {
      id: "console",
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth_kind: "api_key",
      value: "example-key",
    },
    invalid: { id: "Console!", kind: "anthropic" },
    status: 201,
    args: [],
  },
  {
    method: "POST",
    path: `${BASE}/mcp-servers`,
    service: "createMcpServer",
    body: {
      id: "docs",
      url: "https://mcp.example.invalid/mcp",
      credential_ref: "docs_mcp",
      workspaces: ["acme"],
      value: "example-bearer",
    },
    invalid: { id: "docs", workspaces: [] },
    status: 201,
    args: [],
  },
  ...(
    [
      ["connections", "connection"],
      ["mcp-servers", "mcp"],
    ] as const
  ).flatMap(([segment, kind]) => [
    {
      method: "POST" as const,
      path: `${BASE}/${segment}/console/credential`,
      service: "setCredential" as const,
      body: { value: "example-key" },
      invalid: { value: "" },
      status: 200 as const,
      args: [kind, "console", "example-key"],
    },
    {
      method: "POST" as const,
      path: `${BASE}/${segment}/console/disable`,
      service: "disable" as const,
      status: 200 as const,
      args: [kind, "console"],
    },
  ]),
  {
    method: "POST",
    path: `${BASE}/connections/console/convert`,
    service: "convertConnection",
    body: { value: "example-key" },
    invalid: { value: "" },
    status: 200,
    args: ["console", "example-key"],
  },
  {
    method: "PATCH",
    path: `${BASE}/mcp-servers/console`,
    service: "setMcpWorkspaces",
    body: { workspaces: ["acme"] },
    invalid: { workspaces: [] },
    status: 200,
    args: ["console", ["acme"]],
  },
];

describe("GET /v1/installation/settings/{kind}", () => {
  test("answers the list, and every refusal maps to its status", async () => {
    const listed = await request(
      {
        listConnections: async () => ({
          items: [
            {
              id: "fake",
              origin: "import",
              state: "active",
              kind: "anthropic",
              endpoint: "http://fake-model:8080",
              billing: "none",
              auth_kind: "api_key",
              credential: { source: "external", value_env: "FAKE_KEY" },
              created_at: "2026-11-04T03:00:00.000Z",
              disabled_at: null,
            },
          ],
          credential_hosts: null,
          endpoint_defaults: { anthropic: "https://api.anthropic.com" },
        }),
      },
      "GET",
      `${BASE}/connections`,
    );
    expect(listed.status).toBe(200);
    expect(
      listSettingsConnectionsResponseSchema.parse(await listed.json()).items,
    ).toHaveLength(1);
    for (const [service, segment] of [
      ["listConnections", "connections"],
      ["listMcpServers", "mcp-servers"],
    ] as const) {
      const path = `${BASE}/${segment}`;
      expect(
        (await request({ [service]: refusing("FORBIDDEN") }, "GET", path))
          .status,
      ).toBe(403);
      expect((await request({ [service]: outage }, "GET", path)).status).toBe(
        503,
      );
    }
  });
});

describe("GET /v1/installation/settings/connections/{id}/impact", () => {
  const path = `${BASE}/connections/console/impact`;
  const IMPACT = {
    id: "console",
    profile_count: 2,
    agent_count: 3,
    session_count: 1,
    judge_used: false,
  };

  test("asks the service for the id in the path and answers its counts", async () => {
    const asked: unknown[][] = [];
    const response = await request(
      {
        connectionImpact: async (_caller, id) => {
          asked.push([id]);
          return IMPACT;
        },
      },
      "GET",
      path,
    );
    expect(response.status).toBe(200);
    expect(
      settingsConnectionImpactResponseSchema.parse(await response.json()),
    ).toEqual(IMPACT);
    expect(asked).toEqual([["console"]]);
  });

  test("every refusal maps to its status", async () => {
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
    ] as const) {
      const response = await request(
        { connectionImpact: refusing(code) },
        "GET",
        path,
      );
      expect(response.status).toBe(status);
      apiErrorResponseSchema.parse(await response.json());
    }
    expect(
      (await request({ connectionImpact: outage }, "GET", path)).status,
    ).toBe(503);
  });
});

describe("settings console writes", () => {
  for (const write of WRITES) {
    test(`${write.method} ${write.path} passes the request on and maps every refusal`, async () => {
      const asked: unknown[][] = [];
      const answered = await request(
        {
          [write.service]: async (_caller: unknown, ...args: unknown[]) => {
            asked.push(args);
            return CHANGED;
          },
        },
        write.method,
        write.path,
        write.body,
      );
      expect(answered.status).toBe(write.status);
      expect(settingsChangeResponseSchema.parse(await answered.json())).toEqual(
        CHANGED,
      );
      expect(asked).toEqual([
        write.args.length > 0 ? write.args : [write.body],
      ]);

      if (write.invalid !== undefined) {
        expect(
          (await request({}, write.method, write.path, write.invalid)).status,
        ).toBe(400);
      }
      for (const [code, status] of [
        ["BAD_REQUEST", 400],
        ["FORBIDDEN", 403],
        ["NOT_FOUND", 404],
        ["REVISION_CONFLICT", 409],
      ] as const) {
        if (status === 404 && write.status === 201) continue;
        // A disable takes no body: nothing in it to refuse.
        if (status === 400 && write.body === undefined) continue;
        const refused = await request(
          { [write.service]: refusing(code) },
          write.method,
          write.path,
          write.body,
        );
        expect(refused.status).toBe(status);
        expect(
          apiErrorResponseSchema.parse(await refused.json()).error.code,
        ).toBe(code);
      }
      expect(
        (
          await request(
            { [write.service]: outage },
            write.method,
            write.path,
            write.body,
          )
        ).status,
      ).toBe(503);
    });
  }
});

describe("credentialHostsFromEnv", () => {
  test("joins the public and private credential lists; neither set is unknown", () => {
    expect(
      credentialHostsFromEnv({
        EGRESS_CREDENTIAL_ALLOWLIST: " api.anthropic.com:443, ,github.com:443",
        EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "fake-messages:4010",
      }),
    ).toEqual([
      "api.anthropic.com:443",
      "github.com:443",
      "fake-messages:4010",
    ]);
    expect(
      credentialHostsFromEnv({
        EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: "fake-git:3000",
      }),
    ).toEqual(["fake-git:3000"]);
    expect(
      credentialHostsFromEnv({ EGRESS_CREDENTIAL_ALLOWLIST: " " }),
    ).toBeNull();
    expect(credentialHostsFromEnv({})).toBeNull();
  });
});
