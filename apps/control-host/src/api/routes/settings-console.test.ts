import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  discoverConnectionModelsResponseSchema,
  listSettingsConnectionsResponseSchema,
  settingsChangeResponseSchema,
  settingsConnectionImpactResponseSchema,
} from "@werft-ai/contracts";
import {
  SessionServiceError,
  type SettingsConsoleService,
} from "@werft-ai/platform";
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

// `/repositories/{id}/credential` is back for a repository naming its own
// GitHub App only; the service answers 404 for any other. The installation
// catalog MCP is retired, its routes with it.
describe("removed URL repository and catalog MCP routes", () => {
  for (const [method, suffix] of [
    ["GET", "/repositories"],
    ["POST", "/repositories"],
    ["PATCH", "/repositories/legacy"],
    ["POST", "/repositories/legacy/disable"],
    ["GET", "/mcp-servers"],
    ["POST", "/mcp-servers"],
    ["PATCH", "/mcp-servers/docs"],
    ["POST", "/mcp-servers/docs/credential"],
    ["POST", "/mcp-servers/docs/disable"],
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
    path: `${BASE}/connections/console/credential`,
    service: "setCredential",
    body: { value: "example-key" },
    invalid: { value: "" },
    status: 200,
    args: ["connection", "console", "example-key"],
  },
  {
    method: "POST",
    path: `${BASE}/connections/console/disable`,
    service: "disable",
    status: 200,
    args: ["connection", "console"],
  },
  {
    method: "POST",
    path: `${BASE}/repositories/console/credential`,
    service: "setCredential",
    body: { value: "example-key" },
    invalid: { value: "" },
    status: 200,
    args: ["repository", "console", "example-key"],
  },
  {
    method: "POST",
    path: `${BASE}/connections/console/enable`,
    service: "enableConnection",
    status: 200,
    args: ["console"],
  },
  {
    method: "POST",
    path: `${BASE}/connections/console/models`,
    service: "setConnectionModels",
    body: { models: ["claude-sonnet-5"] },
    invalid: { models: [""] },
    status: 200,
    args: ["console", { models: ["claude-sonnet-5"] }],
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
              models: ["claude-sonnet-5"],
              model_families: null,
              credential: { source: "stored", last4: null },
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

describe("POST /v1/installation/settings/connections/{id}/models/discover", () => {
  const path = `${BASE}/connections/console/models/discover`;
  const LISTED = {
    models: [
      {
        id: "claude-sonnet-5",
        display_name: "Claude Sonnet 5",
        selected: true,
      },
    ],
    missing: ["claude-retired-4"],
    skipped: 0,
    truncated: false,
  };

  test("asks the service for the id in the path and answers its list", async () => {
    const asked: unknown[][] = [];
    const response = await request(
      {
        discoverConnectionModels: async (_caller, id) => {
          asked.push([id]);
          return LISTED;
        },
      },
      "POST",
      path,
    );
    expect(response.status).toBe(200);
    expect(
      discoverConnectionModelsResponseSchema.parse(await response.json()),
    ).toEqual(LISTED);
    expect(asked).toEqual([["console"]]);
  });

  test("every refusal maps to its status with its reason", async () => {
    for (const [code, status, reason] of [
      ["BAD_REQUEST", 400, "host_not_allowed"],
      ["FORBIDDEN", 403, "role"],
      ["NOT_FOUND", 404, undefined],
      ["REVISION_CONFLICT", 409, "disabled"],
      ["BACKEND_UNAVAILABLE", 503, "provider_unreachable"],
    ] as const) {
      const response = await request(
        {
          discoverConnectionModels: async () => {
            throw new SessionServiceError(
              code,
              "no",
              undefined,
              reason === undefined ? undefined : { reason_code: reason },
            );
          },
        },
        "POST",
        path,
      );
      expect(response.status).toBe(status);
      const body = apiErrorResponseSchema.parse(await response.json());
      expect(body.error.code).toBe(code);
      if (reason !== undefined) {
        expect(body.error.details).toEqual({ reason_code: reason });
      }
    }
    expect(
      (await request({ discoverConnectionModels: outage }, "POST", path))
        .status,
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
