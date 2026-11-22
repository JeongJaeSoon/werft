import { describe, expect, test } from "bun:test";
import { unwrap } from "@werft-ai/client";
import { apiError, json, me } from "../test-support/fake-api.ts";
import { createApiClient } from "./client.ts";
import { READ_RETRY_DELAYS_MS, retriedByClient } from "./retry.ts";

const DELAYS = [1, 1, 1];

/** A server that gives each answer in turn, then the last one again. */
function server(...answers: (() => Response)[]) {
  const methods: string[] = [];
  const fetch = (async (request: Request) => {
    methods.push(request.method);
    const answer = answers[Math.min(methods.length, answers.length) - 1];
    if (!answer) throw new Error("no answer");
    return answer();
  }) as typeof globalThis.fetch;
  const client = createApiClient({
    baseUrl: "https://console.test",
    fetch,
    readRetryDelaysMs: DELAYS,
  });
  return { client, methods };
}

const gateway = (status: number) => () =>
  new Response("<html>Bad Gateway</html>", {
    status,
    headers: { "content-type": "text/html" },
  });
const dropped = () => {
  throw new TypeError("Failed to fetch");
};
const ok = () => json(200, me());

describe("asking again after a gateway failure", () => {
  test("the default waits are short and few", () => {
    expect(READ_RETRY_DELAYS_MS.length).toBeLessThanOrEqual(3);
    expect(READ_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThan(5_000);
  });

  for (const status of [502, 503, 504])
    test(`a GET answered ${status} is asked again until it succeeds`, async () => {
      const { client, methods } = server(gateway(status), gateway(status), ok);
      expect(await unwrap(client.GET("/v1/auth/me"))).toEqual(me());
      expect(methods).toEqual(["GET", "GET", "GET"]);
    });

  test("a GET whose connection dropped is asked again", async () => {
    const { client, methods } = server(dropped, ok);
    expect(await unwrap(client.GET("/v1/auth/me"))).toEqual(me());
    expect(methods).toEqual(["GET", "GET"]);
  });

  test("a HEAD is asked again", async () => {
    const { client, methods } = server(gateway(502), () => new Response(null));
    const { response } = await client.HEAD("/v1/auth/me" as never);
    expect(response.status).toBe(200);
    expect(methods).toEqual(["HEAD", "HEAD"]);
  });

  test("a GET that keeps failing stops after the last wait and says the server is unavailable", async () => {
    const { client, methods } = server(gateway(502));
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(methods).toHaveLength(DELAYS.length + 1);
    expect(error).toMatchObject({
      status: 502,
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
  });

  test("a GET whose connection keeps dropping ends as a NETWORK_ERROR", async () => {
    const { client, methods } = server(dropped);
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(methods).toHaveLength(DELAYS.length + 1);
    expect(error).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  test("an empty gateway answer says the server is unavailable too", async () => {
    const { client } = server(
      () =>
        new Response(null, {
          status: 503,
          headers: { "content-length": "0" },
        }),
    );
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toMatchObject({ status: 503, code: "BACKEND_UNAVAILABLE" });
  });

  test("an answer with Retry-After is not asked again here", async () => {
    const { client, methods } = server(
      () =>
        new Response("busy", { status: 503, headers: { "retry-after": "60" } }),
      ok,
    );
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(methods).toEqual(["GET"]);
    expect(error).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryAfterSeconds: 60,
    });
  });

  test("an event stream keeps its own reconnect", async () => {
    const { client, methods } = server(gateway(502), ok);
    await client.GET("/v1/auth/me", {
      headers: { accept: "text/event-stream" },
    });
    expect(methods).toEqual(["GET"]);
  });

  test("a query does not retry what the client already asked again", async () => {
    const { client } = server(gateway(504));
    const gatewayError = await unwrap(client.GET("/v1/auth/me")).catch(
      (e) => e,
    );
    const dropError = await unwrap(
      server(dropped).client.GET("/v1/auth/me"),
    ).catch((e) => e);
    expect(retriedByClient(gatewayError)).toBe(true);
    expect(retriedByClient(dropError)).toBe(true);
    expect(
      retriedByClient(
        await unwrap(server(gateway(500)).client.GET("/v1/auth/me")).catch(
          (e) => e,
        ),
      ),
    ).toBe(false);
  });

  test("an answer the API wrote keeps its code", async () => {
    const { client } = server(() =>
      apiError(503, "RATE_LIMITED", "slow down", true),
    );
    const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
    expect(error).toMatchObject({ status: 503, code: "RATE_LIMITED" });
  });

  for (const status of [500, 404, 429])
    test(`a GET answered ${status} is not asked again`, async () => {
      const { client, methods } = server(gateway(status), ok);
      const error = await unwrap(client.GET("/v1/auth/me")).catch((e) => e);
      expect(methods).toEqual(["GET"]);
      expect(error).toMatchObject({ status });
    });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
    for (const [failure, answer] of [
      ["a gateway status", gateway(502)],
      ["a dropped connection", dropped],
    ] as const)
      test(`a ${method} after ${failure} is sent once`, async () => {
        const { client, methods } = server(answer, ok);
        const error = await unwrap(
          client.request(
            method.toLowerCase() as "post",
            "/v1/auth/logout" as never,
          ),
        ).catch((e) => e);
        expect(methods).toEqual([method]);
        expect(error.code).toBe(
          answer === dropped ? "NETWORK_ERROR" : "BACKEND_UNAVAILABLE",
        );
      });

  test("a read cancelled while waiting is not asked again", async () => {
    const methods: string[] = [];
    const client = createApiClient({
      baseUrl: "https://console.test",
      fetch: (async () => {
        methods.push("GET");
        return gateway(502)();
      }) as unknown as typeof globalThis.fetch,
      readRetryDelaysMs: [50, 50],
    });
    const stop = new AbortController();
    const call = unwrap(client.GET("/v1/auth/me", { signal: stop.signal }));
    await Bun.sleep(10);
    stop.abort();
    await call.catch(() => {});
    await Bun.sleep(120);
    expect(methods).toEqual(["GET"]);
  });
});
