import { describe, expect, test } from "bun:test";
import {
  ApiError,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  unwrap,
} from "@werft-ai/client";
import {
  authMeResponseSchema,
  AGENT_DESCRIPTION_MAX_LENGTH as CONTRACT_AGENT_DESCRIPTION_MAX_LENGTH,
  API_KEY_NAME_MAX as CONTRACT_API_KEY_NAME_MAX,
  DISPLAY_NAME_MAX as CONTRACT_DISPLAY_NAME_MAX,
  CSRF_HEADER_NAME as CONTRACT_HEADER_NAME,
  CSRF_HEADER_VALUE as CONTRACT_HEADER_VALUE,
  PASSWORD_MIN_LENGTH as CONTRACT_PASSWORD_MIN_LENGTH,
  WORKSPACE_ROLE_VALUES as CONTRACT_ROLE_VALUES,
  inviteTokenSchema,
} from "@werft-ai/contracts";
import { WORKSPACE_ROLE_VALUES } from "../auth/guard.tsx";
import {
  AGENT_DESCRIPTION_MAX_LENGTH,
  API_KEY_NAME_MAX,
  DISPLAY_NAME_MAX,
  INVITE_TOKEN_LENGTH,
  PASSWORD_MIN_LENGTH,
} from "../auth/limits.ts";
import { apiError, fakeApi, json, me } from "../test-support/fake-api.ts";
import { createApiClient } from "./client.ts";

describe("API client", () => {
  test("the copied constants are the contract's", () => {
    expect(CSRF_HEADER_NAME).toBe(CONTRACT_HEADER_NAME);
    expect(CSRF_HEADER_VALUE).toBe(CONTRACT_HEADER_VALUE);
    expect(PASSWORD_MIN_LENGTH).toBe(CONTRACT_PASSWORD_MIN_LENGTH);
    expect(DISPLAY_NAME_MAX).toBe(CONTRACT_DISPLAY_NAME_MAX);
    expect(API_KEY_NAME_MAX).toBe(CONTRACT_API_KEY_NAME_MAX);
    expect(AGENT_DESCRIPTION_MAX_LENGTH).toBe(
      CONTRACT_AGENT_DESCRIPTION_MAX_LENGTH,
    );
    expect(WORKSPACE_ROLE_VALUES).toEqual(CONTRACT_ROLE_VALUES);
    const { min, max } = INVITE_TOKEN_LENGTH;
    for (const [length, ok] of [
      [min - 1, false],
      [min, true],
      [max, true],
      [max + 1, false],
    ] as const)
      expect(inviteTokenSchema.safeParse("a".repeat(length)).success).toBe(ok);
  });

  test("the test principal is one the server could send", () => {
    expect(authMeResponseSchema.safeParse(me()).success).toBe(true);
    expect(authMeResponseSchema.safeParse(me(["sessions:read"])).success).toBe(
      true,
    );
  });

  test("every request carries the CSRF header", async () => {
    const api = fakeApi({
      "GET /v1/auth/me": () => json(200, me()),
      "POST /v1/auth/logout": () => new Response(null, { status: 204 }),
    });
    const client = createApiClient({
      baseUrl: "https://console.test",
      fetch: api.fetch,
    });
    await unwrap(client.GET("/v1/auth/me"));
    await unwrap(client.POST("/v1/auth/logout"));
    expect(
      api.calls.map((call) => call.headers.get("x-requested-with")),
    ).toEqual(["werft-web", "werft-web"]);
  });

  test("a failure becomes an ApiError with the server's code and words", async () => {
    const api = fakeApi({
      "GET /v1/auth/me": () =>
        apiError(
          403,
          "FORBIDDEN",
          "This credential does not hold sessions:read",
        ),
    });
    const client = createApiClient({
      baseUrl: "https://console.test",
      fetch: api.fetch,
    });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "This credential does not hold sessions:read",
      requestId: "req-1",
    });
  });

  test("an unreachable server is a NETWORK_ERROR, not a crash", async () => {
    const client = createApiClient({
      baseUrl: "https://console.test",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  test("in warn mode an answer with a field the contract lacks comes through as sent and warns once", async () => {
    const body = { ...me(), added_later: true };
    const api = fakeApi({ "GET /v1/auth/me": () => json(200, body) });
    const client = createApiClient({
      baseUrl: "https://console.test",
      fetch: api.fetch,
      validate: "warn",
    });
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...line: unknown[]) => warnings.push(line);
    try {
      expect(await unwrap(client.GET("/v1/auth/me"))).toEqual(body);
      await unwrap(client.GET("/v1/auth/me"));
    } finally {
      console.warn = original;
    }
    expect(warnings).toEqual([
      [
        "API contract mismatch",
        {
          operation: "GET /v1/auth/me",
          issues: [{ path: "*", message: "unrecognized_keys" }],
        },
      ],
    ]);
  });

  test("in strict mode the same answer fails the call", async () => {
    const api = fakeApi({
      "GET /v1/auth/me": () => json(200, { ...me(), added_later: true }),
    });
    const client = createApiClient({
      baseUrl: "https://console.test",
      fetch: api.fetch,
      validate: "strict",
    });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toMatchObject({ code: "CLIENT_CONTRACT_MISMATCH" });
  });
});
