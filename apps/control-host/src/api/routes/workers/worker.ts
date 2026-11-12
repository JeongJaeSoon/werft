import {
  WORKER_PROTOCOL_ROUTES,
  type WorkerProtocolRoute,
} from "@werft-ai/contracts";
import {
  type WorkerGateway,
  WorkerGatewayError,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import type { z } from "zod";
import {
  ApiHttpError,
  type ApiRouter,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import { RequestTracing } from "../../request-tracing.ts";

const WORKER_ROUTE_PREFIX = "/worker";
type Routes = typeof WORKER_PROTOCOL_ROUTES;

function bearerToken(value: string | undefined): string | null {
  const match = value ? /^Bearer ([^\s]+)$/.exec(value) : null;
  return match?.[1] ?? null;
}

async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof WorkerGatewayError) {
      throw new ApiHttpError(
        error.status,
        error.code,
        error.message,
        error.retryable,
      );
    }
    throw error;
  }
}

// Internal worker protocol. It never shares the /v1 API-key middleware: the
// bearer token here is a launch nonce (bootstrapClaim only) or the session
// token bootstrapClaim issued. A session token must name the binding the body
// acts for (the gateway checks); a launch nonce must be the one the body
// claims with.
export function registerWorkerRoutes(
  router: ApiRouter,
  gateway: WorkerGateway,
  tracing = new RequestTracing(),
) {
  function call<P extends WorkerProtocolRoute>(
    path: P,
    handle: (
      principal: WorkerPrincipal,
      body: z.infer<Routes[P]["request"]>,
      token: string | null,
    ) => Promise<z.input<Routes[P]["response"]>>,
  ) {
    const { request, response } = WORKER_PROTOCOL_ROUTES[path];
    router.post(`${WORKER_ROUTE_PREFIX}${path}`, async (context) => {
      const token = bearerToken(context.req.header("Authorization"));
      const principal = await mapped(() => gateway.authenticate(token));
      // TypeScript widens the generic lookup to the union of every route.
      const body = (await parseJsonBody(context, request)) as z.infer<
        Routes[P]["request"]
      >;
      // Only a call the token's own session acts for may join that turn's
      // trace; the gateway rejects a body naming another session below.
      // Not every request carries a scope (bootstrap-claim has none).
      const claimed: Record<string, unknown> =
        typeof body === "object" && body !== null ? body : {};
      const scope =
        principal.kind === "session" &&
        principal.sessionId === claimed.session_id
          ? claimed
          : {};
      return tracing.traceGatewayCall(context, scope, async () => {
        const result = await mapped(() => handle(principal, body, token));
        return jsonWithSchema(context, response, result);
      });
    });
  }

  call("/bootstrap-claim", (principal, body, token) => {
    if (
      principal.kind === "bootstrap" &&
      body.credential.kind === "launch_nonce" &&
      body.credential.nonce !== token
    ) {
      throw new WorkerGatewayError(
        401,
        "UNAUTHORIZED",
        "The bearer launch nonce is not the one the claim carries",
      );
    }
    return gateway.bootstrapClaim(principal, body);
  });
  call("/next-input", (principal, body) => gateway.nextInput(principal, body));
  call("/heartbeat", (principal, body) => gateway.heartbeat(principal, body));
  call("/append-events", (principal, body) =>
    gateway.appendEvents(principal, body),
  );
  call("/checkpoint-request", (principal, body) =>
    gateway.requestCheckpoint(principal, body),
  );
  call("/protected-commits", (principal, body) =>
    gateway.protectedCommits(principal, body),
  );
  call("/restore-plan", (principal, body) =>
    gateway.restorePlan(principal, body),
  );
  call("/ready", (principal, body) => gateway.ready(principal, body));
  call("/register-pending", (principal, body) =>
    gateway.registerPending(principal, body),
  );
  call("/pending-control", (principal, body) =>
    gateway.pendingControl(principal, body),
  );
  call("/park-declined", (principal, body) =>
    gateway.parkDeclined(principal, body),
  );
  call("/request-park", (principal, body) =>
    gateway.requestPark(principal, body),
  );
  call("/invalidate-approval-checkpoint", (principal, body) =>
    gateway.invalidateApprovalCheckpoint(principal, body),
  );
  call("/finalize", (principal, body) => gateway.finalize(principal, body));
  call("/release", (principal, body) => gateway.release(principal, body));

  router.get(
    `${WORKER_ROUTE_PREFIX}/attempts/:attempt_id/extensions/:digest`,
    async (context) => {
      const token = bearerToken(context.req.header("Authorization"));
      const principal = await mapped(() => gateway.authenticate(token));
      const served = await mapped(() =>
        gateway.extensionBundle(principal, {
          attemptId: context.req.param("attempt_id"),
          digest: context.req.param("digest"),
        }),
      );
      return new Response(new Uint8Array(served.tar), {
        headers: {
          "content-type": "application/x-tar",
          "content-length": String(served.tar.byteLength),
          "x-bundle-digest": served.digest,
          "cache-control": "no-store",
        },
      });
    },
  );
}
