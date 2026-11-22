import { describe, expect, test } from "bun:test";
import {
  ApiError,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  unwrap,
} from "@werft-ai/client";
import {
  authMeResponseSchema,
  bootstrapRequestSchema,
  AGENT_DESCRIPTION_MAX_LENGTH as CONTRACT_AGENT_DESCRIPTION_MAX_LENGTH,
  API_KEY_NAME_MAX as CONTRACT_API_KEY_NAME_MAX,
  DISPLAY_NAME_MAX as CONTRACT_DISPLAY_NAME_MAX,
  CSRF_HEADER_NAME as CONTRACT_HEADER_NAME,
  CSRF_HEADER_VALUE as CONTRACT_HEADER_VALUE,
  MESSAGE_MAX_BYTES as CONTRACT_MESSAGE_MAX_BYTES,
  PASSWORD_MIN_LENGTH as CONTRACT_PASSWORD_MIN_LENGTH,
  WORKSPACE_ROLE_VALUES as CONTRACT_ROLE_VALUES,
  SETUP_LINK_TTL_HOURS as CONTRACT_SETUP_LINK_TTL_HOURS,
  WORKSPACE_MCP_RESERVED_NAMES as CONTRACT_WORKSPACE_MCP_RESERVED_NAMES,
  emailSchema,
  githubAppIdSchema,
  inviteTokenSchema,
  putGitHubOAuthClientSecretRequestSchema,
  repositoryBranchSchema,
  updateLoginProviderRequestSchema,
} from "@werft-ai/contracts";
import { WORKSPACE_ROLE_VALUES } from "../auth/guard.tsx";
import {
  AGENT_DESCRIPTION_MAX_LENGTH,
  API_KEY_NAME_MAX,
  DISPLAY_NAME_MAX,
  EMAIL_MAX,
  GITHUB_APP_ID_MAX,
  INVITE_TOKEN_LENGTH,
  LOGIN_DOMAIN_PATTERN,
  LOGIN_DOMAINS_MAX,
  MESSAGE_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
  REPOSITORY_BRANCH_MAX,
  REPOSITORY_BRANCH_PATTERN,
  SECRET_VALUE_LENGTH,
  SECRET_VALUE_PATTERN,
  SETUP_LINK_TTL_HOURS,
  WORKSPACE_MCP_RESERVED_NAMES,
  WORKSPACE_NAME_MAX,
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

  test("the copied form rules accept and refuse what the contract does", () => {
    const bootstrap = bootstrapRequestSchema.shape;
    expect(EMAIL_MAX).toBe(emailSchema.maxLength ?? Number.NaN);
    expect(WORKSPACE_NAME_MAX).toBe(
      bootstrap.workspace_name.maxLength ?? Number.NaN,
    );
    expect(SETUP_LINK_TTL_HOURS).toBe(CONTRACT_SETUP_LINK_TTL_HOURS);
    expect(MESSAGE_MAX_BYTES).toBe(CONTRACT_MESSAGE_MAX_BYTES);
    expect(WORKSPACE_MCP_RESERVED_NAMES).toEqual([
      ...CONTRACT_WORKSPACE_MCP_RESERVED_NAMES,
    ]);

    const domains = (list: string[]) =>
      updateLoginProviderRequestSchema.safeParse({ allowed_domains: list })
        .success;
    for (const domain of [
      "example.com",
      "a-b.co.kr",
      "x1.io",
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`,
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
      "@example.com",
      "*.example.com",
      "localhost",
      "-a.com",
      "a-.com",
      "a..com",
      "example.com/",
    ])
      expect(LOGIN_DOMAIN_PATTERN.test(domain)).toBe(domains([domain]));
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `d${i}.example.com`);
    expect(domains(many(LOGIN_DOMAINS_MAX))).toBe(true);
    expect(domains(many(LOGIN_DOMAINS_MAX + 1))).toBe(false);

    const secret = (value: string) =>
      putGitHubOAuthClientSecretRequestSchema.safeParse({
        client_id: "Iv1.abc",
        client_secret: value,
      }).success;
    const { min, max } = SECRET_VALUE_LENGTH;
    for (const value of [
      "a".repeat(min - 1),
      "a".repeat(min),
      "a".repeat(max),
      "a".repeat(max + 1),
      "abc def ghi",
      "abcdefgh\n",
      "abcdefghé",
      "!~#$%^&*()_+",
    ])
      expect(
        value.length >= min &&
          value.length <= max &&
          SECRET_VALUE_PATTERN.test(value),
      ).toBe(secret(value));

    expect(githubAppIdSchema.safeParse(GITHUB_APP_ID_MAX).success).toBe(true);
    expect(githubAppIdSchema.safeParse(GITHUB_APP_ID_MAX + 1).success).toBe(
      false,
    );

    expect(REPOSITORY_BRANCH_MAX).toBe(
      repositoryBranchSchema.maxLength ?? Number.NaN,
    );
    for (const branch of [
      "main",
      "feature/x-1",
      "release/v1.2",
      "a@b",
      "feature..x",
      "a:b",
      "x.lock",
      "-x",
      "/x",
      ".x",
      "x/",
      "a//b",
      "a/.b",
      "a@{b",
      "a b",
      "a~b",
      "a^b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "a\u0001b",
    ])
      expect(REPOSITORY_BRANCH_PATTERN.test(branch)).toBe(
        repositoryBranchSchema.safeParse(branch).success,
      );
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
