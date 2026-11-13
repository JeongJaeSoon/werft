import { describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  disableLoginProviderResponseSchema,
  discoverLoginProviderResponseSchema,
  LOGIN_FLOW_COOKIE_NAME,
  type LoginProviderView,
  listLoginProvidersResponseSchema,
  loginProviderResponseSchema,
  startProviderLoginResponseSchema,
} from "@werft-ai/contracts";
import { SessionServiceError } from "@werft-ai/platform";
import type { ProviderAdmin } from "../provider-admin.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerLoginProviderRoutes } from "./login-providers.ts";

const createApiApp = recordRouteErrors("routes/login-providers.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f1";
const ID = "5b0c7e2a-9d41-4f6b-8a3e-7c1d2e3f4a5b";
const BASE = "/v1/login-providers";
const AT = "2026-10-18T09:00:00.000Z";

const PROVIDER: LoginProviderView = {
  id: ID,
  display_name: "Keycloak",
  issuer: "https://idp.example.com/realms/acme",
  redirect_uri: `https://console.example.com/auth/callback/${ID}`,
  authorization_endpoint: "https://idp.example.com/realms/acme/auth",
  token_endpoint: "https://idp.example.com/realms/acme/token",
  jwks_uri: "https://idp.example.com/realms/acme/certs",
  userinfo_endpoint: null,
  endpoint_hosts: ["idp.example.com"],
  signing_algs: ["RS256"],
  pkce_advertised: true,
  discovery_checked_at: AT,
  client_id: "werft-console",
  token_auth_method: "client_secret_basic",
  client_secret: { last4: "9f3a", updated_at: AT },
  pending_client_secret: null,
  allowed_domains: [],
  jit_role: null,
  require_verified_email: true,
  state: "ready",
  tested_at: AT,
  revision: 4,
  created_at: AT,
  updated_at: AT,
};

type Method = keyof ProviderAdmin;

function request(
  admin: Partial<ProviderAdmin>,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerLoginProviderRoutes(router, admin as ProviderAdmin),
  }).request(path, {
    method,
    headers: {
      "X-Owner-Id": WORKSPACE,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const refusing =
  (code: string, details: Record<string, unknown> = {}) =>
  async () => {
    throw new SessionServiceError(code as never, "no", undefined, details);
  };

/** Every route: its service method, a body it takes, and what it answers. */
const ROUTES: ReadonlyArray<{
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  service: Method;
  body?: unknown;
  /** Bodies the route refuses before the service sees them. */
  invalid?: unknown[];
  headers?: Record<string, string>;
  /** What the service returns. */
  result: unknown;
  status: 200 | 201 | 204;
  /** The service's arguments after the caller. */
  args: unknown[];
  /** The JSON the route answers; absent for 204. */
  answer?: unknown;
  /** Each refusal the service can raise here, and its status. */
  refusals: ReadonlyArray<[code: string, status: number]>;
}> = [
  {
    method: "GET",
    path: BASE,
    service: "list",
    result: { providers: [PROVIDER], console_origin_configured: true },
    status: 200,
    args: [],
    answer: { providers: [PROVIDER], console_origin_configured: true },
    refusals: [["FORBIDDEN", 403]],
  },
  {
    method: "POST",
    path: `${BASE}/discover`,
    service: "discover",
    body: { issuer: "https://idp.example.com/realms/acme" },
    invalid: [{}, { issuer: "" }, { issuer: "https://idp", extra: 1 }],
    result: { outcome: "failed", problem: "issuer_mismatch" },
    status: 200,
    args: ["https://idp.example.com/realms/acme"],
    answer: { outcome: "failed", problem: "issuer_mismatch" },
    refusals: [["FORBIDDEN", 403]],
  },
  {
    method: "POST",
    path: BASE,
    service: "create",
    body: { display_name: "Keycloak", issuer: PROVIDER.issuer },
    invalid: [{ issuer: PROVIDER.issuer }, { display_name: " ", issuer: "x" }],
    result: PROVIDER,
    status: 201,
    args: [{ display_name: "Keycloak", issuer: PROVIDER.issuer }],
    answer: { provider: PROVIDER },
    refusals: [
      ["FORBIDDEN", 403],
      ["BAD_REQUEST", 400],
      ["ALREADY_EXISTS", 409],
    ],
  },
  {
    method: "PATCH",
    path: `${BASE}/${ID}`,
    service: "update",
    body: { client_id: "werft-console" },
    invalid: [
      {},
      { client_secret: "never through this route" },
      { allowed_domains: ["Not A Host"] },
      { jit_role: "owner" },
    ],
    headers: { "If-Match": "4" },
    result: PROVIDER,
    status: 200,
    args: [ID, "4", { client_id: "werft-console" }],
    answer: { provider: PROVIDER },
    refusals: [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["REVISION_CONFLICT", 409],
      ["VERSION_MISMATCH", 412],
      ["PRECONDITION_REQUIRED", 428],
    ],
  },
  {
    method: "POST",
    path: `${BASE}/${ID}/refresh-discovery`,
    service: "refreshDiscovery",
    result: PROVIDER,
    status: 200,
    args: [ID],
    answer: { provider: PROVIDER },
    refusals: [
      ["FORBIDDEN", 403],
      ["BAD_REQUEST", 400],
      ["NOT_FOUND", 404],
      ["REVISION_CONFLICT", 409],
    ],
  },
  {
    method: "PUT",
    path: `${BASE}/${ID}/client-secret`,
    service: "setClientSecret",
    body: { value: "example-client-secret" },
    invalid: [{}, { value: "short" }, { value: "x".repeat(4097) }],
    result: PROVIDER,
    status: 200,
    args: [ID, "example-client-secret"],
    answer: { provider: PROVIDER },
    refusals: [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
    ],
  },
  {
    method: "POST",
    path: `${BASE}/${ID}/test/start`,
    service: "startTest",
    result: {
      authorizationUrl: "https://idp.example.com/realms/acme/auth?state=s",
      cookieValue: "sealed-flow",
    },
    status: 200,
    // No console session under `authMode: "none"`.
    args: [ID, undefined],
    answer: {
      authorization_url: "https://idp.example.com/realms/acme/auth?state=s",
    },
    refusals: [
      ["FORBIDDEN", 403],
      ["BAD_REQUEST", 400],
      ["NOT_FOUND", 404],
      ["REVISION_CONFLICT", 409],
    ],
  },
  {
    method: "POST",
    path: `${BASE}/${ID}/enable`,
    service: "enable",
    result: { ...PROVIDER, state: "enabled" },
    status: 200,
    args: [ID],
    answer: { provider: { ...PROVIDER, state: "enabled" } },
    refusals: [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["REVISION_CONFLICT", 409],
    ],
  },
  {
    method: "POST",
    path: `${BASE}/${ID}/disable`,
    service: "disable",
    result: { provider: PROVIDER, sessions_revoked: 2 },
    status: 200,
    args: [ID],
    answer: { provider: PROVIDER, sessions_revoked: 2 },
    refusals: [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      // The last provider that is on, while passwords are closed.
      ["REVISION_CONFLICT", 409],
    ],
  },
  {
    method: "DELETE",
    path: `${BASE}/${ID}`,
    service: "remove",
    result: undefined,
    status: 204,
    args: [ID],
    refusals: [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["REVISION_CONFLICT", 409],
    ],
  },
];

describe("sign-in provider settings routes", () => {
  for (const route of ROUTES) {
    const name = `${route.method} ${route.path.replace(ID, "{id}")}`;

    test(`${name} hands the service what the request names and answers its result`, async () => {
      const calls: unknown[][] = [];
      const response = await request(
        {
          [route.service]: async (_caller: unknown, ...args: unknown[]) => {
            calls.push(args);
            return route.result;
          },
        },
        route.method,
        route.path,
        route.body,
        route.headers,
      );
      expect(response.status).toBe(route.status);
      expect(calls).toEqual([route.args]);
      if (route.status === 204) {
        expect(await response.text()).toBe("");
      } else {
        expect(await response.json()).toEqual(route.answer);
      }
    });

    for (const [code, status] of route.refusals) {
      test(`${name} answers ${status} when the service refuses with ${code}`, async () => {
        const response = await request(
          {
            [route.service]: refusing(code, {
              reason_code: "provider_enabled",
              current_version: 5,
              problem: "issuer_mismatch",
            }),
          },
          route.method,
          route.path,
          route.body,
          route.headers,
        );
        expect(response.status).toBe(status);
        const { error } = apiErrorResponseSchema.parse(await response.json());
        expect(error.code).toBe(code as typeof error.code);
        // What tells the screen which refusal this is travels with it.
        expect(error.details).toMatchObject({
          reason_code: "provider_enabled",
          current_version: 5,
          problem: "issuer_mismatch",
        });
      });
    }

    for (const invalid of route.invalid ?? []) {
      test(`${name} refuses ${JSON.stringify(invalid).slice(0, 60)} before the service`, async () => {
        let called = false;
        const response = await request(
          {
            [route.service]: async () => {
              called = true;
              return route.result;
            },
          },
          route.method,
          route.path,
          invalid,
          route.headers,
        );
        expect(response.status).toBe(400);
        expect(called).toBe(false);
      });
    }

    if (route.path.includes(ID)) {
      test(`${name} is 404 for an id that is not one, without asking the service`, async () => {
        let called = false;
        const response = await request(
          {
            [route.service]: async () => {
              called = true;
              return route.result;
            },
          },
          route.method,
          route.path.replace(ID, "not-a-uuid"),
          route.body,
          route.headers,
        );
        expect(response.status).toBe(404);
        expect(called).toBe(false);
      });
    }
  }

  test("each answer is the one its schema publishes", async () => {
    const schemas = {
      list: listLoginProvidersResponseSchema,
      discover: discoverLoginProviderResponseSchema,
      create: loginProviderResponseSchema,
      update: loginProviderResponseSchema,
      refreshDiscovery: loginProviderResponseSchema,
      setClientSecret: loginProviderResponseSchema,
      startTest: startProviderLoginResponseSchema,
      enable: loginProviderResponseSchema,
      disable: disableLoginProviderResponseSchema,
    } as const;
    for (const route of ROUTES) {
      if (route.status === 204) continue;
      const schema = schemas[route.service as keyof typeof schemas];
      expect(schema.safeParse(route.answer).success, route.path).toBe(true);
    }
  });

  test("the update passes a missing If-Match on for the service to refuse", async () => {
    const calls: unknown[][] = [];
    await request(
      {
        update: async (_caller, ...args) => {
          calls.push(args);
          return PROVIDER;
        },
      },
      "PATCH",
      `${BASE}/${ID}`,
      { display_name: "Renamed" },
    );
    expect(calls).toEqual([[ID, undefined, { display_name: "Renamed" }]]);
  });

  test("starting a test sets the flow cookie, host-bound and unreadable to scripts, and is not cached", async () => {
    const response = await request(
      {
        startTest: async () => ({
          authorizationUrl: "https://idp.example.com/auth?state=s",
          cookieValue: "sealed-flow",
        }),
      },
      "POST",
      `${BASE}/${ID}/test/start`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const [cookie = ""] = cookies;
    expect(cookie.startsWith(`${LOGIN_FLOW_COOKIE_NAME}=sealed-flow;`)).toBe(
      true,
    );
    for (const attribute of [
      "Max-Age=600",
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
    ]) {
      expect(cookie, attribute).toContain(attribute);
    }
  });

  test("a refused test start sets no flow cookie", async () => {
    const response = await request(
      {
        startTest: refusing("REVISION_CONFLICT", { reason_code: "not_tested" }),
      },
      "POST",
      `${BASE}/${ID}/test/start`,
    );
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("no answer carries a client secret's value", async () => {
    const response = await request(
      { setClientSecret: async () => PROVIDER },
      "PUT",
      `${BASE}/${ID}/client-secret`,
      { value: "example-client-secret" },
    );
    expect(await response.text()).not.toContain("example-client-secret");
  });
});
