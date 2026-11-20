import { describe, expect, test } from "bun:test";
import {
  SESSION_EVENT_NAMES as CONTRACT_EVENT_NAMES,
  CSRF_HEADER_NAME as CONTRACT_HEADER_NAME,
  CSRF_HEADER_VALUE as CONTRACT_HEADER_VALUE,
  SSE_SCHEMA_VERSION as CONTRACT_SCHEMA_VERSION,
} from "@werft-ai/contracts";
import {
  ApiError,
  type ContractMismatch,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createApiClient,
  isApiError,
  unwrap,
  type Validator,
} from "./index.ts";
import { SESSION_EVENT_NAMES, SSE_SCHEMA_VERSION } from "./sse.ts";

const BASE = "https://api.test";

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A fetch that answers every request with `answer` and records it. */
function recording(answer: () => Response) {
  const requests: Request[] = [];
  const fetch = (async (request: Request) => {
    requests.push(request);
    return answer();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

const ME = { principal: { kind: "user", id: "u1" } };
// Shaped like what a schema library's issues become; the value never appears.
const needsWorkspace: Validator = (value) =>
  (value as Record<string, unknown>).workspace === undefined
    ? [{ path: "workspace", message: "Required" }]
    : [];

describe("constants", () => {
  test("the copies are the contract's", () => {
    expect(CSRF_HEADER_NAME).toBe(CONTRACT_HEADER_NAME);
    expect(CSRF_HEADER_VALUE).toBe(CONTRACT_HEADER_VALUE);
    expect(SESSION_EVENT_NAMES).toEqual([...CONTRACT_EVENT_NAMES]);
    expect(SSE_SCHEMA_VERSION).toBe(CONTRACT_SCHEMA_VERSION);
  });
});

describe("requests", () => {
  test("a cookie request carries the CSRF header", async () => {
    const api = recording(() => json(200, ME));
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    await unwrap(client.GET("/v1/auth/me"));
    await unwrap(client.POST("/v1/auth/logout"));
    expect(api.requests.map((r) => r.headers.get("x-requested-with"))).toEqual([
      "werft-web",
      "werft-web",
    ]);
  });

  test("a server-side caller sets its own headers and sends no cookie", async () => {
    const authorization = "Bearer fake";
    const api = recording(() => json(200, ME));
    const client = createApiClient({
      baseUrl: BASE,
      fetch: api.fetch,
      credentials: "omit",
      headers: { authorization },
    });
    expect(await unwrap<unknown>(client.GET("/v1/auth/me"))).toEqual(ME);
    const [request] = api.requests;
    expect(request?.headers.get("authorization")).toBe(authorization);
    expect(request?.headers.get("x-requested-with")).toBeNull();
  });

  test("a call's own credentials decide the CSRF header, both ways", async () => {
    const api = recording(() => json(200, ME));
    const sent = () =>
      api.requests.splice(0).map((r) => r.headers.get("x-requested-with"));
    const keyClient = createApiClient({
      baseUrl: BASE,
      fetch: api.fetch,
      credentials: "omit",
    });
    await unwrap(keyClient.GET("/v1/auth/me", { credentials: "include" }));
    await unwrap(keyClient.request("get", "/v1/auth/me", {}));
    expect(sent()).toEqual(["werft-web", null]);
    const cookieClient = createApiClient({
      baseUrl: BASE,
      fetch: api.fetch,
      headers: { "x-requested-with": "werft-web" },
    });
    await unwrap(cookieClient.GET("/v1/auth/me", { credentials: "omit" }));
    await unwrap(cookieClient.POST("/v1/auth/logout"));
    expect(sent()).toEqual([null, "werft-web"]);
  });

  test("a failure becomes an ApiError with the server's code and words", async () => {
    const api = recording(() =>
      json(403, {
        error: {
          code: "FORBIDDEN",
          message: "This credential does not hold sessions:read",
          request_id: "req-1",
        },
      }),
    );
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(isApiError(error, "FORBIDDEN")).toBe(true);
    expect(error).toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "This credential does not hold sessions:read",
      requestId: "req-1",
      retryable: null,
      details: null,
      retryAfterSeconds: null,
    });
  });

  test("an older client preserves an unfamiliar server error code", async () => {
    for (const code of ["WORKSPACE_QUOTA_EXCEEDED", "FUTURE_SERVER_CODE"]) {
      const api = recording(() =>
        json(409, {
          error: { code, message: "Free workspace storage before growing it" },
        }),
      );
      const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
      const error = await unwrap(client.GET("/v1/auth/me")).catch(
        (error) => error,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe(code);
    }
  });

  test("it keeps the server's retry hints and details", async () => {
    const api = recording(() =>
      json(
        429,
        {
          error: {
            code: "RATE_LIMITED",
            message: "Too many requests",
            retryable: true,
            request_id: "req-3",
            details: { limit: 8 },
          },
        },
        { "retry-after": "15" },
      ),
    );
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toMatchObject({
      status: 429,
      retryable: true,
      details: { limit: 8 },
      retryAfterSeconds: 15,
    });
  });

  test("a body without an error code is UNKNOWN, with the response's request id", async () => {
    const api = recording(
      () =>
        new Response("bad gateway", {
          status: 502,
          headers: { "x-request-id": "req-9" },
        }),
    );
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toMatchObject({
      status: 502,
      code: "UNKNOWN",
      requestId: "req-9",
    });
  });

  test("an error body's fields of the wrong type are not taken", async () => {
    const api = recording(() =>
      json(
        500,
        { error: { code: 42, message: { text: "no" }, request_id: ["r"] } },
        { "x-request-id": "req-h" },
      ),
    );
    const client = createApiClient({ baseUrl: BASE, fetch: api.fetch });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toMatchObject({
      status: 500,
      code: "UNKNOWN",
      requestId: "req-h",
    });
    expect(typeof error.message).toBe("string");
  });

  test("an unreachable server is a NETWORK_ERROR, not a crash", async () => {
    const client = createApiClient({
      baseUrl: BASE,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toMatchObject({
      status: 0,
      code: "NETWORK_ERROR",
      message: "fetch failed",
    });
  });
});

describe("validate", () => {
  const offContract = { principal: { kind: "user", id: "secret-user-id" } };

  test("strict fails the call with CLIENT_CONTRACT_MISMATCH, naming the place but not the value", async () => {
    const api = recording(() =>
      json(200, offContract, { "x-request-id": "req-2" }),
    );
    const client = createApiClient({
      baseUrl: BASE,
      fetch: api.fetch,
      validate: "strict",
      validators: { responses: { "GET /v1/auth/me": needsWorkspace } },
    });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("CLIENT_CONTRACT_MISMATCH");
    expect(error.status).toBe(200);
    expect(error.requestId).toBe("req-2");
    expect(error.mismatch).toEqual({
      operation: "GET /v1/auth/me",
      issues: [{ path: "workspace", message: "Required" }],
    });
    expect(JSON.stringify([error.message, error.mismatch])).not.toContain(
      "secret-user-id",
    );
  });

  test("an issue keeps its place and words, not what else the validator hung on it", async () => {
    const api = recording(() => json(200, offContract));
    const client = createApiClient({
      baseUrl: BASE,
      fetch: api.fetch,
      validate: "strict",
      validators: {
        responses: {
          "GET /v1/auth/me": (value) => [
            {
              path: "workspace",
              message: "Required",
              received: (value as typeof offContract).principal.id,
            } as never,
          ],
        },
      },
    });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error.mismatch.issues).toEqual([
      { path: "workspace", message: "Required" },
    ]);
    expect(JSON.stringify(error.mismatch)).not.toContain("secret-user-id");
  });

  test("strict passes a conforming answer and ignores operations it has no validator for", async () => {
    const api = recording(() => json(200, { ...ME, workspace: { id: "w1" } }));
    const client = createApiClient({
      baseUrl: BASE,
      fetch: api.fetch,
      validate: "strict",
      validators: { responses: { "GET /v1/auth/me": needsWorkspace } },
    });
    expect(await unwrap(client.GET("/v1/auth/me"))).toMatchObject({
      workspace: { id: "w1" },
    });
    expect(await unwrap(client.GET("/v1/members"))).toBeDefined();
  });

  test("warn reports the mismatch and hands the data on", async () => {
    const api = recording(() => json(200, offContract));
    const seen: ContractMismatch[] = [];
    const client = createApiClient({
      baseUrl: BASE,
      fetch: api.fetch,
      validate: "warn",
      validators: { responses: { "GET /v1/auth/me": needsWorkspace } },
      onContractMismatch: (mismatch) => seen.push(mismatch),
    });
    expect(await unwrap<unknown>(client.GET("/v1/auth/me"))).toEqual(
      offContract,
    );
    expect(seen).toEqual([
      {
        operation: "GET /v1/auth/me",
        issues: [{ path: "workspace", message: "Required" }],
      },
    ]);
  });

  test("off, the default, never runs a validator", async () => {
    let ran = 0;
    const counting: Validator = (value) => {
      ran += 1;
      return needsWorkspace(value);
    };
    const api = recording(() => json(200, offContract));
    for (const validate of ["off", undefined] as const) {
      const client = createApiClient({
        baseUrl: BASE,
        fetch: api.fetch,
        ...(validate ? { validate } : {}),
        validators: { responses: { "GET /v1/auth/me": counting } },
      });
      expect(await unwrap<unknown>(client.GET("/v1/auth/me"))).toEqual(
        offContract,
      );
    }
    expect(ran).toBe(0);
  });

  test("strict checks a body whatever its content type says", async () => {
    const api = recording(
      () =>
        new Response(JSON.stringify(offContract), {
          headers: { "content-type": "text/plain" },
        }),
    );
    const client = createApiClient({
      baseUrl: BASE,
      fetch: api.fetch,
      validate: "strict",
      validators: { responses: { "GET /v1/auth/me": needsWorkspace } },
    });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error.code).toBe("CLIENT_CONTRACT_MISMATCH");
  });

  test("an NDJSON export the caller asked for is not checked as one JSON answer", async () => {
    const lines = `${JSON.stringify(ME)}\n{"kind":"end","rows":1,"truncated":false,"next_cursor":null}\n`;
    const api = recording(
      () =>
        new Response(lines, {
          headers: { "content-type": "application/x-ndjson" },
        }),
    );
    const client = createApiClient({
      baseUrl: BASE,
      fetch: api.fetch,
      validate: "strict",
      validators: { responses: { "GET /v1/auth/me": needsWorkspace } },
    });
    const file = await unwrap(
      client.GET("/v1/auth/me", {
        headers: { Accept: "application/x-ndjson" },
        parseAs: "text",
      }),
    );
    expect(file).toBe(lines);
  });

  test("an error answer is not checked against the success schema", async () => {
    const api = recording(() =>
      json(401, { error: { code: "UNAUTHORIZED", message: "no" } }),
    );
    const client = createApiClient({
      baseUrl: BASE,
      fetch: api.fetch,
      validate: "strict",
      validators: { responses: { "GET /v1/auth/me": needsWorkspace } },
    });
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error.code).toBe("UNAUTHORIZED");
  });
});
