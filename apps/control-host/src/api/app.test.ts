import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiErrorResponseSchema,
  healthResponseSchema,
  postSessionMessageRequestSchema,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import { InstallationConfigUnavailableError } from "@werft-ai/platform";
import {
  INTERACTIVE_CONFIGURATION_ATTRIBUTE,
  STYLE_NONCE_SCRIPT,
} from "./api-reference.ts";
import {
  BODY_IDLE_TIMEOUT_SECONDS,
  jsonWithSchema,
  parseJsonBody,
} from "./app.ts";
import {
  REQUEST_IDLE_TIMEOUT_SECONDS,
  RESPONSE_IDLE_TIMEOUT_SECONDS,
} from "./deadline.ts";
import { type ApiKeyStore, hashApiKey } from "./keys.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { recordRouteErrors } from "./route-error-coverage.ts";

const createApiApp = recordRouteErrors("app.test.ts");

test("serves the generated OpenAPI document without authentication", async () => {
  const response = await createApiApp({ authMode: "api-key" }).request(
    "/v1/openapi.json",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(buildOpenApiDocument());
});

test("serves the API reference with same-origin test requests and no authentication", async () => {
  const app = createApiApp({ authMode: "api-key" });
  const html = await app.request("/docs");
  expect(html.status).toBe(200);
  expect(html.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(html.headers.get("Cache-Control")).toBe("no-cache");
  const csp = html.headers.get("Content-Security-Policy");
  expect(csp).toContain("connect-src 'self';");
  expect(csp).not.toContain("unsafe-inline");
  expect(html.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(html.headers.get("X-Frame-Options")).toBe("DENY");
  expect(html.headers.get("Set-Cookie")).toBeNull();
  const body = await html.text();
  // The nonce script has to run before Scalar adds its first <style>.
  expect(body).toMatch(
    /<script src="\/docs\/style-nonce\.js"><\/script>\s*<script src="\/docs\/scalar\.js"><\/script>/,
  );
  const nonce = body.match(/property="csp-nonce" content="([^"]+)"/)?.[1];
  expect(nonce).toBeDefined();
  expect(csp).toContain(`style-src 'nonce-${nonce}'`);
  expect(body).toContain(INTERACTIVE_CONFIGURATION_ATTRIBUTE);
  expect(body).toContain("&quot;hideTestRequestButton&quot;:false");
  expect(body).toContain(
    "&quot;preferredSecurityScheme&quot;:&quot;bearerApiKey&quot;",
  );
  expect(body).toContain("&quot;persistAuth&quot;:false");
  expect(body).toContain("&quot;mcp&quot;:{&quot;disabled&quot;:true}");
  expect(body).toContain("&quot;telemetry&quot;:false");
  expect(body).not.toContain("proxyUrl");
  expect(body).not.toMatch(/(?:src|href)="https?:\/\//);

  const scalar = await app.request("/docs/scalar.js");
  expect(scalar.status).toBe(200);
  expect(scalar.headers.get("Content-Type")).toBe(
    "text/javascript; charset=utf-8",
  );
  expect(scalar.headers.get("Cache-Control")).toBe("public, max-age=3600");
  expect(scalar.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect((await scalar.arrayBuffer()).byteLength).toBeGreaterThan(1_000_000);

  const styleNonce = await app.request("/docs/style-nonce.js");
  expect(styleNonce.status).toBe(200);
  expect(styleNonce.headers.get("Content-Type")).toBe(
    "text/javascript; charset=utf-8",
  );
  expect(styleNonce.headers.get("X-Content-Type-Options")).toBe("nosniff");
});

test("the style nonce script gives each new <style> the page's nonce, and nothing else", async () => {
  class FakeDocument {
    querySelector(selector: string) {
      return selector === 'meta[property="csp-nonce"]'
        ? { content: "n-1" }
        : null;
    }
    createElement(name: string) {
      const attributes = new Map<string, string>();
      return {
        name,
        attributes,
        setAttribute: (key: string, value: string) =>
          attributes.set(key, value),
      };
    }
  }
  const document = new FakeDocument();
  new Function("document", "Document", STYLE_NONCE_SCRIPT)(
    document,
    FakeDocument,
  );
  expect(document.createElement("style").attributes.get("nonce")).toBe("n-1");
  expect(document.createElement("STYLE").attributes.get("nonce")).toBe("n-1");
  expect(document.createElement("div").attributes.has("nonce")).toBe(false);
});

test("serves the API reference from the documented package-directory launch", async () => {
  const script = `
    import { createApiApp } from ${JSON.stringify(join(import.meta.dir, "app.ts"))};
    const app = createApiApp({ authMode: "api-key" });
    const html = await app.request("/docs");
    const scalar = await app.request("/docs/scalar.js");
    console.log(JSON.stringify({ html: html.status, scalar: scalar.status }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ html: 200, scalar: 200 });
});

function loggerWithMemory(): {
  logger: StructuredLogger;
  sink: MemoryLogSink;
} {
  const sink = new MemoryLogSink();
  return { logger: new StructuredLogger({ sinks: [sink] }), sink };
}

describe("API authentication", () => {
  test("internal routes get the same idle clock management as /v1", async () => {
    const app = createApiApp({
      authMode: "none",
      logger: loggerWithMemory().logger,
      registerInternalRoutes: (router) => {
        router.get("/poll", (context) => context.json({ ok: true }));
        router.post("/poll", async (context) =>
          context.json({ bytes: (await context.req.arrayBuffer()).byteLength }),
        );
      },
    });
    const calls: number[] = [];
    const env = { setIdleTimeout: (seconds: number) => calls.push(seconds) };

    // A long poll is a GET-shaped wait: the clock is off before the handler
    // runs, so Bun's idle default cannot cut the connection mid-wait.
    expect((await app.request("/internal/poll", {}, env)).status).toBe(200);
    expect(calls).toEqual([0]);

    // A body is still read under the clock, then the clock stops.
    calls.length = 0;
    const posted = await app.request(
      "/internal/poll",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(await posted.json()).toEqual({ bytes: 2 });
    expect(calls).toEqual([BODY_IDLE_TIMEOUT_SECONDS, 0]);
  });

  test("routes to /internal only when the undecoded path starts with /internal", async () => {
    let handled = 0;
    const app = createApiApp({
      authMode: "none",
      logger: loggerWithMemory().logger,
      registerInternalRoutes: (router) => {
        router.get("/worker/poll", (context) => {
          handled += 1;
          return context.json({ ok: true });
        });
      },
    });

    // The ALB's 404 rule matches /internal* before decoding, so each of these
    // passes it; Hono would decode the first four into /internal/worker/poll.
    for (const path of [
      "/%69nternal/worker/poll",
      "/i%6Eternal/worker/poll",
      "/i%6eternal/worker/poll",
      "/intern%61l/worker/poll",
      "/%2Finternal/worker/poll",
      "/%2finternal/worker/poll",
    ]) {
      const response = await app.request(path);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect(
        apiErrorResponseSchema.safeParse(await response.json()).success,
      ).toBe(true);
    }
    expect(handled).toBe(0);

    const plain = await app.request("/internal/worker/poll");
    expect(plain.status).toBe(200);
    expect(handled).toBe(1);
  });

  test("holds the idle clock above the deadline for database work and re-arms it only while an authenticated body is read", async () => {
    let bodyRead = false;
    const app = createApiApp({
      authMode: "none",
      logger: loggerWithMemory().logger,
      registerRoutes: (router) => {
        router.get("/echo", (context) => context.json({ ok: true }));
        router.get(
          "/stream",
          () =>
            new Response(": keepalive\n\n", {
              headers: { "Content-Type": "text/event-stream" },
            }),
        );
        router.post("/echo", async (context) => {
          bodyRead = true;
          return context.json({
            bytes: (await context.req.arrayBuffer()).byteLength,
          });
        });
      },
    });
    const calls: number[] = [];
    const env = { setIdleTimeout: (seconds: number) => calls.push(seconds) };
    const post = (body: string, headers: Record<string, string> = {}) =>
      app.request(
        "/v1/echo",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body,
        },
        env,
      );

    // GET: above the deadline for the key lookup and the route, off once the
    // response is decided (a stream keeps its own clocks).
    const ok = await app.request(
      "/v1/echo",
      { headers: { "X-Owner-Id": "local-owner" } },
      env,
    );
    expect(ok.status).toBe(200);
    expect(calls).toEqual([
      REQUEST_IDLE_TIMEOUT_SECONDS,
      RESPONSE_IDLE_TIMEOUT_SECONDS,
    ]);

    // An event stream writes on its own keepalive clock; the idle clock stays
    // off for it as it always was.
    calls.length = 0;
    const streamed = await app.request(
      "/v1/stream",
      { headers: { "X-Owner-Id": "local-owner" } },
      env,
    );
    expect(streamed.status).toBe(200);
    expect(calls).toEqual([REQUEST_IDLE_TIMEOUT_SECONDS, 0]);

    // POST: the body streams in under the short idle clock, then the route
    // gets the deadline's clock back; the route sees the same bytes.
    calls.length = 0;
    const accepted = await post("{}", { "X-Owner-Id": "local-owner" });
    expect(await accepted.json()).toEqual({ bytes: 2 });
    expect(calls).toEqual([
      REQUEST_IDLE_TIMEOUT_SECONDS,
      BODY_IDLE_TIMEOUT_SECONDS,
      REQUEST_IDLE_TIMEOUT_SECONDS,
      RESPONSE_IDLE_TIMEOUT_SECONDS,
    ]);

    // Unauthenticated POST: 401 without reading the body, so a dripping
    // sender is never waited on.
    calls.length = 0;
    bodyRead = false;
    expect((await post("{}")).status).toBe(401);
    expect(calls).toEqual([
      REQUEST_IDLE_TIMEOUT_SECONDS,
      RESPONSE_IDLE_TIMEOUT_SECONDS,
    ]);
    expect(bodyRead).toBe(false);

    // Oversized: rejected straight from the body phase.
    calls.length = 0;
    const oversized = await post("x".repeat(65 * 1024), {
      "X-Owner-Id": "local-owner",
    });
    expect(oversized.status).toBe(413);
    expect(calls).toEqual([
      REQUEST_IDLE_TIMEOUT_SECONDS,
      BODY_IDLE_TIMEOUT_SECONDS,
      RESPONSE_IDLE_TIMEOUT_SECONDS,
    ]);
  });

  test("fails closed when AUTH_MODE is missing and ignores X-Owner-Id", async () => {
    const previous = process.env.AUTH_MODE;
    delete process.env.AUTH_MODE;
    try {
      const app = createApiApp();
      const response = await app.request("/v1", {
        headers: { "X-Owner-Id": "forged-owner" },
      });
      expect(response.status).toBe(401);
      expect(apiErrorResponseSchema.parse(await response.json())).toMatchObject(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication is required",
            retryable: false,
            details: null,
          },
        },
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AUTH_MODE;
      } else {
        process.env.AUTH_MODE = previous;
      }
    }
  });

  test("treats an unknown AUTH_MODE as authenticated mode", async () => {
    const app = createApiApp({ authMode: "unexpected" });
    const response = await app.request("/v1", {
      headers: { "X-Owner-Id": "forged-owner" },
    });
    expect(response.status).toBe(401);
  });

  test("accepts one bearer key and passes its owner to the handler", async () => {
    const plaintext = "csp_test_key";
    const expectedHash = hashApiKey(plaintext);
    let receivedHash: Uint8Array | undefined;
    const keyStore: ApiKeyStore = {
      async find(keyHash) {
        receivedHash = keyHash;
        return Buffer.from(keyHash).equals(Buffer.from(expectedHash))
          ? {
              id: "key-a",
              ownerId: "owner-a",
              workspaceId: null,
              kind: "operator" as const,
              createdByUserId: null,
              creatorRole: null,
              scopes: ["sessions:read" as const],
            }
          : null;
      },
    };
    const app = createApiApp({ authMode: "api-key", keyStore });

    const accepted = await app.request("/v1", {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({
      status: "ok",
      owner_id: "owner-a",
    });
    expect(
      (
        await app.request("/v1/", {
          headers: { Authorization: `Bearer ${plaintext}` },
        })
      ).status,
    ).toBe(200);
    expect(receivedHash).toEqual(expectedHash);
    expect(new TextDecoder().decode(receivedHash)).not.toContain(plaintext);

    const rejected = await app.request("/v1", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(rejected.status).toBe(401);
  });

  test("answers 503 when the key lookup cannot reach storage", async () => {
    const { logger, sink } = loggerWithMemory();
    const keyStore: ApiKeyStore = {
      async find() {
        // Shape of a DrizzleQueryError wrapping a pg connection failure.
        throw new Error("Failed query", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          }),
        });
      },
    };
    const app = createApiApp({ authMode: "api-key", keyStore, logger });
    const response = await app.request("/v1", {
      headers: { Authorization: "Bearer csp_any" },
    });
    expect(response.status).toBe(503);
    expect(apiErrorResponseSchema.parse(await response.json())).toMatchObject({
      error: {
        code: "BACKEND_UNAVAILABLE",
        retryable: true,
      },
    });
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "Storage unavailable during API request",
      }),
    );
    expect(sink.records.some((record) => record.level === "error")).toBe(false);
  });

  test.each([
    ["pg socket drop", new Error("Connection terminated unexpectedly")],
    ["pg connect timeout", new Error("timeout expired")],
    [
      "pg-pool acquisition timeout on a saturated pool",
      new Error("timeout exceeded when trying to connect"),
    ],
    [
      "pg-pool timeout wrapping a socket error",
      new Error("Connection terminated due to connection timeout", {
        cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      }),
    ],
    [
      "SQLSTATE 57P01",
      Object.assign(new Error("terminating"), { code: "57P01" }),
    ],
    [
      "SQLSTATE 53300 too many connections",
      Object.assign(new Error("too many connections"), { code: "53300" }),
    ],
    [
      "SQLSTATE 57014 statement_timeout cancel",
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014",
      }),
    ],
    [
      "SQLSTATE 40P01 deadlock",
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    ],
    [
      "SQLSTATE 55P03 lock_timeout",
      Object.assign(new Error("canceling statement due to lock timeout"), {
        code: "55P03",
      }),
    ],
    [
      "SQLSTATE 40001 serialization failure",
      Object.assign(new Error("could not serialize access"), {
        code: "40001",
      }),
    ],
    ["pg client query_timeout", new Error("Query read timeout")],
    [
      "database host that stopped resolving",
      Object.assign(new Error("getaddrinfo ENOTFOUND db"), {
        code: "ENOTFOUND",
      }),
    ],
    [
      "network that went down",
      Object.assign(new Error("connect ENETDOWN"), { code: "ENETDOWN" }),
    ],
    [
      "statement queued behind an evicted client",
      new Error(
        "Client has encountered a connection error and is not queryable",
      ),
    ],
    [
      "statement queued behind a closed client",
      new Error("Client was closed and is not queryable"),
    ],
  ])("maps a %s during key lookup to 503", async (_name, failure) => {
    const keyStore: ApiKeyStore = {
      async find() {
        throw new Error("Failed query", { cause: failure });
      },
    };
    const app = createApiApp({ authMode: "api-key", keyStore });
    const response = await app.request("/v1", {
      headers: { Authorization: "Bearer csp_any" },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
  });

  test("keeps 500 for a key lookup failure that is not a storage outage", async () => {
    const { logger, sink } = loggerWithMemory();
    const keyStore: ApiKeyStore = {
      async find() {
        throw new Error("Failed query", {
          cause: Object.assign(new Error("relation does not exist"), {
            code: "42P01",
          }),
        });
      },
    };
    const app = createApiApp({ authMode: "api-key", keyStore, logger });
    const response = await app.request("/v1", {
      headers: { Authorization: "Bearer csp_any" },
    });
    expect(response.status).toBe(500);
    expect(apiErrorResponseSchema.parse(await response.json())).toMatchObject({
      error: { code: "INTERNAL_ERROR", retryable: false },
    });
    expect(sink.records).toContainEqual(
      expect.objectContaining({ level: "error" }),
    );
  });

  test("trusts X-Owner-Id only in explicit local mode and warns", async () => {
    const { logger, sink } = loggerWithMemory();
    const app = createApiApp({ authMode: "none", logger });
    const response = await app.request("/v1", {
      headers: { "X-Owner-Id": "local-owner" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      owner_id: "local-owner",
    });
    expect(sink.records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "API authentication is disabled",
      }),
    );
  });
});

describe("API validation and errors", () => {
  test("logs every /v1 completion without request bodies or credentials", async () => {
    const { logger, sink } = loggerWithMemory();
    const app = createApiApp({
      authMode: "none",
      logger,
      registerRoutes(router) {
        router.post("/sessions/:id/echo", async (context) => {
          await context.req.json();
          return context.json({ ok: true });
        });
      },
    });
    const secret = "sk-example-secret-value";
    const response = await app.request("/v1/sessions/session-actual-id/echo", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "X-Owner-Id": "local-owner",
      },
      body: JSON.stringify({ message: secret }),
    });

    expect(response.status).toBe(200);
    const record = sink.records.find(
      ({ event }) => event === "api.request.completed",
    );
    expect(record).toMatchObject({
      message: "API request completed",
      request_id: response.headers.get("X-Request-Id"),
      fields: {
        operation: "api_request",
        outcome: "succeeded",
        reason_code: "none",
        route_template: "/v1/sessions/:id/echo",
        method: "POST",
        status: 200,
        duration_ms: expect.any(Number),
      },
    });
    const logged = JSON.stringify(record);
    expect(logged).not.toContain("session-actual-id");
    expect(logged).not.toContain(secret);
  });

  test("logs a worker route's completion only when it is a 5xx", async () => {
    const { logger, sink } = loggerWithMemory();
    const app = createApiApp({
      authMode: "none",
      logger,
      registerInternalRoutes(router) {
        router.post("/worker/ok", (context) => context.json({ ok: true }));
        router.post("/worker/heartbeat", () => {
          throw Object.assign(new Error("canceling statement"), {
            code: "55P03",
          });
        });
      },
    });

    expect(
      (await app.request("/internal/worker/ok", { method: "POST" })).status,
    ).toBe(200);
    expect(
      (await app.request("/internal/worker/heartbeat", { method: "POST" }))
        .status,
    ).toBe(503);

    const completions = sink.records.filter(
      ({ event }) => event === "api.request.completed",
    );
    expect(
      sink.records.find(
        (r) => r.message === "Storage unavailable during API request",
      )?.fields,
    ).toMatchObject({ sqlstate: "55P03" });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      fields: {
        outcome: "server_error",
        reason_code: "http_503",
        route_template: "/internal/worker/heartbeat",
        status: 503,
      },
    });
  });

  test("rejects unknown request fields through the contracts schema", async () => {
    const app = createApiApp({
      authMode: "none",
      registerRoutes(router) {
        router.post("/echo", async (context) => {
          await parseJsonBody(context, postSessionMessageRequestSchema);
          return jsonWithSchema(context, healthResponseSchema, {
            status: "ok",
          });
        });
      },
    });
    const response = await app.request("/v1/echo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "local-owner",
      },
      body: JSON.stringify({ message: "hello", unexpected: true }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("X-Request-Id")).toHaveLength(36);
    expect(
      apiErrorResponseSchema.safeParse(await response.json()).success,
    ).toBe(true);

    const oversized = await app.request("/v1/echo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "local-owner",
      },
      body: JSON.stringify({ message: "x".repeat(65 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(
      apiErrorResponseSchema.parse(await oversized.json()).error.code,
    ).toBe("PAYLOAD_TOO_LARGE");
  });

  test("returns a stable 500 without exposing an error or stack", async () => {
    const app = createApiApp({
      authMode: "none",
      registerRoutes(router) {
        router.get("/explode", () => {
          throw new Error("sensitive implementation detail");
        });
      },
    });
    const response = await app.request("/v1/explode", {
      headers: { "X-Owner-Id": "local-owner" },
    });
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(apiErrorResponseSchema.safeParse(JSON.parse(text)).success).toBe(
      true,
    );
    expect(text).not.toContain("sensitive implementation detail");
    expect(text).not.toContain("app.test.ts");
  });

  test("limits that cannot be read answer a retryable 503 that names the setting", async () => {
    const app = createApiApp({
      authMode: "none",
      registerRoutes(router) {
        router.get("/blocked", () => {
          throw new InstallationConfigUnavailableError(
            "queued_input_limit_per_session",
          );
        });
        router.get("/stale", () => {
          throw new InstallationConfigUnavailableError(null);
        });
      },
    });
    const blocked = await app.request("/v1/blocked", {
      headers: { "X-Owner-Id": "local-owner" },
    });
    expect(blocked.status).toBe(503);
    const { error } = apiErrorResponseSchema.parse(await blocked.json());
    expect(error).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
    expect(error.message).toContain("queued_input_limit_per_session");
    const stale = await app.request("/v1/stale", {
      headers: { "X-Owner-Id": "local-owner" },
    });
    expect(stale.status).toBe(503);
    expect(apiErrorResponseSchema.parse(await stale.json()).error.message).toBe(
      "the installation settings could not be read",
    );
  });

  test("validates responses before serializing them", async () => {
    const app = createApiApp({
      authMode: "none",
      registerRoutes(router) {
        router.get("/invalid-response", (context) =>
          jsonWithSchema(context, healthResponseSchema, {
            status: "wrong",
          } as never),
        );
      },
    });
    const response = await app.request("/v1/invalid-response", {
      headers: { "X-Owner-Id": "local-owner" },
    });
    expect(response.status).toBe(500);
    expect(
      apiErrorResponseSchema.safeParse(await response.json()).success,
    ).toBe(true);
  });
});

describe("web console (WEB_DIST_DIR)", () => {
  async function withDist(
    run: (app: ReturnType<typeof createApiApp>) => Promise<void>,
    authMode = "api-key",
  ) {
    const parent = await mkdtemp(join(tmpdir(), "web-dist-"));
    const dist = join(parent, "dist");
    try {
      await mkdir(dist);
      await mkdir(join(dist, "assets"));
      await writeFile(
        join(dist, "index.html"),
        "<!doctype html><title>web</title>",
      );
      await writeFile(join(dist, "assets", "index-abc.js"), "console.log(1)");
      await writeFile(join(dist, "favicon.svg"), "<svg/>");
      await writeFile(join(parent, "outside-web-dist.txt"), "secret");
      await run(createApiApp({ authMode, webDistDir: dist }));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }

  test("serves built files, hashed assets as immutable", async () => {
    await withDist(async (app) => {
      const asset = await app.request("/assets/index-abc.js");
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe("console.log(1)");
      expect(asset.headers.get("Content-Type")).toContain("javascript");
      expect(asset.headers.get("Cache-Control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(asset.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const icon = await app.request("/favicon.svg");
      expect(icon.headers.get("Cache-Control")).toBe("no-cache");
    });
  });

  test("answers any other page path with index.html under a strict CSP", async () => {
    await withDist(async (app) => {
      for (const path of ["/", "/login", "/bootstrap", "/sessions/abc"]) {
        const page = await app.request(path);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("<title>web</title>");
        expect(page.headers.get("Content-Type")).toBe(
          "text/html; charset=utf-8",
        );
        expect(page.headers.get("Cache-Control")).toBe("no-cache");
        const csp = page.headers.get("Content-Security-Policy") ?? "";
        expect(csp).toContain("script-src 'self'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).not.toContain("unsafe-inline");
        // The GitHub App manifest is a form POST to github.com, and only there.
        expect(csp).toContain("form-action 'self' https://github.com;");
      }
      const head = await app.request("/login", { method: "HEAD" });
      expect(head.status).toBe(200);
    });
  });

  test("keeps the API's JSON 404 under /v1 and /internal", async () => {
    await withDist(async (app) => {
      for (const path of ["/v1/nope", "/internal/nope"]) {
        const response = await app.request(path, {
          headers: { "X-Owner-Id": "local-owner" },
        });
        expect(response.status).toBe(404);
        expect(response.headers.get("Content-Type")).toContain(
          "application/json",
        );
        expect(
          apiErrorResponseSchema.safeParse(await response.json()).success,
        ).toBe(true);
      }
    }, "none");
  });

  test("leaves /v1 behind its authentication", async () => {
    await withDist(async (app) => {
      const response = await app.request("/v1/nope");
      expect(response.status).toBe(401);
      expect(response.headers.get("Content-Type")).toContain(
        "application/json",
      );
    });
  });

  test("a missing hashed asset is a 404, not the page", async () => {
    await withDist(async (app) => {
      expect((await app.request("/assets/index-old.js")).status).toBe(404);
    });
  });

  test("never reads outside the directory", async () => {
    await withDist(async (app) => {
      for (const path of [
        "/../outside-web-dist.txt",
        "/%2e%2e/outside-web-dist.txt",
        "/assets/%2e%2e%2f%2e%2e%2foutside-web-dist.txt",
      ]) {
        const response = await app.request(path);
        expect(await response.text()).not.toContain("secret");
      }
    });
  });

  test("without WEB_DIST_DIR a page path is the JSON 404 it always was", async () => {
    const response = await createApiApp({ authMode: "api-key" }).request(
      "/login",
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});
