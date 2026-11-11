import { describe, expect, test } from "bun:test";
import { SESSION_SCOPE_VALUES, type SessionScope } from "@werft-ai/contracts";
import type {
  IdentityStore,
  InterruptService,
  PendingRequestService,
  PushRequestService,
  SessionService,
} from "@werft-ai/platform";
import { createApiApp } from "./app.ts";
import type { BootstrapGate } from "./auth.ts";
import { hashApiKey } from "./keys.ts";
import { API_ROUTE_SCOPES } from "./openapi.ts";
import { registerPushRequestRoutes } from "./routes/action/push-requests.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerCloseRoutes } from "./routes/sessions/close.ts";
import { registerEventRoutes } from "./routes/sessions/events.ts";
import { registerInterruptRoutes } from "./routes/sessions/interrupt.ts";
import { registerPauseRoutes } from "./routes/sessions/pause.ts";
import { registerPendingRoutes } from "./routes/sessions/pending.ts";
import { registerReceiptRoutes } from "./routes/sessions/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { requiredScope } from "./scope-policy.ts";

const SESSION = "019a0000-0000-7000-8000-000000000001";
const TURN = "1";
const RECEIPT = "rcpt_0000000000000000000000";

// A service whose every method records the call and then fails: a request
// that reaches it was admitted by the scope check.
function recorder<T>(calls: string[]): T {
  return new Proxy(
    {},
    {
      get: (_target, name) => async () => {
        calls.push(String(name));
        throw new Error("reached the service");
      },
    },
  ) as T;
}

function appWithKey(scopes: readonly SessionScope[], calls: string[]) {
  const token = "csp_matrix";
  const app = createApiApp({
    authMode: "api-key",
    keyStore: {
      async find(hash) {
        return Buffer.from(hash).equals(Buffer.from(hashApiKey(token)))
          ? {
              id: "key-1",
              ownerId: "owner-a",
              workspaceId: null,
              kind: "operator" as const,
              createdByUserId: null,
              creatorRole: null,
              scopes: [...scopes],
            }
          : null;
      },
    },
    registerRoutes: (router) => {
      registerAuthRoutes(router, {
        identity: {} as IdentityStore,
        bootstrap: {} as BootstrapGate,
      });
      const sessions = recorder<SessionService>(calls);
      registerSessionRoutes(router, sessions);
      registerReceiptRoutes(router, sessions);
      registerPendingRoutes(router, recorder<PendingRequestService>(calls));
      registerPushRequestRoutes(router, recorder<PushRequestService>(calls));
      registerInterruptRoutes(router, recorder<InterruptService>(calls));
      registerPauseRoutes(router, sessions);
      registerCloseRoutes(router, sessions);
      registerEventRoutes(router, sessions, {
        wakeup: { wait: async () => {} },
      });
    },
  });
  return { app, token };
}

function concrete(path: string): string {
  return path
    .replace("{id}", path.startsWith("/v1/receipts") ? RECEIPT : SESSION)
    .replace("{turn_id}", TURN)
    .replace("{push_request_id}", SESSION);
}

// Every declared route is served.
const SERVED = API_ROUTE_SCOPES;

describe("scope matrix: every scoped route", () => {
  for (const route of SERVED) {
    const label = `${route.method} ${route.path}`;

    test(`${label} is 403 without ${route.scope}, before body or service`, async () => {
      const calls: string[] = [];
      const { app, token } = appWithKey(
        SESSION_SCOPE_VALUES.filter((scope) => scope !== route.scope),
        calls,
      );
      let bodyRead = false;
      const body =
        route.method === "POST"
          ? new ReadableStream(
              {
                pull(controller) {
                  bodyRead = true;
                  controller.enqueue(new TextEncoder().encode("{}"));
                  controller.close();
                },
              },
              // No pull until someone reads.
              { highWaterMark: 0 },
            )
          : null;
      const response = await app.request(concrete(route.path), {
        method: route.method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "k-1",
        },
        ...(body ? { body, duplex: "half" } : {}),
      } as RequestInit);
      expect(response.status).toBe(403);
      const error = (await response.json()) as { error: { code: string } };
      expect(error.error.code).toBe("FORBIDDEN");
      expect(calls).toEqual([]);
      expect(bodyRead).toBe(false);
    });

    test(`${label} is admitted with only ${route.scope}`, async () => {
      const calls: string[] = [];
      const { app, token } = appWithKey([route.scope], calls);
      const response = await app.request(concrete(route.path), {
        method: route.method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "k-1",
        },
        ...(route.method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status).not.toBe(403);
      expect(response.status).not.toBe(401);
    });
  }

  test("a key issued before scopes (none held) is refused everywhere", async () => {
    const calls: string[] = [];
    const { app, token } = appWithKey([], calls);
    for (const route of SERVED) {
      const response = await app.request(concrete(route.path), {
        method: route.method,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  test("sessions:recover is its own scope: every other scope together is not enough", async () => {
    const calls: string[] = [];
    const { app, token } = appWithKey(
      SESSION_SCOPE_VALUES.filter((scope) => scope !== "sessions:recover"),
      calls,
    );
    const response = await app.request(
      `/v1/sessions/${SESSION}/recovery-decisions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "k-1",
        },
        body: JSON.stringify({ decision: "abandon", expected_revision: 1 }),
      },
    );
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("requiredScope", () => {
  test("matches parameters as one segment and tolerates a trailing slash", () => {
    expect(requiredScope("GET", `/v1/sessions/${SESSION}`)).toBe(
      "sessions:read",
    );
    expect(requiredScope("GET", `/v1/sessions/${SESSION}/`)).toBe(
      "sessions:read",
    );
    expect(requiredScope("HEAD", "/v1/sessions")).toBe("sessions:read");
    expect(requiredScope("POST", "/v1/sessions")).toBe("sessions:write");
    expect(requiredScope("GET", `/v1/sessions/${SESSION}/x/turns`)).toBeNull();
    expect(requiredScope("POST", "/v1/auth/logout")).toBeNull();
    expect(requiredScope("POST", "/v1/auth/login")).toBeNull();
  });
});
