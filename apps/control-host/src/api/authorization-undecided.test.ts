import { describe, expect, test } from "bun:test";
import { apiErrorResponseSchema } from "@werft-ai/contracts";
import {
  type AuthorizationPolicy,
  AuthorizationUndecidedError,
  createAuthorizationPolicy,
  requirePermitted,
} from "@werft-ai/platform";
import { createApiApp, isStorageUnavailable } from "./app.ts";
import type { ApiKeyStore } from "./keys.ts";
import { mapped } from "./routes/errors.ts";

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
