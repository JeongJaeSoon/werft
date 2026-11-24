import { describe, expect, spyOn, test } from "bun:test";
import {
  apiErrorResponseSchema,
  healthResponseSchema,
  readyResponseSchema,
} from "@werft-ai/contracts";
import type { ReadinessResult } from "./readiness.ts";
import { recordRouteErrors } from "./route-error-coverage.ts";

const createApiApp = recordRouteErrors("probes.test.ts");

function app(result?: ReadinessResult) {
  return createApiApp({
    authMode: "api-key",
    ...(result ? { readiness: async () => result } : {}),
  });
}

describe("GET /healthz", () => {
  test("answers 200 with a minimal body and no authentication", async () => {
    const response = await app().request("/healthz");
    expect(response.status).toBe(200);
    expect(healthResponseSchema.parse(await response.json())).toEqual({
      status: "ok",
    });
  });
});

describe("GET /readyz", () => {
  test("answers 200 with every check ok when the probe passes", async () => {
    const response = await app({ ready: true }).request("/readyz");
    expect(response.status).toBe(200);
    expect(readyResponseSchema.parse(await response.json())).toEqual({
      status: "ready",
      checks: { database: "ok", schema: "ok", config: "ok" },
    });
  });

  test("passes the probe's detail on, and leaves the key out without one", async () => {
    const response = await app({
      ready: true,
      detail: { checkpoints_forgotten_on_boot: 2 },
    }).request("/readyz");
    expect(response.status).toBe(200);
    expect(readyResponseSchema.parse(await response.json())).toEqual({
      status: "ready",
      checks: { database: "ok", schema: "ok", config: "ok" },
      detail: { checkpoints_forgotten_on_boot: 2 },
    });
    const plain = await app({ ready: true }).request("/readyz");
    expect(await plain.json()).not.toHaveProperty("detail");
  });

  test("answers 503 NOT_READY naming the failed check", async () => {
    // A request id holding the digits a leak check once looked for.
    const uuid = spyOn(crypto, "randomUUID").mockReturnValue(
      "aa243477-8602-4291-a70e-2270003cb766",
    );
    let response: Response;
    try {
      response = await app({
        ready: false,
        check: "schema",
        reason: "expected 0004, database at pg.internal.example has 0003",
      }).request("/readyz");
    } finally {
      uuid.mockRestore();
    }
    expect(response.status).toBe(503);
    const body = apiErrorResponseSchema.parse(await response.json());
    expect(body.error).toMatchObject({
      code: "NOT_READY",
      retryable: true,
      details: { check: "schema" },
    });
    // The reason stays in the log; it may name hosts or files. The host is
    // the marker: a uuid, hex only, can never spell it.
    expect(body.error.request_id).toBe("aa243477-8602-4291-a70e-2270003cb766");
    expect(JSON.stringify(body)).not.toContain("pg.internal.example");
  });

  test("answers 503 when no probe was wired", async () => {
    const response = await app().request("/readyz");
    expect(response.status).toBe(503);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "NOT_READY",
    );
  });
});
