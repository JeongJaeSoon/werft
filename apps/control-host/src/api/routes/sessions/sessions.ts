import {
  controlAcceptedResponseSchema,
  countSessionsQuerySchema,
  countSessionsResponseSchema,
  createSessionRequestSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  getTurnResponseSchema,
  listSessionsQuerySchema,
  listSessionsResponseSchema,
  listTurnsQuerySchema,
  listTurnsResponseSchema,
  postSessionMessageRequestSchema,
  postSessionMessageResponseSchema,
  recoveryDecisionRequestSchema,
  resumeSessionRequestSchema,
  sessionIdParamsSchema,
  terminateSessionRequestSchema,
  terminateSessionResponseSchema,
  turnIdParamsSchema,
  updateSessionRequestSchema,
} from "@werft-ai/contracts";
import { currentSpanContext, formatTraceparent } from "@werft-ai/observability";
import type { SessionService } from "@werft-ai/platform";
import {
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../../app.ts";
import {
  mapped,
  requireIdempotencyKey,
  requireParams,
  requireQuery,
  sessionControlRoute,
} from "../errors.ts";

// The request span is active while a route runs; a turn it queues keeps that
// span's traceparent as text so the worker can link back to the request.
function requestTraceContext(): { traceContext?: string } {
  const span = currentSpanContext();
  return span === undefined ? {} : { traceContext: formatTraceparent(span) };
}

export function registerSessionRoutes(
  router: ApiRouter,
  service: SessionService,
) {
  apiRoute(router, "createSession", async (context) => {
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, createSessionRequestSchema);
    const created = await mapped(() =>
      service.createSession(context.get("caller"), {
        idempotencyKey: key,
        body,
        ...requestTraceContext(),
      }),
    );
    return jsonWithSchema(context, createSessionResponseSchema, created, 201);
  });

  apiRoute(router, "listSessions", async (context) => {
    const query = requireQuery(context, listSessionsQuerySchema);
    const page = await mapped(() =>
      service.listSessions(context.get("caller"), query),
    );
    return jsonWithSchema(context, listSessionsResponseSchema, page);
  });

  // Before getSession, so "counts" is never read as a session id.
  apiRoute(router, "countSessions", async (context) => {
    const query = requireQuery(context, countSessionsQuerySchema);
    const counts = await mapped(() =>
      service.countSessions(context.get("caller"), query),
    );
    return jsonWithSchema(context, countSessionsResponseSchema, counts);
  });

  apiRoute(router, "getSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const detail = await mapped(() =>
      service.getSession(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, getSessionResponseSchema, detail);
  });

  apiRoute(router, "updateSession", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const body = await parseJsonBody(context, updateSessionRequestSchema);
    const detail = await mapped(() =>
      service.renameSession(context.get("caller"), params.id, body),
    );
    return jsonWithSchema(context, getSessionResponseSchema, detail);
  });

  apiRoute(router, "appendSessionMessage", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const key = requireIdempotencyKey(context);
    const body = await parseJsonBody(context, postSessionMessageRequestSchema);
    const accepted = await mapped(() =>
      service.appendMessage(context.get("caller"), params.id, {
        idempotencyKey: key,
        body,
        ...requestTraceContext(),
      }),
    );
    return jsonWithSchema(
      context,
      postSessionMessageResponseSchema,
      accepted,
      202,
    );
  });

  sessionControlRoute(
    router,
    "terminateSession",
    terminateSessionRequestSchema,
    terminateSessionResponseSchema,
    (caller, id, input) => service.terminateSession(caller, id, input),
  );

  sessionControlRoute(
    router,
    "resumeSession",
    resumeSessionRequestSchema,
    controlAcceptedResponseSchema,
    (caller, id, input) => service.resumeSession(caller, id, input),
  );

  sessionControlRoute(
    router,
    "decideSessionRecovery",
    recoveryDecisionRequestSchema,
    controlAcceptedResponseSchema,
    (caller, id, input) => service.decideRecovery(caller, id, input),
  );

  apiRoute(router, "listSessionTurns", async (context) => {
    const params = requireParams(context, sessionIdParamsSchema);
    const query = requireQuery(context, listTurnsQuerySchema);
    const page = await mapped(() =>
      service.listTurns(context.get("caller"), params.id, query),
    );
    return jsonWithSchema(context, listTurnsResponseSchema, page);
  });

  apiRoute(router, "getSessionTurn", async (context) => {
    const params = requireParams(context, turnIdParamsSchema);
    const turn = await mapped(() =>
      service.getTurn(context.get("caller"), params.id, params.turn_id),
    );
    return jsonWithSchema(context, getTurnResponseSchema, turn);
  });
}
