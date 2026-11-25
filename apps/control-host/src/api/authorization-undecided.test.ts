import { describe, expect, test } from "bun:test";
import { apiErrorResponseSchema } from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  AuthorizationUndecidedError,
  createAuthorizationPolicy,
  createWorkerGateway,
  requirePermitted,
  type WorkerGateway,
} from "@werft-ai/platform";
import { testCatalog } from "@werft-ai/platform/testing/catalog";
import { acceptAllCheckpoints } from "@werft-ai/platform/testing/checkpoints";
import { createApiApp, isStorageUnavailable } from "./app.ts";
import type { ApiKeyStore } from "./keys.ts";
import { mapped } from "./routes/errors.ts";
import { registerWorkerRoutes } from "./routes/workers/worker.ts";

// What pg raises when the server is shut down under a query.
const adminShutdown = () =>
  Object.assign(
    new Error("terminating connection due to administrator command"),
    {
      code: "57P01",
    },
  );

function policy(failure: () => Error): AuthorizationPolicy {
  return createAuthorizationPolicy({
    identity: {
      reread: async () => {
        throw failure();
      },
    },
    storageUnavailable: isStorageUnavailable,
  });
}

function keyStore(scopes: string[]): ApiKeyStore {
  return {
    async find() {
      return {
        id: "key-a",
        ownerId: "owner-a",
        workspaceId: null,
        kind: "operator" as const,
        createdByUserId: null,
        creatorRole: null,
        scopes: scopes as never,
      };
    },
  };
}

// Each way an API request meets the policy; reached means the request went
// on as allowed.
const callers: [
  string,
  (
    authorization: AuthorizationPolicy,
    reached: () => void,
  ) => ReturnType<typeof createApiApp>,
][] = [
  [
    "a service entry through requirePermitted",
    (authorization, reached) =>
      createApiApp({
        authMode: "api-key",
        keyStore: keyStore(["sessions:read"]),
        authorization,
        registerRoutes(router) {
          router.get("/probe", async (context) => {
            await mapped(() =>
              requirePermitted(
                authorization,
                context.get("caller"),
                "session.read",
                {
                  kind: "session",
                  id: null,
                },
              ),
            );
            reached();
            return context.json({ ok: true });
          });
        },
      }),
  ],
  [
    "a route asking the policy itself",
    (authorization, reached) =>
      createApiApp({
        authMode: "api-key",
        keyStore: keyStore(["sessions:read"]),
        authorization,
        registerRoutes(router) {
          router.get("/probe", async (context) => {
            const caller = context.get("caller");
            const decision = await authorization.authorize({
              subject: caller.subject,
              action: "session.read",
              resource: {
                kind: "session",
                id: null,
                owner_scope: caller.ownerId,
              },
              request_id: caller.requestId,
            });
            if (decision.outcome !== "allow") {
              return context.json({ refused: true }, 403);
            }
            reached();
            return context.json({ ok: true });
          });
        },
      }),
  ],
];

describe("a permission check whose store cannot be read", () => {
  for (const [name, app] of callers) {
    test(`${name} answers a retryable 503 and never goes on as allowed`, async () => {
      let reached = 0;
      const response = await app(policy(adminShutdown), () => {
        reached += 1;
      }).request("/v1/probe", { headers: { Authorization: "Bearer csp_any" } });
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      expect(apiErrorResponseSchema.parse(await response.json())).toMatchObject(
        {
          error: { code: "BACKEND_UNAVAILABLE", retryable: true },
        },
      );
      expect(reached).toBe(0);
    });

    test(`${name} still refuses with 403 when the failure is not the store's`, async () => {
      let reached = 0;
      const response = await app(
        policy(() => new Error("invalid input syntax for type uuid")),
        () => {
          reached += 1;
        },
      ).request("/v1/probe", { headers: { Authorization: "Bearer csp_any" } });
      expect(response.status).toBe(403);
      expect(reached).toBe(0);
    });
  }

  test("a scope the credential lacks stays a 403 even when recording the refusal fails", async () => {
    let asked = 0;
    const authorization: AuthorizationPolicy = {
      authorize: async () => {
        asked += 1;
        throw new AuthorizationUndecidedError(adminShutdown());
      },
    };
    let reached = 0;
    const response = await createApiApp({
      authMode: "api-key",
      keyStore: keyStore([]),
      authorization,
      registerRoutes(router) {
        router.get("/sessions", (context) => {
          reached += 1;
          return context.json({ ok: true });
        });
      },
    }).request("/v1/sessions", {
      headers: { Authorization: "Bearer csp_any" },
    });
    expect(response.status).toBe(403);
    expect(apiErrorResponseSchema.parse(await response.json())).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "This credential does not hold sessions:read",
      },
    });
    expect(asked).toBe(1);
    expect(reached).toBe(0);
  });
});
describe("a worker's session allow whose policy cannot read its store", () => {
  const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
  const principal = {
    kind: "session",
    attemptId: "att_1",
    sessionId: SESSION,
    leaseEpoch: 1,
    executionGeneration: 1,
    authRevision: 0,
  } as const;
  const giver = {
    principal: {
      kind: "user",
      id: "11111111-1111-4111-8111-111111111111",
      workspace_id: "22222222-2222-4222-8222-222222222222",
      role: "member",
      scopes: ["sessions:approve"],
    },
    actor_user_id: "11111111-1111-4111-8111-111111111111",
    surface: { kind: "web" },
  };

  function app(authorization: AuthorizationPolicy) {
    const gateway = createWorkerGateway({
      work: {} as never,
      catalog: testCatalog(),
      pending: {
        sessionAllowAtomic: async () => ({
          outcome: "ok",
          grant: { ownerScope: "owner-a", subject: giver },
        }),
      } as never,
      checkpoints: acceptAllCheckpoints,
      authorization,
      options: {
        sessionBudget: { costUsd: 1_000, tokens: null },
        leaseTtlMs: 30_000,
      },
    });
    const routes = {
      authenticate: async () => principal,
      sessionAllow: gateway.sessionAllow,
    } as unknown as WorkerGateway;
    return createApiApp({
      registerInternalRoutes: (router) => registerWorkerRoutes(router, routes),
    });
  }

  const check = (authorization: AuthorizationPolicy) =>
    app(authorization).request("/internal/worker/session-allow", {
      method: "POST",
      headers: {
        Authorization: "Bearer wst_any",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: SESSION,
        turn_id: "1",
        attempt_id: "att_1",
        lease_epoch: 1,
        execution_generation: 1,
        auth_revision: 0,
        grant_request_id: "req_1",
        tool_call_id: "toolu_1",
        input_hash: "a".repeat(64),
      }),
    });

  test("answers a retryable 503 with Retry-After, never allowed", async () => {
    const response = await check(policy(adminShutdown));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    const body = await response.json();
    expect(apiErrorResponseSchema.parse(body)).toMatchObject({
      error: { code: "BACKEND_UNAVAILABLE", retryable: true },
    });
    expect(body).not.toHaveProperty("allowed");
  });

  test("a failure that is not the store's is allowed: false", async () => {
    const response = await check(
      policy(() => new Error("invalid input syntax for type uuid")),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ allowed: false });
  });
});
