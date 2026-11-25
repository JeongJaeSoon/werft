import { describe, expect, test } from "bun:test";
import {
  type ConversationRuntimeTurns,
  type WorkerGateway,
  WorkerGatewayError,
} from "@werft-ai/platform";
import { createApiApp } from "../../app.ts";
import { conversationRuntimeBearer } from "../../conversation-runtime.ts";
import { RequestTracing } from "../../request-tracing.ts";
import { registerInternalApiRoutes } from "./internal.ts";

const RUNTIME_BEARER = ["runtime", "bearer", "0123456789abcdef"].join("-");

// Anything past authentication is a route that answered without a bearer.
function unreachable(family: string): never {
  throw new Error(`a call without a bearer reached the ${family}`);
}
const gateway = new Proxy(
  {},
  {
    get: (_target, name) =>
      name === "authenticate"
        ? async (token: string | null) => {
            if (token === null) {
              throw new WorkerGatewayError(401, "UNAUTHORIZED", "No bearer");
            }
            return unreachable("worker gateway");
          }
        : () => unreachable("worker gateway"),
  },
) as WorkerGateway;
const turns = new Proxy(
  {},
  { get: () => () => unreachable("conversation runtime") },
) as ConversationRuntimeTurns;

const app = createApiApp({
  authMode: "api-key",
  registerInternalRoutes: (router) =>
    registerInternalApiRoutes(router, {
      workers: gateway,
      tracing: new RequestTracing(),
      conversationRuntime: {
        turns,
        readTools: { call: () => unreachable("conversation read tools") },
        isRuntimeBearer: conversationRuntimeBearer([RUNTIME_BEARER]),
      },
    }),
});

// Every entry is called, middleware included: an endpoint mounted with all()
// is ALL too and the two look alike in the table. A wildcard path matches no
// endpoint of its own, so 404 is the one other answer it may give.
const internalRoutes = app.routes
  .filter(
    (route) =>
      route.path === "/internal" || route.path.startsWith("/internal/"),
  )
  .flatMap((route) =>
    (route.method === "ALL" ? ["GET", "POST"] : [route.method]).map(
      (method) => ({
        method,
        path: route.path.replace(/:[^/]+/g, "x").replace(/\*/g, "x"),
        allowed: route.path.includes("*") ? [401, 403, 404] : [401, 403],
      }),
    ),
  );

describe("every /internal route needs its own bearer", () => {
  test("the table holds both families", () => {
    expect(internalRoutes.map((route) => route.path)).toEqual(
      expect.arrayContaining([
        "/internal/worker/bootstrap-claim",
        "/internal/worker/attempts/x/extensions/x",
        "/internal/conversation-runtime/next-turn",
        "/internal/conversation-runtime/turn-result",
      ]),
    );
  });

  test.each(internalRoutes)(
    "$method $path without a bearer is refused",
    async ({ method, path, allowed }) => {
      const response = await app.request(path, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
      });
      expect(allowed).toContain(response.status);
    },
  );
});
